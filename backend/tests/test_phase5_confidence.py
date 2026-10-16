import pytest
import numpy as np
from typing import Dict, Any

from backend.engine import ForecastingEngine
from backend.models import HistGradientBoostingModel, NaiveModel
from backend.backtesting import calculate_metrics

class DummyBacktestModel:
    def __init__(self, eligible: bool = True, wape: float = 10.0, bias: float = 0.0, valid_windows: int = 5, horizon_errors: Dict[int, list] = None):
        self.eligible = eligible
        self.wape = wape
        self.bias = bias
        self.valid_windows = valid_windows
        if horizon_errors is None:
            horizon_errors = {
                1: [-5.0, 2.0, 3.0, -1.0, 0.0],
                2: [-8.0, 5.0, 6.0, -2.0, 1.0]
            }
        self.horizon_errors = horizon_errors

    def to_dict(self):
        return {
            "model": "DUMMY_MODEL",
            "modelType": "dummy",
            "eligible": self.eligible,
            "wape": self.wape,
            "bias": self.bias,
            "validWindows": self.valid_windows,
            "horizon_errors": self.horizon_errors
        }


def test_1_4_5_deterministic_intervals_and_levels():
    engine = ForecastingEngine()
    dummy = DummyBacktestModel(
        horizon_errors={
            1: [-10.0, -5.0, 0.0, 5.0, 10.0]
        }
    )
    # 90% confidence -> alpha = 0.1 -> 5th and 95th percentiles
    # For [-10, -5, 0, 5, 10], 5th = -9.0, 95th = 9.0 (approx based on np.percentile)
    conf_90 = engine.calculate_confidence_and_intervals(
        point_forecasts=[100.0],
        winner_name="DUMMY_MODEL",
        backtest_results=[dummy.to_dict()],
        confidence_level=0.90
    )
    
    assert conf_90["status"] == "EVALUATED"
    assert len(conf_90["lowerBound"]) == 1
    assert conf_90["lowerBound"][0] < 100.0
    assert conf_90["upperBound"][0] > 100.0
    
    # 95% confidence -> alpha = 0.05 -> 2.5th and 97.5th percentiles
    conf_95 = engine.calculate_confidence_and_intervals(
        point_forecasts=[100.0],
        winner_name="DUMMY_MODEL",
        backtest_results=[dummy.to_dict()],
        confidence_level=0.95
    )
    
    # 95% interval should be wider than 90%
    width_90 = conf_90["upperBound"][0] - conf_90["lowerBound"][0]
    width_95 = conf_95["upperBound"][0] - conf_95["lowerBound"][0]
    assert width_95 > width_90


def test_2_3_residual_dispersion_affects_width():
    engine = ForecastingEngine()
    
    # Narrow errors
    dummy_narrow = DummyBacktestModel(horizon_errors={1: [-1, 0, 1, 0, -1]})
    conf_narrow = engine.calculate_confidence_and_intervals(
        point_forecasts=[100.0], winner_name="DUMMY_MODEL", backtest_results=[dummy_narrow.to_dict()]
    )
    width_narrow = conf_narrow["upperBound"][0] - conf_narrow["lowerBound"][0]
    
    # Wide errors
    dummy_wide = DummyBacktestModel(horizon_errors={1: [-100, 0, 100, 0, -100]})
    conf_wide = engine.calculate_confidence_and_intervals(
        point_forecasts=[100.0], winner_name="DUMMY_MODEL", backtest_results=[dummy_wide.to_dict()]
    )
    width_wide = conf_wide["upperBound"][0] - conf_wide["lowerBound"][0]
    
    assert width_wide > width_narrow


def test_6_insufficient_validation():
    engine = ForecastingEngine()
    # Less than 3 valid errors
    dummy = DummyBacktestModel(horizon_errors={1: [5.0]})
    conf = engine.calculate_confidence_and_intervals(
        point_forecasts=[100.0], winner_name="DUMMY_MODEL", backtest_results=[dummy.to_dict()]
    )
    assert conf["status"] == "NOT_EVALUATED"


def test_7_negative_lower_bound_clipped():
    engine = ForecastingEngine()
    dummy = DummyBacktestModel(horizon_errors={1: [-200, -150, -100, 0, 100]})
    conf = engine.calculate_confidence_and_intervals(
        point_forecasts=[50.0], winner_name="DUMMY_MODEL", backtest_results=[dummy.to_dict()]
    )
    # The true lower bound would be 50 - something > 100, which is negative.
    # Should be clipped to 0.
    assert conf["lowerBound"][0] == 0.0


def test_property_a_worse_wape_lowers_reliability():
    engine = ForecastingEngine()
    good_wape = engine.calculate_confidence_and_intervals([100.0], "DUMMY_MODEL", [DummyBacktestModel(wape=5.0, bias=0.0).to_dict()])
    bad_wape = engine.calculate_confidence_and_intervals([100.0], "DUMMY_MODEL", [DummyBacktestModel(wape=25.0, bias=0.0).to_dict()])
    assert good_wape["score"] > bad_wape["score"]

def test_property_b_worse_bias_lowers_reliability():
    engine = ForecastingEngine()
    good_bias = engine.calculate_confidence_and_intervals([100.0], "DUMMY_MODEL", [DummyBacktestModel(wape=10.0, bias=2.0).to_dict()])
    bad_bias = engine.calculate_confidence_and_intervals([100.0], "DUMMY_MODEL", [DummyBacktestModel(wape=10.0, bias=15.0).to_dict()])
    assert good_bias["score"] > bad_bias["score"]

def test_property_c_wider_interval_lowers_reliability():
    engine = ForecastingEngine()
    # Mocking interval is trickier because it depends on all_errors. We can mock errors to produce different quantiles.
    model_narrow = DummyBacktestModel(wape=10.0, bias=0.0)
    # 5 windows, small errors
    model_narrow.horizon_errors = {1: [-1, 1, 0, -2, 2]} 
    
    model_wide = DummyBacktestModel(wape=10.0, bias=0.0)
    # 5 windows, huge errors (high dispersion)
    model_wide.horizon_errors = {1: [-50, 50, 0, -40, 40]}
    
    narrow_res = engine.calculate_confidence_and_intervals([100.0], "DUMMY_MODEL", [model_narrow.to_dict()])
    wide_res = engine.calculate_confidence_and_intervals([100.0], "DUMMY_MODEL", [model_wide.to_dict()])
    
    assert narrow_res["score"] > wide_res["score"]

def test_property_h_reliability_not_just_100_minus_wape():
    engine = ForecastingEngine()
    res = engine.calculate_confidence_and_intervals([100.0], "DUMMY_MODEL", [DummyBacktestModel(wape=10.0, bias=0.0).to_dict()])
    # With WAPE=10, old score would be exactly 90 (or 92 with +2 bonus).
    # New score uses geometric mean, so it should not equal 100 - wape.
    assert res["score"] != (100.0 - 10.0)

def test_property_j_insufficient_validation():
    engine = ForecastingEngine()
    # Only 2 validation windows
    model = DummyBacktestModel(wape=10.0, bias=0.0, valid_windows=2)
    model.horizon_errors = {1: [5, -5]}
    res = engine.calculate_confidence_and_intervals([100.0], "DUMMY_MODEL", [model.to_dict()])
    assert res["status"] == "NOT_EVALUATED"
    assert res["level"] == "NOT_EVALUATED"
    assert res["lowerBound"][0] is None
    assert res["upperBound"][0] is None

def test_property_k_intervals_unchanged():
    engine = ForecastingEngine()
    model = DummyBacktestModel(wape=10.0, bias=0.0)
    model.horizon_errors = {1: [-10, 10, -5, 5, 0]}
    res = engine.calculate_confidence_and_intervals([100.0], "DUMMY_MODEL", [model.to_dict()])
    # empirical interval: 5th pctile of [-10, -5, 0, 5, 10] is -9.0
    # 95th pctile is 9.0
    assert abs(res["lowerBound"][0] - 91.0) < 0.1
    assert abs(res["upperBound"][0] - 109.0) < 0.1

def test_engine_integration_confidence():
    engine = ForecastingEngine()
    history = [100, 110, 105, 115, 120, 105, 110, 130, 125, 135, 140, 130, 140, 150]
    res = engine.forecast_single_sku("TEST", history)
    
    assert "confidence" in res
    conf = res["confidence"]
    assert conf["status"] in ["EVALUATED", "NOT_EVALUATED"]
    assert len(conf["lowerBound"]) == 6  # default horizon is 6
    assert conf["lowerBound"][0] >= 0

def test_engine_fallback_less_than_6m():
    engine = ForecastingEngine(validation_horizon=1)
    res = engine.forecast_single_sku("TEST", [10, 20])
    
    assert res["selectionStatus"] == "SPARSE_HISTORY"
    assert res["confidence"]["status"] == "NOT_EVALUATED"

    # Test 6-11M gives INSUFFICIENT_HISTORY
    res_6m = engine.forecast_single_sku("TEST", [10, 20, 30, 40, 50, 60])
    assert res_6m["selectionStatus"] == "INSUFFICIENT_HISTORY"
    assert res_6m["confidence"]["status"] == "NOT_EVALUATED"
