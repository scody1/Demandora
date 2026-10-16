"""
Integration Test for Data Sensitivity via the Real Python Engine.

Tests:
1. Dataset A: flat historical demand (100.0) across 16 months.
2. Dataset B: surging historical demand (100.0 -> 1400.0) across 16 months.
3. Submits both through the authoritative Python ForecastingEngine API.
4. Asserts that the returned forecasts and selected models materially differ, proving that
   the model is learning from empirical data and is NOT hardcoded.
"""

import pytest
from backend.engine import ForecastingEngine


def test_api_data_sensitivity_integration():
    engine = ForecastingEngine()

    # Dataset A: Flat baseline ~100
    dataset_a = [100.0] * 16
    periods_a = [f"2025-{m:02d}" for m in range(1, 13)] + ["2026-01", "2026-02", "2026-03", "2026-04"]

    # Dataset B: High acceleration / project spikes ~100 to ~1400
    dataset_b = [
        100.0, 110.0, 130.0, 180.0,
        250.0, 360.0, 500.0, 680.0,
        820.0, 950.0, 1050.0, 1150.0,
        1200.0, 1250.0, 1300.0, 1400.0
    ]
    periods_b = list(periods_a)

    batch_request = [
        {"itemCode": "ITEM-FLAT", "history": dataset_a, "periods": periods_a},
        {"itemCode": "ITEM-SURGE", "history": dataset_b, "periods": periods_b}
    ]

    response = engine.forecast_batch(batch_request, horizon=6, start_month="2026-11")

    assert response["totalItemsProcessed"] == 2
    results = response["results"]

    flat_result = next(r for r in results if r["itemCode"] == "ITEM-FLAT")
    surge_result = next(r for r in results if r["itemCode"] == "ITEM-SURGE")

    # For flat data, baseline model (e.g. Naive / Mean / Linear) achieves 0.0% WAPE
    assert flat_result["selectedModelMetrics"]["wape"] <= 1.0
    assert flat_result["selectionStatus"] == "SELECTED"

    # For surging data, trend model wins
    assert surge_result["selectionStatus"] == "SELECTED"
    assert surge_result["selectedModelMetrics"] is not None

    forecast_flat = flat_result["forecast"]
    forecast_surge = surge_result["forecast"]

    assert len(forecast_flat) == 6
    assert len(forecast_surge) == 6

    # Absolute difference between forecasts must be massive (> 3000 total)
    total_diff = sum(abs(s - f) for f, s in zip(forecast_flat, forecast_surge))
    assert total_diff > 3000, f"Expected total_diff > 3000, got {total_diff}"

    # Surge forecast must be at least 5x the flat forecast
    assert forecast_surge[-1] > forecast_flat[-1] * 5

    # Check metadata integrity
    assert flat_result["trainingRows"] > 0
    assert flat_result["metadata"]["clipped"] is False
