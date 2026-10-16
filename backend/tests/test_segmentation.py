"""
Unit & Integration Tests for Demand-Based SKU Segmentation (Runner, Repeater, Stranger).
"""

import time
import pytest
from fastapi.testclient import TestClient
from backend.main import app, jobs
from backend.segmentation import (
    calculate_segmentation_metrics,
    classify_sku,
    segment_sku_population,
    DEFAULT_SEGMENTATION_CONFIG
)


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_jobs_state():
    jobs.clear()
    yield
    jobs.clear()


def test_metrics_calculation_empty_and_zero():
    m_empty = calculate_segmentation_metrics([])
    assert m_empty["history_length"] == 0
    assert m_empty["active_months"] == 0
    assert m_empty["zero_demand_ratio"] == 1.0

    m_zero = calculate_segmentation_metrics([0, 0, 0, 0, 0, 0])
    assert m_zero["history_length"] == 6
    assert m_zero["active_months"] == 0
    assert m_zero["zero_demand_ratio"] == 1.0
    assert m_zero["total_demand"] == 0.0


def test_runner_classification_criteria():
    # Stable, continuous demand: ADI = 1.0, CV2 very small, active ratio 100%
    stable_history = [100.0, 105.0, 98.0, 102.0, 100.0, 103.0, 99.0, 101.0, 104.0, 97.0, 100.0, 102.0]
    res = classify_sku("SKU_RUNNER_1", stable_history)

    assert res["category"] == "RUNNER"
    assert res["adi"] <= 1.32
    assert res["cvSquared"] <= 0.49
    assert res["activeMonths"] == 12
    assert res["demandFrequency"] == 100.0
    assert "Frequent and consistent demand" in res["classificationReason"]
    assert "ADI = 1.00" in res["classificationReason"]


def test_repeater_erratic_classification():
    # Frequent orders (ADI <= 1.32) but highly variable volume (CV2 > 0.49)
    erratic_history = [20.0, 500.0, 30.0, 800.0, 15.0, 600.0, 25.0, 950.0, 40.0, 700.0, 30.0, 850.0]
    res = classify_sku("SKU_REPEATER_ERRATIC", erratic_history)

    assert res["category"] == "REPEATER"
    assert res["adi"] <= 1.32
    assert res["cvSquared"] > 0.49
    assert "Frequent but erratic demand" in res["classificationReason"]


def test_repeater_intermittent_regular_classification():
    # Intermittent spacing (ADI > 1.32) but consistent lot sizing (CV2 <= 0.49)
    # Order every 2 months with approx 100 units
    intermittent_history = [100.0, 0.0, 105.0, 0.0, 98.0, 0.0, 102.0, 0.0, 100.0, 0.0, 97.0, 0.0]
    res = classify_sku("SKU_REPEATER_INTERMITTENT", intermittent_history)

    assert res["category"] == "REPEATER"
    assert res["adi"] > 1.32
    assert res["cvSquared"] <= 0.49
    assert "Intermittent recurring demand" in res["classificationReason"]


def test_stranger_insufficient_history():
    # Short history (< 6 months) -> Stranger
    short_history = [100.0, 120.0, 110.0]
    res = classify_sku("SKU_STRANGER_SHORT", short_history)

    assert res["category"] == "STRANGER"
    assert res["historyLength"] == 3
    assert "Insufficient historical maturity" in res["classificationReason"]


def test_stranger_lumpy_pattern():
    # Infrequent (ADI > 1.32) AND wildly volatile quantity (CV2 > 0.49)
    # 3 active months out of 12, with values 10, 2500, 50
    lumpy_history = [0.0, 10.0, 0.0, 0.0, 2500.0, 0.0, 0.0, 0.0, 50.0, 0.0, 0.0, 0.0]
    res = classify_sku("SKU_STRANGER_LUMPY", lumpy_history)

    assert res["category"] == "STRANGER"
    assert (res["adi"] > 1.32 and res["cvSquared"] > 0.49) or res["zeroDemandMonths"] / 12 >= 0.70
    assert "STRANGER" == res["category"]


def test_unclassified_zero_demand():
    # All zeros
    res = classify_sku("SKU_DEAD", [0.0] * 12)
    assert res["category"] == "UNCLASSIFIED"
    assert "Zero recorded historical demand" in res["classificationReason"]


def test_population_segmentation_collectively_exhaustive():
    items = [
        {"itemCode": "SKU_RUNNER", "history": [100, 105, 98, 102, 100, 103, 99, 101, 104, 97, 100, 102]},
        {"itemCode": "SKU_REPEATER", "history": [100, 0, 105, 0, 98, 0, 102, 0, 100, 0, 97, 0]},
        {"itemCode": "SKU_STRANGER_1", "history": [100, 120]},
        {"itemCode": "SKU_STRANGER_2", "history": [0, 0, 0, 5000, 0, 0, 0, 0, 0, 0, 0, 0]},
        {"itemCode": "SKU_UNCLASSIFIED", "history": [0, 0, 0, 0, 0, 0]}
    ]

    summary = segment_sku_population(items)
    assert summary["totalSKUs"] == 5
    assert len(summary["items"]) == 5

    categories = [it["category"] for it in summary["items"]]
    assert categories.count("RUNNER") == 1
    assert categories.count("REPEATER") == 1
    assert categories.count("STRANGER") == 2
    assert categories.count("UNCLASSIFIED") == 1

    # Check mutually exclusive counts
    sum_counts = (
        summary["summary"]["RUNNER"]["count"]
        + summary["summary"]["REPEATER"]["count"]
        + summary["summary"]["STRANGER"]["count"]
        + summary["summary"]["UNCLASSIFIED"]["count"]
    )
    assert sum_counts == 5

    # Check illustrative examples
    assert summary["summary"]["RUNNER"]["illustrativeSku"] is not None
    assert summary["summary"]["REPEATER"]["illustrativeSku"] is not None
    assert summary["summary"]["STRANGER"]["illustrativeSku"] is not None


def test_segmentation_api_endpoint():
    payload = {
        "items": [
            {"itemCode": "RUN_01", "history": [50] * 12},
            {"itemCode": "REP_01", "history": [50, 0] * 6},
            {"itemCode": "STR_01", "history": [50, 60]}
        ]
    }
    resp = client.post("/api/forecast/segmentation", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert "summary" in data
    assert data["summary"]["RUNNER"]["count"] == 1
    assert data["summary"]["REPEATER"]["count"] == 1
    assert data["summary"]["STRANGER"]["count"] == 1


def test_scope_validation_in_job_creation():
    # Only RUNNER requested
    valid_payload = {
        "items": [
            {"itemCode": "RUN_01", "history": [50] * 12}
        ],
        "allowedCategories": ["RUNNER"]
    }
    resp = client.post("/api/forecast/jobs", json=valid_payload)
    assert resp.status_code == 200
    job_id = resp.json()["jobId"]

    # Now attempt to send a REPEATER item under RUNNER-only scope
    invalid_payload = {
        "items": [
            {"itemCode": "RUN_01", "history": [50] * 12},
            {"itemCode": "REP_01", "history": [100, 0, 100, 0, 100, 0, 100, 0, 100, 0, 100, 0]}
        ],
        "allowedCategories": ["RUNNER"]
    }
    resp_invalid = client.post("/api/forecast/jobs", json=invalid_payload)
    assert resp_invalid.status_code == 400
    assert "Scope violation" in resp_invalid.json()["detail"]


def test_boundary_adi_threshold():
    # Exact ADI = 1.32 (33 / 25 = 1.32)
    history_exact = [100.0]
    for _ in range(17):
        history_exact.append(100.0)
    for _ in range(8):
        history_exact.extend([0.0, 100.0])

    res_exact = classify_sku("SKU_ADI_EXACT", history_exact)
    assert res_exact["category"] == "RUNNER"
    assert "ADI = 1.32 <= 1.32" in res_exact["classificationReason"]

    # Unrounded ADI = 1.324 (331 / 250 = 1.324)
    history_1324 = [100.0]
    for _ in range(249):
        history_1324.append(100.0)
    for _ in range(81):
        history_1324.append(0.0)
    history_1324.append(100.0)

    res_1324 = classify_sku("SKU_ADI_1324", history_1324)
    # Must NOT be RUNNER; unrounded comparison 1.324 > 1.32 routes to REPEATER
    assert res_1324["category"] == "REPEATER"
    assert "ADI = 1.324 > 1.32" in res_1324["classificationReason"]


def test_boundary_cv2_threshold():
    # CV² <= 0.49
    delta_low = 67.0
    history_low = [
        100.0 - delta_low, 100.0 + delta_low, 100.0 - delta_low, 100.0 + delta_low,
        100.0 - delta_low, 100.0 + delta_low, 100.0 - delta_low, 100.0 + delta_low,
        100.0 - delta_low, 100.0 + delta_low, 100.0 - delta_low, 100.0 + delta_low
    ]
    res_low = classify_sku("SKU_CV2_LOW", history_low)
    assert res_low["category"] == "RUNNER"

    # CV² = 0.4904 > 0.49
    delta_high = 67.047247
    history_high = [
        100.0 - delta_high, 100.0 + delta_high, 100.0 - delta_high, 100.0 + delta_high,
        100.0 - delta_high, 100.0 + delta_high, 100.0 - delta_high, 100.0 + delta_high,
        100.0 - delta_high, 100.0 + delta_high, 100.0 - delta_high, 100.0 + delta_high
    ]
    res_high = classify_sku("SKU_CV2_HIGH", history_high)
    assert res_high["category"] == "REPEATER"
    assert "CV² = 0.4904 > 0.49" in res_high["classificationReason"]


def test_empty_history_cold_start_classification_and_routing():
    # 1. 0M history classifies as STRANGER cold-start candidate
    res = classify_sku("SKU_NEW_COLD", [], description="12W Downlight WW", item_group="Downlight")
    assert res["category"] == "STRANGER"
    assert res["historyLength"] == 0
    assert "Zero observed historical periods (0M history)" in res["classificationReason"]
    assert "routes to cold-start peer discovery" in res["classificationReason"]

    # 2. Can pass through STRANGER forecast scope validation
    payload = {
        "items": [
            {"itemCode": "SKU_NEW_COLD", "description": "12W Downlight WW", "itemGroup": "Downlight", "history": []}
        ],
        "allowedCategories": ["STRANGER"]
    }
    resp = client.post("/api/forecast/jobs", json=payload)
    assert resp.status_code == 200

    # 3. Backend engine routes empty history to COLD_START with mature peer baseline
    from backend.engine import ForecastingEngine
    engine = ForecastingEngine()
    candidate_pool = [
        {"itemCode": "PEER_01", "description": "12W Downlight CW", "itemGroup": "Downlight", "history": [100.0] * 12}
    ]
    forecast_res = engine.forecast_single_sku(
        item_code="SKU_NEW_COLD",
        history_values=[],
        candidate_pool=candidate_pool,
        description="12W Downlight WW",
        item_group="Downlight",
        horizon=6
    )
    assert forecast_res["selectionStatus"] == "COLD_START"
    assert forecast_res["skuCategory"] == "STRANGER"
    assert forecast_res["historyMonths"] == 0
    assert len(forecast_res["forecast"]) == 6
    assert forecast_res["confidence"]["status"] == "NOT_EVALUATED"
    assert forecast_res["confidence"]["lowerBound"] == [None] * 6
    assert forecast_res["confidence"]["upperBound"] == [None] * 6


def test_observed_all_zero_history_remains_unclassified_and_excluded():
    # Observed periods with zero demand (e.g. 6 months of 0.0)
    res = classify_sku("SKU_INACTIVE", [0.0] * 6, description="Old Inactive Item", item_group="General")
    assert res["category"] == "UNCLASSIFIED"
    assert "Zero recorded historical demand across all 6 observed month(s)" in res["classificationReason"]

    # Attempting to send under STRANGER scope is rejected by backend
    payload = {
        "items": [
            {"itemCode": "SKU_INACTIVE", "description": "Old Inactive Item", "itemGroup": "General", "history": [0.0] * 6}
        ],
        "allowedCategories": ["STRANGER"]
    }
    resp = client.post("/api/forecast/jobs", json=payload)
    assert resp.status_code == 400
    assert "Scope violation" in resp.json()["detail"]


def test_history_depth_spectrum_preserved():
    from backend.engine import ForecastingEngine
    engine = ForecastingEngine()
    candidate_pool = [
        {"itemCode": "MATURE_PEER", "description": "12W Spotlight", "itemGroup": "Spotlight", "history": [100.0] * 12}
    ]

    # 1-5M Sparse history
    sparse_res = engine.forecast_single_sku(
        item_code="SPARSE_SKU",
        history_values=[100.0, 110.0, 105.0],
        candidate_pool=candidate_pool,
        description="12W Spotlight",
        item_group="Spotlight",
        horizon=6
    )
    assert sparse_res["selectionStatus"] == "SPARSE_HISTORY"
    assert sparse_res["skuCategory"] == "STRANGER"

    # 6-11M Insufficient history for walk-forward
    short_res = engine.forecast_single_sku(
        item_code="SHORT_SKU",
        history_values=[100.0] * 8,
        candidate_pool=candidate_pool,
        description="12W Spotlight",
        item_group="Spotlight",
        horizon=6
    )
    assert short_res["selectionStatus"] == "INSUFFICIENT_HISTORY"
    assert short_res["modelName"] == "No AI Forecast"

    # 12-23M Normal walk-forward evaluated
    normal_res = engine.forecast_single_sku(
        item_code="NORMAL_SKU",
        history_values=[100.0 + (i % 5) for i in range(16)],
        candidate_pool=candidate_pool,
        description="12W Spotlight",
        item_group="Spotlight",
        horizon=6
    )
    assert normal_res["selectionStatus"] == "SELECTED"
    assert normal_res["modelName"] != "No AI Forecast"


def test_scenario_a_category_only_stranger_cold_start_api_job():
    """
    Scenario A:
    - Target: a 0M STRANGER SKU.
    - Candidate context: a mature 12M RUNNER SKU with matching attributes.
    - Selected categories: STRANGER only.
    - Verify the target receives COLD_START using the mature peer.
    - Verify only the target appears in forecast results.
    - Verify totalItems = 1.
    """
    target_0m = {
        "itemCode": "COLD_DOWNLIGHT_WW",
        "description": "12W Downlight WW",
        "itemGroup": "Downlight",
        "history": []
    }
    mature_runner_peer = {
        "itemCode": "RUNNER_DOWNLIGHT_CW",
        "description": "12W Downlight CW",
        "itemGroup": "Downlight",
        "history": [250.0] * 12
    }

    payload = {
        "items": [target_0m],
        "candidatePool": [mature_runner_peer, target_0m],
        "allowedCategories": ["STRANGER"],
        "horizon": 6
    }

    # 1. API Batch test
    resp_batch = client.post("/api/forecast/batch", json=payload)
    assert resp_batch.status_code == 200
    batch_res = resp_batch.json()

    assert batch_res["totalItemsProcessed"] == 1
    assert len(batch_res["results"]) == 1
    r_cold = batch_res["results"][0]
    assert r_cold["itemCode"] == "COLD_DOWNLIGHT_WW"
    assert r_cold["selectionStatus"] == "COLD_START"
    assert r_cold["skuCategory"] == "STRANGER"
    assert r_cold["historyMonths"] == 0
    assert r_cold["forecast"] == [250, 250, 250, 250, 250, 250]
    assert "RUNNER_DOWNLIGHT_CW" in r_cold["metadata"]["peer_skus"]

    # Verify only target appears in results
    forecasted_skus = [r["itemCode"] for r in batch_res["results"]]
    assert forecasted_skus == ["COLD_DOWNLIGHT_WW"]
    assert "RUNNER_DOWNLIGHT_CW" not in forecasted_skus

    # 2. API Background Job test
    jobs.clear()
    resp_job = client.post("/api/forecast/jobs", json=payload)
    assert resp_job.status_code == 200
    job_id = resp_job.json()["jobId"]

    # Verify initial job state
    status_resp = client.get(f"/api/forecast/jobs/{job_id}")
    assert status_resp.status_code == 200
    assert status_resp.json()["totalItems"] == 1

    # Poll until job finishes
    for _ in range(50):
        s = client.get(f"/api/forecast/jobs/{job_id}").json()
        if s["status"] in ("COMPLETED", "FAILED"):
            break
        time.sleep(0.05)

    final_status = client.get(f"/api/forecast/jobs/{job_id}").json()
    assert final_status["status"] == "COMPLETED"
    assert final_status["totalItems"] == 1
    assert final_status["completedItems"] == 1
    assert len(final_status["result"]["results"]) == 1
    assert final_status["result"]["results"][0]["itemCode"] == "COLD_DOWNLIGHT_WW"


def test_scenario_b_sparse_history_peer_blend_api_job():
    """
    Scenario B:
    - Target: a 3M STRANGER SKU.
    - Candidate context: a mature comparable SKU.
    - Verify SPARSE_HISTORY remains unchanged.
    - Verify the peer is not forecast.
    """
    target_3m = {
        "itemCode": "SPARSE_DOWNLIGHT_WW",
        "description": "12W Downlight WW",
        "itemGroup": "Downlight",
        "history": [100.0, 110.0, 105.0]  # direct mean = 105.0
    }
    mature_runner_peer = {
        "itemCode": "RUNNER_DOWNLIGHT_CW",
        "description": "12W Downlight CW",
        "itemGroup": "Downlight",
        "history": [250.0] * 12  # peer baseline = 250.0
    }

    payload = {
        "items": [target_3m],
        "candidatePool": [mature_runner_peer, target_3m],
        "allowedCategories": ["STRANGER"],
        "horizon": 6
    }

    resp = client.post("/api/forecast/batch", json=payload)
    assert resp.status_code == 200
    data = resp.json()

    assert data["totalItemsProcessed"] == 1
    assert len(data["results"]) == 1
    res = data["results"][0]
    assert res["itemCode"] == "SPARSE_DOWNLIGHT_WW"
    assert res["selectionStatus"] == "SPARSE_HISTORY"
    assert res["skuCategory"] == "STRANGER"
    # Linear shrinkage: w = 3/6 = 0.5; blended = 0.5 * 105.0 + 0.5 * 250.0 = 177.5 -> 178
    assert res["forecast"] == [178, 178, 178, 178, 178, 178]
    assert "RUNNER_DOWNLIGHT_CW" in res["metadata"]["peer_skus"]

    # Verify peer is not forecast
    codes = [r["itemCode"] for r in data["results"]]
    assert "RUNNER_DOWNLIGHT_CW" not in codes


def test_scenario_c_non_comparable_context_does_not_invent_peer_baseline():
    """
    Scenario C:
    - Target: a 0M SKU.
    - Candidate context: mature but non-comparable SKUs.
    - Verify the engine does not invent a peer baseline.
    """
    target_0m = {
        "itemCode": "FLOOD_50W_OUTDOOR",
        "description": "50W Flood Light Outdoor IP65",
        "itemGroup": "Flood Light",
        "history": []
    }
    non_comparable_peer = {
        "itemCode": "BULB_3W_INDOOR",
        "description": "3W Bulb Indoor E27",
        "itemGroup": "Bulb",
        "history": [800.0] * 12
    }

    payload = {
        "items": [target_0m],
        "candidatePool": [non_comparable_peer, target_0m],
        "allowedCategories": ["STRANGER"],
        "horizon": 6
    }

    resp = client.post("/api/forecast/batch", json=payload)
    assert resp.status_code == 200
    data = resp.json()

    assert data["totalItemsProcessed"] == 1
    res = data["results"][0]
    assert res["itemCode"] == "FLOOD_50W_OUTDOOR"
    assert res["selectionStatus"] == "COLD_START"
    assert res["modelName"] == "Cold Start (No Mature Peers)"
    # Does NOT invent a peer baseline: forecast is all zeros
    assert res["forecast"] == [0, 0, 0, 0, 0, 0]
    assert res["metadata"]["peer_skus"] == []


def test_scenario_d_target_scope_rejection_vs_candidate_pool_acceptance():
    """
    Scenario D:
    - Submit a RUNNER SKU as a target while allowedCategories contains only STRANGER.
    - Verify backend rejects the request.
    - Verify candidatePool-only RUNNER items do not trigger scope rejection.
    """
    runner_sku = {
        "itemCode": "RUN_TARGET_01",
        "description": "Stable Runner Bulb",
        "itemGroup": "Bulb",
        "history": [100.0] * 12
    }
    stranger_0m = {
        "itemCode": "STR_TARGET_01",
        "description": "New Stranger Downlight",
        "itemGroup": "Downlight",
        "history": []
    }

    # 1. RUNNER as target under STRANGER scope -> REJECTED (HTTP 400)
    invalid_payload = {
        "items": [runner_sku],
        "allowedCategories": ["STRANGER"]
    }
    resp_invalid = client.post("/api/forecast/jobs", json=invalid_payload)
    assert resp_invalid.status_code == 400
    assert "Scope violation" in resp_invalid.json()["detail"]

    # 2. RUNNER only in candidatePool under STRANGER scope -> ACCEPTED (HTTP 200)
    valid_payload = {
        "items": [stranger_0m],
        "candidatePool": [runner_sku, stranger_0m],
        "allowedCategories": ["STRANGER"]
    }
    resp_valid = client.post("/api/forecast/jobs", json=valid_payload)
    assert resp_valid.status_code == 200
    assert "jobId" in resp_valid.json()


def test_scenario_e_all_three_categories_selection_preserved():
    """
    Scenario E:
    - Select all three categories.
    - Verify existing category selection and forecast behavior remain unchanged.
    """
    runner_item = {
        "itemCode": "RUN_01",
        "description": "12W Bulb",
        "itemGroup": "Bulb",
        "history": [100.0] * 12
    }
    repeater_item = {
        "itemCode": "REP_01",
        "description": "15W Panel",
        "itemGroup": "Panel Light",
        "history": [100.0, 0.0] * 6
    }
    stranger_item = {
        "itemCode": "STR_01",
        "description": "12W Downlight",
        "itemGroup": "Downlight",
        "history": []
    }

    payload = {
        "items": [runner_item, repeater_item, stranger_item],
        "candidatePool": [runner_item, repeater_item, stranger_item],
        "allowedCategories": ["RUNNER", "REPEATER", "STRANGER"],
        "horizon": 6
    }

    resp = client.post("/api/forecast/batch", json=payload)
    assert resp.status_code == 200
    data = resp.json()

    assert data["totalItemsProcessed"] == 3
    result_codes = [r["itemCode"] for r in data["results"]]
    assert "RUN_01" in result_codes
    assert "REP_01" in result_codes
    assert "STR_01" in result_codes


def test_target_cannot_match_itself_as_own_peer():
    from backend.cold_start import find_comparable_skus
    target = {
        "itemCode": "SELF_SKU_01",
        "description": "20W Batten WW",
        "itemGroup": "Batten",
        "history": [100.0] * 12
    }
    candidate_pool = [
        target,
        {
            "itemCode": "PEER_SKU_02",
            "description": "20W Batten CW",
            "itemGroup": "Batten",
            "history": [120.0] * 12
        }
    ]

    peers = find_comparable_skus(target, candidate_pool, min_history_depth=6)
    peer_codes = [p["itemCode"] for p in peers]
    assert "SELF_SKU_01" not in peer_codes
    assert "PEER_SKU_02" in peer_codes


def test_workload_and_progress_counts_strictly_targets():
    """
    Validate workload and progress:
    - Job total must equal selected target count.
    - Completed count must count only selected targets.
    - Candidate context must not trigger model training or backtesting.
    - Candidate context must not appear as forecast output.
    """
    target = {
        "itemCode": "TARGET_SINGLE",
        "description": "12W Downlight",
        "itemGroup": "Downlight",
        "history": [100.0] * 12
    }
    context_peers = [
        {"itemCode": f"CONTEXT_PEER_{i}", "description": "12W Downlight", "itemGroup": "Downlight", "history": [150.0] * 12}
        for i in range(5)
    ]

    jobs.clear()
    payload = {
        "items": [target],
        "candidatePool": [target] + context_peers,
        "allowedCategories": ["RUNNER"],
        "horizon": 6
    }

    resp = client.post("/api/forecast/jobs", json=payload)
    assert resp.status_code == 200
    job_id = resp.json()["jobId"]

    # Poll until completed
    for _ in range(50):
        s = client.get(f"/api/forecast/jobs/{job_id}").json()
        if s["status"] in ("COMPLETED", "FAILED"):
            break
        time.sleep(0.05)

    final_status = client.get(f"/api/forecast/jobs/{job_id}").json()
    assert final_status["status"] == "COMPLETED"
    assert final_status["totalItems"] == 1
    assert final_status["completedItems"] == 1
    assert len(final_status["result"]["results"]) == 1
    assert final_status["result"]["results"][0]["itemCode"] == "TARGET_SINGLE"
    for cp in context_peers:
        assert cp["itemCode"] not in [r["itemCode"] for r in final_status["result"]["results"]]


def test_discontinued_sku_early_return_and_peer_exclusion():
    """
    TASK 3 Tests:
    - Discontinued SKU returns DISCONTINUED_SKU status without model fitting.
    - Forecast is locked to 0.0 for all horizon steps.
    - History months and demand profile are preserved.
    - Discontinued SKU is excluded from peer candidate pool.
    """
    disc_item = {
        "itemCode": "DISC_SKU_01",
        "description": "Ledure Discontinued Downlight 12W",
        "itemGroup": "Downlight",
        "history": [100.0, 110.0, 105.0, 95.0, 100.0, 105.0, 110.0, 100.0, 95.0, 100.0, 105.0, 100.0],
        "isDiscontinued": True
    }
    active_target_0m = {
        "itemCode": "COLD_TARGET_01",
        "description": "Ledure New Downlight 12W",
        "itemGroup": "Downlight",
        "history": [],
        "isDiscontinued": False
    }

    # Run batch with discontinued SKU and cold target, where discontinued SKU is in pool
    from backend.engine import ForecastingEngine
    eng = ForecastingEngine()

    res = eng.forecast_batch(
        items=[disc_item, active_target_0m],
        horizon=6,
        candidate_pool=[disc_item]  # Discontinued item is only candidate in pool
    )

    results_by_code = {r["itemCode"]: r for r in res["results"]}

    # Verify discontinued SKU result
    disc_res = results_by_code["DISC_SKU_01"]
    assert disc_res["selectionStatus"] == "DISCONTINUED_SKU"
    assert disc_res["modelName"] == "Zero Allocation (Discontinued SKU)"
    assert disc_res["forecast"] == [0.0] * 6
    assert disc_res["rawForecast"] == [0.0] * 6
    assert disc_res["trainingRows"] == 0
    assert disc_res["historyMonths"] == 12  # Historical data preserved
    assert disc_res["metadata"]["isDiscontinued"] is True

    # Verify discontinued SKU was NOT used as a peer for cold target
    cold_res = results_by_code["COLD_TARGET_01"]
    # Since only candidate in pool was discontinued, cold_res should find NO peers
    comparable_peers = cold_res.get("metadata", {}).get("comparablePeers", [])
    peer_codes = [p["itemCode"] for p in comparable_peers]
    assert "DISC_SKU_01" not in peer_codes

