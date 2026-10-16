"""
Unit Tests for Phase 2.2 Procurement Heuristics & Lead-Time Scheduling Engine.
"""

import pytest
from backend.heuristics import (
    evaluate_procurement_heuristics,
    calculate_procurement_schedule
)


class TestPhase22Heuristics:
    def test_contraction_positive_bias_throttling(self):
        res = evaluate_procurement_heuristics(
            lifecycle_regime="CONTRACTION_PHASE_OUT",
            momentum_flag="NEGATIVE",
            selected_model_metrics={"bias": 12.5, "wape": 18.0}
        )
        assert res["lifecycleRegime"] == "CONTRACTION_PHASE_OUT"
        assert res["netBufferAdjustmentPct"] == -25.0
        assert res["orderCapMultiplier"] == 1.10
        assert len(res["policyActions"]) == 1
        assert res["policyActions"][0]["ruleId"] == "POL-CAPITAL-01"
        assert res["policyActions"][0]["severity"] == "WARNING"

    def test_contraction_negative_bias(self):
        res = evaluate_procurement_heuristics(
            lifecycle_regime="CONTRACTION_PHASE_OUT",
            momentum_flag="NEGATIVE",
            selected_model_metrics={"bias": -5.0, "wape": 16.0}
        )
        assert res["netBufferAdjustmentPct"] == -15.0
        assert res["orderCapMultiplier"] == 1.20
        assert res["policyActions"][0]["ruleId"] == "POL-CAPITAL-02"

    def test_growth_negative_bias_expansion(self):
        res = evaluate_procurement_heuristics(
            lifecycle_regime="SUSTAINED_GROWTH_RAMP",
            momentum_flag="SURGE",
            selected_model_metrics={"bias": -15.0, "wape": 12.0}
        )
        assert res["lifecycleRegime"] == "SUSTAINED_GROWTH_RAMP"
        assert res["netBufferAdjustmentPct"] == 20.0
        assert res["policyActions"][0]["ruleId"] == "POL-STOCKOUT-01"
        assert res["policyActions"][0]["severity"] == "OPPORTUNITY"

    def test_growth_positive_bias(self):
        res = evaluate_procurement_heuristics(
            lifecycle_regime="SUSTAINED_GROWTH_RAMP",
            momentum_flag="SURGE",
            selected_model_metrics={"bias": 8.0, "wape": 14.0}
        )
        assert res["netBufferAdjustmentPct"] == 10.0
        assert res["policyActions"][0]["ruleId"] == "POL-STOCKOUT-02"

    def test_stable_high_accuracy_buffer(self):
        res = evaluate_procurement_heuristics(
            lifecycle_regime="STABLE_STATIONARY",
            momentum_flag="NEUTRAL",
            selected_model_metrics={"bias": 1.0, "wape": 9.5}
        )
        assert res["netBufferAdjustmentPct"] == -10.0
        assert res["orderCapMultiplier"] == 1.30
        assert res["policyActions"][0]["ruleId"] == "POL-STABLE-01"

    def test_lumpy_policy(self):
        res = evaluate_procurement_heuristics(
            lifecycle_regime="INTERMITTENT_LUMPY",
            momentum_flag="NEUTRAL"
        )
        assert res["policyActions"][0]["ruleId"] == "POL-LUMPY-01"
        assert res["netBufferAdjustmentPct"] == 0.0

    def test_latest_order_date_calculation(self):
        # Requirement on 2026-11-01 with 30 days lead time -> Latest order date: 2026-10-02
        sched = calculate_procurement_schedule(
            start_month="2026-11",
            lead_time_days=30,
            reference_date="2026-10-01"
        )
        assert sched["requirementStartDate"] == "2026-11-01"
        assert sched["latestOrderDate"] == "2026-10-02"
        assert sched["daysUntilOrderDeadline"] == 1
        assert sched["isOverdue"] is False
        assert sched["urgency"] == "IMMINENT"

    def test_overdue_procurement_detection(self):
        # Reference date is 2026-10-15; order deadline was 2026-10-02 -> Overdue by 13 days
        sched = calculate_procurement_schedule(
            start_month="2026-11",
            lead_time_days=30,
            reference_date="2026-10-15"
        )
        assert sched["isOverdue"] is True
        assert sched["urgency"] == "OVERDUE"
        assert sched["daysUntilOrderDeadline"] == -13

    def test_missing_lead_time_fallback(self):
        sched = calculate_procurement_schedule(
            start_month="2026-11",
            lead_time_days=None
        )
        assert sched["urgency"] == "NO_LEAD_TIME"
        assert sched["isOverdue"] is False
        assert sched["latestOrderDate"] is None
