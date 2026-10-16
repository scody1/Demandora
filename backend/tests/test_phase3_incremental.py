import pytest
from backend.main import BatchItem
from backend.engine import ForecastingEngine

class TestPhase3Incremental:
    """
    Test suite for Phase 3 - Incremental Data Learning
    Validating that the stateless backend properly recalculates features,
    re-evaluates models, and generates updated forecasts when the canonical
    history changes (simulating the frontend sending an updated dataset).
    """
    
    def test_11_no_forecast_as_actual(self):
        """
        Verify forecast values are never inserted into historical actual demand.
        The backend engine only receives historical actuals in the `history` array.
        It generates a forecast, which is returned in the `forecast` array.
        The engine itself does not persist forecasts into actuals.
        """
        history = [10, 20, 30, 40, 50, 60]
        engine = ForecastingEngine()
        result = engine.forecast_single_sku(item_code="ITEM_1", history_values=history, history_periods=["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"], horizon=6, start_month="2026-07")
        
        # Verify forecast length
        assert len(result["forecast"]) == 6
        # Verify actuals were not mutated to include forecast
        assert len(history) == 6
        assert history == [10, 20, 30, 40, 50, 60]
        
    def test_12_model_reevaluation(self):
        """
        Generate forecast with initial history.
        Add meaningful new actual months.
        Verify model-selection/backtest pipeline runs again and can select a different model.
        """
        # Initial: Highly periodic data
        initial_history = [10.0, 100.0, 50.0, 200.0] * 6 # 24 months
        engine1 = ForecastingEngine()
        result1 = engine1.forecast_single_sku(
            item_code="ITEM_1",
            history_values=initial_history,
            history_periods=[f"2024-{i:02d}" if i <= 12 else f"2025-{i-12:02d}" for i in range(1, 25)],
            horizon=6, start_month="2026-01"
        )
        
        # Model for highly non-linear data should be HistGradientBoostingRegressor
        assert "Gradient Boosting" in result1["modelName"]
        
        # Update: Make the data completely flat for the next 12 months (correction/new data)
        updated_history = initial_history + [50.0] * 12
        engine2 = ForecastingEngine()
        result2 = engine2.forecast_single_sku(
            item_code="ITEM_1",
            history_values=updated_history,
            history_periods=[f"2024-{i:02d}" if i <= 12 else (f"2025-{i-12:02d}" if i <= 24 else f"2026-{i-24:02d}") for i in range(1, 37)],
            horizon=6, start_month="2027-01"
        )
        
        # The selected model might change, but more importantly, the backtest WAPE should be different
        assert result1["selectedModelMetrics"]["wape"] != result2["selectedModelMetrics"]["wape"]
        assert result1["selectedModel"] != result2["selectedModel"] or result1["forecast"] != result2["forecast"]
        
    def test_13_forecast_changes(self):
        """
        Initial dataset: low demand.
        Updated dataset: substantially higher demand.
        Expected: future forecast changes.
        """
        engine1 = ForecastingEngine()
        res1 = engine1.forecast_single_sku(item_code="ITEM_1", history_values=[10]*24, history_periods=[f"M{i}" for i in range(24)], horizon=6, start_month="2026-01")
        
        engine2 = ForecastingEngine()
        res2 = engine2.forecast_single_sku(item_code="ITEM_1", history_values=[1000]*24, history_periods=[f"M{i}" for i in range(24)], horizon=6, start_month="2026-01")
        
        assert sum(res1["forecast"]) < sum(res2["forecast"])

    def test_14_correction_propagation(self):
        """
        Change an old historical value substantially.
        Verify features change OR backtest metrics change OR selected model changes OR future forecast changes.
        """
        history1 = [100.0] * 24
        engine1 = ForecastingEngine()
        res1 = engine1.forecast_single_sku(item_code="ITEM_1", history_values=history1, history_periods=[f"M{i}" for i in range(24)], horizon=6, start_month="2026-01")
        
        # Substantial correction in the middle
        history2 = [100.0] * 24
        history2[12] = 9000.0
        engine2 = ForecastingEngine()
        res2 = engine2.forecast_single_sku(item_code="ITEM_1", history_values=history2, history_periods=[f"M{i}" for i in range(24)], horizon=6, start_month="2026-01")
        
        assert res1["selectedModelMetrics"]["wape"] != res2["selectedModelMetrics"]["wape"]
        assert res1["forecast"] != res2["forecast"]

    def test_15_unchanged_data(self):
        """
        Upload same logical dataset.
        Expected: no historical change.
        No unnecessary model re-selection is required (handled by frontend avoiding API calls or backend being deterministic).
        Testing determinism here.
        """
        history = [50.0] * 24
        engine1 = ForecastingEngine()
        res1 = engine1.forecast_single_sku(item_code="ITEM_1", history_values=history, history_periods=[f"M{i}" for i in range(24)], horizon=6, start_month="2026-01")
        
        engine2 = ForecastingEngine()
        res2 = engine2.forecast_single_sku(item_code="ITEM_1", history_values=history, history_periods=[f"M{i}" for i in range(24)], horizon=6, start_month="2026-01")
        
        assert res1["modelName"] == res2["modelName"]
        assert res1["selectedModelMetrics"]["wape"] == res2["selectedModelMetrics"]["wape"]
        assert res1["forecast"] == res2["forecast"]
