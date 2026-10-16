"""
Automated Test Suite for Real Forecasting Engine (Phase 1).

Covers:
A. Naive model
B. Mean model
C. Moving Average
D. Weighted Moving Average
E. Linear Trend
F. Exponential Smoothing / Holt
G. Gradient Boosting (HistGradientBoostingRegressor)
H. Feature generation
I. Lag generation
J. Rolling features
K. Insufficient history
L. Data leakage prevention
M. Multi-step forecast
N. Negative forecast handling
O. Different history lengths
CRITICAL: Data Sensitivity (Dataset A vs Dataset B)
CRITICAL: Model Fitting (actual fit call, learned weights, predict call)
CRITICAL: Chronological order (no random temporal shuffling)
"""

import math
import numpy as np
import pytest

from backend.models import (
    NaiveModel,
    HistoricalMeanModel,
    SimpleMovingAverageModel,
    WeightedMovingAverageModel,
    LinearTrendModel,
    HoltExponentialSmoothingModel,
    HistGradientBoostingModel
)
from backend.features import (
    determine_eligible_feature_names,
    extract_row_features,
    build_supervised_dataset,
    make_future_step_feature_extractor
)
from backend.engine import ForecastingEngine


class TestModels:
    # A. Naive Model Test
    def test_naive_model(self):
        model = NaiveModel()
        series = np.array([120.0, 150.0, 180.0])
        model.fit(series)
        preds, meta = model.predict(horizon=3)
        assert len(preds) == 3
        assert preds == [180.0, 180.0, 180.0]
        assert meta["last_observed_value"] == 180.0
        assert meta["training_rows"] == 3

    # B. Mean Model Test
    def test_mean_model(self):
        model = HistoricalMeanModel()
        series = np.array([100.0, 200.0, 300.0])
        model.fit(series)
        preds, meta = model.predict(horizon=2)
        assert len(preds) == 2
        assert preds == [200.0, 200.0]
        assert meta["historical_mean"] == 200.0

    # C. Moving Average Test
    def test_moving_average_model(self):
        model = SimpleMovingAverageModel(window=3)
        series = np.array([50.0, 100.0, 150.0, 200.0])
        model.fit(series)
        preds, meta = model.predict(horizon=3)
        # Average of last 3: (100 + 150 + 200) / 3 = 150.0
        assert len(preds) == 3
        assert preds == [150.0, 150.0, 150.0]
        assert meta["window"] == 3

    # D. Weighted Moving Average Test
    def test_weighted_moving_average_model(self):
        weights = [0.2, 0.3, 0.5]
        model = WeightedMovingAverageModel(weights=weights)
        series = np.array([10.0, 100.0, 200.0, 300.0])
        model.fit(series)
        preds, meta = model.predict(horizon=2)
        expected = 100.0 * 0.2 + 200.0 * 0.3 + 300.0 * 0.5  # 20 + 60 + 150 = 230.0
        assert len(preds) == 2
        assert abs(preds[0] - expected) < 1e-5
        assert preds[0] == preds[1]

    # E. Linear Trend Test
    def test_linear_trend_model(self):
        model = LinearTrendModel()
        # Series y = 10 + 5 * t => t=0:10, t=1:15, t=2:20, t=3:25
        series = np.array([10.0, 15.0, 20.0, 25.0])
        model.fit(series)
        preds, meta = model.predict(horizon=2)
        # t=4 -> 30, t=5 -> 35
        assert abs(preds[0] - 30.0) < 1e-4
        assert abs(preds[1] - 35.0) < 1e-4
        assert abs(meta["slope"] - 5.0) < 1e-4
        assert abs(meta["intercept"] - 10.0) < 1e-4

    # F. Exponential Smoothing / Holt's Linear Trend Test
    def test_holt_exponential_smoothing(self):
        model = HoltExponentialSmoothingModel()
        series = np.array([100.0, 120.0, 135.0, 155.0, 180.0, 210.0])
        model.fit(series)
        preds, meta = model.predict(horizon=3)
        assert len(preds) == 3
        # Should project upward trend
        assert preds[0] > series[-1] or abs(preds[0] - series[-1]) < 30
        assert preds[2] > preds[0]
        assert "alpha" in meta
        assert "beta" in meta

    # G. Gradient Boosting Model Test
    def test_hist_gradient_boosting(self):
        # 12 months with growing pattern
        series = [100.0, 110.0, 125.0, 140.0, 160.0, 185.0, 210.0, 240.0, 275.0, 310.0, 350.0, 395.0]
        X, y, feature_names = build_supervised_dataset(series)
        assert len(y) >= 3
        model = HistGradientBoostingModel(min_samples_leaf=1, max_iter=50)
        model.fit(np.array(series), X, y, feature_names)

        extractor = make_future_step_feature_extractor("2026-11")
        preds, meta = model.predict_multistep(horizon=4, feature_extractor_fn=extractor)
        assert len(preds) == 4
        assert all(p >= 0 for p in preds)
        assert meta["training_rows"] == len(y)
        assert meta["n_features"] == X.shape[1]


class TestFeatureEngineering:
    # H & I. Feature and Lag Generation
    def test_lag_generation(self):
        series = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0]
        req = ["lag_1", "lag_2", "lag_3"]
        feats = extract_row_features(series, current_idx=4, period_str="2026-05", requested_features=req)
        # At index 4 (value 50.0), past is [10, 20, 30, 40]
        # lag_1 = 40.0, lag_2 = 30.0, lag_3 = 20.0
        assert feats[0] == 40.0
        assert feats[1] == 30.0
        assert feats[2] == 20.0

    # J. Rolling Features
    def test_rolling_features(self):
        series = [10.0, 20.0, 30.0, 40.0, 50.0]
        req = ["rolling_mean_3", "rolling_std_3"]
        feats = extract_row_features(series, current_idx=4, period_str="2026-05", requested_features=req)
        # At index 4, past is [10, 20, 30, 40]. Last 3 = [20, 30, 40]
        mean_3 = (20.0 + 30.0 + 40.0) / 3.0  # 30.0
        assert abs(feats[0] - mean_3) < 1e-4

    # K. Insufficient History Adaptation
    def test_insufficient_history_features(self):
        # Only 2 observations
        names_2 = determine_eligible_feature_names(2)
        assert "lag_12" not in names_2
        assert "lag_6" not in names_2
        assert "lag_3" not in names_2

        # 6 observations
        names_6 = determine_eligible_feature_names(6)
        assert "lag_12" not in names_6
        assert "lag_1" in names_6
        assert "lag_2" in names_6
        assert "lag_3" in names_6

    # L. Data Leakage Prevention Test
    def test_data_leakage_prevention(self):
        """
        Verify that changing future observations does NOT alter features constructed for past points.
        """
        series_original = [10.0, 20.0, 30.0, 40.0, 50.0]
        series_with_future_change = [10.0, 20.0, 30.0, 9999.0, 8888.0]

        req = ["lag_1", "lag_2", "rolling_mean_2"]
        feats_orig = extract_row_features(series_original, current_idx=3, period_str=None, requested_features=req)
        feats_mod = extract_row_features(series_with_future_change, current_idx=3, period_str=None, requested_features=req)

        # For index 3, both series have [10, 20, 30] in the past. Future changes must have 0 effect.
        assert feats_orig == feats_mod

    # M. Multi-Step Forecast Test
    def test_multistep_recursive_forecast(self):
        series = [100.0 + i * 15 for i in range(14)]
        X, y, fnames = build_supervised_dataset(series)
        model = HistGradientBoostingModel(min_samples_leaf=1)
        model.fit(np.array(series), X, y, fnames)

        extractor = make_future_step_feature_extractor("2026-11")
        preds, meta = model.predict_multistep(horizon=6, feature_extractor_fn=extractor)
        assert len(preds) == 6
        # Original history must remain untouched
        assert len(model.history_series) == 14

    # N. Negative Forecast Handling & Clipping Audit
    def test_negative_forecast_clipping(self):
        # Force a steep downward trend
        series = np.array([50.0, 30.0, 10.0])
        model = LinearTrendModel()
        model.fit(series)
        preds, meta = model.predict(horizon=3)
        # Without clipping, slope is -20 => t=3 -> -10, t=4 -> -30
        assert all(p >= 0 for p in preds)
        assert meta["clipped"] is True
        assert any(r < 0 for r in meta["raw_predictions"])

    # O. Different History Lengths Test
    def test_different_history_lengths(self):
        engine = ForecastingEngine()
        # 1 month
        res_1m = engine.forecast_single_sku("SKU-1", [250.0], horizon=6)
        assert res_1m["modelType"] == "sparse_history"
        assert res_1m["historyMonths"] == 1
        assert res_1m["selectionStatus"] == "SPARSE_HISTORY"

        # 4 months
        res_4m = engine.forecast_single_sku("SKU-4", [100.0, 120.0, 110.0, 130.0], horizon=6)
        assert res_4m["historyMonths"] == 4
        assert res_4m["selectionStatus"] == "SPARSE_HISTORY"
        assert res_4m["selectedModelMetrics"] is None

        # 16 months
        res_16m = engine.forecast_single_sku("SKU-16", [100.0 + i * 10 for i in range(16)], horizon=6)
        assert res_16m["historyMonths"] == 16
        assert res_16m["selectionStatus"] == "SELECTED"
        assert res_16m["selectedModelMetrics"] is not None


class TestCriticalRequirements:
    # 20. CRITICAL TEST — DATA SENSITIVITY
    def test_critical_data_sensitivity(self):
        """
        Verify that substantially different data inputs produce genuinely different forecasts
        demonstrating that models actually learn from data and are NOT hardcoded.
        """
        engine = ForecastingEngine()

        # Dataset A: Flat baseline ~100
        history_a = [100.0] * 14

        # Dataset B: High acceleration spikes ~500 to ~800
        history_b = [100.0, 120.0, 100.0, 300.0, 100.0, 500.0, 150.0, 700.0, 200.0, 850.0, 250.0, 950.0, 300.0, 1100.0]

        res_a = engine.forecast_single_sku("SKU-FLAT", history_a, horizon=6)
        res_b = engine.forecast_single_sku("SKU-SPIKE", history_b, horizon=6)

        forecast_a = res_a["forecast"]
        forecast_b = res_b["forecast"]

        # Confirm forecasts are significantly different
        diff = sum(abs(b - a) for a, b in zip(forecast_a, forecast_b))
        assert diff > 500, f"Expected substantial difference, got diff={diff}"
        assert forecast_b[-1] > forecast_a[-1] * 2

    # 21. CRITICAL TEST — MODEL FITTING (True fit and predict calls)
    def test_critical_model_fitting(self):
        """
        Verifies that HistGradientBoostingRegressor actually calls fit(X, y)
        and learns tree parameters rather than using a static arithmetic proxy.
        """
        series = [50.0, 60.0, 80.0, 110.0, 150.0, 200.0, 260.0, 330.0, 410.0, 500.0]
        X, y, fnames = build_supervised_dataset(series)
        model = HistGradientBoostingModel(min_samples_leaf=1)

        assert not model.is_fitted
        model.fit(np.array(series), X, y, fnames)
        assert model.is_fitted

        # Verify underlying sklearn estimator was fitted
        assert hasattr(model.model, "_predictors") or hasattr(model.model, "n_iter_")
        assert model.model.n_features_in_ == X.shape[1]

        extractor = make_future_step_feature_extractor("2026-11")
        preds, meta = model.predict_multistep(horizon=3, feature_extractor_fn=extractor)
        assert len(preds) == 3
        assert preds[0] > 0

    # 22. CRITICAL TEST — NO RANDOM TIME SHUFFLING
    def test_critical_no_time_shuffling(self):
        """
        Verify that training pairs (X, y) preserve chronological ordering.
        Target at index row i must correspond strictly to series[i + max_lag].
        """
        series = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0]
        X, y, fnames = build_supervised_dataset(series)

        # Confirm target vector strictly matches the end of the chronological series
        # E.g. last target must equal the last element of series
        assert y[-1] == series[-1]
        assert y[-2] == series[-2]
        # Targets must be monotonically increasing matching series
        for i in range(len(y) - 1):
            assert y[i] < y[i + 1]
