import numpy as np
from typing import List, Dict, Any, Optional, Tuple

def calculate_cv2(series: np.ndarray) -> float:
    """Calculate squared coefficient of variation for non-zero demand."""
    non_zero = series[series > 0]
    if len(non_zero) < 2:
        return 0.0
    mean_val = np.mean(non_zero)
    if mean_val == 0:
        return 0.0
    return float((np.std(non_zero, ddof=1) / mean_val) ** 2)

def calculate_adi(series: np.ndarray) -> float:
    """Calculate Average Demand Interval."""
    non_zero_indices = np.where(series > 0)[0]
    if len(non_zero_indices) < 2:
        # If there's 1 or 0 non-zero demands, ADI is effectively the length of the series
        return float(len(series))
    intervals = np.diff(non_zero_indices)
    return float(np.mean(intervals))

def detect_outliers_iqr(series: np.ndarray) -> Dict[str, Any]:
    """Flag outliers using the IQR method on non-zero demands only."""
    non_zero = series[series > 0]
    if len(non_zero) < 4:
        return {"outlier_count": 0, "outlier_periods": [], "outlier_method": "IQR"}
    
    q1 = np.percentile(non_zero, 25)
    q3 = np.percentile(non_zero, 75)
    iqr = q3 - q1
    lower_bound = q1 - 1.5 * iqr
    upper_bound = q3 + 1.5 * iqr
    
    outliers = []
    # Evaluate original series against non-zero IQR upper bound
    # (only demand-size outliers > upper_bound are considered)
    for i, val in enumerate(series):
        if val > upper_bound:
            outliers.append(i)
            
    return {
        "outlier_count": len(outliers),
        "outlier_periods_indices": outliers,
        "outlier_method": "IQR"
    }

def detect_trend(series: np.ndarray) -> Dict[str, Any]:
    """Detect genuine trend using linear regression slope relative to scale and R²."""
    n = len(series)
    if n < 3:
        return {"trend_strength": 0.0, "trend_direction": "flat"}
        
    x = np.arange(n)
    y = series
    # Calculate slope
    slope, intercept = np.polyfit(x, y, 1)
    
    # Calculate R-squared
    y_pred = slope * x + intercept
    ss_res = np.sum((y - y_pred) ** 2)
    ss_tot = np.sum((y - np.mean(y)) ** 2)
    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0.0
    
    mean_demand = np.mean(series)
    normalized_slope = slope / mean_demand if mean_demand != 0 else 0.0
        
    # Threshold for trend: R^2 > 0.4 and absolute normalized slope > 5%
    direction = "flat"
    if r_squared > 0.4:
        if normalized_slope > 0.05:
            direction = "increasing"
        elif normalized_slope < -0.05:
            direction = "decreasing"
        
    return {
        "trend_strength": float(r_squared),
        "trend_direction": direction,
        "normalized_slope": float(normalized_slope)
    }


def calculate_yoy_velocity(
    series: np.ndarray,
    seasonality_detected: bool = False,
    seasonality_strength: float = 0.0
) -> Dict[str, Any]:
    """
    Computes Year-over-Year (YoY) velocity percentage change.
    Compares recent demand window (up to trailing 6 months) against the exact same
    calendar period in the prior year.
    Normalized if seasonality is detected.
    """
    n = len(series)
    if n < 12:
        return {
            "yoy_velocity_pct": None,
            "recent_window_months": 0,
            "is_seasonally_normalized": False
        }

    # Use up to 6 months for recent window, capped by (n - 12)
    k = min(6, n - 12)
    if k <= 0:
        k = min(3, n // 2)
        recent_sum = float(np.sum(series[-k:]))
        prior_sum = float(np.sum(series[:k]))
    else:
        recent_sum = float(np.sum(series[-k:]))
        prior_sum = float(np.sum(series[-k-12:-12]))

    if prior_sum <= 0:
        raw_delta = 100.0 if recent_sum > 0 else 0.0
    else:
        raw_delta = ((recent_sum - prior_sum) / prior_sum) * 100.0

    is_normalized = False
    if seasonality_detected and seasonality_strength > 0.4:
        raw_delta = raw_delta / (1.0 + 0.5 * (seasonality_strength - 0.4))
        is_normalized = True

    clamped_delta = float(round(np.clip(raw_delta, -100.0, 500.0), 1))
    return {
        "yoy_velocity_pct": clamped_delta,
        "recent_window_months": k,
        "is_seasonally_normalized": is_normalized
    }


def assign_momentum_flag(
    velocity_pct: Optional[float],
    normalized_slope: float = 0.0,
    r_squared: float = 0.0
) -> str:
    """
    Assigns operational directional momentum flag: NEGATIVE, SURGE, or NEUTRAL.
    """
    if velocity_pct is None:
        return "NEUTRAL"

    if velocity_pct < -15.0 or (r_squared > 0.35 and normalized_slope < -0.06):
        return "NEGATIVE"
    elif velocity_pct > 15.0 or (r_squared > 0.35 and normalized_slope > 0.06):
        return "SURGE"
    return "NEUTRAL"


def classify_lifecycle_regime(
    n_obs: int,
    adi: float,
    cv2: float,
    velocity_pct: Optional[float],
    normalized_slope: float,
    r_squared: float
) -> Tuple[str, str]:
    """
    Classifies SKU into a 4-quadrant operational lifecycle regime.
    Returns: (regime_code, description)
    """
    if n_obs < 12 or velocity_pct is None:
        return "INSUFFICIENT_HISTORY", "Insufficient historical observations (< 12M) to determine lifecycle regime."

    # Intermittent or lumpy check
    if adi >= 1.32 or cv2 >= 0.49:
        if adi >= 1.32 and cv2 >= 0.49:
            return "INTERMITTENT_LUMPY", "Lumpy demand regime with sporadic orders and volatile transaction sizes."
        elif adi >= 1.32:
            return "INTERMITTENT_LUMPY", "Intermittent demand regime with frequent zero-demand periods."
        else:
            return "INTERMITTENT_LUMPY", "Erratic demand regime with high transaction variance."

    # Contraction / Phase-Out Check
    # Either strong negative YoY velocity (< -15%) with downward trend,
    # or moderate negative velocity (< -10%) with downward slope (< -0.025) and R^2 > 0.30
    if (velocity_pct < -15.0 and normalized_slope < -0.01) or (
        velocity_pct < -10.0 and normalized_slope < -0.025 and r_squared > 0.30
    ):
        return (
            "CONTRACTION_PHASE_OUT",
            "Sustained downward sales velocity and negative trend slope; potential phase-out candidate."
        )

    # Sustained Growth / Ramp Check
    # Either strong positive YoY velocity (> +15%) with upward trend,
    # or moderate positive velocity (> +10%) with upward slope (> 0.025) and R^2 > 0.30
    if (velocity_pct > 15.0 and normalized_slope > 0.01) or (
        velocity_pct > 10.0 and normalized_slope > 0.025 and r_squared > 0.30
    ):
        return (
            "SUSTAINED_GROWTH_RAMP",
            "Sustained upward sales velocity and positive trend slope; active growth/ramp regime."
        )

    # Default: Stable Stationary
    return "STABLE_STATIONARY", "Stable demand run-rate with stationary mean and low volatility."

def detect_seasonality(series: np.ndarray, period: int = 12) -> Dict[str, Any]:
    """Detect real annual seasonality using autocorrelation at lag 12 on a detrended series."""
    n = len(series)
    if n < period * 2: # Require at least 2 full seasons to reliably detect
        return {
            "seasonality_detected": False,
            "seasonality_period": None,
            "seasonality_strength": 0.0,
            "seasonality_reason": "insufficient_history"
        }
    
    # Detrend the series using linear regression to avoid trend leaking into ACF
    x = np.arange(n)
    slope, intercept = np.polyfit(x, series, 1)
    detrended = series - (slope * x + intercept)
        
    # Calculate autocorrelation at lag 12 on detrended series
    mean = np.mean(detrended)
    var = np.var(detrended)
    if var == 0:
        return {
            "seasonality_detected": False,
            "seasonality_period": None,
            "seasonality_strength": 0.0,
            "seasonality_reason": "zero_variance"
        }
        
    lag = period
    cov = np.mean((detrended[:-lag] - mean) * (detrended[lag:] - mean))
    acf_lag12 = cov / var
    
    # Threshold for seasonality
    if acf_lag12 > 0.4:
        return {
            "seasonality_detected": True,
            "seasonality_period": 12,
            "seasonality_strength": float(acf_lag12),
            "seasonality_reason": "strong_autocorrelation"
        }
    else:
        return {
            "seasonality_detected": False,
            "seasonality_period": None,
            "seasonality_strength": float(acf_lag12),
            "seasonality_reason": "weak_autocorrelation"
        }

def profile_demand(item_code: str, history_values: List[float], history_periods: Optional[List[str]] = None, missing_periods: Optional[List[str]] = None) -> Dict[str, Any]:
    """Generate mathematical item-level demand profile."""
    series = np.array(history_values, dtype=float)
    n_obs = len(series)
    
    missing_periods_list = missing_periods or []
    
    profile = {
        "item_code": item_code,
        "history_months": n_obs,
        "missing_periods": len(missing_periods_list),
        "zero_demand_ratio": 0.0,
        "demand_pattern": "insufficient_history",
        "trend_direction": "flat",
        "trend_strength": 0.0,
        "seasonality_detected": False,
        "seasonality_period": None,
        "seasonality_strength": 0.0,
        "outlier_count": 0,
        "data_quality_flags": [],
        "forecast_eligibility": "insufficient_history",
        "eligibility_reason": "Less than 6 months of history.",
        "recommended_model_family": "insufficient_history",
        "cv_squared": 0.0,
        "average_inter_demand_interval": 0.0,
        "yoy_velocity_pct": None,
        "momentum_flag": "NEUTRAL",
        "lifecycle_regime": "INSUFFICIENT_HISTORY",
        "lifecycle_description": "Insufficient history (< 12 months) for lifecycle regime evaluation."
    }
    
    if n_obs == 0:
        profile["data_quality_flags"].append("NO_HISTORY")
        return profile
        
    zeros = np.sum(series == 0)
    profile["zero_demand_ratio"] = float(zeros / n_obs)
    
    if missing_periods_list:
        profile["data_quality_flags"].append("MISSING_PERIODS")
        
    if n_obs < 12:
        profile["data_quality_flags"].append("INSUFFICIENT_HISTORY")
        profile["eligibility_reason"] = "Less than 6 months of history." if n_obs < 6 else "Insufficient history. Minimum 12 months required."
        return profile

    profile["forecast_eligibility"] = "eligible"
    profile["eligibility_reason"] = "Sufficient history."
    
    # Intermittent/Lumpy logic (Syntetos, Boylan and Croston classification)
    cv2 = calculate_cv2(series)
    adi = calculate_adi(series)
    profile["cv_squared"] = cv2
    profile["average_inter_demand_interval"] = adi
    
    is_intermittent = False
    is_lumpy = False
    is_stable = False
    
    if adi > 1.32:
        if cv2 > 0.49:
            is_lumpy = True
            profile["demand_pattern"] = "lumpy"
        else:
            is_intermittent = True
            profile["demand_pattern"] = "intermittent"
    else:
        if cv2 > 0.49:
            profile["demand_pattern"] = "erratic"
        else:
            is_stable = True
            profile["demand_pattern"] = "stable"
            
    if is_intermittent or is_lumpy:
        profile["data_quality_flags"].append("INTERMITTENT_DEMAND" if is_intermittent else "LUMPY_DEMAND")
        if profile["zero_demand_ratio"] > 0.3:
            profile["data_quality_flags"].append("HIGH_ZERO_RATIO")

    # Trend detection
    trend_res = detect_trend(series)
    profile.update(trend_res)
    if profile["trend_direction"] != "flat" and not is_intermittent and not is_lumpy:
        profile["demand_pattern"] = "trend"
        profile["data_quality_flags"].append("STRONG_TREND")

    # Seasonality detection
    seas_res = detect_seasonality(series, period=12)
    profile.update(seas_res)
    if profile["seasonality_detected"] and not is_intermittent and not is_lumpy:
        profile["demand_pattern"] = "seasonal"
        profile["data_quality_flags"].append("SEASONAL_PATTERN")

    # Outlier detection
    outlier_res = detect_outliers_iqr(series)
    profile["outlier_count"] = outlier_res["outlier_count"]
    if profile["outlier_count"] > 0:
        profile["data_quality_flags"].append("OUTLIERS_PRESENT")
        
    # Recommended Family
    if profile["demand_pattern"] == "seasonal":
        profile["recommended_model_family"] = "seasonal"
    elif profile["demand_pattern"] == "trend":
        profile["recommended_model_family"] = "trend"
    elif profile["demand_pattern"] in ["intermittent", "lumpy"]:
        profile["recommended_model_family"] = "intermittent"
    else:
        profile["recommended_model_family"] = "stable"

    # Phase 2.2: Velocity Telemetry, Momentum Flagging & Lifecycle Classification
    vel_res = calculate_yoy_velocity(
        series=series,
        seasonality_detected=profile["seasonality_detected"],
        seasonality_strength=profile["seasonality_strength"]
    )
    profile["yoy_velocity_pct"] = vel_res["yoy_velocity_pct"]
    
    momentum = assign_momentum_flag(
        velocity_pct=profile["yoy_velocity_pct"],
        normalized_slope=trend_res["normalized_slope"],
        r_squared=trend_res["trend_strength"]
    )
    profile["momentum_flag"] = momentum
    
    regime, regime_desc = classify_lifecycle_regime(
        n_obs=n_obs,
        adi=adi,
        cv2=cv2,
        velocity_pct=profile["yoy_velocity_pct"],
        normalized_slope=trend_res["normalized_slope"],
        r_squared=trend_res["trend_strength"]
    )
    profile["lifecycle_regime"] = regime
    profile["lifecycle_description"] = regime_desc
    
    if momentum == "NEGATIVE":
        profile["data_quality_flags"].append("NEGATIVE_VELOCITY")
    elif momentum == "SURGE":
        profile["data_quality_flags"].append("SURGE_VELOCITY")

    return profile
