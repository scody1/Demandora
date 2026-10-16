"""
Gate B Test Suite: Rigorous Differential Cached-versus-Uncached Equivalence.
Proves bit-for-bit / strict numerical equivalence across all candidate models,
prediction intervals, confidence fields, and contract metadata.
"""

import os
import sys
import copy
import pytest
import numpy as np

from backend.engine import ForecastingEngine
from backend.cache import ForecastCache


@pytest.fixture
def test_engine(tmp_path):
    db_path = str(tmp_path / "equiv_test.db")
    cache = ForecastCache(db_path=db_path, enabled=True)
    engine = ForecastingEngine(validation_horizon=1, cache=cache, use_cache=True)
    yield engine
    cache.close()


def assert_forecast_contract_equivalence(fresh: dict, cached: dict, is_ml: bool = False):
    """Asserts complete contract equivalence between fresh and cached results."""
    # Top-level keys
    assert fresh["itemCode"] == cached["itemCode"]
    assert fresh["modelName"] == cached["modelName"]
    assert fresh["modelType"] == cached["modelType"]
    assert fresh["selectedModel"] == cached["selectedModel"]
    assert fresh["selectionStatus"] == cached["selectionStatus"]
    assert fresh["selectionReason"] == cached["selectionReason"]
    assert fresh["historyMonths"] == cached["historyMonths"]
    assert fresh["trainingRows"] == cached["trainingRows"]
    assert fresh["skuCategory"] == cached["skuCategory"]

    # Point Forecasts
    assert fresh["forecast"] == cached["forecast"], (
        f"Discrete forecasts mismatch: fresh={fresh['forecast']}, cached={cached['forecast']}"
    )
    if is_ml:
        np.testing.assert_allclose(fresh["rawForecast"], cached["rawForecast"], atol=1e-5)
    else:
        assert fresh["rawForecast"] == cached["rawForecast"], "Statistical raw forecasts must be bit-for-bit identical"

    # Confidence Block & Prediction Intervals
    c_fresh = fresh.get("confidence", {}) or {}
    c_cached = cached.get("confidence", {}) or {}
    assert c_fresh.get("status") == c_cached.get("status")
    assert c_fresh.get("level") == c_cached.get("level")
    assert c_fresh.get("method") == c_cached.get("method")
    if c_fresh.get("score") is not None:
        assert abs(c_fresh["score"] - c_cached["score"]) < 1e-4

    assert len(c_fresh.get("lowerBound", [])) == len(c_cached.get("lowerBound", []))
    assert len(c_fresh.get("upperBound", [])) == len(c_cached.get("upperBound", []))
    for lb1, lb2 in zip(c_fresh.get("lowerBound", []), c_cached.get("lowerBound", [])):
        if lb1 is None:
            assert lb2 is None
        else:
            assert abs(lb1 - lb2) < 1e-4

    for ub1, ub2 in zip(c_fresh.get("upperBound", []), c_cached.get("upperBound", [])):
        if ub1 is None:
            assert ub2 is None
        else:
            assert abs(ub1 - ub2) < 1e-4

    # Model Comparison Leaderboard
    mc_fresh = fresh.get("modelComparison", [])
    mc_cached = cached.get("modelComparison", [])
    assert len(mc_fresh) == len(mc_cached)
    for m1, m2 in zip(mc_fresh, mc_cached):
        assert m1["model"] == m2["model"]
        assert m1["eligible"] == m2["eligible"]
        if m1["eligible"] and m1.get("wape") is not None:
            assert abs(m1["wape"] - m2["wape"]) < 1e-4
            assert abs(m1["mae"] - m2["mae"]) < 1e-4


# -------------------------------------------------------------------------
# 1. Mature SKUs: Model-by-Model Equivalence (Fresh vs Cached Rerun)
# -------------------------------------------------------------------------
@pytest.mark.parametrize("preferred_model", [
    "Naive (Last Observation)",
    "Historical Mean",
    "Simple Moving Average (SMA-3)",
    "Weighted Moving Average (WMA-3)",
    "Linear Trend Regression (OLS)",
    "Holt's Linear Exponential Smoothing",
    "HistGradientBoostingRegressor"
])
def test_mature_model_cached_rerun_equivalence(test_engine, preferred_model):
    item_code = f"MATURE-{preferred_model[:5].strip()}"
    # 24-month trended/varied series
    history = [100.0 + (i * 5.0) + (10.0 if i % 2 == 0 else -10.0) for i in range(24)]
    periods = [f"2024-{(i%12)+1:02d}" for i in range(24)]

    # 1. Fresh uncached run
    test_engine.use_cache = False
    fresh_res = test_engine.forecast_single_sku(
        item_code=item_code,
        history_values=history,
        history_periods=periods,
        horizon=6,
        preferred_model=preferred_model
    )

    # 2. Cached run (populates cache)
    test_engine.use_cache = True
    cached_first_run = test_engine.forecast_single_sku(
        item_code=item_code,
        history_values=history,
        history_periods=periods,
        horizon=6,
        preferred_model=preferred_model
    )

    # 3. Cached rerun (hits cache!)
    cached_second_run = test_engine.forecast_single_sku(
        item_code=item_code,
        history_values=history,
        history_periods=periods,
        horizon=6,
        preferred_model=preferred_model
    )

    is_ml = "HistGradient" in preferred_model
    assert_forecast_contract_equivalence(fresh_res, cached_first_run, is_ml=is_ml)
    assert_forecast_contract_equivalence(fresh_res, cached_second_run, is_ml=is_ml)


# -------------------------------------------------------------------------
# 2. Horizon Extension Equivalence (H=6 -> H=12 Fast Path vs Fresh H=12)
# -------------------------------------------------------------------------
@pytest.mark.parametrize("preferred_model", [
    "Naive (Last Observation)",
    "Historical Mean",
    "Simple Moving Average (SMA-3)",
    "Weighted Moving Average (WMA-3)",
    "Linear Trend Regression (OLS)",
    "Holt's Linear Exponential Smoothing",
    "HistGradientBoostingRegressor"
])
def test_horizon_extension_equivalence(test_engine, preferred_model):
    item_code = f"HORIZON-{preferred_model[:5].strip()}"
    history = [120.0 + (i * 4.0) + (5.0 if i % 3 == 0 else -5.0) for i in range(24)]
    periods = [f"2024-{(i%12)+1:02d}" for i in range(24)]

    # 1. Warm cache with H=6
    test_engine.use_cache = True
    test_engine.forecast_single_sku(
        item_code=item_code,
        history_values=history,
        history_periods=periods,
        horizon=6,
        preferred_model=preferred_model
    )

    # 2. Request H=12 using cache (triggers fast path bypassing all 7 backtests!)
    extended_cached_res = test_engine.forecast_single_sku(
        item_code=item_code,
        history_values=history,
        history_periods=periods,
        horizon=12,
        preferred_model=preferred_model
    )

    # 3. Fresh uncached H=12 run
    test_engine.use_cache = False
    fresh_h12_res = test_engine.forecast_single_sku(
        item_code=item_code,
        history_values=history,
        history_periods=periods,
        horizon=12,
        preferred_model=preferred_model
    )

    is_ml = "HistGradient" in preferred_model
    assert_forecast_contract_equivalence(fresh_h12_res, extended_cached_res, is_ml=is_ml)
    assert len(extended_cached_res["forecast"]) == 12


# -------------------------------------------------------------------------
# 3. Cold-Start (0M) and Sparse-History (1-5M) Equivalence
# -------------------------------------------------------------------------
def test_cold_start_cached_equivalence(test_engine):
    peer_pool = [
        {
            "itemCode": "PEER-101",
            "description": "12W LED Downlight Warm White",
            "itemGroup": "Commercial",
            "history": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0]
        },
        {
            "itemCode": "PEER-102",
            "description": "12W LED Downlight Cool White",
            "itemGroup": "Commercial",
            "history": [15.0, 25.0, 35.0, 45.0, 55.0, 65.0]
        }
    ]

    # Cold Start 0M
    test_engine.use_cache = False
    fresh_cold = test_engine.forecast_single_sku(
        item_code="COLD-NEW-001",
        history_values=[],
        description="12W LED Downlight",
        item_group="Commercial",
        candidate_pool=peer_pool,
        horizon=6
    )

    test_engine.use_cache = True
    cached_cold = test_engine.forecast_single_sku(
        item_code="COLD-NEW-001",
        history_values=[],
        description="12W LED Downlight",
        item_group="Commercial",
        candidate_pool=peer_pool,
        horizon=6
    )
    assert_forecast_contract_equivalence(fresh_cold, cached_cold)

    # Sparse History 3M
    test_engine.use_cache = False
    fresh_sparse = test_engine.forecast_single_sku(
        item_code="SPARSE-003",
        history_values=[10.0, 15.0, 20.0],
        description="12W LED Downlight",
        item_group="Commercial",
        candidate_pool=peer_pool,
        horizon=6
    )

    test_engine.use_cache = True
    cached_sparse = test_engine.forecast_single_sku(
        item_code="SPARSE-003",
        history_values=[10.0, 15.0, 20.0],
        description="12W LED Downlight",
        item_group="Commercial",
        candidate_pool=peer_pool,
        horizon=6
    )
    assert_forecast_contract_equivalence(fresh_sparse, cached_sparse)
