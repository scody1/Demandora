"""
Data-Length-Aware Feature Engineering Pipeline.

Enforces:
1. Strict data leakage prevention (only past observations used).
2. Data-length adaptation (lags and rolling windows only constructed when observations exist).
3. Chronological row construction (no random temporal shuffling).
4. Calendar & cyclical regressors (sine/cosine of month-of-year, quarter).
"""

from typing import List, Dict, Tuple, Optional
import math
import numpy as np


def determine_eligible_feature_names(n_obs: int) -> List[str]:
    """
    Determines which features are mathematically valid given historical series length.
    Never requests lag_12 if only 6 observations exist.
    """
    features: List[str] = ["lag_1"]
    if n_obs >= 3:
        features.extend(["lag_2", "rolling_mean_2"])
    if n_obs >= 4:
        features.extend(["lag_3", "rolling_mean_3", "rolling_std_3", "trend_index", "recent_growth"])
    if n_obs >= 7:
        features.extend(["lag_6", "rolling_mean_6", "rolling_std_6"])
    if n_obs >= 13:
        features.extend(["lag_12", "rolling_mean_12"])

    # Calendar features always constructible if periods are provided
    features.extend(["month_of_year", "quarter", "seasonal_sin", "seasonal_cos"])
    return features


def extract_row_features(
    series_slice: List[float],
    current_idx: int,
    period_str: Optional[str],
    requested_features: List[str]
) -> List[float]:
    """
    Computes feature values for a single point in time using strictly past data (series_slice[:current_idx]).
    """
    history_up_to_now = series_slice[:current_idx]
    k = len(history_up_to_now)
    row: List[float] = []

    # Parse month/quarter if available
    month = 1
    quarter = 1
    if period_str and len(period_str) >= 7:
        try:
            month = int(period_str[5:7])
            quarter = (month - 1) // 3 + 1
        except Exception:
            month = 1
            quarter = 1
    else:
        # Fallback cyclical month derived from index
        month = (current_idx % 12) + 1
        quarter = (month - 1) // 3 + 1

    for fname in requested_features:
        if fname == "lag_1":
            row.append(history_up_to_now[-1] if k >= 1 else 0.0)
        elif fname == "lag_2":
            row.append(history_up_to_now[-2] if k >= 2 else (history_up_to_now[-1] if k >= 1 else 0.0))
        elif fname == "lag_3":
            row.append(history_up_to_now[-3] if k >= 3 else 0.0)
        elif fname == "lag_6":
            row.append(history_up_to_now[-6] if k >= 6 else 0.0)
        elif fname == "lag_12":
            row.append(history_up_to_now[-12] if k >= 12 else 0.0)
        elif fname == "rolling_mean_2":
            vals = history_up_to_now[-2:] if k >= 2 else history_up_to_now
            row.append(float(np.mean(vals)) if len(vals) > 0 else 0.0)
        elif fname == "rolling_mean_3":
            vals = history_up_to_now[-3:] if k >= 3 else history_up_to_now
            row.append(float(np.mean(vals)) if len(vals) > 0 else 0.0)
        elif fname == "rolling_mean_6":
            vals = history_up_to_now[-6:] if k >= 6 else history_up_to_now
            row.append(float(np.mean(vals)) if len(vals) > 0 else 0.0)
        elif fname == "rolling_mean_12":
            vals = history_up_to_now[-12:] if k >= 12 else history_up_to_now
            row.append(float(np.mean(vals)) if len(vals) > 0 else 0.0)
        elif fname == "rolling_std_3":
            vals = history_up_to_now[-3:] if k >= 3 else history_up_to_now
            row.append(float(np.std(vals)) if len(vals) > 1 else 0.0)
        elif fname == "rolling_std_6":
            vals = history_up_to_now[-6:] if k >= 6 else history_up_to_now
            row.append(float(np.std(vals)) if len(vals) > 1 else 0.0)
        elif fname == "trend_index":
            row.append(float(current_idx))
        elif fname == "recent_growth":
            if k >= 2 and history_up_to_now[-2] > 0:
                growth = (history_up_to_now[-1] - history_up_to_now[-2]) / history_up_to_now[-2]
                row.append(float(np.clip(growth, -2.0, 2.0)))
            else:
                row.append(0.0)
        elif fname == "month_of_year":
            row.append(float(month))
        elif fname == "quarter":
            row.append(float(quarter))
        elif fname == "seasonal_sin":
            row.append(float(math.sin(2.0 * math.pi * month / 12.0)))
        elif fname == "seasonal_cos":
            row.append(float(math.cos(2.0 * math.pi * month / 12.0)))
        else:
            row.append(0.0)

    return row


def build_supervised_dataset(
    series: List[float],
    periods: Optional[List[str]] = None
) -> Tuple[np.ndarray, np.ndarray, List[str]]:
    """
    Builds chronological supervised training matrix (X, y) without temporal leakage.
    For target y at time t, X[t] is formulated strictly using observations y[:t].
    """
    n = len(series)
    if n < 4:
        # Insufficient depth for supervised lag-features
        return np.empty((0, 0)), np.empty((0,)), []

    feature_names = determine_eligible_feature_names(n)

    # Determine maximum lag required to form complete initial row
    max_lag = 1
    if "lag_12" in feature_names:
        max_lag = 12
    elif "lag_6" in feature_names:
        max_lag = 6
    elif "lag_3" in feature_names:
        max_lag = 3
    elif "lag_2" in feature_names:
        max_lag = 2

    # Safety check: if max_lag leaves fewer than 3 training targets, adjust features
    if (n - max_lag) < 3:
        if n >= 6:
            max_lag = 3
            feature_names = [f for f in feature_names if not f.startswith("lag_6") and not f.startswith("lag_12") and not "12" in f and not "6" in f]
        elif n >= 4:
            max_lag = 2
            feature_names = [f for f in feature_names if f in ["lag_1", "lag_2", "rolling_mean_2", "month_of_year", "quarter", "seasonal_sin", "seasonal_cos"]]
        else:
            max_lag = 1
            feature_names = ["lag_1", "month_of_year", "quarter", "seasonal_sin", "seasonal_cos"]

    X_list: List[List[float]] = []
    y_list: List[float] = []

    # Construct strictly in chronological order
    for t in range(max_lag, n):
        period_str = periods[t] if periods and t < len(periods) else None
        feat_vector = extract_row_features(series, t, period_str, feature_names)
        target_val = float(series[t])

        X_list.append(feat_vector)
        y_list.append(target_val)

    X = np.array(X_list, dtype=float)
    y = np.array(y_list, dtype=float)

    return X, y, feature_names


def make_future_step_feature_extractor(start_period: Optional[str] = None):
    """
    Returns a callable for recursive multi-step forecasting that generates features
    for step `s` using the extended sequence without mutating original history.
    """
    def extractor(extended_series: List[float], step_idx: int, feature_names: List[str]) -> List[float]:
        # Determine target month for step
        period_str = None
        if start_period and len(start_period) >= 7:
            try:
                base_year = int(start_period[0:4])
                base_month = int(start_period[5:7])
                total_m = (base_month - 1) + step_idx
                cur_y = base_year + (total_m // 12)
                cur_m = (total_m % 12) + 1
                period_str = f"{cur_y:04d}-{cur_m:02d}"
            except Exception:
                period_str = None

        return extract_row_features(
            extended_series,
            len(extended_series),
            period_str,
            feature_names
        )

    return extractor
