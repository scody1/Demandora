"""
Persistent Forecast and Model Caching Subsystem for Demandora.
Phase 2.1.1 Defect Correction & Acceptance Gate Implementation.

Provides:
- SQLite WAL configuration with synchronous=NORMAL and foreign_keys=ON.
- Exact canonical IEEE-754 floating point and length-prefixed serialization.
- SHA-256 multi-layer dependency fingerprints (L1 to L5B).
- Calendar-aware peer candidate fingerprints with exact observation periods.
- Full genuine integration of L1 (sku_profiles), L2 (engineered_features),
  L3 (backtest_evaluations), L4 (fitted_model_artifacts), L5A (forecast_results),
  and L5B (cold_start_forecast_results).
- Safe deterministic fitted model parameter serialization, retrieval, and reuse.
- Robust single-flight duplicate request coalescing with leader error propagation,
  follower timeouts, and deadlock prevention.
- Safe SQLite lifecycle, online backups, and quarantine recovery without raw WAL deletion.
- Local filesystem enforcement for Windows UNC and POSIX paths.
- Cache observability, performance metrics, and non-blocking telemetry.
"""

from typing import List, Dict, Any, Optional, Tuple
import os
import sys
import io
import json
import math
import time
import zlib
import shutil
import sqlite3
import hashlib
import threading
import numpy as np

# -------------------------------------------------------------------------
# Provenance Fingerprints (Phase 2.0.2 / 2.1.1 Specification)
# -------------------------------------------------------------------------
P1_CANONICAL_SERIALIZER_VERSION = "v1.0.0-EXACT-IEEE"
P2_SEGMENTATION_ALGO_VERSION = "v1.0.0-SBC-ADI132-CV049"
P3_FEATURE_PIPELINE_VERSION = "v1.0.0-LAGS-CYCLICAL-ROLLING"
P4_CANDIDATE_MODELS_VERSION = "v1.0.0-7MODELS-DEFAULT-HYPERPARAMS"
P5_BACKTEST_SELECTION_VERSION = "v1.0.0-WF-WAPE-TIEBREAK"
P6_MODEL_RUNTIME_VERSION = "v1.0.0-SKLEARN-STATSMODELS-PY312"
P7_INTERVAL_METHOD_VERSION = "v1.0.0-EMPIRICAL-RESIDUALS"
P8_RESULT_SCHEMA_VERSION = "v1.0.0-CONTRACT-PYFORECAST"

TARGET_SCHEMA_VERSION = 1
DEFAULT_MAX_STORAGE_BYTES = 500 * 1024 * 1024  # 500 MB
PROACTIVE_EVICTION_THRESHOLD_BYTES = 450 * 1024 * 1024  # 450 MB


# -------------------------------------------------------------------------
# Custom Exceptions
# -------------------------------------------------------------------------
class CacheError(Exception):
    """Base exception for forecast cache operations."""
    pass


class IncompatibleSchemaVersionError(CacheError):
    """Raised when the database schema version is newer than supported."""
    pass


class MigrationExecutionError(CacheError):
    """Raised when a schema migration fails during execution."""
    pass


class SingleFlightTimeoutError(CacheError, TimeoutError):
    """Raised when a follower thread times out waiting for a single-flight leader computation."""
    pass


class DatabaseCorruptedError(CacheError):
    """Raised when SQLite database fails PRAGMA integrity_check."""
    pass


class NetworkFilesystemError(CacheError):
    """Raised when the database path is located on an unsupported network share or UNC path."""
    pass


# -------------------------------------------------------------------------
# Local Filesystem & UNC Path Validation
# -------------------------------------------------------------------------
def check_local_filesystem(path: str):
    """
    Ensures database is on a local filesystem, rejecting networked drives/UNC paths.
    Validates original input path string BEFORE normalization or abspath conversion,
    and supports both Windows UNC and POSIX/Linux paths.
    """
    if not isinstance(path, str) or not path.strip():
        raise ValueError("Invalid database path specified.")

    raw_path = path.strip()

    # 1. Validate original path string BEFORE any normalization or abspath conversion
    # Any UNC path starting with two consecutive slash/backslash characters in ANY combination:
    # \\, //, /\, \/, \//, /\\, etc.
    if len(raw_path) >= 2 and raw_path[0] in ('/', '\\') and raw_path[1] in ('/', '\\'):
        raise NetworkFilesystemError(f"Network UNC filesystem paths not allowed for SQLite cache: {raw_path}")

    raw_lower = raw_path.lower()
    if (
        raw_lower.startswith(r"\\?\unc")
        or raw_lower.startswith("//?/unc")
        or raw_lower.startswith(r"/\?/unc")
        or raw_lower.startswith(r"\/?/unc")
        or raw_lower.startswith("smb://")
        or raw_lower.startswith("nfs://")
        or raw_lower.startswith("cifs://")
    ):
        raise NetworkFilesystemError(f"Network filesystem URI or UNC path not allowed for SQLite cache: {raw_path}")

    # 2. Check normalized absolute path
    abs_path = os.path.abspath(raw_path)
    if len(abs_path) >= 2 and abs_path[0] in ('/', '\\') and abs_path[1] in ('/', '\\'):
        raise NetworkFilesystemError(f"Resolved path is a network UNC path: {abs_path}")

    # 3. On Windows, check drive letter type
    if os.name == "nt" and len(abs_path) >= 2 and abs_path[1] == ":":
        drive_letter = abs_path[0].upper()
        if drive_letter.isalpha():
            drive = f"{drive_letter}:\\"
            try:
                import ctypes
                dt = ctypes.windll.kernel32.GetDriveTypeW(drive)
                # DRIVE_REMOTE = 4
                if dt == 4:
                    raise NetworkFilesystemError(f"Network drive {drive} not allowed for SQLite cache.")
            except Exception as e:
                if isinstance(e, NetworkFilesystemError):
                    raise


# -------------------------------------------------------------------------
# Exact Canonical Serialization Utilities (UTF-8 Byte Length Prefixed)
# -------------------------------------------------------------------------
def length_prefix(s: str) -> str:
    """
    Framing helper: len(s.encode('utf-8')):s.
    Prevents delimiter-injection and concatenation collision risks.
    """
    b = s.encode("utf-8")
    return f"{len(b)}:{s}"


def serialize_demand_value(v: float) -> str:
    """
    Exact IEEE-754 numeric serialization:
    - Rejects NaN, Inf, -Inf.
    - Normalizes -0.0 to 0.
    - Preserves micro-differences up to 17 significant digits (.17g).
    """
    if math.isnan(v) or math.isinf(v):
        raise ValueError(f"Invalid non-finite demand observation: {v}")
    if v == 0.0 or v == -0.0:
        return "0"
    return f"{v:.17g}"


def format_period_record(period: str, status: str, value: float) -> str:
    """
    Encodes a single period observation:
    status: 'VALID' (non-zero), 'ZERO' (active zero demand), 'MISSING' (absent/missing)
    """
    if status == "MISSING":
        val_str = "NULL"
    elif status == "ZERO":
        val_str = "0"
    else:
        val_str = serialize_demand_value(value)
    return f"{length_prefix(period)}{length_prefix(status)}{length_prefix(val_str)}"


# -------------------------------------------------------------------------
# Deterministic Key Computation Helpers
# -------------------------------------------------------------------------
def compute_series_hash(
    item_code: str,
    history_values: List[float],
    history_periods: Optional[List[str]] = None,
    missing_periods: Optional[List[str]] = None,
    is_discontinued: bool = False,
    description: Optional[str] = "",
    item_group: Optional[str] = ""
) -> Tuple[str, Dict[str, Any]]:
    """
    Computes exact series hash K_series and chronological summary metadata.
    Differentiates active zero demand from missing or truncated calendar periods.
    Captures item identity, description, itemGroup, and chronological observations.
    """
    cleaned_code = str(item_code).strip().upper()
    desc_str = str(description or "").strip()
    group_str = str(item_group or "").strip()
    n_obs = len(history_values)
    missing_list = set(missing_periods or [])

    period_records = []
    zero_count = 0
    missing_count = 0

    for i in range(n_obs):
        val = float(history_values[i])
        period = history_periods[i] if (history_periods and i < len(history_periods)) else f"P{i:04d}"

        if period in missing_list:
            status = "MISSING"
            missing_count += 1
        elif val == 0.0 or val == -0.0:
            status = "ZERO"
            zero_count += 1
        else:
            status = "VALID"

        period_records.append(format_period_record(period, status, val))

    earliest = history_periods[0] if (history_periods and len(history_periods) > 0) else ("P0000" if n_obs > 0 else "")
    latest = history_periods[-1] if (history_periods and len(history_periods) > 0) else (f"P{n_obs - 1:04d}" if n_obs > 0 else "")

    canonical_seq = (
        length_prefix(cleaned_code)
        + length_prefix("1" if is_discontinued else "0")
        + length_prefix(desc_str)
        + length_prefix(group_str)
        + "".join(period_records)
        + length_prefix(P1_CANONICAL_SERIALIZER_VERSION)
    )
    series_hash = hashlib.sha256(canonical_seq.encode("utf-8")).hexdigest()

    metadata = {
        "item_code": cleaned_code,
        "description": desc_str,
        "item_group": group_str,
        "history_length": n_obs,
        "earliest_period": earliest,
        "latest_period": latest,
        "zero_demand_count": zero_count,
        "missing_period_count": missing_count,
        "is_discontinued": is_discontinued
    }
    return series_hash, metadata


def compute_peer_pool_digest(candidate_pool: List[Dict[str, Any]]) -> str:
    """
    Computes deterministic digest of the eligible peer candidate pool.
    - Filters: len(history) >= 6, not discontinued, sum(history) > 0.
    - Preserves actual calendar periods and missing months for every peer SKU.
    - Canonical lexicographical sorting by peer code guarantees input-order invariance.
    - Captures peer identity, exact numeric demand, attribute framing, and algorithm versions.
    """
    from .cold_start import extract_sku_attributes

    eligible_records = []

    for cand in candidate_pool:
        if not isinstance(cand, dict):
            continue
        if bool(cand.get("isDiscontinued", False)):
            continue
        c_code = str(cand.get("itemCode", cand.get("item_code", ""))).strip().upper()
        if not c_code:
            continue

        raw_hist = cand.get("history", cand.get("history_values", []))
        if not isinstance(raw_hist, (list, tuple)):
            continue
        try:
            numeric_hist = [float(v) for v in raw_hist if v is not None]
        except (ValueError, TypeError):
            continue

        if len(numeric_hist) >= 6 and sum(numeric_hist) > 0:
            c_desc = str(cand.get("description", "")).strip()
            c_group = str(cand.get("itemGroup", "")).strip()
            attrs = extract_sku_attributes(c_code, c_desc, c_group)

            # Extract calendar periods and missing periods for peer if present
            peer_periods = cand.get("periods") or cand.get("history_periods")
            peer_missing = cand.get("missingPeriods") or cand.get("missing_periods")

            # Compute peer series hash using actual calendar periods
            peer_shash, _ = compute_series_hash(
                item_code=c_code,
                history_values=numeric_hist,
                history_periods=peer_periods,
                missing_periods=peer_missing,
                is_discontinued=False,
                description=c_desc,
                item_group=c_group
            )

            wattage_str = str(attrs.get("wattage")) if attrs.get("wattage") is not None else "NONE"
            form_str = str(attrs.get("formFactor", ""))
            cct_str = str(attrs.get("cct", ""))

            precord = (
                length_prefix(c_code)
                + length_prefix(c_desc)
                + length_prefix(c_group)
                + length_prefix(wattage_str)
                + length_prefix(form_str)
                + length_prefix(cct_str)
                + length_prefix(str(len(numeric_hist)))
                + length_prefix(peer_shash)
                + length_prefix(P2_SEGMENTATION_ALGO_VERSION)
            )
            eligible_records.append((c_code, precord))

    # Stable lexicographical sorting by SKU code
    eligible_records.sort(key=lambda x: x[0])
    concatenated = "".join(rec for _, rec in eligible_records)
    return hashlib.sha256(concatenated.encode("utf-8")).hexdigest()


def compute_cold_start_keys(
    item_code: str,
    description: str,
    item_group: str,
    history_values: List[float],
    candidate_pool: List[Dict[str, Any]],
    horizon: int,
    start_month: Optional[str] = "2026-11",
    segmentation_config: Optional[Dict[str, Any]] = None,
    history_periods: Optional[List[str]] = None,
    missing_periods: Optional[List[str]] = None,
    is_discontinued: bool = False
) -> Tuple[str, str, str, str]:
    """
    Computes deterministic cold-start keys:
    Returns (series_hash, peer_pool_digest, peer_dependency_key, cold_forecast_key).
    """
    from .cold_start import extract_sku_attributes

    series_hash, _ = compute_series_hash(
        item_code, history_values, history_periods, missing_periods, is_discontinued, description, item_group
    )
    peer_pool_digest = compute_peer_pool_digest(candidate_pool)

    # Target SKU structured attributes
    t_attrs = extract_sku_attributes(item_code, description, item_group)
    t_wattage = str(t_attrs.get("wattage")) if t_attrs.get("wattage") is not None else "NONE"
    t_form = str(t_attrs.get("formFactor", ""))
    t_cct = str(t_attrs.get("cct", ""))

    target_attr_framing = (
        length_prefix(str(item_code).strip().upper())
        + length_prefix(str(description).strip())
        + length_prefix(str(item_group).strip())
        + length_prefix(t_wattage)
        + length_prefix(t_form)
        + length_prefix(t_cct)
    )
    target_attr_hash = hashlib.sha256(target_attr_framing.encode("utf-8")).hexdigest()

    cfg_str = json.dumps(segmentation_config or {}, sort_keys=True)
    cfg_hash = hashlib.sha256(cfg_str.encode("utf-8")).hexdigest()

    peer_dep_framing = (
        target_attr_hash
        + length_prefix(peer_pool_digest)
        + length_prefix(P2_SEGMENTATION_ALGO_VERSION)
        + length_prefix(cfg_hash)
    )
    peer_dep_key = hashlib.sha256(peer_dep_framing.encode("utf-8")).hexdigest()

    cold_forecast_framing = (
        series_hash
        + length_prefix(peer_dep_key)
        + length_prefix(str(horizon))
        + length_prefix(str(start_month or ""))
        + length_prefix(P8_RESULT_SCHEMA_VERSION)
    )
    cold_forecast_key = hashlib.sha256(cold_forecast_framing.encode("utf-8")).hexdigest()

    return series_hash, peer_pool_digest, peer_dep_key, cold_forecast_key


def compute_mature_keys(
    series_hash: str,
    winning_model_name: Optional[str] = None,
    horizon: int = 6,
    start_month: Optional[str] = "2026-11",
    confidence_level: float = 0.90
) -> Dict[str, str]:
    """
    Computes mature SKU keys across layers L2, L3, L4, L5A:
    feature_hash, backtest_hash, model_artifact_hash, forecast_hash.
    """
    f_framing = series_hash + length_prefix(P3_FEATURE_PIPELINE_VERSION)
    feature_hash = hashlib.sha256(f_framing.encode("utf-8")).hexdigest()

    bt_framing = (
        feature_hash
        + length_prefix(P4_CANDIDATE_MODELS_VERSION)
        + length_prefix(P5_BACKTEST_SELECTION_VERSION)
    )
    backtest_hash = hashlib.sha256(bt_framing.encode("utf-8")).hexdigest()

    model_name = winning_model_name or "UNKNOWN_WINNER"
    art_framing = (
        backtest_hash
        + length_prefix(model_name)
        + length_prefix(P6_MODEL_RUNTIME_VERSION)
    )
    model_artifact_hash = hashlib.sha256(art_framing.encode("utf-8")).hexdigest()

    fc_framing = (
        model_artifact_hash
        + length_prefix(str(horizon))
        + length_prefix(str(start_month or ""))
        + length_prefix(serialize_demand_value(confidence_level))
        + length_prefix(P7_INTERVAL_METHOD_VERSION)
        + length_prefix(P8_RESULT_SCHEMA_VERSION)
    )
    forecast_hash = hashlib.sha256(fc_framing.encode("utf-8")).hexdigest()

    return {
        "series_hash": series_hash,
        "feature_hash": feature_hash,
        "backtest_hash": backtest_hash,
        "model_artifact_hash": model_artifact_hash,
        "forecast_hash": forecast_hash
    }


# -------------------------------------------------------------------------
# Single-Flight Duplicate Request Coalescing Registry (Reliable)
# -------------------------------------------------------------------------
class SingleFlightRegistry:
    """
    Coalesces concurrent requests for the same computation key onto a single execution.
    Handles leader exceptions, follower timeouts, lock safety, and clean retries.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._active: Dict[str, Dict[str, Any]] = {}
        self._completed_errors: Dict[str, Optional[str]] = {}

    def acquire(self, key: str) -> Tuple[bool, threading.Event]:
        """
        Returns (is_leader, event).
        Leader executes compute and then calls release.
        Follower waits on event.
        Clears any stale error from an earlier failed computation for this key when acquired as leader.
        """
        with self._lock:
            if key in self._active:
                return False, self._active[key]["event"]
            ev = threading.Event()
            # Clear any stale error from an earlier failed computation for this key
            self._completed_errors.pop(key, None)
            self._active[key] = {
                "event": ev,
                "error": None,
                "started_at": time.time(),
                "leader_thread": threading.get_ident()
            }
            return True, ev

    def release(self, key: str, error: Optional[Any] = None):
        """
        Releases single-flight key, records error if any, wakes all waiting followers,
        and clears key from active registry so subsequent requests can try afresh.
        """
        with self._lock:
            flight = self._active.pop(key, None)
            if flight:
                err_str = str(error) if error is not None else None
                flight["error"] = err_str
                if err_str is not None:
                    self._completed_errors[key] = err_str
                else:
                    self._completed_errors.pop(key, None)
                flight["event"].set()

    def get_error(self, key: str) -> Optional[str]:
        with self._lock:
            if key in self._active:
                return self._active[key].get("error")
            return self._completed_errors.get(key)

    def clear_error(self, key: str):
        """Explicitly clears recorded error for key."""
        with self._lock:
            self._completed_errors.pop(key, None)
            if key in self._active:
                self._active[key]["error"] = None

    def get_flight_error(self, key: str) -> Optional[str]:
        return self.get_error(key)


# -------------------------------------------------------------------------
# Safe Deterministic Model Artifact Serialization & Restoration
# -------------------------------------------------------------------------
def serialize_fitted_model(model: Any, series: np.ndarray) -> Dict[str, Any]:
    """
    Serializes a fitted forecast model into pure, validated JSON parameters.
    Eliminates unsafe arbitrary pickle/joblib deserialization.
    """
    m_name = getattr(model, "name", type(model).__name__)
    n_obs = len(series)

    if m_name == "Naive (Last Observation)":
        return {
            "model_name": m_name,
            "provenance": P6_MODEL_RUNTIME_VERSION,
            "last_val": float(getattr(model, "last_val", series[-1])),
            "training_rows": n_obs
        }
    elif m_name == "Historical Mean":
        return {
            "model_name": m_name,
            "provenance": P6_MODEL_RUNTIME_VERSION,
            "mean_val": float(getattr(model, "mean_val", np.mean(series))),
            "training_rows": n_obs
        }
    elif m_name.startswith("Simple Moving Average"):
        w = int(getattr(model, "window", 3))
        v = float(getattr(model, "val", np.mean(series[-w:])))
        return {
            "model_name": m_name,
            "provenance": P6_MODEL_RUNTIME_VERSION,
            "val": v,
            "window": w,
            "training_rows": n_obs
        }
    elif m_name.startswith("Weighted Moving Average"):
        w = int(getattr(model, "window", 3))
        weights = [float(x) for x in getattr(model, "weights", [0.2, 0.3, 0.5])]
        v = float(getattr(model, "val", np.dot(series[-w:], weights)))
        return {
            "model_name": m_name,
            "provenance": P6_MODEL_RUNTIME_VERSION,
            "val": v,
            "weights": weights,
            "window": w,
            "training_rows": n_obs
        }
    elif m_name == "Linear Trend Regression (OLS)":
        slope = float(model.metadata.get("slope", 0.0))
        intercept = float(model.metadata.get("intercept", 0.0))
        n_train = int(getattr(model, "n_train", n_obs))
        return {
            "model_name": m_name,
            "provenance": P6_MODEL_RUNTIME_VERSION,
            "slope": slope,
            "intercept": intercept,
            "n_train": n_train,
            "training_rows": n_obs
        }
    elif m_name == "Holt's Linear Exponential Smoothing":
        # Extract mathematical parameters from statsmodels Holt
        level = float(model.fitted_res.level[-1]) if (hasattr(model, "fitted_res") and model.fitted_res is not None) else float(series[-1])
        trend = float(model.fitted_res.trend[-1]) if (hasattr(model, "fitted_res") and model.fitted_res is not None) else 0.0
        alpha = float(model.metadata.get("alpha", 0.2))
        beta = float(model.metadata.get("beta", 0.1))
        damped = bool(getattr(model, "damped_trend", False))
        phi = float(model.metadata.get("phi", 1.0)) if damped else 1.0
        return {
            "model_name": m_name,
            "provenance": P6_MODEL_RUNTIME_VERSION,
            "level": level,
            "trend": trend,
            "alpha": alpha,
            "beta": beta,
            "phi": phi,
            "damped_trend": damped,
            "training_rows": n_obs
        }
    elif m_name == "Gradient Boosting (HistGradientBoostingRegressor)":
        # ML ensemble trees rely on internal C extensions; store hyperparams & note safe refit fallback
        return {
            "model_name": m_name,
            "provenance": P6_MODEL_RUNTIME_VERSION,
            "can_reuse_params": False,
            "requires_feature_refit": True,
            "training_rows": n_obs
        }
    else:
        return {
            "model_name": m_name,
            "provenance": P6_MODEL_RUNTIME_VERSION,
            "can_reuse_params": False,
            "training_rows": n_obs
        }


def restore_fitted_model(params: Dict[str, Any]) -> Optional[Any]:
    """
    Restores a fitted model from validated JSON parameters.
    Returns None if artifact is incompatible, corrupted, or requires feature refit.
    """
    if not isinstance(params, dict):
        return None
    if params.get("provenance") != P6_MODEL_RUNTIME_VERSION:
        return None

    m_name = params.get("model_name")
    if not m_name:
        return None

    from .models import (
        NaiveModel,
        HistoricalMeanModel,
        SimpleMovingAverageModel,
        WeightedMovingAverageModel,
        LinearTrendModel,
        HoltExponentialSmoothingModel
    )

    try:
        if m_name == "Naive (Last Observation)":
            m = NaiveModel()
            m.last_val = float(params["last_val"])
            m.is_fitted = True
            m.metadata["training_rows"] = int(params["training_rows"])
            return m
        elif m_name == "Historical Mean":
            m = HistoricalMeanModel()
            m.mean_val = float(params["mean_val"])
            m.is_fitted = True
            m.metadata["training_rows"] = int(params["training_rows"])
            return m
        elif m_name.startswith("Simple Moving Average"):
            w = int(params.get("window", 3))
            m = SimpleMovingAverageModel(window=w)
            m.val = float(params["val"])
            m.is_fitted = True
            m.metadata["training_rows"] = int(params["training_rows"])
            return m
        elif m_name.startswith("Weighted Moving Average"):
            weights = [float(x) for x in params.get("weights", [0.2, 0.3, 0.5])]
            m = WeightedMovingAverageModel(weights=weights)
            m.val = float(params["val"])
            m.is_fitted = True
            m.metadata["training_rows"] = int(params["training_rows"])
            return m
        elif m_name == "Linear Trend Regression (OLS)":
            m = LinearTrendModel()
            m.n_train = int(params["n_train"])
            m.model.coef_ = np.array([float(params["slope"])])
            m.model.intercept_ = float(params["intercept"])
            m.is_fitted = True
            m.metadata["training_rows"] = m.n_train
            m.metadata["slope"] = float(params["slope"])
            m.metadata["intercept"] = float(params["intercept"])
            return m
        elif m_name == "Holt's Linear Exponential Smoothing":
            # Restored proxy for Holt that evaluates exact analytical extrapolation formula
            class RestoredHoltModel:
                def __init__(self, p: Dict[str, Any]):
                    self.name = "Holt's Linear Exponential Smoothing"
                    self.model_type = "statistical"
                    self.level = float(p["level"])
                    self.trend = float(p["trend"])
                    self.damped_trend = bool(p.get("damped_trend", False))
                    self.phi = float(p.get("phi", 1.0))
                    self.is_fitted = True
                    self.metadata = {
                        "name": self.name,
                        "model_type": self.model_type,
                        "training_rows": int(p["training_rows"]),
                        "alpha": float(p.get("alpha", 0.0)),
                        "beta": float(p.get("beta", 0.0)),
                        "restored_from_cache": True
                    }

                def predict(self, horizon: int, future_features=None):
                    raw = []
                    for h in range(1, horizon + 1):
                        if self.damped_trend and self.phi != 1.0:
                            damp_factor = sum(self.phi ** i for i in range(1, h + 1))
                            pred = self.level + damp_factor * self.trend
                        else:
                            pred = self.level + h * self.trend
                        raw.append(pred)
                    clipped = [max(0.0, float(v)) for v in raw]
                    meta = {
                        **self.metadata,
                        "raw_predictions": [float(v) for v in raw],
                        "clipped": any(r < 0 for r in raw)
                    }
                    return clipped, meta

            return RestoredHoltModel(params)
        else:
            return None
    except Exception:
        return None


# -------------------------------------------------------------------------
# Cache Telemetry & Instrumentation
# -------------------------------------------------------------------------
class CacheTelemetry:
    """Thread-safe performance instrumentation and metrics collector."""

    def __init__(self):
        self._lock = threading.Lock()
        self.reset()

    def reset(self):
        with self._lock:
            self.hits_by_layer = {
                "layer1_profile": 0,
                "layer2_features": 0,
                "layer3_backtest": 0,
                "layer4_model": 0,
                "layer5a_forecast": 0,
                "layer5b_cold_forecast": 0,
            }
            self.misses_by_layer = {
                "layer1_profile": 0,
                "layer2_features": 0,
                "layer3_backtest": 0,
                "layer4_model": 0,
                "layer5a_forecast": 0,
                "layer5b_cold_forecast": 0,
            }
            self.invalidations_by_reason = {
                "history_updated": 0,
                "peer_pool_changed": 0,
                "horizon_changed": 0,
                "lru_evicted": 0,
                "provenance_bumped": 0,
            }
            self.forecast_computations_avoided = 0
            self.model_fits_avoided = 0
            self.validation_windows_avoided = 0
            self.total_read_time_ms = 0.0
            self.total_write_time_ms = 0.0
            self.eviction_events = 0
            self.migration_events = 0
            self.recovery_events = 0
            self.fallback_events = 0

    def record_hit(self, layer: str, fits_saved: int = 0, windows_saved: int = 0, computations_saved: int = 0):
        with self._lock:
            if layer in self.hits_by_layer:
                self.hits_by_layer[layer] += 1
            self.model_fits_avoided += fits_saved
            self.validation_windows_avoided += windows_saved
            self.forecast_computations_avoided += computations_saved

    def record_miss(self, layer: str):
        with self._lock:
            if layer in self.misses_by_layer:
                self.misses_by_layer[layer] += 1

    def record_invalidation(self, reason: str):
        with self._lock:
            self.invalidations_by_reason[reason] = self.invalidations_by_reason.get(reason, 0) + 1

    def record_time(self, op: str, duration_ms: float):
        with self._lock:
            if op == "read":
                self.total_read_time_ms += duration_ms
            elif op == "write":
                self.total_write_time_ms += duration_ms

    def record_eviction(self, count: int = 1):
        with self._lock:
            self.eviction_events += count

    def record_migration(self):
        with self._lock:
            self.migration_events += 1

    def record_recovery(self):
        with self._lock:
            self.recovery_events += 1

    def record_fallback(self):
        with self._lock:
            self.fallback_events += 1

    def get_summary(self) -> Dict[str, Any]:
        with self._lock:
            total_hits = sum(self.hits_by_layer.values())
            total_misses = sum(self.misses_by_layer.values())
            total_reqs = total_hits + total_misses
            hit_ratio = round((total_hits / total_reqs * 100), 2) if total_reqs > 0 else 0.0
            return {
                "totalHits": total_hits,
                "totalMisses": total_misses,
                "hitRatioPct": hit_ratio,
                "hitsByLayer": dict(self.hits_by_layer),
                "missesByLayer": dict(self.misses_by_layer),
                "invalidationsByReason": dict(self.invalidations_by_reason),
                "forecastComputationsAvoided": self.forecast_computations_avoided,
                "modelFitsAvoided": self.model_fits_avoided,
                "validationWindowsAvoided": self.validation_windows_avoided,
                "readTimeMs": round(self.total_read_time_ms, 2),
                "writeTimeMs": round(self.total_write_time_ms, 2),
                "evictionEvents": self.eviction_events,
                "migrationEvents": self.migration_events,
                "recoveryEvents": self.recovery_events,
                "fallbackEvents": self.fallback_events
            }


# -------------------------------------------------------------------------
# Core SQLite Forecast Cache Manager
# -------------------------------------------------------------------------
class ForecastCache:
    """
    Production-grade SQLite caching subsystem.
    Thread-safe, WAL-enabled, transactional sequential migrations,
    deterministic LRU eviction, and single-flight duplicate coalescing.
    """

    SCHEMA_DDL = """
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 10000;

    -- 1. Provenance & Subsystem Version Registry
    CREATE TABLE IF NOT EXISTS cache_provenance (
        component_name TEXT PRIMARY KEY,
        version_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. Layer 1: Canonical Series Profiles & Segmentation (Root Parent Table)
    CREATE TABLE IF NOT EXISTS sku_profiles (
        series_hash TEXT PRIMARY KEY,
        item_code TEXT NOT NULL,
        history_length INTEGER NOT NULL,
        earliest_period TEXT NOT NULL,
        latest_period TEXT NOT NULL,
        zero_demand_count INTEGER NOT NULL,
        missing_period_count INTEGER NOT NULL,
        adi REAL NOT NULL,
        cv_squared REAL NOT NULL,
        demand_pattern TEXT NOT NULL,
        trend_direction TEXT NOT NULL,
        trend_strength REAL NOT NULL,
        seasonality_detected BOOLEAN NOT NULL,
        seasonality_period INTEGER,
        outlier_count INTEGER NOT NULL,
        category TEXT NOT NULL,
        classification_reason TEXT NOT NULL,
        segmentation_config_hash TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        classification_json TEXT NOT NULL,
        last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 3. Layer 2: Engineered Feature Store
    CREATE TABLE IF NOT EXISTS engineered_features (
        feature_hash TEXT PRIMARY KEY,
        series_hash TEXT NOT NULL REFERENCES sku_profiles(series_hash) ON DELETE CASCADE,
        feature_names_json TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        compressed_matrix BLOB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 4. Layer 3: Walk-Forward Backtesting Leaderboard & Metrics
    CREATE TABLE IF NOT EXISTS backtest_evaluations (
        backtest_hash TEXT PRIMARY KEY,
        series_hash TEXT NOT NULL REFERENCES sku_profiles(series_hash) ON DELETE CASCADE,
        validation_horizon INTEGER NOT NULL,
        winning_model TEXT NOT NULL,
        selection_status TEXT NOT NULL,
        selection_reason TEXT NOT NULL,
        candidate_leaderboard_json TEXT NOT NULL,
        residual_quantiles_json TEXT NOT NULL,
        selected_metrics_json TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 5. Layer 4: Fitted Model State
    CREATE TABLE IF NOT EXISTS fitted_model_artifacts (
        model_artifact_hash TEXT PRIMARY KEY,
        backtest_hash TEXT NOT NULL REFERENCES backtest_evaluations(backtest_hash) ON DELETE CASCADE,
        model_name TEXT NOT NULL,
        model_type TEXT NOT NULL,
        artifact_format TEXT NOT NULL,
        serialized_model TEXT NOT NULL,
        provenance_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 6. Layer 5A: Final Predictions & Prediction Intervals (Mature SKUs)
    CREATE TABLE IF NOT EXISTS forecast_results (
        forecast_hash TEXT PRIMARY KEY,
        item_code TEXT NOT NULL,
        series_hash TEXT NOT NULL REFERENCES sku_profiles(series_hash) ON DELETE CASCADE,
        horizon INTEGER NOT NULL,
        start_month TEXT NOT NULL,
        confidence_level REAL NOT NULL,
        point_forecast_json TEXT NOT NULL,
        lower_bound_json TEXT NOT NULL,
        upper_bound_json TEXT NOT NULL,
        confidence_score REAL,
        confidence_level_label TEXT,
        result_payload_json TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 7. Layer 5B: Cold-Start & Sparse-History Predictions (Peer-Dependent)
    CREATE TABLE IF NOT EXISTS cold_start_forecast_results (
        cold_forecast_hash TEXT PRIMARY KEY,
        item_code TEXT NOT NULL,
        series_hash TEXT NOT NULL REFERENCES sku_profiles(series_hash) ON DELETE CASCADE,
        horizon INTEGER NOT NULL,
        start_month TEXT NOT NULL,
        peer_pool_hash TEXT NOT NULL,
        peer_skus_json TEXT NOT NULL,
        peer_weights_json TEXT NOT NULL,
        point_forecast_json TEXT NOT NULL,
        result_payload_json TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 8. Persistent Job Registry (Phase 2.2)
    CREATE TABLE IF NOT EXISTS forecast_jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        current_stage TEXT NOT NULL,
        completed_stages_json TEXT NOT NULL,
        completed_items INTEGER NOT NULL DEFAULT 0,
        total_items INTEGER NOT NULL DEFAULT 0,
        current_item_code TEXT,
        current_model TEXT,
        start_time REAL NOT NULL,
        end_time REAL,
        elapsed_seconds REAL NOT NULL DEFAULT 0.0,
        progress_percentage REAL NOT NULL DEFAULT 0.0,
        error TEXT,
        result_json TEXT,
        telemetry_json TEXT,
        allowed_categories_json TEXT,
        cancelled BOOLEAN NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Relational Indexes
    CREATE INDEX IF NOT EXISTS idx_forecast_lookup ON forecast_results(item_code, series_hash, horizon, start_month);
    CREATE INDEX IF NOT EXISTS idx_cold_lookup ON cold_start_forecast_results(item_code, series_hash, horizon, start_month);
    CREATE INDEX IF NOT EXISTS idx_profiles_item ON sku_profiles(item_code);
    CREATE INDEX IF NOT EXISTS idx_profiles_lru ON sku_profiles(last_accessed);
    CREATE INDEX IF NOT EXISTS idx_features_series ON engineered_features(series_hash);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON forecast_jobs(status);
    """

    def __init__(
        self,
        db_path: Optional[str] = None,
        max_storage_bytes: int = DEFAULT_MAX_STORAGE_BYTES,
        enabled: bool = True
    ):
        self.enabled = enabled
        self.max_storage_bytes = max_storage_bytes
        self.telemetry = CacheTelemetry()
        self.single_flight = SingleFlightRegistry()

        if db_path is None:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            db_dir = os.path.join(base_dir, "cache_data")
            os.makedirs(db_dir, exist_ok=True)
            self.db_path = os.path.join(db_dir, "forecast_cache.db")
        else:
            check_local_filesystem(db_path)
            self.db_path = os.path.abspath(db_path)
            os.makedirs(os.path.dirname(self.db_path), exist_ok=True)

        check_local_filesystem(self.db_path)

        # Threading lock for serialized write transactions (single writer)
        self._write_lock = threading.Lock()
        self._local = threading.local()
        self._touched_buffer = set()
        self._touched_lock = threading.Lock()

        if self.enabled:
            self._initialize_or_migrate()

    def get_connection(self) -> sqlite3.Connection:
        """Returns a thread-local SQLite connection with WAL pragmas."""
        if not hasattr(self._local, "conn") or self._local.conn is None:
            conn = sqlite3.connect(
                self.db_path,
                timeout=10.0,
                check_same_thread=False,
                isolation_level=None  # autocommit / manual transactions
            )
            try:
                conn.execute("PRAGMA journal_mode = WAL;")
                conn.execute("PRAGMA synchronous = NORMAL;")
                conn.execute("PRAGMA foreign_keys = ON;")
                conn.execute("PRAGMA busy_timeout = 10000;")
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
                raise
            self._local.conn = conn
        return self._local.conn

    def close(self):
        """Closes thread-local connection cleanly."""
        if hasattr(self._local, "conn") and self._local.conn is not None:
            try:
                self._local.conn.close()
            except Exception:
                pass
            self._local.conn = None

    # ---------------------------------------------------------------------
    # Migration & Integrity Management
    # ---------------------------------------------------------------------
    def _initialize_or_migrate(self):
        """Runs integrity check, schema version discovery, and atomic migrations."""
        with self._write_lock:
            # 1. Quick integrity check
            try:
                conn = self.get_connection()
                cur = conn.cursor()
                cur.execute("PRAGMA integrity_check;")
                row = cur.fetchone()
                if not row or row[0] != "ok":
                    raise DatabaseCorruptedError(f"Integrity check failed: {row}")
            except Exception as e:
                self.telemetry.record_recovery()
                self._recover_corrupted_database(e)
                conn = self.get_connection()

            # 2. Check user_version
            cur = conn.cursor()
            cur.execute("PRAGMA user_version;")
            curr_ver = cur.fetchone()[0]

            if curr_ver > TARGET_SCHEMA_VERSION:
                raise IncompatibleSchemaVersionError(
                    f"Database schema version {curr_ver} is newer than supported engine version {TARGET_SCHEMA_VERSION}."
                )

            if curr_ver == 0:
                # Fresh database initialization
                self._apply_migration(conn, 1, self.SCHEMA_DDL)
                self.telemetry.record_migration()
            elif curr_ver < TARGET_SCHEMA_VERSION:
                # Sequential migration path
                for v in range(curr_ver + 1, TARGET_SCHEMA_VERSION + 1):
                    backup_path = f"{self.db_path}.bak_v{curr_ver}"
                    self.create_online_backup(backup_path)
                    try:
                        self._apply_migration(conn, v, "")
                        self.telemetry.record_migration()
                    except Exception as err:
                        self.restore_from_backup(backup_path)
                        raise MigrationExecutionError(f"Migration to v{v} failed: {err}") from err

            # Ensure Phase 2.2 persistent job table exists even on legacy databases
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS forecast_jobs (
                    job_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    current_stage TEXT NOT NULL,
                    completed_stages_json TEXT NOT NULL,
                    completed_items INTEGER NOT NULL DEFAULT 0,
                    total_items INTEGER NOT NULL DEFAULT 0,
                    current_item_code TEXT,
                    current_model TEXT,
                    start_time REAL NOT NULL,
                    end_time REAL,
                    elapsed_seconds REAL NOT NULL DEFAULT 0.0,
                    progress_percentage REAL NOT NULL DEFAULT 0.0,
                    error TEXT,
                    result_json TEXT,
                    telemetry_json TEXT,
                    allowed_categories_json TEXT,
                    cancelled BOOLEAN NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_status ON forecast_jobs(status);
            """)

            # 3. Synchronize Provenance Fingerprints
            self._sync_provenance(conn)

    def _apply_migration(self, conn: sqlite3.Connection, version: int, ddl_statements: str):
        """Applies migration script and updates user_version."""
        if ddl_statements.strip():
            conn.executescript(ddl_statements)
        conn.execute(f"PRAGMA user_version = {version};")

    def _sync_provenance(self, conn: sqlite3.Connection):
        """Records current subsystem fingerprints into cache_provenance."""
        provenance = [
            ("P1_CANONICAL_SERIALIZER", P1_CANONICAL_SERIALIZER_VERSION),
            ("P2_SEGMENTATION_ALGO", P2_SEGMENTATION_ALGO_VERSION),
            ("P3_FEATURE_PIPELINE", P3_FEATURE_PIPELINE_VERSION),
            ("P4_CANDIDATE_MODELS", P4_CANDIDATE_MODELS_VERSION),
            ("P5_BACKTEST_SELECTION", P5_BACKTEST_SELECTION_VERSION),
            ("P6_MODEL_RUNTIME", P6_MODEL_RUNTIME_VERSION),
            ("P7_INTERVAL_METHOD", P7_INTERVAL_METHOD_VERSION),
            ("P8_RESULT_SCHEMA", P8_RESULT_SCHEMA_VERSION),
        ]
        conn.execute("BEGIN IMMEDIATE;")
        try:
            for name, ver in provenance:
                conn.execute(
                    """
                    INSERT INTO cache_provenance (component_name, version_hash, metadata_json, updated_at)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(component_name) DO UPDATE SET
                        version_hash = excluded.version_hash,
                        updated_at = CURRENT_TIMESTAMP;
                    """,
                    (name, ver, json.dumps({"version": ver}))
                )
            conn.execute("COMMIT;")
        except Exception:
            conn.execute("ROLLBACK;")
            raise

    def create_online_backup(self, backup_path: str):
        """Creates a WAL-safe online snapshot using sqlite3.Connection.backup()."""
        abs_bak = os.path.abspath(backup_path)
        os.makedirs(os.path.dirname(abs_bak), exist_ok=True)
        if os.path.exists(abs_bak):
            try:
                os.remove(abs_bak)
            except Exception:
                pass
        src_conn = self.get_connection()
        dst_conn = sqlite3.connect(abs_bak)
        try:
            with dst_conn:
                src_conn.backup(dst_conn, pages=100)
        finally:
            dst_conn.close()

    def restore_from_backup(self, backup_path: str):
        """Restores database from a WAL-safe backup snapshot."""
        src_conn = sqlite3.connect(backup_path)
        dst_conn = self.get_connection()
        try:
            with dst_conn:
                src_conn.backup(dst_conn, pages=100)
        finally:
            src_conn.close()

    def _recover_corrupted_database(self, err: Exception):
        """
        Quarantines corrupted database and restarts with a pristine schema.
        Never manually deletes active WAL/SHM files while in use.
        """
        self.close()
        timestamp = int(time.time())
        corrupt_name = f"{self.db_path}.corrupt_{timestamp}"
        try:
            if os.path.exists(self.db_path):
                shutil.move(self.db_path, corrupt_name)
        except Exception:
            pass

    # ---------------------------------------------------------------------
    # Deterministic Cascading LRU Eviction
    # ---------------------------------------------------------------------
    def touch_profile(self, series_hash: str):
        """Buffers touched profile hash to avoid holding SQLite write locks on every read query."""
        if not self.enabled:
            return
        should_flush = False
        with self._touched_lock:
            self._touched_buffer.add(series_hash)
            if len(self._touched_buffer) >= 200:
                should_flush = True
        if should_flush:
            self.flush_touched_profiles()

    def flush_touched_profiles(self):
        """Flushes buffered touched profiles in a single batch write transaction."""
        if not self.enabled:
            return
        with self._touched_lock:
            if not self._touched_buffer:
                return
            to_flush = list(self._touched_buffer)
            self._touched_buffer.clear()

        with self._write_lock:
            try:
                conn = self.get_connection()
                chunk_size = 200
                for i in range(0, len(to_flush), chunk_size):
                    chunk = to_flush[i:i + chunk_size]
                    placeholders = ",".join("?" for _ in chunk)
                    conn.execute(
                        f"UPDATE sku_profiles SET last_accessed = CURRENT_TIMESTAMP WHERE series_hash IN ({placeholders});",
                        chunk
                    )
            except Exception:
                pass

    def check_and_evict_lru(self, target_free_bytes: Optional[int] = None):
        """
        Deterministic LRU eviction:
        When DB size exceeds max_storage_bytes, evicts oldest profiles.
        Tie-breaking: ORDER BY last_accessed ASC, series_hash ASC.
        Cascades via foreign keys to clean all child tables with zero orphans.
        """
        if not os.path.exists(self.db_path):
            return

        db_size = os.path.getsize(self.db_path)
        wal_file = f"{self.db_path}-wal"
        if os.path.exists(wal_file):
            db_size += os.path.getsize(wal_file)

        threshold = target_free_bytes or PROACTIVE_EVICTION_THRESHOLD_BYTES
        if db_size < threshold:
            return

        with self._write_lock:
            conn = self.get_connection()
            conn.execute("BEGIN IMMEDIATE;")
            try:
                cur = conn.cursor()
                cur.execute(
                    """
                    SELECT series_hash FROM sku_profiles
                    ORDER BY last_accessed ASC, series_hash ASC
                    LIMIT 200;
                    """
                )
                rows = cur.fetchall()
                if rows:
                    hashes = [r[0] for r in rows]
                    placeholders = ",".join(["?"] * len(hashes))
                    cur.execute(
                        f"DELETE FROM sku_profiles WHERE series_hash IN ({placeholders});",
                        hashes
                    )
                    self.telemetry.record_eviction(len(hashes))
                    self.telemetry.record_invalidation("lru_evicted")
                conn.execute("COMMIT;")
            except Exception:
                conn.execute("ROLLBACK;")
                raise

    # ---------------------------------------------------------------------
    # Read & Write API: Layer 1 (SKU Profiles & Classification)
    # ---------------------------------------------------------------------
    def get_sku_profile(
        self,
        series_hash: str,
        description: Optional[str] = None,
        item_group: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None
        t0 = time.time()
        try:
            conn = self.get_connection()
            cur = conn.cursor()
            cur.execute(
                """
                SELECT item_code, demand_pattern, category, profile_json, classification_json
                FROM sku_profiles WHERE series_hash = ?;
                """,
                (series_hash,)
            )
            row = cur.fetchone()
            if row:
                cls_data = json.loads(row[4])
                # Double-validation: ensure description and itemGroup match requested attributes
                if description is not None and str(cls_data.get("description", "")).strip() != str(description or "").strip():
                    self.telemetry.record_miss("layer1_profile")
                    return None
                if item_group is not None and str(cls_data.get("itemGroup", "")).strip() != str(item_group or "").strip():
                    self.telemetry.record_miss("layer1_profile")
                    return None

                self.touch_profile(series_hash)
                self.telemetry.record_hit("layer1_profile")
                self.telemetry.record_time("read", (time.time() - t0) * 1000)
                return {
                    "itemCode": row[0],
                    "demandPattern": row[1],
                    "category": row[2],
                    "profile": json.loads(row[3]),
                    "classification": cls_data
                }
            self.telemetry.record_miss("layer1_profile")
            return None
        except Exception:
            self.telemetry.record_fallback()
            return None

    def put_sku_profile(
        self,
        series_hash: str,
        item_code: str,
        meta: Dict[str, Any],
        profile: Dict[str, Any],
        classification: Dict[str, Any],
        segmentation_config: Optional[Dict[str, Any]] = None
    ):
        if not self.enabled:
            return
        t0 = time.time()
        cfg_hash = hashlib.sha256(json.dumps(segmentation_config or {}, sort_keys=True).encode("utf-8")).hexdigest()
        try:
            with self._write_lock:
                conn = self.get_connection()
                conn.execute("BEGIN IMMEDIATE;")
                try:
                    conn.execute(
                        """
                        INSERT INTO sku_profiles (
                            series_hash, item_code, history_length, earliest_period, latest_period,
                            zero_demand_count, missing_period_count, adi, cv_squared, demand_pattern,
                            trend_direction, trend_strength, seasonality_detected, seasonality_period,
                            outlier_count, category, classification_reason, segmentation_config_hash,
                            profile_json, classification_json, last_accessed
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(series_hash) DO UPDATE SET
                            last_accessed = CURRENT_TIMESTAMP;
                        """,
                        (
                            series_hash,
                            item_code,
                            meta.get("history_length", 0),
                            meta.get("earliest_period", ""),
                            meta.get("latest_period", ""),
                            meta.get("zero_demand_count", 0),
                            meta.get("missing_period_count", 0),
                            float(profile.get("average_inter_demand_interval", 0.0) or 0.0),
                            float(profile.get("cv_squared", 0.0) or 0.0),
                            str(profile.get("demand_pattern", "regular")),
                            str(profile.get("trend_direction", "flat")),
                            float(profile.get("trend_strength", 0.0) or 0.0),
                            bool(profile.get("seasonality_detected", False)),
                            profile.get("seasonality_period"),
                            int(profile.get("outlier_count", 0) or 0),
                            str(classification.get("category", "UNCLASSIFIED")),
                            str(classification.get("classification_reason", "")),
                            cfg_hash,
                            json.dumps(profile),
                            json.dumps(classification)
                        )
                    )
                    conn.execute("COMMIT;")
                    self.telemetry.record_time("write", (time.time() - t0) * 1000)
                except Exception:
                    conn.execute("ROLLBACK;")
                    raise
        except Exception:
            self.telemetry.record_fallback()

    # ---------------------------------------------------------------------
    # Read & Write API: Layer 2 (Engineered Features)
    # ---------------------------------------------------------------------
    def get_engineered_features(self, feature_hash: str) -> Optional[Tuple[np.ndarray, np.ndarray, List[str]]]:
        """
        Genuine cache retrieval for Layer 2 feature store.
        Returns (X, y, feature_names) or None on cache miss.
        """
        if not self.enabled:
            return None
        t0 = time.time()
        try:
            conn = self.get_connection()
            cur = conn.cursor()
            cur.execute(
                """
                SELECT series_hash, feature_names_json, row_count, compressed_matrix
                FROM engineered_features WHERE feature_hash = ?;
                """,
                (feature_hash,)
            )
            row = cur.fetchone()
            if row:
                self.touch_profile(row[0])
                feature_names = json.loads(row[1])
                decompressed = zlib.decompress(row[3])
                # Load X and y from serialized numpy buffer
                buf = io.BytesIO(decompressed)
                npz = np.load(buf)
                X = npz["X"]
                y = npz["y"]
                self.telemetry.record_hit("layer2_features")
                self.telemetry.record_time("read", (time.time() - t0) * 1000)
                return X, y, feature_names
            self.telemetry.record_miss("layer2_features")
            return None
        except Exception:
            self.telemetry.record_fallback()
            return None

    def put_engineered_features(
        self,
        feature_hash: str,
        series_hash: str,
        X: np.ndarray,
        y: np.ndarray,
        feature_names: List[str]
    ):
        """Stores compressed supervised training matrices into Layer 2."""
        if not self.enabled:
            return
        t0 = time.time()
        try:
            buf = io.BytesIO()
            np.savez_compressed(buf, X=X, y=y)
            raw_bytes = buf.getvalue()
            compressed = zlib.compress(raw_bytes, level=6)

            with self._write_lock:
                conn = self.get_connection()
                conn.execute("BEGIN IMMEDIATE;")
                try:
                    conn.execute(
                        """
                        INSERT INTO engineered_features (
                            feature_hash, series_hash, feature_names_json, row_count, compressed_matrix
                        ) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(feature_hash) DO NOTHING;
                        """,
                        (
                            feature_hash,
                            series_hash,
                            json.dumps(feature_names),
                            int(len(y)),
                            compressed
                        )
                    )
                    conn.execute("COMMIT;")
                    self.telemetry.record_time("write", (time.time() - t0) * 1000)
                except Exception:
                    conn.execute("ROLLBACK;")
                    raise
        except Exception:
            self.telemetry.record_fallback()

    # ---------------------------------------------------------------------
    # Read & Write API: Layer 3 (Backtest Evaluations & Leaderboard)
    # ---------------------------------------------------------------------
    def get_backtest_evaluations(self, backtest_hash: str) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None
        t0 = time.time()
        try:
            conn = self.get_connection()
            cur = conn.cursor()
            cur.execute(
                """
                SELECT series_hash, validation_horizon, winning_model, selection_status,
                       selection_reason, candidate_leaderboard_json, residual_quantiles_json,
                       selected_metrics_json
                FROM backtest_evaluations WHERE backtest_hash = ?;
                """,
                (backtest_hash,)
            )
            row = cur.fetchone()
            if row:
                self.touch_profile(row[0])
                leaderboard = json.loads(row[5])
                saved_fits = len(leaderboard)
                saved_windows = sum(alt.get("validWindows", 0) for alt in leaderboard)
                self.telemetry.record_hit("layer3_backtest", fits_saved=saved_fits, windows_saved=saved_windows)
                self.telemetry.record_time("read", (time.time() - t0) * 1000)
                return {
                    "series_hash": row[0],
                    "validation_horizon": row[1],
                    "winning_model": row[2],
                    "selection_status": row[3],
                    "selection_reason": row[4],
                    "candidate_leaderboard": leaderboard,
                    "residual_quantiles": json.loads(row[6]),
                    "selected_metrics": json.loads(row[7])
                }
            self.telemetry.record_miss("layer3_backtest")
            return None
        except Exception:
            self.telemetry.record_fallback()
            return None

    def put_backtest_evaluations(
        self,
        backtest_hash: str,
        series_hash: str,
        validation_horizon: int,
        winning_model: str,
        selection_status: str,
        selection_reason: str,
        candidate_leaderboard: List[Dict[str, Any]],
        residual_quantiles: Dict[str, Any],
        selected_metrics: Optional[Dict[str, Any]] = None
    ):
        if not self.enabled:
            return
        t0 = time.time()
        try:
            with self._write_lock:
                conn = self.get_connection()
                conn.execute("BEGIN IMMEDIATE;")
                try:
                    conn.execute(
                        """
                        INSERT INTO backtest_evaluations (
                            backtest_hash, series_hash, validation_horizon, winning_model,
                            selection_status, selection_reason, candidate_leaderboard_json,
                            residual_quantiles_json, selected_metrics_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(backtest_hash) DO NOTHING;
                        """,
                        (
                            backtest_hash,
                            series_hash,
                            validation_horizon,
                            winning_model,
                            selection_status,
                            selection_reason,
                            json.dumps(candidate_leaderboard),
                            json.dumps(residual_quantiles),
                            json.dumps(selected_metrics or {})
                        )
                    )
                    conn.execute("COMMIT;")
                    self.telemetry.record_time("write", (time.time() - t0) * 1000)
                except Exception:
                    conn.execute("ROLLBACK;")
                    raise
        except Exception:
            self.telemetry.record_fallback()

    # ---------------------------------------------------------------------
    # Read & Write API: Layer 4 (Fitted Model Artifacts - Genuine Reuse)
    # ---------------------------------------------------------------------
    def get_model_artifact(self, model_artifact_hash: str) -> Optional[Dict[str, Any]]:
        """
        Retrieves genuinely reusable fitted model parameters from Layer 4.
        Validates artifact provenance; returns None on incompatibility or miss.
        """
        if not self.enabled:
            return None
        t0 = time.time()
        try:
            conn = self.get_connection()
            cur = conn.cursor()
            cur.execute(
                """
                SELECT backtest_hash, model_name, model_type, artifact_format, serialized_model, provenance_hash
                FROM fitted_model_artifacts WHERE model_artifact_hash = ?;
                """,
                (model_artifact_hash,)
            )
            row = cur.fetchone()
            if row:
                prov = row[5]
                if prov != P6_MODEL_RUNTIME_VERSION:
                    self.telemetry.record_miss("layer4_model")
                    return None
                params = json.loads(row[4])
                self.telemetry.record_hit("layer4_model")
                self.telemetry.record_time("read", (time.time() - t0) * 1000)
                return {
                    "backtest_hash": row[0],
                    "model_name": row[1],
                    "model_type": row[2],
                    "artifact_format": row[3],
                    "model_params": params,
                    "provenance_hash": prov
                }
            self.telemetry.record_miss("layer4_model")
            return None
        except Exception:
            self.telemetry.record_fallback()
            return None

    def put_model_artifact(
        self,
        model_artifact_hash: str,
        backtest_hash: str,
        model_name: str,
        model_type: str,
        model_params: Dict[str, Any]
    ):
        if not self.enabled:
            return
        t0 = time.time()
        try:
            with self._write_lock:
                conn = self.get_connection()
                conn.execute("BEGIN IMMEDIATE;")
                try:
                    conn.execute(
                        """
                        INSERT INTO fitted_model_artifacts (
                            model_artifact_hash, backtest_hash, model_name, model_type,
                            artifact_format, serialized_model, provenance_hash
                        ) VALUES (?, ?, ?, ?, 'JSON_PARAMS', ?, ?)
                        ON CONFLICT(model_artifact_hash) DO NOTHING;
                        """,
                        (
                            model_artifact_hash,
                            backtest_hash,
                            model_name,
                            model_type,
                            json.dumps(model_params),
                            P6_MODEL_RUNTIME_VERSION
                        )
                    )
                    conn.execute("COMMIT;")
                    self.telemetry.record_time("write", (time.time() - t0) * 1000)
                except Exception:
                    conn.execute("ROLLBACK;")
                    raise
        except Exception:
            self.telemetry.record_fallback()

    # ---------------------------------------------------------------------
    # Read & Write API: Layer 5A (Mature Forecast Results)
    # ---------------------------------------------------------------------
    def get_forecast_result(self, forecast_hash: str) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None
        t0 = time.time()
        try:
            conn = self.get_connection()
            cur = conn.cursor()
            cur.execute(
                """
                SELECT series_hash, result_payload_json
                FROM forecast_results WHERE forecast_hash = ?;
                """,
                (forecast_hash,)
            )
            row = cur.fetchone()
            if row:
                self.touch_profile(row[0])
                payload = json.loads(row[1])
                leaderboard = payload.get("modelComparison", [])
                saved_fits = len(leaderboard) + 1
                saved_windows = sum(alt.get("validWindows", 0) for alt in leaderboard)
                self.telemetry.record_hit("layer5a_forecast", fits_saved=saved_fits, windows_saved=saved_windows, computations_saved=1)
                self.telemetry.record_time("read", (time.time() - t0) * 1000)
                return payload
            self.telemetry.record_miss("layer5a_forecast")
            return None
        except Exception:
            self.telemetry.record_fallback()
            return None

    def put_forecast_result(
        self,
        forecast_hash: str,
        item_code: str,
        series_hash: str,
        horizon: int,
        start_month: str,
        confidence_level: float,
        result_payload: Dict[str, Any]
    ):
        if not self.enabled:
            return
        t0 = time.time()
        point_forecast = result_payload.get("forecast", [])
        conf = result_payload.get("confidence", {}) or {}
        lower_bound = conf.get("lowerBound", [])
        upper_bound = conf.get("upperBound", [])
        conf_score = conf.get("score")
        conf_label = conf.get("level")

        try:
            with self._write_lock:
                conn = self.get_connection()
                conn.execute("BEGIN IMMEDIATE;")
                try:
                    conn.execute(
                        """
                        INSERT INTO forecast_results (
                            forecast_hash, item_code, series_hash, horizon, start_month,
                            confidence_level, point_forecast_json, lower_bound_json,
                            upper_bound_json, confidence_score, confidence_level_label,
                            result_payload_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(forecast_hash) DO UPDATE SET
                            result_payload_json = excluded.result_payload_json;
                        """,
                        (
                            forecast_hash,
                            item_code,
                            series_hash,
                            horizon,
                            start_month or "",
                            confidence_level,
                            json.dumps(point_forecast),
                            json.dumps(lower_bound),
                            json.dumps(upper_bound),
                            conf_score,
                            conf_label,
                            json.dumps(result_payload)
                        )
                    )
                    conn.execute("COMMIT;")
                    self.telemetry.record_time("write", (time.time() - t0) * 1000)
                except Exception:
                    conn.execute("ROLLBACK;")
                    raise
        except Exception:
            self.telemetry.record_fallback()

    # ---------------------------------------------------------------------
    # Read & Write API: Layer 5B (Cold-Start & Sparse-History Results)
    # ---------------------------------------------------------------------
    def get_cold_forecast_result(self, cold_forecast_hash: str) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None
        t0 = time.time()
        try:
            conn = self.get_connection()
            cur = conn.cursor()
            cur.execute(
                """
                SELECT series_hash, result_payload_json
                FROM cold_start_forecast_results WHERE cold_forecast_hash = ?;
                """,
                (cold_forecast_hash,)
            )
            row = cur.fetchone()
            if row:
                self.touch_profile(row[0])
                payload = json.loads(row[1])
                self.telemetry.record_hit("layer5b_cold_forecast", fits_saved=0, windows_saved=0, computations_saved=1)
                self.telemetry.record_time("read", (time.time() - t0) * 1000)
                return payload
            self.telemetry.record_miss("layer5b_cold_forecast")
            return None
        except Exception:
            self.telemetry.record_fallback()
            return None

    def put_cold_forecast_result(
        self,
        cold_forecast_hash: str,
        item_code: str,
        series_hash: str,
        horizon: int,
        start_month: str,
        peer_pool_hash: str,
        peer_skus: List[str],
        peer_weights: List[float],
        point_forecast: List[float],
        result_payload: Dict[str, Any]
    ):
        if not self.enabled:
            return
        t0 = time.time()
        try:
            with self._write_lock:
                conn = self.get_connection()
                conn.execute("BEGIN IMMEDIATE;")
                try:
                    conn.execute(
                        """
                        INSERT INTO cold_start_forecast_results (
                            cold_forecast_hash, item_code, series_hash, horizon, start_month,
                            peer_pool_hash, peer_skus_json, peer_weights_json, point_forecast_json,
                            result_payload_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(cold_forecast_hash) DO UPDATE SET
                            result_payload_json = excluded.result_payload_json;
                        """,
                        (
                            cold_forecast_hash,
                            item_code,
                            series_hash,
                            horizon,
                            start_month or "",
                            peer_pool_hash,
                            json.dumps(peer_skus),
                            json.dumps(peer_weights),
                            json.dumps(point_forecast),
                            json.dumps(result_payload)
                        )
                    )
                    conn.execute("COMMIT;")
                    self.telemetry.record_time("write", (time.time() - t0) * 1000)
                except Exception:
                    conn.execute("ROLLBACK;")
                    raise
        except Exception:
            self.telemetry.record_fallback()

    def save_job(self, job: Dict[str, Any]) -> None:
        """Persists a new or updated forecast job record to SQLite."""
        if not self.enabled:
            return
        t0 = time.time()
        try:
            with self._write_lock:
                conn = self.get_connection()
                try:
                    conn.execute("BEGIN IMMEDIATE;")
                    conn.execute("""
                        INSERT OR REPLACE INTO forecast_jobs (
                            job_id, status, current_stage, completed_stages_json,
                            completed_items, total_items, current_item_code, current_model,
                            start_time, end_time, elapsed_seconds, progress_percentage,
                            error, result_json, telemetry_json, allowed_categories_json,
                            cancelled, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP);
                    """, (
                        job["jobId"],
                        job["status"],
                        job.get("currentStage", ""),
                        json.dumps(job.get("completedStages", [])),
                        job.get("completedItems", 0),
                        job.get("totalItems", 0),
                        job.get("currentItemCode") or "",
                        job.get("currentModel") or "",
                        job.get("startTime", time.time()),
                        job.get("endTime"),
                        job.get("elapsedSeconds", 0.0),
                        job.get("progressPercentage", 0.0),
                        job.get("error"),
                        json.dumps(job.get("result")) if job.get("result") is not None else None,
                        json.dumps(job.get("telemetry")) if job.get("telemetry") is not None else None,
                        json.dumps(job.get("allowedCategories")) if job.get("allowedCategories") is not None else None,
                        1 if job.get("cancelled", False) else 0
                    ))
                    conn.execute("COMMIT;")
                    self.telemetry.record_time("write", (time.time() - t0) * 1000)
                except Exception:
                    conn.execute("ROLLBACK;")
                    raise
        except Exception:
            self.telemetry.record_fallback()

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Retrieves a persisted forecast job record from SQLite."""
        if not self.enabled:
            return None
        try:
            conn = self.get_connection()
            cur = conn.cursor()
            cur.execute("""
                SELECT job_id, status, current_stage, completed_stages_json,
                       completed_items, total_items, current_item_code, current_model,
                       start_time, end_time, elapsed_seconds, progress_percentage,
                       error, result_json, telemetry_json, allowed_categories_json, cancelled
                FROM forecast_jobs WHERE job_id = ?;
            """, (job_id,))
            row = cur.fetchone()
            if not row:
                return None
            return {
                "jobId": row[0],
                "status": row[1],
                "currentStage": row[2],
                "completedStages": json.loads(row[3]) if row[3] else [],
                "completedItems": row[4],
                "totalItems": row[5],
                "currentItemCode": row[6] or None,
                "currentModel": row[7] or None,
                "startTime": row[8],
                "endTime": row[9],
                "elapsedSeconds": row[10],
                "progressPercentage": row[11],
                "error": row[12],
                "result": json.loads(row[13]) if row[13] else None,
                "telemetry": json.loads(row[14]) if row[14] else None,
                "allowedCategories": json.loads(row[15]) if row[15] else None,
                "cancelled": bool(row[16])
            }
        except Exception:
            self.telemetry.record_fallback()
            return None

    def get_cache_metrics(self) -> Dict[str, Any]:
        """Returns database storage and row counts for cache observability."""
        if not self.enabled:
            return {"enabled": False}
        conn = self.get_connection()
        cur = conn.cursor()
        counts = {}
        for tbl in [
            "sku_profiles", "engineered_features", "backtest_evaluations",
            "fitted_model_artifacts", "forecast_results", "cold_start_forecast_results",
            "forecast_jobs"
        ]:
            try:
                cur.execute(f"SELECT COUNT(*) FROM {tbl};")
                counts[tbl] = cur.fetchone()[0]
            except Exception:
                counts[tbl] = 0

        file_size_mb = 0.0
        if os.path.exists(self.db_path):
            file_size_mb = round(os.path.getsize(self.db_path) / (1024 * 1024), 2)

        summary = self.telemetry.get_summary()
        return {
            "enabled": True,
            "databasePath": self.db_path,
            "databaseSizeMB": file_size_mb,
            "tableCounts": counts,
            "telemetry": summary
        }

    def get_database_size_bytes(self) -> int:
        """Returns the total disk footprint of the SQLite database and its WAL."""
        if not os.path.exists(self.db_path):
            return 0
        size = os.path.getsize(self.db_path)
        wal_file = f"{self.db_path}-wal"
        if os.path.exists(wal_file):
            size += os.path.getsize(wal_file)
        return size


# Global module singleton instance
_default_cache: Optional[ForecastCache] = None
_init_lock = threading.Lock()


def get_default_cache() -> ForecastCache:
    """Returns the default ForecastCache singleton."""
    global _default_cache
    if _default_cache is None:
        with _init_lock:
            if _default_cache is None:
                _default_cache = ForecastCache()
    return _default_cache
