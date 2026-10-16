"""
Candidate Forecasting Models Implementation for Demandora.

Phase 1: Real Statistical and Machine Learning Models.
- Naive
- Historical Mean
- Simple Moving Average (SMA)
- Weighted Moving Average (WMA)
- Linear Trend Regression (OLS)
- Holt's Linear Exponential Smoothing (statsmodels)
- HistGradientBoostingRegressor (scikit-learn)

All models adhere to fit(series, features) -> predict(horizon, future_features)
"""

from typing import List, Dict, Any, Optional, Tuple
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LinearRegression
import statsmodels.tsa.holtwinters as hw


class BaseForecastModel:
    def __init__(self, name: str, model_type: str, min_history: int):
        self.name = name
        self.model_type = model_type
        self.min_history = min_history
        self.is_fitted = False
        self.metadata: Dict[str, Any] = {
            "name": name,
            "model_type": model_type,
            "min_history": min_history,
            "clipped_count": 0,
            "hyperparameters": {},
            "raw_predictions": [],
            "training_rows": 0,
        }

    def check_eligibility(self, n_obs: int, pattern_profile: Optional[Dict[str, Any]] = None) -> Tuple[bool, str]:
        if n_obs < self.min_history:
            return False, f"Requires at least {self.min_history} observations; SKU has {n_obs}."
        return True, "Eligible"

    def fit(
        self,
        series: np.ndarray,
        features: Optional[np.ndarray] = None,
        targets: Optional[np.ndarray] = None,
        feature_names: Optional[List[str]] = None,
        periods: Optional[List[str]] = None,
        **kwargs: Any
    ):
        raise NotImplementedError

    def predict(self, horizon: int, future_features: Optional[np.ndarray] = None) -> Tuple[List[float], Dict[str, Any]]:
        raise NotImplementedError


class NaiveModel(BaseForecastModel):
    """
    1. Naive Model:
    Forecast: y_hat(t + h) = y(t)
    Carries forward the most recent valid historical demand.
    """
    def __init__(self):
        super().__init__(name="Naive (Last Observation)", model_type="baseline", min_history=1)
        self.last_val = 0.0

    def fit(self, series: np.ndarray, features=None, targets=None):
        if len(series) < 1:
            raise ValueError("Naive model requires at least 1 observation.")
        self.last_val = float(series[-1])
        self.is_fitted = True
        self.metadata["training_rows"] = len(series)
        self.metadata["last_observed_value"] = self.last_val

    def predict(self, horizon: int, future_features=None) -> Tuple[List[float], Dict[str, Any]]:
        if not self.is_fitted:
            raise RuntimeError("Model must be fitted before predict.")
        raw = [self.last_val] * horizon
        clipped = [max(0.0, v) for v in raw]
        meta = {
            **self.metadata,
            "raw_predictions": raw,
            "clipped": any(r < 0 for r in raw),
        }
        return clipped, meta


class HistoricalMeanModel(BaseForecastModel):
    """
    2. Historical Mean Model:
    Forecast: y_hat(t + h) = mean(historical demand)
    """
    def __init__(self):
        super().__init__(name="Historical Mean", model_type="baseline", min_history=1)
        self.mean_val = 0.0

    def fit(self, series: np.ndarray, features=None, targets=None):
        if len(series) < 1:
            raise ValueError("Historical Mean requires at least 1 observation.")
        self.mean_val = float(np.mean(series))
        self.is_fitted = True
        self.metadata["training_rows"] = len(series)
        self.metadata["historical_mean"] = self.mean_val

    def predict(self, horizon: int, future_features=None) -> Tuple[List[float], Dict[str, Any]]:
        if not self.is_fitted:
            raise RuntimeError("Model must be fitted before predict.")
        raw = [self.mean_val] * horizon
        clipped = [max(0.0, v) for v in raw]
        meta = {
            **self.metadata,
            "raw_predictions": raw,
            "clipped": any(r < 0 for r in raw),
        }
        return clipped, meta


class SimpleMovingAverageModel(BaseForecastModel):
    """
    3. Simple Moving Average:
    For window k: y_hat(t+1) = mean(y(t-k+1) ... y(t))
    """
    def __init__(self, window: int = 3):
        super().__init__(name=f"Simple Moving Average (SMA-{window})", model_type="statistical", min_history=window)
        self.window = window
        self.val = 0.0

    def fit(self, series: np.ndarray, features=None, targets=None):
        if len(series) < self.window:
            raise ValueError(f"SMA-{self.window} requires at least {self.window} observations.")
        self.val = float(np.mean(series[-self.window:]))
        self.is_fitted = True
        self.metadata["training_rows"] = len(series)
        self.metadata["window"] = self.window

    def predict(self, horizon: int, future_features=None) -> Tuple[List[float], Dict[str, Any]]:
        if not self.is_fitted:
            raise RuntimeError("Model must be fitted before predict.")
        raw = [self.val] * horizon
        clipped = [max(0.0, v) for v in raw]
        meta = {
            **self.metadata,
            "raw_predictions": raw,
            "clipped": any(r < 0 for r in raw),
        }
        return clipped, meta


class WeightedMovingAverageModel(BaseForecastModel):
    """
    4. Weighted Moving Average:
    Uses explicit weights that sum to 1.
    Calculates weighted forecast from actual trailing observations.
    """
    def __init__(self, weights: Optional[List[float]] = None):
        if weights is None:
            weights = [0.2, 0.3, 0.5]
        weights = [float(w) for w in weights]
        total = sum(weights)
        norm_weights = [w / total for w in weights]
        k = len(norm_weights)
        super().__init__(name=f"Weighted Moving Average (WMA-{k})", model_type="statistical", min_history=k)
        self.weights = np.array(norm_weights)
        self.window = k
        self.val = 0.0

    def fit(self, series: np.ndarray, features=None, targets=None):
        if len(series) < self.window:
            raise ValueError(f"WMA-{self.window} requires at least {self.window} observations.")
        slice_vals = series[-self.window:]
        self.val = float(np.dot(slice_vals, self.weights))
        self.is_fitted = True
        self.metadata["training_rows"] = len(series)
        self.metadata["weights"] = list(self.weights)

    def predict(self, horizon: int, future_features=None) -> Tuple[List[float], Dict[str, Any]]:
        if not self.is_fitted:
            raise RuntimeError("Model must be fitted before predict.")
        raw = [self.val] * horizon
        clipped = [max(0.0, v) for v in raw]
        meta = {
            **self.metadata,
            "raw_predictions": raw,
            "clipped": any(r < 0 for r in raw),
        }
        return clipped, meta


class LinearTrendModel(BaseForecastModel):
    """
    5. Linear Trend Regression:
    Fits y_t = a + b * t using actual historical observations via scikit-learn LinearRegression.
    """
    def __init__(self):
        super().__init__(name="Linear Trend Regression (OLS)", model_type="statistical", min_history=3)
        self.model = LinearRegression()
        self.n_train = 0

    def fit(self, series: np.ndarray, features=None, targets=None):
        if len(series) < self.min_history:
            raise ValueError(f"Linear Trend requires at least {self.min_history} observations.")
        self.n_train = len(series)
        X = np.arange(self.n_train).reshape(-1, 1)
        y = series.astype(float)
        self.model.fit(X, y)
        self.is_fitted = True
        self.metadata["training_rows"] = self.n_train
        self.metadata["slope"] = float(self.model.coef_[0])
        self.metadata["intercept"] = float(self.model.intercept_)

    def predict(self, horizon: int, future_features=None) -> Tuple[List[float], Dict[str, Any]]:
        if not self.is_fitted:
            raise RuntimeError("Model must be fitted before predict.")
        X_fut = np.arange(self.n_train, self.n_train + horizon).reshape(-1, 1)
        raw_preds = self.model.predict(X_fut).tolist()
        clipped = [max(0.0, float(v)) for v in raw_preds]
        meta = {
            **self.metadata,
            "raw_predictions": [float(v) for v in raw_preds],
            "clipped": any(r < 0 for r in raw_preds),
            "slope": float(self.model.coef_[0]),
            "intercept": float(self.model.intercept_),
        }
        return clipped, meta


class HoltExponentialSmoothingModel(BaseForecastModel):
    """
    6. Exponential Smoothing / Holt's Linear Trend:
    Genuine implementation using statsmodels.tsa.holtwinters.Holt with numerical parameter estimation.
    """
    def __init__(self, damped_trend: bool = False):
        super().__init__(name="Holt's Linear Exponential Smoothing", model_type="statistical", min_history=4)
        self.damped_trend = damped_trend
        self.fitted_res = None
        self.series = None

    def check_eligibility(self, n_obs: int, pattern_profile: Optional[Dict[str, Any]] = None) -> Tuple[bool, str]:
        base_eligible, base_reason = super().check_eligibility(n_obs, pattern_profile)
        if not base_eligible:
            return False, base_reason
        if pattern_profile and pattern_profile.get("demand_pattern") in ["intermittent", "lumpy"]:
            return False, "Not suitable for intermittent or lumpy demand."
        return True, "Eligible"

    def fit(self, series: np.ndarray, features=None, targets=None):
        if len(series) < self.min_history:
            raise ValueError(f"Holt Exponential Smoothing requires at least {self.min_history} observations.")
        self.series = series.astype(float)
        # Genuine statsmodels Holt fit with MLE / SSE optimization
        model = hw.Holt(self.series, damped_trend=self.damped_trend, initialization_method="estimated")
        self.fitted_res = model.fit(optimized=True)
        self.is_fitted = True
        self.metadata["training_rows"] = len(series)
        self.metadata["alpha"] = float(self.fitted_res.params.get("smoothing_level", 0.0))
        self.metadata["beta"] = float(self.fitted_res.params.get("smoothing_trend", 0.0))
        if self.damped_trend:
            self.metadata["phi"] = float(self.fitted_res.params.get("damping_trend", 1.0))

    def predict(self, horizon: int, future_features=None) -> Tuple[List[float], Dict[str, Any]]:
        if not self.is_fitted:
            raise RuntimeError("Model must be fitted before predict.")
        raw_preds = self.fitted_res.forecast(horizon).tolist()
        clipped = [max(0.0, float(v)) for v in raw_preds]
        meta = {
            **self.metadata,
            "raw_predictions": [float(v) for v in raw_preds],
            "clipped": any(r < 0 for r in raw_preds),
        }
        return clipped, meta


class HistGradientBoostingModel(BaseForecastModel):
    """
    7. Machine Learning: HistGradientBoostingRegressor (scikit-learn)
    Genuine supervised tree ensemble learning fit(X, y) on lag/rolling feature matrices,
    and multi-step recursive forecasting without mutating original historical series.
    """
    def __init__(self, min_samples_leaf: int = 2, max_iter: int = 100, learning_rate: float = 0.1):
        super().__init__(name="Gradient Boosting (HistGradientBoostingRegressor)", model_type="machine_learning", min_history=6)
        self.model = HistGradientBoostingRegressor(
            min_samples_leaf=min_samples_leaf,
            max_iter=max_iter,
            learning_rate=learning_rate,
            random_state=42
        )
        self.feature_names: List[str] = []
        self.history_series: np.ndarray = np.array([])
        self.history_periods: List[str] = []

    def fit(self, series: np.ndarray, features: Optional[np.ndarray] = None, targets: Optional[np.ndarray] = None, feature_names: Optional[List[str]] = None, periods: Optional[List[str]] = None):
        if features is None or targets is None or len(targets) < 3:
            raise ValueError("HistGradientBoosting requires at least 3 supervised training rows (X, y).")
        
        self.history_series = np.array(series, dtype=float)
        self.history_periods = list(periods) if periods else []
        self.feature_names = list(feature_names) if feature_names else [f"f_{i}" for i in range(features.shape[1])]
        
        # Real ML fit(X, y)
        self.model.fit(features, targets)
        self.is_fitted = True

        self.metadata["training_rows"] = int(features.shape[0])
        self.metadata["n_features"] = int(features.shape[1])
        self.metadata["feature_names"] = self.feature_names
        self.metadata["hyperparameters"] = {
            "min_samples_leaf": self.model.min_samples_leaf,
            "max_iter": self.model.max_iter,
            "learning_rate": self.model.learning_rate,
            "random_state": 42
        }

    def predict_multistep(self, horizon: int, feature_extractor_fn) -> Tuple[List[float], Dict[str, Any]]:
        """
        Recursive multi-step forecast:
        1. Predict Month 1 using features from current history.
        2. Append prediction to temporary future sequence.
        3. Recalculate features including the temporary prediction.
        4. Predict Month 2 ... until horizon is reached.
        The original historical series is NEVER mutated.
        """
        if not self.is_fitted:
            raise RuntimeError("Model must be fitted before predict.")

        raw_predictions: List[float] = []
        clipped_predictions: List[float] = []
        temp_series = list(self.history_series)

        for step in range(horizon):
            # Extract features for next step using temporary series (unmutated original + temp preds)
            x_step = feature_extractor_fn(temp_series, step, self.feature_names)
            x_step_arr = np.array(x_step).reshape(1, -1)

            # Real ML predict(X)
            pred_val = float(self.model.predict(x_step_arr)[0])
            raw_predictions.append(pred_val)

            # Apply non-negative constraint
            clipped_val = max(0.0, pred_val)
            clipped_predictions.append(clipped_val)

            # Append to temporary future sequence for subsequent lags
            temp_series.append(clipped_val)

        meta = {
            **self.metadata,
            "raw_predictions": raw_predictions,
            "clipped": any(r < 0 for r in raw_predictions),
            "multistep_steps": horizon,
        }
        return clipped_predictions, meta


class CrostonModel(BaseForecastModel):
    """
    8. Croston's Method for Intermittent Demand:
    Separates demand size and demand interval, exponentially smoothing both.
    Forecast = smoothed_size / smoothed_interval
    """
    def __init__(self, alpha: float = 0.1):
        super().__init__(name="Croston Intermittent", model_type="intermittent", min_history=4)
        self.alpha = alpha
        self.forecast_val = 0.0

    def check_eligibility(self, n_obs: int, pattern_profile: Optional[Dict[str, Any]] = None) -> Tuple[bool, str]:
        base_eligible, base_reason = super().check_eligibility(n_obs, pattern_profile)
        if not base_eligible:
            return False, base_reason
        if pattern_profile and pattern_profile.get("demand_pattern") not in ["intermittent", "lumpy", "erratic"]:
            return False, "Only suitable for intermittent, lumpy, or erratic demand."
        return True, "Eligible"

    def fit(self, series: np.ndarray, features=None, targets=None):
        if len(series) < self.min_history:
            raise ValueError(f"Croston requires at least {self.min_history} observations.")
        
        # Initialize
        z = series[series > 0]
        if len(z) == 0:
            self.forecast_val = 0.0
            self.is_fitted = True
            return
            
        q = np.mean(z) # smoothed size
        
        non_zero_indices = np.where(series > 0)[0]
        if len(non_zero_indices) < 2:
            a = float(len(series))
        else:
            a = np.mean(np.diff(non_zero_indices)) # smoothed interval
            
        # Croston iteration
        q_smooth = q
        a_smooth = a
        last_q = q_smooth
        last_a = a_smooth
        
        q_intervals = 1
        for val in series:
            if val > 0:
                q_smooth = self.alpha * val + (1 - self.alpha) * last_q
                a_smooth = self.alpha * q_intervals + (1 - self.alpha) * last_a
                last_q = q_smooth
                last_a = a_smooth
                q_intervals = 1
            else:
                q_intervals += 1
                
        self.forecast_val = float(last_q / last_a) if last_a > 0 else 0.0
        self.is_fitted = True
        self.metadata["training_rows"] = len(series)
        self.metadata["alpha"] = self.alpha

    def predict(self, horizon: int, future_features=None) -> Tuple[List[float], Dict[str, Any]]:
        if not self.is_fitted:
            raise RuntimeError("Model must be fitted before predict.")
        raw = [self.forecast_val] * horizon
        clipped = [max(0.0, v) for v in raw]
        meta = {
            **self.metadata,
            "raw_predictions": raw,
            "clipped": False,
        }
        return clipped, meta


class SBAModel(BaseForecastModel):
    """
    9. Syntetos-Boylan Approximation (SBA):
    Bias-corrected version of Croston's method.
    Forecast = (1 - alpha/2) * (smoothed_size / smoothed_interval)
    """
    def __init__(self, alpha: float = 0.1):
        super().__init__(name="Syntetos-Boylan Approximation (SBA)", model_type="intermittent", min_history=4)
        self.alpha = alpha
        self.forecast_val = 0.0

    def check_eligibility(self, n_obs: int, pattern_profile: Optional[Dict[str, Any]] = None) -> Tuple[bool, str]:
        base_eligible, base_reason = super().check_eligibility(n_obs, pattern_profile)
        if not base_eligible:
            return False, base_reason
        if pattern_profile and pattern_profile.get("demand_pattern") not in ["intermittent", "lumpy", "erratic"]:
            return False, "Only suitable for intermittent, lumpy, or erratic demand."
        return True, "Eligible"

    def fit(self, series: np.ndarray, features=None, targets=None):
        if len(series) < self.min_history:
            raise ValueError(f"SBA requires at least {self.min_history} observations.")
            
        z = series[series > 0]
        if len(z) == 0:
            self.forecast_val = 0.0
            self.is_fitted = True
            return
            
        q = np.mean(z)
        
        non_zero_indices = np.where(series > 0)[0]
        if len(non_zero_indices) < 2:
            a = float(len(series))
        else:
            a = np.mean(np.diff(non_zero_indices))
            
        q_smooth = q
        a_smooth = a
        last_q = q_smooth
        last_a = a_smooth
        
        q_intervals = 1
        for val in series:
            if val > 0:
                q_smooth = self.alpha * val + (1 - self.alpha) * last_q
                a_smooth = self.alpha * q_intervals + (1 - self.alpha) * last_a
                last_q = q_smooth
                last_a = a_smooth
                q_intervals = 1
            else:
                q_intervals += 1
                
        # SBA correction
        correction = (1 - self.alpha / 2)
        self.forecast_val = float(correction * (last_q / last_a)) if last_a > 0 else 0.0
        self.is_fitted = True
        self.metadata["training_rows"] = len(series)
        self.metadata["alpha"] = self.alpha

    def predict(self, horizon: int, future_features=None) -> Tuple[List[float], Dict[str, Any]]:
        if not self.is_fitted:
            raise RuntimeError("Model must be fitted before predict.")
        raw = [self.forecast_val] * horizon
        clipped = [max(0.0, v) for v in raw]
        meta = {
            **self.metadata,
            "raw_predictions": raw,
            "clipped": False,
        }
        return clipped, meta

