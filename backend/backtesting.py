"""
Chronological Walk-Forward Backtesting Engine & Metrics for Demandora.

Enforces:
1. Strict chronological expanding windows: training y[0:t], validation y[t:t+h].
2. Zero data leakage: training sets never see validation actuals.
3. Safe metric computation: MAE, RMSE, WAPE, Bias with safe zero-demand handling.
4. Per-window and aggregate performance reporting.
"""

from typing import List, Dict, Any, Optional, Tuple
import math
import numpy as np

from .models import (
    BaseForecastModel,
    NaiveModel,
    HistoricalMeanModel,
    SimpleMovingAverageModel,
    WeightedMovingAverageModel,
    LinearTrendModel,
    HoltExponentialSmoothingModel,
    HistGradientBoostingModel
)
from .features import (
    build_supervised_dataset,
    make_future_step_feature_extractor
)
from .pattern_intelligence import profile_demand


def calculate_metrics(actuals: np.ndarray, forecasts: np.ndarray) -> Dict[str, float]:
    """
    Computes standard time-series evaluation metrics:
    - MAE = mean(|actual - forecast|)
    - RMSE = sqrt(mean((actual - forecast)^2))
    - WAPE = (sum(|actual - forecast|) / sum(|actual|)) * 100
    - Bias = (sum(forecast - actual) / sum(|actual|)) * 100

    Safely handles zero-demand periods without NaN or division by zero.
    """
    act = np.asarray(actuals, dtype=float)
    fcst = np.asarray(forecasts, dtype=float)

    if len(act) == 0 or len(fcst) == 0 or len(act) != len(fcst):
        return {"mae": 0.0, "rmse": 0.0, "wape": 0.0, "bias": 0.0}

    errors = fcst - act
    abs_errors = np.abs(errors)
    sq_errors = errors ** 2

    mae = float(np.mean(abs_errors))
    rmse = float(np.sqrt(np.mean(sq_errors)))

    sum_abs_actual = float(np.sum(np.abs(act)))
    sum_abs_error = float(np.sum(abs_errors))
    sum_error = float(np.sum(errors))

    if sum_abs_actual == 0.0:
        if sum_abs_error == 0.0:
            wape = 0.0
            bias = 0.0
        else:
            wape = 100.0
            bias = 100.0 if sum_error > 0 else -100.0
    else:
        wape = float((sum_abs_error / sum_abs_actual) * 100.0)
        bias = float((sum_error / sum_abs_actual) * 100.0)

    return {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "wape": round(wape, 4),
        "bias": round(bias, 4)
    }


def instantiate_model(model_name: str) -> BaseForecastModel:
    """
    Creates a fresh candidate model instance by name.
    """
    name_lower = model_name.lower()
    if "naive" in name_lower:
        return NaiveModel()
    elif "mean" in name_lower:
        return HistoricalMeanModel()
    elif "weighted" in name_lower or "wma" in name_lower:
        return WeightedMovingAverageModel()
    elif "moving average" in name_lower or "sma" in name_lower:
        return SimpleMovingAverageModel(window=3)
    elif "linear" in name_lower or "trend" in name_lower or "ols" in name_lower:
        return LinearTrendModel()
    elif "holt" in name_lower or "exponential" in name_lower:
        return HoltExponentialSmoothingModel()
    elif "gradient" in name_lower or "hist" in name_lower or "boosting" in name_lower:
        return HistGradientBoostingModel()
    elif "croston" in name_lower:
        from .models import CrostonModel
        return CrostonModel()
    elif "sba" in name_lower or "syntetos" in name_lower:
        from .models import SBAModel
        return SBAModel()
    else:
        return NaiveModel()


class WalkForwardBacktester:
    """
    Executes chronological expanding-window walk-forward backtesting.
    """
    def __init__(self, validation_horizon: int = 1):
        self.validation_horizon = max(1, validation_horizon)

    def get_candidate_models(self) -> List[BaseForecastModel]:
        # Local import to prevent circular if any, but we already imported globally
        from .models import CrostonModel, SBAModel
        return [
            NaiveModel(),
            HistoricalMeanModel(),
            SimpleMovingAverageModel(window=3),
            WeightedMovingAverageModel(),
            LinearTrendModel(),
            HoltExponentialSmoothingModel(),
            HistGradientBoostingModel(),
            CrostonModel(),
            SBAModel()
        ]

    def evaluate_model_backtest(
        self,
        model_template: BaseForecastModel,
        series: np.ndarray,
        periods: Optional[List[str]] = None,
        min_train_size: Optional[int] = None,
        profile_cache: Optional[Dict[int, Any]] = None
    ) -> Dict[str, Any]:
        """
        Runs walk-forward validation for a single candidate model.
        Training slice: series[:t]
        Validation slice: series[t:t+h]
        Never leaks future data into training.
        """
        n_obs = len(series)
        h = self.validation_horizon
        model_name = model_template.name
        model_type = model_template.model_type
        min_hist = model_template.min_history

        # Initial eligibility check for backtesting:
        # Needs at least min_hist observations to train + h observations to validate
        req_total = min_hist + h
        if n_obs < req_total:
            return {
                "model": model_name,
                "modelType": model_type,
                "eligible": False,
                "reason": f"Requires at least {req_total} observations for backtesting ({min_hist} train + {h} val); series has {n_obs}.",
                "wape": None,
                "mae": None,
                "rmse": None,
                "bias": None,
                "validationWindows": 0,
                "validWindows": 0,
                "windows": []
            }

        # For ML models (HistGradientBoosting), verify supervised dataset can produce >= 3 training rows
        is_ml = isinstance(model_template, HistGradientBoostingModel)

        # Determine start origin t
        # If min_train_size is specified, use max(min_hist, min_train_size)
        t_start = max(min_hist, min_train_size if min_train_size is not None else min_hist)

        # For ML, t_start must have enough history to yield >= 3 supervised rows
        if is_ml:
            # Check when supervised dataset has len(y) >= 3
            ml_ready = False
            for t_candidate in range(max(min_hist, 6), n_obs - h + 1):
                X_cand, y_cand, _ = build_supervised_dataset(list(series[:t_candidate]), periods[:t_candidate] if periods else None)
                if len(y_cand) >= 3:
                    t_start = max(t_start, t_candidate)
                    ml_ready = True
                    break
            if not ml_ready or t_start > (n_obs - h):
                return {
                    "model": model_name,
                    "modelType": model_type,
                    "eligible": False,
                    "reason": f"Only {n_obs} observations available; insufficient supervised training rows (requires >= 3 rows after lag extraction).",
                    "wape": None,
                    "mae": None,
                    "rmse": None,
                    "bias": None,
                    "validationWindows": 0,
                    "validWindows": 0,
                    "windows": []
                }

        window_results: List[Dict[str, Any]] = []
        all_actuals: List[float] = []
        all_forecasts: List[float] = []

        # Chronological expanding window: t from t_start to n_obs - h
        for t in range(t_start, n_obs - h + 1):
            train_series = series[:t]
            val_series = series[t:t+h]
            val_periods = periods[t:t+h] if periods and len(periods) >= t+h else None
            origin_period = periods[t-1] if periods and len(periods) >= t else f"M-{n_obs - t + 1}"
            val_target_period = periods[t] if periods and len(periods) >= t+1 else f"M-{n_obs - t}"

            # Create a clean, independent model instance for this origin
            fresh_model = instantiate_model(model_name)

            # LEAKAGE PREVENTION: Profile demand using ONLY the training slice (memoized by origin t)
            if profile_cache is not None and t in profile_cache:
                window_profile = profile_cache[t]
            else:
                window_profile = profile_demand("temp", list(train_series), None, None)
                if profile_cache is not None:
                    profile_cache[t] = window_profile

            is_eligible, _ = fresh_model.check_eligibility(len(train_series), window_profile)
            if not is_eligible:
                continue

            try:
                if is_ml:
                    train_periods = periods[:t] if periods and len(periods) >= t else None
                    X_tr, y_tr, fnames = build_supervised_dataset(list(train_series), train_periods)
                    if len(y_tr) < 3:
                        continue
                    fresh_model.fit(
                        series=train_series,
                        features=X_tr,
                        targets=y_tr,
                        feature_names=fnames,
                        periods=train_periods
                    )
                    extractor = make_future_step_feature_extractor(val_target_period)
                    preds, _ = fresh_model.predict_multistep(horizon=h, feature_extractor_fn=extractor)
                else:
                    fresh_model.fit(series=train_series)
                    preds, _ = fresh_model.predict(horizon=h)

                preds_arr = np.array(preds[:h], dtype=float)
                val_arr = np.array(val_series, dtype=float)

                win_metrics = calculate_metrics(val_arr, preds_arr)

                window_results.append({
                    "origin": origin_period,
                    "targetPeriod": val_target_period,
                    "originIdx": int(t),
                    "actual": [round(float(v), 2) for v in val_arr.tolist()],
                    "forecast": [round(float(p), 2) for p in preds_arr.tolist()],
                    "mae": win_metrics["mae"],
                    "rmse": win_metrics["rmse"],
                    "wape": win_metrics["wape"],
                    "bias": win_metrics["bias"]
                })

                all_actuals.extend(val_arr.tolist())
                all_forecasts.extend(preds_arr.tolist())

            except Exception:
                # If a specific fold fails numerical convergence (e.g. singular matrix in small sample), continue
                continue

        if len(window_results) == 0:
            return {
                "model": model_name,
                "modelType": model_type,
                "eligible": False,
                "reason": "No valid validation windows could be evaluated.",
                "wape": None,
                "mae": None,
                "rmse": None,
                "bias": None,
                "validationWindows": 0,
                "validWindows": 0,
                "windows": [],
                "horizon_errors": {}
            }

        # Aggregate metrics across all valid windows
        agg_metrics = calculate_metrics(np.array(all_actuals), np.array(all_forecasts))

        # Aggregate horizon-specific errors
        horizon_errors: Dict[int, List[float]] = {}
        for w in window_results:
            for step_idx, (act, fcst) in enumerate(zip(w["actual"], w["forecast"])):
                h_step = step_idx + 1
                if h_step not in horizon_errors:
                    horizon_errors[h_step] = []
                # error = actual - prediction
                horizon_errors[h_step].append(float(act - fcst))

        return {
            "model": model_name,
            "modelType": model_type,
            "eligible": True,
            "reason": f"Successfully evaluated across {len(window_results)} chronological validation windows.",
            "wape": agg_metrics["wape"],
            "mae": agg_metrics["mae"],
            "rmse": agg_metrics["rmse"],
            "bias": agg_metrics["bias"],
            "validationWindows": len(window_results),
            "validWindows": len(window_results),
            "windows": window_results,
            "horizon_errors": horizon_errors
        }

    def backtest_all_candidates(
        self,
        series: np.ndarray,
        periods: Optional[List[str]] = None,
        on_candidate_start: Optional[Any] = None,
        on_candidate_finish: Optional[Any] = None,
        is_cancelled: Optional[Any] = None
    ) -> List[Dict[str, Any]]:
        """
        Evaluates all candidate models against the series.
        """
        candidates = self.get_candidate_models()
        results: List[Dict[str, Any]] = []
        profile_cache: Dict[int, Any] = {}

        for cand in candidates:
            if is_cancelled and is_cancelled():
                raise RuntimeError("Forecast calculation was cancelled.")
            if on_candidate_start:
                on_candidate_start(cand.name)
            res = self.evaluate_model_backtest(cand, series, periods, profile_cache=profile_cache)
            if on_candidate_finish:
                on_candidate_finish(cand.name, res)
            results.append(res)

        return results
