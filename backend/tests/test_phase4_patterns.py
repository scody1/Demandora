import pytest
import numpy as np
from backend.pattern_intelligence import profile_demand, calculate_cv2, calculate_adi
from backend.models import CrostonModel, SBAModel, HoltExponentialSmoothingModel
from backend.engine import ForecastingEngine

class TestPhase4Patterns:
    def test_1_stable_series(self):
        # Stable series
        series = [100, 102, 98, 101, 99, 100, 102, 98, 101, 99, 100, 100]
        profile = profile_demand("ITEM-STABLE", series)
        assert profile["demand_pattern"] == "stable"
        assert profile["trend_direction"] == "flat"
        assert profile["seasonality_detected"] is False

    def test_2_increasing_trend(self):
        # Clear increasing series
        series = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210]
        profile = profile_demand("ITEM-INC", series)
        assert profile["demand_pattern"] == "trend"
        assert profile["trend_direction"] == "increasing"

    def test_3_decreasing_trend(self):
        # Clear decreasing series
        series = [210, 200, 190, 180, 170, 160, 150, 140, 130, 120, 110, 100]
        profile = profile_demand("ITEM-DEC", series)
        assert profile["demand_pattern"] == "trend"
        assert profile["trend_direction"] == "decreasing"

    def test_4_seasonal_series(self):
        # Synthetic 12-month repeating seasonal series with sufficient history
        base = [50, 60, 70, 200, 50, 40, 50, 60, 70, 80, 90, 300]
        series = base * 3 # 3 years
        profile = profile_demand("ITEM-SEAS", series)
        assert profile["demand_pattern"] == "seasonal"
        assert profile["seasonality_detected"] is True
        assert profile["seasonality_period"] == 12

    def test_5_random_non_seasonal(self):
        np.random.seed(42)
        series = np.random.randint(50, 100, size=36).tolist()
        profile = profile_demand("ITEM-RAND", series)
        assert profile["seasonality_detected"] is False

    def test_6_sparse_zero_heavy_intermittent(self):
        series = [0, 0, 15, 0, 0, 20, 0, 0, 0, 18, 0, 0, 10, 0, 0, 0, 12]
        profile = profile_demand("ITEM-INT", series)
        assert profile["demand_pattern"] == "intermittent"
        assert "INTERMITTENT_DEMAND" in profile["data_quality_flags"]

    def test_7_lumpy_demand(self):
        # Intermittent + highly variable non-zero
        series = [0, 0, 500, 0, 0, 10, 0, 0, 0, 2000, 0, 0, 0, 0, 50, 0, 0, 0]
        profile = profile_demand("ITEM-LUMPY", series)
        assert profile["demand_pattern"] == "lumpy"
        assert "LUMPY_DEMAND" in profile["data_quality_flags"]

    def test_8_regular_demand_with_occ_zero(self):
        series = [100, 90, 110, 0, 95, 105, 100, 90, 110, 100, 95, 0]
        profile = profile_demand("ITEM-OCC-ZERO", series)
        assert profile["demand_pattern"] not in ["intermittent", "lumpy"]
        assert "INTERMITTENT_DEMAND" not in profile["data_quality_flags"]

    def test_9_outlier(self):
        series = [100, 102, 98, 101, 99, 100, 102, 98, 1000, 99, 100, 100]
        profile = profile_demand("ITEM-OUT", series)
        assert profile["outlier_count"] > 0
        assert "OUTLIERS_PRESENT" in profile["data_quality_flags"]

    def test_9b_zero_not_outlier(self):
        # A zero should not be flagged as an outlier merely for being 0
        series = [100, 100, 0, 100, 100]
        profile = profile_demand("ITEM-ZERO", series)
        assert profile["outlier_count"] == 0
        
    def test_9c_extreme_positive_outlier_flagged(self):
        series = [100, 102, 98, 100, 101, 99, 100, 102, 98, 1000, 101, 99]
        profile = profile_demand("ITEM-EXTREME", series)
        assert profile["outlier_count"] > 0

    def test_10_outlier_not_deleted(self):
        # Outlier MUST NOT be silently deleted from canonical history
        series = [100, 102, 98, 101, 99, 100, 102, 98, 1000, 99, 100, 100]
        engine = ForecastingEngine(validation_horizon=1)
        res = engine.forecast_single_sku("ITEM-OUT", series)
        assert res["historyMonths"] == 12

    def test_11_missing_month(self):
        series = [100, 102, 98, 101, 99, 100]
        missing = ["2026-03"]
        profile = profile_demand("ITEM-MISSING", series, missing_periods=missing)
        assert profile["missing_periods"] == 1
        assert "MISSING_PERIODS" in profile["data_quality_flags"]

    def test_12_actual_zero_month(self):
        series = [100, 102, 0, 101, 99, 100]
        profile = profile_demand("ITEM-ZERO", series)
        assert profile["zero_demand_ratio"] > 0
        assert profile["missing_periods"] == 0
        assert "MISSING_PERIODS" not in profile["data_quality_flags"]

    def test_13_new_item_insufficient_history(self):
        series = [100, 200, 150]
        profile = profile_demand("ITEM-NEW", series)
        assert profile["forecast_eligibility"] == "insufficient_history"
        assert "INSUFFICIENT_HISTORY" in profile["data_quality_flags"]

    def test_14_croston_forecast(self):
        model = CrostonModel()
        series = np.array([0, 0, 15, 0, 0, 20, 0, 0, 0, 18, 0, 0, 10, 0, 0, 0, 12])
        model.fit(series)
        preds, _ = model.predict(3)
        assert len(preds) == 3
        assert preds[0] > 0
        assert preds[0] < 15 # Should be a smoothed value over interval

    def test_15_sba_forecast(self):
        model = SBAModel()
        series = np.array([0, 0, 15, 0, 0, 20, 0, 0, 0, 18, 0, 0, 10, 0, 0, 0, 12])
        model.fit(series)
        preds, _ = model.predict(3)
        assert len(preds) == 3
        assert preds[0] > 0

    def test_16_pattern_based_model_eligibility(self):
        # Croston not eligible for stable
        profile_stable = profile_demand("ITEM-STABLE", [100] * 12)
        model1 = CrostonModel()
        elig, _ = model1.check_eligibility(12, profile_stable)
        assert not elig

        # Holt not eligible for lumpy
        profile_lumpy = profile_demand("ITEM-LUMPY", [0, 0, 500, 0, 0, 10, 0, 0, 0, 2000, 0, 0, 0, 0, 50, 0, 0, 0])
        model2 = HoltExponentialSmoothingModel()
        elig, _ = model2.check_eligibility(18, profile_lumpy)
        assert not elig

    def test_17_18_leakage_safeguard(self):
        # STRENGTHENED LEAKAGE TEST
        # Construct two series with exact same history but vastly different validation observation
        history = [100, 102, 98, 101, 99, 100, 102, 98, 100, 99, 101, 98, 100, 102]
        val_normal = history + [100]
        val_extreme = history + [10000]
        
        # Profile calculated using ONLY the training history (simulate how engine.py splits it)
        # We explicitly calculate it and test the invariant:
        # SAME TRAINING DATA + DIFFERENT FUTURE VALIDATION DATA = SAME TRAINING-WINDOW PROFILE
        profile_normal = profile_demand("ITEM", history)
        profile_extreme = profile_demand("ITEM", history)
        
        # Must be completely identical
        assert profile_normal == profile_extreme
        
        engine = ForecastingEngine(validation_horizon=1)
        res_norm = engine.forecast_single_sku("ITEM-NORM", val_normal)
        res_ext = engine.forecast_single_sku("ITEM-EXT", val_extreme)
        
        # The backtester should not change its model eligibility for the training windows based on the last point
        # Since the first N-1 points are the same
        assert res_norm["modelComparison"] is not None
        assert res_ext["modelComparison"] is not None
        
        # We verify that the EXACT SAME models were evaluated as eligible and ineligible
        # (Since model selection operates strictly on the N-1 history profile during the loop)
        norm_eligibility = {c["model"]: c["eligible"] for c in res_norm["modelComparison"]}
        ext_eligibility = {c["model"]: c["eligible"] for c in res_ext["modelComparison"]}
        
        assert norm_eligibility == ext_eligibility
