import time
import pytest
from fastapi.testclient import TestClient
from backend.main import app, jobs, job_lock

client = TestClient(app)

SAMPLE_ITEMS = [
    {
        "itemCode": "TEST-SKU-01",
        "history": [10.0, 15.0, 12.0, 18.0, 20.0, 22.0, 25.0, 30.0, 28.0, 35.0, 40.0, 42.0],
        "periods": [f"2025-{m:02d}" for m in range(1, 13)],
        "description": "Test Item 01",
        "itemGroup": "BULBS"
    },
    {
        "itemCode": "TEST-SKU-02",
        "history": [100.0, 110.0, 95.0, 105.0, 120.0, 115.0, 130.0, 125.0, 140.0, 135.0, 150.0, 155.0],
        "periods": [f"2025-{m:02d}" for m in range(1, 13)],
        "description": "Test Item 02",
        "itemGroup": "PANELS"
    }
]


def setup_function():
    with job_lock:
        jobs.clear()


def test_job_creation_and_polling():
    """
    Test 1, 2, 3:
    - POST /api/forecast/jobs returns job ID immediately.
    - Status transitions from QUEUED/RUNNING to COMPLETED.
    - Information includes completedItems, totalItems, currentStage, currentModel, elapsedSeconds.
    """
    payload = {
        "items": SAMPLE_ITEMS,
        "horizon": 6,
        "startMonth": "2026-01"
    }

    create_res = client.post("/api/forecast/jobs", json=payload)
    assert create_res.status_code == 200, create_res.text
    data = create_res.json()
    assert "jobId" in data
    assert data["status"] in ("QUEUED", "RUNNING")
    job_id = data["jobId"]

    # Poll until finished or timeout
    max_wait = 20
    start = time.time()
    final_status = None
    intermediate_seen = False

    while time.time() - start < max_wait:
        poll_res = client.get(f"/api/forecast/jobs/{job_id}")
        assert poll_res.status_code == 200
        poll_data = poll_res.json()
        assert poll_data["jobId"] == job_id
        assert poll_data["totalItems"] == 2
        assert poll_data["elapsedSeconds"] >= 0

        if poll_data["status"] in ("QUEUED", "RUNNING"):
            intermediate_seen = True
            time.sleep(0.1)
        elif poll_data["status"] == "COMPLETED":
            final_status = poll_data
            break
        elif poll_data["status"] == "FAILED":
            pytest.fail(f"Job unexpectedly failed: {poll_data.get('error')}")

    assert final_status is not None, "Job did not complete within timeout"
    assert final_status["status"] == "COMPLETED"
    assert final_status["completedItems"] == 2
    assert final_status["progressPercentage"] == 100.0
    assert "result" in final_status and final_status["result"] is not None
    assert len(final_status["result"]["results"]) == 2
    assert len(final_status["completedStages"]) >= 8


def test_duplicate_job_submission_prevented():
    """
    Test 11:
    Duplicate job submissions are rejected with 409 Conflict while a job is running.
    """
    # Create an artificial running job in registry
    with job_lock:
        jobs["running_job_1"] = {
            "jobId": "running_job_1",
            "status": "RUNNING",
            "currentStage": "Training eligible candidate models",
            "completedStages": ["Validating Excel demand history"],
            "completedItems": 0,
            "totalItems": 5,
            "currentItemCode": "SKU-1",
            "currentModel": "HistGradientBoostingRegressor",
            "elapsedSeconds": 1.0,
            "progressPercentage": 0.0,
            "error": None,
            "result": None,
            "startTime": time.time(),
            "endTime": None,
            "cancelled": False
        }

    payload = {
        "items": SAMPLE_ITEMS,
        "horizon": 6,
        "startMonth": "2026-01"
    }

    # Attempt to submit another job
    res = client.post("/api/forecast/jobs", json=payload)
    assert res.status_code == 409
    assert "already in progress" in res.json()["detail"]


def test_job_cancellation():
    """
    Test 10 & cancellation:
    Job cancellation sets status to CANCELLED and halts further execution.
    """
    with job_lock:
        jobs["test_cancel_job"] = {
            "jobId": "test_cancel_job",
            "status": "RUNNING",
            "currentStage": "Training eligible candidate models",
            "completedStages": ["Validating Excel demand history"],
            "completedItems": 0,
            "totalItems": 10,
            "currentItemCode": "SKU-1",
            "currentModel": "HistGradientBoostingRegressor",
            "elapsedSeconds": 0.5,
            "progressPercentage": 0.0,
            "error": None,
            "result": None,
            "startTime": time.time(),
            "endTime": None,
            "cancelled": False
        }

    res = client.post("/api/forecast/jobs/test_cancel_job/cancel")
    assert res.status_code == 200
    assert res.json()["status"] == "CANCELLED"

    poll_res = client.get("/api/forecast/jobs/test_cancel_job")
    assert poll_res.json()["status"] == "CANCELLED"


def test_numerical_equivalence_between_batch_and_job():
    """
    Test 14:
    Results returned by background job match results returned by synchronous batch API exactly.
    """
    payload = {
        "items": SAMPLE_ITEMS,
        "horizon": 6,
        "startMonth": "2026-01"
    }

    # 1. Direct synchronous batch
    direct_res = client.post("/api/forecast/batch", json=payload).json()

    # 2. Asynchronous job
    job_init = client.post("/api/forecast/jobs", json=payload).json()
    job_id = job_init["jobId"]

    # Poll until complete
    for _ in range(50):
        status_res = client.get(f"/api/forecast/jobs/{job_id}").json()
        if status_res["status"] == "COMPLETED":
            job_result = status_res["result"]
            break
        time.sleep(0.1)
    else:
        pytest.fail("Job did not finish in time")

    assert len(direct_res["results"]) == len(job_result["results"])
    for d_item, j_item in zip(direct_res["results"], job_result["results"]):
        assert d_item["itemCode"] == j_item["itemCode"]
        assert d_item["selectedModel"] == j_item["selectedModel"]
        assert d_item["forecast"] == j_item["forecast"]
        assert d_item["historyMonths"] == j_item["historyMonths"]
