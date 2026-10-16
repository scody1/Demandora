import pytest
from fastapi.testclient import TestClient
from backend.main import app
from backend.engine import ForecastingEngine

client = TestClient(app)


def test_forecast_single_sku_enriched_contract():
    engine = ForecastingEngine(use_cache=False)
    # 24 months of steady demand
    history = [100.0] * 24
    periods = [f"2024-{m:02d}" for m in range(1, 13)] + [f"2025-{m:02d}" for m in range(1, 13)]

    res = engine.forecast_single_sku(
        item_code="STEADY-SKU",
        history_values=history,
        history_periods=periods,
        horizon=3,
        start_month="2026-01"
    )

    assert "lifecycle_regime" in res
    assert "lifecycleRegime" in res
    assert "momentum_flag" in res
    assert "momentumFlag" in res
    assert "procurement_heuristics" in res
    assert "heuristicAdvisories" in res
    assert res["lifecycle_regime"] == "STABLE_STATIONARY"
    assert res["momentum_flag"] == "NEUTRAL"
    assert res["procurement_heuristics"]["buffer_modifier_pct"] == -10.0
    assert any("lean" in adv.lower() or "stability" in adv.lower() for adv in res["heuristicAdvisories"])


def test_discontinued_sku_heuristics():
    engine = ForecastingEngine(use_cache=False)
    history = [50.0] * 12
    periods = [f"2025-{m:02d}" for m in range(1, 13)]

    res = engine.forecast_single_sku(
        item_code="DISC-SKU",
        history_values=history,
        history_periods=periods,
        horizon=3,
        start_month="2026-01",
        is_discontinued=True
    )

    assert res["lifecycle_regime"] == "CONTRACTION_PHASE_OUT"
    assert res["momentum_flag"] == "NEGATIVE"
    assert res["forecast"] == [0.0, 0.0, 0.0]
    assert res["procurement_heuristics"]["buffer_modifier_pct"] == -100.0
    assert res["procurement_heuristics"]["order_cap"] == 0.0


def test_growth_surge_heuristics():
    engine = ForecastingEngine(use_cache=False)
    # 12 months at 100, then 12 months ramping up to 250
    history = [100.0] * 12 + [110.0 + i * 12.0 for i in range(12)]
    periods = [f"2024-{m:02d}" for m in range(1, 13)] + [f"2025-{m:02d}" for m in range(1, 13)]

    res = engine.forecast_single_sku(
        item_code="SURGE-SKU",
        history_values=history,
        history_periods=periods,
        horizon=3,
        start_month="2026-01"
    )

    assert res["lifecycle_regime"] == "SUSTAINED_GROWTH_RAMP"
    assert res["momentum_flag"] == "SURGE"
    assert res["procurement_heuristics"]["buffer_modifier_pct"] in (10.0, 20.0)
    assert any("growth" in adv.lower() or "buffer" in adv.lower() for adv in res["heuristicAdvisories"])


def test_api_procurement_schedule_endpoint():
    payload = {
        "startMonth": "2026-06-01",
        "leadTimeDays": 45,
        "referenceDate": "2026-04-01"
    }
    resp = client.post("/api/procurement/schedule", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["requirementStartDate"] == "2026-06-01"
    assert data["leadTimeDays"] == 45
    assert data["latestOrderDate"] == "2026-04-17"
    assert data["daysUntilOrderDeadline"] == 16
    assert data["isOverdue"] is False
    assert data["urgency"] == "NORMAL"
