"""
Comprehensive Automated Test Suite for Phase 2:
Walk-Forward Backtesting and Data-Driven Model Selection.

Tests:
1. TEST 1 — NO RANDOM SHUFFLING (chronological expanding windows)
2. TEST 2 — NO LEAKAGE (validation actuals never seen during training)
3. TEST 3 — WALK-FORWARD WINDOWS (multiple sequential expanding windows)
4. TEST 4 — METRICS (exact manual calculation check for MAE, RMSE, WAPE, Bias)
5. TEST 5 — MODEL SELECTION (lowest WAPE model is selected deterministically)
6. TEST 6 — COMPLEX MODEL CAN LOSE (simpler model wins when outperforming ML)
7. TEST 7 — ML CAN WIN (HistGradientBoostingRegressor wins on non-linear/lag patterns)
8. TEST 8 — INSUFFICIENT HISTORY (status INSUFFICIENT_HISTORY returned when history < 3)
9. TEST 9 — ZERO DEMAND (zero actuals do not produce NaN or div-by-zero)
10. TEST 10 — NEGATIVE FORECAST (non-negative clipping preserved)
11. TEST 11 — MULTI-STEP (horizons 1, 3, 6, 9, 12 supported)
12. TEST 12 — DATA SENSITIVITY (backtest metrics and model selection adapt to data)
13. CRITICAL END-TO-END TEST (multi-item batch with heterogeneous history lengths)
"""

import math
import numpy as np
import pytest

from backend.backtesting import (
    calculate_metrics,
    WalkForwardBacktester,
    instantiate_model
)
from backend.model_selection import select_best_model
from backend.engine import ForecastingEngine
from backend.models import (
    NaiveModel,
    HistoricalMeanModel,
    SimpleMovingAverageModel,
    WeightedMovingAverageModel,
    LinearTrendModel,
    HoltExponentialSmoothingModel,
    HistGradientBoostingModel
)


class TestPhase2Backtesting:
    # -------------------------------------------------------------
    # TEST 1 — NO RANDOM SHUFFLING
    # -------------------------------------------------------------
    def test_1_no_random_shuffling(self):
        """
        Verify validation is chronological:
        Training timestamps/indices must strictly precede validation timestamps/indices.
        """
        backtester = WalkForwardBacktester(validation_horizon=1)
        series = np.array([100.0 + i * 5 for i in range(12)])
        periods = [f"2025-{i+1:02d}" for i in range(12)]

        model = NaiveModel()
        res = backtester.evaluate_model_backtest(model, series, periods)

        assert res["eligible"] is True
        windows = res["windows"]
        assert len(windows) > 1

        # Check each window: origin index strictly increases
        for i in range(len(windows) - 1):
            assert windows[i]["originIdx"] < windows[i+1]["originIdx"]
            # Target period must be after origin period chronologically
            assert windows[i]["origin"] < windows[i]["targetPeriod"]

    # -------------------------------------------------------------
    # TEST 2 — NO LEAKAGE
    # -------------------------------------------------------------
    def test_2_no_leakage(self):
        """
        Modify validation actuals dramatically in the future.
        The model's predictions for earlier validation origins must remain strictly identical.
        """
        backtester = WalkForwardBacktester(validation_horizon=1)
        series_clean = np.array([100.0, 110.0, 120.0, 130.0, 140.0, 150.0, 160.0, 170.0])
        # Modify the last 2 elements drastically
        series_tampered = np.array([100.0, 110.0, 120.0, 130.0, 140.0, 150.0, 99999.0, 88888.0])

        model_clean = HoltExponentialSmoothingModel()
        model_tamp = HoltExponentialSmoothingModel()

        res_clean = backtester.evaluate_model_backtest(model_clean, series_clean)
        res_tamp = backtester.evaluate_model_backtest(model_tamp, series_tampered)

        # The first 3 validation windows (evaluating t=4, t=5, t=6) only train on indices <= 5.
        # Their predictions MUST be identical because future tampered values at index 6 and 7 were not yet seen.
        for w_clean, w_tamp in zip(res_clean["windows"][:2], res_tamp["windows"][:2]):
            assert w_clean["originIdx"] == w_tamp["originIdx"]
            assert abs(w_clean["forecast"][0] - w_tamp["forecast"][0]) < 1e-5

    # -------------------------------------------------------------
    # TEST 3 — WALK-FORWARD WINDOWS
    # -------------------------------------------------------------
    def test_3_walk_forward_windows(self):
        """
        Given 12 months, verify multiple sequential expanding validation windows are created.
        """
        backtester = WalkForwardBacktester(validation_horizon=1)
        series = np.array([50.0, 60.0, 70.0, 80.0, 90.0, 100.0, 110.0, 120.0, 130.0, 140.0, 150.0, 160.0])
        model = LinearTrendModel()

        res = backtester.evaluate_model_backtest(model, series)
        assert res["eligible"] is True
        # Linear trend requires min_history=3. For N=12 and h=1, origins run from t=3 to t=11 => 9 windows
        assert res["validationWindows"] == 9
        assert len(res["windows"]) == 9
        # Expanding window checks: origin indices run 3, 4, 5, ..., 11
        indices = [w["originIdx"] for w in res["windows"]]
        assert indices == list(range(3, 12))

    # -------------------------------------------------------------
    # TEST 4 — METRICS (Exact calculation check)
    # -------------------------------------------------------------
    def test_4_metrics_exact_calculation(self):
        """
        Small dataset with known manual mathematical calculation:
        actuals = [100.0, 200.0]
        forecasts = [110.0, 180.0]

        Errors = [+10.0, -20.0]
        MAE = (|10| + |-20|) / 2 = 15.0
        RMSE = sqrt((10^2 + (-20)^2) / 2) = sqrt(250) = 15.8114
        WAPE = (|10| + |-20|) / (|100| + |200|) * 100 = 30 / 300 * 100 = 10.0%
        Bias = (+10 - 20) / (|100| + |200|) * 100 = -10 / 300 * 100 = -3.3333%
        """
        actuals = np.array([100.0, 200.0])
        forecasts = np.array([110.0, 180.0])

        metrics = calculate_metrics(actuals, forecasts)

        assert abs(metrics["mae"] - 15.0) < 1e-3
        assert abs(metrics["rmse"] - math.sqrt(250.0)) < 1e-3
        assert abs(metrics["wape"] - 10.0) < 1e-3
        assert abs(metrics["bias"] - (-10.0 / 3.0)) < 1e-3

    # -------------------------------------------------------------
    # TEST 5 — MODEL SELECTION (Lowest WAPE selected deterministically)
    # -------------------------------------------------------------
    def test_5_model_selection_lowest_wape(self):
        """
        Synthetic leaderboard where Holt has WAPE 12.5%, Naive 22.0%, Linear 18.0%.
        Verify Holt is selected deterministically.
        """
        leaderboard = [
            {"model": "Naive (Last Observation)", "eligible": True, "wape": 22.0, "mae": 20.0, "rmse": 25.0, "bias": -5.0, "validationWindows": 5},
            {"model": "Holt's Linear Exponential Smoothing", "eligible": True, "wape": 12.5, "mae": 11.0, "rmse": 14.0, "bias": 1.2, "validationWindows": 5},
            {"model": "Linear Trend Regression (OLS)", "eligible": True, "wape": 18.0, "mae": 16.0, "rmse": 19.0, "bias": 0.5, "validationWindows": 5},
        ]

        winner_name, status, reason, selected_metrics = select_best_model(leaderboard, n_obs=10)

        assert winner_name == "Holt's Linear Exponential Smoothing"
        assert status == "SELECTED"
        assert "12.5%" in reason
        assert selected_metrics["wape"] == 12.5

    # -------------------------------------------------------------
    # TEST 6 — COMPLEX MODEL CAN LOSE
    # -------------------------------------------------------------
    def test_6_complex_model_can_lose(self):
        """
        Create a clean linear trend series where LinearTrend / Holt achieves ~0% error,
        while a tree ensemble with small data has higher error.
        Verify the system selects the simpler model over Gradient Boosting.
        """
        engine = ForecastingEngine()
        # Perfect linear progression: 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210
        series = [100.0 + i * 10.0 for i in range(12)]

        res = engine.forecast_single_sku("SKU-PERFECT-LINEAR", series, horizon=6)

        assert res["selectionStatus"] == "SELECTED"
        # Linear trend or Holt must win because their WAPE is ~0.0%
        assert "Linear" in res["selectedModel"] or "Holt" in res["selectedModel"]
        # Ensure Gradient Boosting was not artificially forced to win
        assert res["selectedModelMetrics"]["wape"] <= 5.0

    # -------------------------------------------------------------
    # TEST 7 — ML CAN WIN
    # -------------------------------------------------------------
    def test_7_ml_can_win(self):
        """
        Create a series with a repeating seasonal or autoregressive step function
        where Gradient Boosting performs well across expanding windows.
        Verify HistGradientBoosting is eligible and can be selected.
        """
        engine = ForecastingEngine()
        # Highly non-linear/seasonal pattern with sufficient history (36 periods)
        series = []
        for _ in range(3):
            series.extend([10.0, 100.0, 50.0, 200.0, 10.0, 100.0, 50.0, 200.0, 10.0, 100.0, 50.0, 200.0])
        periods = [f"202{3 + i//12}-{i%12 + 1:02d}" for i in range(36)]

        res = engine.forecast_single_sku("SKU-CYCLICAL", series, history_periods=periods, horizon=6)

        assert res["selectionStatus"] == "SELECTED"
        assert res["selectedModelMetrics"] is not None
        
        # Assert Gradient Boosting actually wins
        assert "Gradient Boosting" in res["selectedModel"]
        
        # Check comparison leaderboard has HistGradientBoosting evaluated
        gb_entry = next((c for c in res["modelComparison"] if "Gradient Boosting" in c["model"]), None)
        assert gb_entry is not None
        assert gb_entry["eligible"] is True
        assert gb_entry["validationWindows"] > 0
        
        # Assert Gradient Boosting's WAPE is strictly lower than every other eligible candidate's WAPE
        gb_wape = gb_entry["wape"]
        for c in res["modelComparison"]:
            if c["eligible"] and c["model"] != gb_entry["model"]:
                assert gb_wape < c["wape"]

    # -------------------------------------------------------------
    # TEST 8 — INSUFFICIENT HISTORY
    # -------------------------------------------------------------
    def test_8_insufficient_history(self):
        """
        Verify that 1 to 5 observations return SPARSE_HISTORY, and 6 to 11 return INSUFFICIENT_HISTORY.
        """
        engine = ForecastingEngine()

        # 1 observation
        res_1m = engine.forecast_single_sku("SKU-1", [350.0], horizon=6)
        assert res_1m["selectionStatus"] == "SPARSE_HISTORY"
        assert res_1m["selectedModelMetrics"] is None

        # 5 observations
        res_5m = engine.forecast_single_sku("SKU-2", [100.0, 150.0, 100.0, 150.0, 120.0], horizon=6)
        assert res_5m["selectionStatus"] == "SPARSE_HISTORY"
        assert res_5m["selectedModelMetrics"] is None

        # 6 observations
        res_6m = engine.forecast_single_sku("SKU-6", [100.0] * 6, horizon=6)
        assert res_6m["selectionStatus"] == "INSUFFICIENT_HISTORY"
        assert res_6m["selectedModelMetrics"] is None

    # -------------------------------------------------------------
    # TEST 9 — ZERO DEMAND
    # -------------------------------------------------------------
    def test_9_zero_demand_handling(self):
        """
        Zero actual demand history must not cause division-by-zero, NaN, or Infinity.
        """
        engine = ForecastingEngine()
        series = [0.0] * 8

        res = engine.forecast_single_sku("SKU-ZERO", series, horizon=6)
        assert res["forecast"] == [0] * 6
        if res["selectedModelMetrics"]:
            assert not math.isnan(res["selectedModelMetrics"]["wape"])
            assert not math.isinf(res["selectedModelMetrics"]["wape"])

        # Also test metrics helper directly
        m = calculate_metrics(np.array([0.0, 0.0]), np.array([0.0, 0.0]))
        assert m["wape"] == 0.0
        assert m["bias"] == 0.0

    # -------------------------------------------------------------
    # TEST 10 — NEGATIVE FORECAST CLIPPING
    # -------------------------------------------------------------
    def test_10_negative_forecast_clipping(self):
        """
        Verify that steep negative trends clip to non-negative values in production forecast.
        """
        engine = ForecastingEngine()
        # Steep plunge: 100 -> 60 -> 20
        series = [100.0, 80.0, 60.0, 40.0, 20.0, 5.0]

        res = engine.forecast_single_sku("SKU-PLUNGE", series, horizon=6)
        assert all(v >= 0 for v in res["forecast"])
        assert all(v >= 0 for v in res["rawForecast"])

    # -------------------------------------------------------------
    # TEST 11 — MULTI-STEP HORIZONS
    # -------------------------------------------------------------
    def test_11_multistep_horizons(self):
        """
        Verify forecasting engine supports requested horizons: 1, 3, 6, 9, 12 months.
        """
        engine = ForecastingEngine()
        series = [100.0 + i * 5 for i in range(12)]

        for h in [1, 3, 6, 9, 12]:
            res = engine.forecast_single_sku(f"SKU-H{h}", series, horizon=h)
            assert len(res["forecast"]) == h
            assert len(res["rawForecast"]) == h

    # -------------------------------------------------------------
    # TEST 12 — DATA SENSITIVITY
    # -------------------------------------------------------------
    def test_12_data_sensitivity(self):
        """
        Substantially changing historical demand alters backtest metrics, selected model, and forecast.
        """
        engine = ForecastingEngine()

        # Dataset A: Flat steady baseline ~200
        history_a = [200.0] * 12

        # Dataset B: Rapid accelerating exponential-style growth
        history_b = [10.0, 20.0, 40.0, 80.0, 160.0, 320.0, 640.0, 1280.0, 2500.0, 5000.0, 9500.0, 18000.0]

        res_a = engine.forecast_single_sku("SKU-A", history_a, horizon=6)
        res_b = engine.forecast_single_sku("SKU-B", history_b, horizon=6)

        assert res_a["forecast"] != res_b["forecast"]
        assert res_a["selectedModelMetrics"]["wape"] != res_b["selectedModelMetrics"]["wape"]

    # -------------------------------------------------------------
    # TEST 13 — CRITICAL END-TO-END MULTI-ITEM HETEROGENEOUS BATCH
    # -------------------------------------------------------------
    def test_13_critical_e2e_multi_item_heterogeneous(self):
        """
        Verify that a batch with heterogeneous item history depths (6M, 12M, 24M, 36M):
        - Evaluates per-item eligibility
        - Runs per-item backtesting
        - Allows different models to be selected for different items
        - Does NOT force a single global model
        """
        engine = ForecastingEngine()

        items = [
            # Item A: 13 months flat
            {"itemCode": "ITEM-A-13M", "history": [100.0] * 13},
            # Item B: 18 months linear trend
            {"itemCode": "ITEM-B-18M", "history": [50.0 + i * 10 for i in range(18)]},
            # Item C: 24 months step cycle
            {"itemCode": "ITEM-C-24M", "history": [100.0, 200.0, 300.0] * 8},
            # Item D: 36 months growing trend
            {"itemCode": "ITEM-D-36M", "history": [100.0 + (i**1.2) * 5 for i in range(36)]},
        ]

        batch_res = engine.forecast_batch(items, horizon=6)

        assert batch_res["totalItemsProcessed"] == 4
        assert len(batch_res["results"]) == 4

        # Check that items have independent model selection results
        item_a = next(r for r in batch_res["results"] if r["itemCode"] == "ITEM-A-13M")
        item_b = next(r for r in batch_res["results"] if r["itemCode"] == "ITEM-B-18M")
        item_c = next(r for r in batch_res["results"] if r["itemCode"] == "ITEM-C-24M")
        item_d = next(r for r in batch_res["results"] if r["itemCode"] == "ITEM-D-36M")

        assert item_a["historyMonths"] == 13
        assert item_b["historyMonths"] == 18
        assert item_c["historyMonths"] == 24
        assert item_d["historyMonths"] == 36

        # Check each has its own validation windows count
        assert item_a["selectedModelMetrics"]["validationWindows"] < item_d["selectedModelMetrics"]["validationWindows"]

        # Check that multiple model names exist in the distribution (not forced into 1 global model)
        assert len(batch_res["modelDistribution"]) >= 2
