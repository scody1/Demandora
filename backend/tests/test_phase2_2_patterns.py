"""
Unit Tests for Phase 2.2 Demand Pattern Intelligence Evolution:
- YoY Demand Velocity Calculation & Seasonal Normalization
- Operational Directional Momentum Flagging (NEGATIVE, SURGE, NEUTRAL)
- Four-Quadrant Lifecycle Classification (Contraction/Phase-Out, Sustained Growth, Lumpy, Stable)
"""

import pytest
import numpy as np
from backend.pattern_intelligence import (
    calculate_yoy_velocity,
    assign_momentum_flag,
    classify_lifecycle_regime,
    profile_demand
)


class TestPhase22Patterns:
    def test_yoy_velocity_calculation_multi_year(self):
        # 24 months of data: year 1 avg = 100, year 2 avg = 70 (30% drop)
        year1 = [100.0] * 12
        year2 = [70.0] * 12
        series = np.array(year1 + year2, dtype=float)
        
        res = calculate_yoy_velocity(series)
        assert res["yoy_velocity_pct"] is not None
        assert abs(res["yoy_velocity_pct"] - (-30.0)) < 0.5
        assert res["recent_window_months"] == 6

    def test_seasonally_normalized_velocity(self):
        # High seasonal wave with strong autocorrelation
        year1 = [50.0, 60.0, 70.0, 200.0, 50.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 300.0]
        year2 = [55.0, 65.0, 75.0, 210.0, 55.0, 45.0, 55.0, 65.0, 75.0, 85.0, 95.0, 315.0]
        series = np.array(year1 + year2, dtype=float)
        
        # Raw delta vs normalized delta
        raw_res = calculate_yoy_velocity(series, seasonality_detected=False)
        norm_res = calculate_yoy_velocity(series, seasonality_detected=True, seasonality_strength=0.85)
        
        assert raw_res["yoy_velocity_pct"] is not None
        assert norm_res["yoy_velocity_pct"] is not None
        assert norm_res["is_seasonally_normalized"] is True
        # Normalization dampens the raw percentage
        assert abs(norm_res["yoy_velocity_pct"]) <= abs(raw_res["yoy_velocity_pct"])

    def test_directional_momentum_negative_flag(self):
        flag = assign_momentum_flag(velocity_pct=-23.3, normalized_slope=-0.08, r_squared=0.6)
        assert flag == "NEGATIVE"

    def test_directional_momentum_surge_flag(self):
        flag = assign_momentum_flag(velocity_pct=28.5, normalized_slope=0.09, r_squared=0.7)
        assert flag == "SURGE"

    def test_directional_momentum_neutral_flag(self):
        flag = assign_momentum_flag(velocity_pct=3.2, normalized_slope=0.01, r_squared=0.1)
        assert flag == "NEUTRAL"

    def test_contraction_phase_out_classification(self):
        # Clear downward contraction over 24 months
        year1 = [200, 195, 190, 185, 180, 175, 170, 165, 160, 155, 150, 145]
        year2 = [140, 135, 130, 125, 120, 115, 110, 105, 100, 95, 90, 85]
        series = year1 + year2
        
        profile = profile_demand("SKU-CONTRACTION", series)
        assert profile["lifecycle_regime"] == "CONTRACTION_PHASE_OUT"
        assert profile["momentum_flag"] == "NEGATIVE"
        assert profile["yoy_velocity_pct"] < -15.0
        assert "NEGATIVE_VELOCITY" in profile["data_quality_flags"]

    def test_sustained_growth_ramp_classification(self):
        # Clear upward growth over 24 months
        year1 = [100, 105, 110, 115, 120, 125, 130, 135, 140, 145, 150, 155]
        year2 = [160, 168, 175, 182, 190, 198, 205, 215, 225, 235, 245, 260]
        series = year1 + year2
        
        profile = profile_demand("SKU-GROWTH", series)
        assert profile["lifecycle_regime"] == "SUSTAINED_GROWTH_RAMP"
        assert profile["momentum_flag"] == "SURGE"
        assert profile["yoy_velocity_pct"] > 15.0
        assert "SURGE_VELOCITY" in profile["data_quality_flags"]

    def test_intermittent_lumpy_lifecycle_classification(self):
        # High zeros, intermittent
        series = [0, 0, 100, 0, 0, 0, 80, 0, 0, 120, 0, 0, 0, 90, 0, 0, 0, 110]
        profile = profile_demand("SKU-LUMPY", series)
        assert profile["lifecycle_regime"] == "INTERMITTENT_LUMPY"

    def test_stable_stationary_lifecycle_classification(self):
        # Stationary series hovering around 100
        series = [100, 102, 99, 101, 98, 100, 101, 99, 102, 100, 99, 101,
                  100, 101, 99, 100, 102, 98, 101, 100, 99, 101, 100, 100]
        profile = profile_demand("SKU-STABLE", series)
        assert profile["lifecycle_regime"] == "STABLE_STATIONARY"
        assert profile["momentum_flag"] == "NEUTRAL"

    def test_insufficient_history_lifecycle_fallback(self):
        # 3 months of history
        series = [2376.0, 1615.0, 2425.0]
        profile = profile_demand("SKU-STRANGER", series)
        assert profile["lifecycle_regime"] == "INSUFFICIENT_HISTORY"
        assert profile["momentum_flag"] == "NEUTRAL"
        assert profile["yoy_velocity_pct"] is None
