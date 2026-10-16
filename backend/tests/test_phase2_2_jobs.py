import os
import tempfile
import time
import pytest
from fastapi.testclient import TestClient

from backend.cache import ForecastCache
from backend.main import app, jobs, job_lock


@pytest.fixture
def temp_cache():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name
    cache = ForecastCache(db_path=db_path, enabled=True)
    yield cache
    cache.close()
    for ext in ["", "-wal", "-shm"]:
        p = db_path + ext
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass


def test_job_persistence_direct_cache(temp_cache):
    job_data = {
        "jobId": "test_job_123",
        "status": "QUEUED",
        "currentStage": "Validating Excel demand history",
        "completedStages": ["Validating Excel demand history"],
        "completedItems": 0,
        "totalItems": 10,
        "currentItemCode": "SKU-A",
        "currentModel": "LinearRegression",
        "startTime": 1000.0,
        "endTime": None,
        "elapsedSeconds": 0.0,
        "progressPercentage": 0.0,
        "error": None,
        "result": None,
        "telemetry": {"sample": 1},
        "allowedCategories": ["CAT1"],
        "cancelled": False
    }
    temp_cache.save_job(job_data)
    recovered = temp_cache.get_job("test_job_123")
    assert recovered is not None
    assert recovered["jobId"] == "test_job_123"
    assert recovered["status"] == "QUEUED"
    assert recovered["totalItems"] == 10
    assert recovered["allowedCategories"] == ["CAT1"]
    assert recovered["telemetry"] == {"sample": 1}

    # Update job
    job_data["status"] = "COMPLETED"
    job_data["progressPercentage"] = 100.0
    job_data["result"] = {"forecasts": [{"itemCode": "SKU-A", "forecast": [10, 20]}]}
    job_data["endTime"] = 1015.0
    job_data["elapsedSeconds"] = 15.0
    temp_cache.save_job(job_data)

    recovered2 = temp_cache.get_job("test_job_123")
    assert recovered2["status"] == "COMPLETED"
    assert recovered2["progressPercentage"] == 100.0
    assert recovered2["result"] == {"forecasts": [{"itemCode": "SKU-A", "forecast": [10, 20]}]}
    assert recovered2["elapsedSeconds"] == 15.0


def test_job_recovery_after_memory_cleared():
    client = TestClient(app)
    # Post a minimal forecast job
    payload = {
        "items": [
            {
                "itemCode": "TEST-SKU-JOB",
                "description": "Test SKU",
                "itemGroup": "Test",
                "history": [10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 45.0, 50.0, 55.0, 60.0, 65.0],
                "periods": [f"2025-{m:02d}" for m in range(1, 13)]
            }
        ],
        "horizon": 3,
        "startMonth": "2026-01"
    }
    resp = client.post("/api/forecast/jobs", json=payload)
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["jobId"]

    # Poll until completed (it's only 1 SKU with 12 points, very fast)
    max_wait = 10.0
    start = time.time()
    while time.time() - start < max_wait:
        status_resp = client.get(f"/api/forecast/jobs/{job_id}")
        if status_resp.status_code == 200 and status_resp.json()["status"] in ("COMPLETED", "FAILED"):
            break
        time.sleep(0.1)

    assert status_resp.json()["status"] == "COMPLETED"

    # Now simulate server restart / memory wipe by clearing the in-memory dict
    with job_lock:
        assert job_id in jobs
        del jobs[job_id]
        assert job_id not in jobs

    # Fetching the job should transparently recover from SQLite cache!
    recovered_resp = client.get(f"/api/forecast/jobs/{job_id}")
    assert recovered_resp.status_code == 200
    recovered_data = recovered_resp.json()
    assert recovered_data["jobId"] == job_id
    assert recovered_data["status"] == "COMPLETED"
    assert recovered_data["result"] is not None
    assert len(recovered_data["result"]["results"]) == 1


def test_cache_metrics_endpoint():
    client = TestClient(app)
    resp = client.get("/api/forecast/cache/metrics")
    assert resp.status_code == 200
    data = resp.json()
    assert "enabled" in data
    if data["enabled"]:
        assert "databasePath" in data
        assert "databaseSizeMB" in data
        assert "tableCounts" in data
        assert "forecast_jobs" in data["tableCounts"]
        assert "telemetry" in data
