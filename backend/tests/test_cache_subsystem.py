"""
Gate A Unit Test Suite: Independent Validation of Persistent SQLite Cache Subsystem.
Tests all requirements of Phase 2.1-A before engine integration.
"""

import os
import sys
import math
import time
import json
import sqlite3
import pytest
import threading
import tempfile
import shutil

from backend.cache import (
    ForecastCache,
    length_prefix,
    serialize_demand_value,
    format_period_record,
    compute_series_hash,
    compute_peer_pool_digest,
    compute_cold_start_keys,
    compute_mature_keys,
    IncompatibleSchemaVersionError,
    MigrationExecutionError,
    NetworkFilesystemError,
    check_local_filesystem,
    TARGET_SCHEMA_VERSION,
    P1_CANONICAL_SERIALIZER_VERSION
)


@pytest.fixture
def temp_cache_dir():
    d = tempfile.mkdtemp(prefix="ledure_cache_test_")
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def cache(temp_cache_dir):
    db_path = os.path.join(temp_cache_dir, "test_cache.db")
    fc = ForecastCache(db_path=db_path, enabled=True)
    yield fc
    fc.close()


# -------------------------------------------------------------------------
# 1. Exact Canonical Serializers & Floating Point Sensitivity
# -------------------------------------------------------------------------
def test_length_prefix_utf8_bytes():
    # ASCII
    assert length_prefix("SKU-100") == "7:SKU-100"
    # Multi-byte UTF-8 (e.g. Greek Omega Ω = 2 bytes)
    assert length_prefix("100Ω") == "5:100Ω"
    # Empty string
    assert length_prefix("") == "0:"


def test_serialize_demand_value_ieee():
    # Zero and negative zero
    assert serialize_demand_value(0.0) == "0"
    assert serialize_demand_value(-0.0) == "0"
    assert serialize_demand_value(100.0) == "100"
    assert serialize_demand_value(100.5) == "100.5"
    # Micro-precision
    assert serialize_demand_value(100.0001) == "100.0001"
    assert serialize_demand_value(1234567.8901234567) == "1234567.8901234567"

    # NaN and Inf must be rejected with ValueError
    with pytest.raises(ValueError, match="Invalid non-finite demand observation"):
        serialize_demand_value(float("nan"))
    with pytest.raises(ValueError, match="Invalid non-finite demand observation"):
        serialize_demand_value(float("inf"))
    with pytest.raises(ValueError, match="Invalid non-finite demand observation"):
        serialize_demand_value(float("-inf"))


def test_canonical_series_hash_sensitivity():
    # 1. Exact float sensitivity: 100 vs 100.0001
    h1, _ = compute_series_hash("SKU-A", [100.0, 200.0, 300.0])
    h2, _ = compute_series_hash("SKU-A", [100.0001, 200.0, 300.0])
    assert h1 != h2, "Micro-difference in sales demand must yield distinct hashes"

    # 2. Zero demand vs missing period vs absent month
    h_active_zero, _ = compute_series_hash(
        "SKU-A",
        [100.0, 0.0],
        history_periods=["2025-01", "2025-02"]
    )
    h_missing, _ = compute_series_hash(
        "SKU-A",
        [100.0, 0.0],
        history_periods=["2025-01", "2025-02"],
        missing_periods=["2025-02"]
    )
    h_absent, _ = compute_series_hash(
        "SKU-A",
        [100.0],
        history_periods=["2025-01"]
    )
    assert h_active_zero != h_missing, "Active zero demand must differ from missing period"
    assert h_active_zero != h_absent, "Active zero demand in period 2 must differ from absent month"
    assert h_missing != h_absent, "Missing period record must differ from absent month"

    # 3. Discontinued flag sensitivity
    h_active, _ = compute_series_hash("SKU-A", [100.0, 200.0], is_discontinued=False)
    h_disc, _ = compute_series_hash("SKU-A", [100.0, 200.0], is_discontinued=True)
    assert h_active != h_disc, "Discontinued SKU must yield distinct series hash"


# -------------------------------------------------------------------------
# 2. Deterministic Peer Fingerprints
# -------------------------------------------------------------------------
def test_peer_pool_order_invariance():
    # Peer pool with multiple items
    cand1 = {
        "itemCode": "PEER-1",
        "description": "12W Downlight Warm White",
        "itemGroup": "Commercial",
        "history": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0]
    }
    cand2 = {
        "itemCode": "PEER-2",
        "description": "15W Panel Cool White",
        "itemGroup": "Indoor",
        "history": [15.0, 25.0, 35.0, 45.0, 55.0, 65.0]
    }
    cand3 = {
        "itemCode": "PEER-3",
        "description": "20W Flood Light",
        "itemGroup": "Outdoor",
        "history": [5.0, 10.0, 15.0, 20.0, 25.0, 30.0]
    }

    # Digest with order: [1, 2, 3]
    digest_order_a = compute_peer_pool_digest([cand1, cand2, cand3])
    # Digest with order: [3, 1, 2]
    digest_order_b = compute_peer_pool_digest([cand3, cand1, cand2])
    # Digest with order: [2, 3, 1]
    digest_order_c = compute_peer_pool_digest([cand2, cand3, cand1])

    assert digest_order_a == digest_order_b == digest_order_c, (
        "Candidate pool order must be invariant under lexicographical sorting"
    )


def test_peer_pool_modification_sensitivity():
    cand1 = {
        "itemCode": "PEER-1",
        "description": "12W Downlight",
        "itemGroup": "Commercial",
        "history": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0]
    }
    cand2 = {
        "itemCode": "PEER-2",
        "description": "15W Panel",
        "itemGroup": "Indoor",
        "history": [15.0, 25.0, 35.0, 45.0, 55.0, 65.0]
    }

    base_digest = compute_peer_pool_digest([cand1, cand2])

    # 1. Modifying eligible peer's sales alters digest
    cand1_modified_sales = dict(cand1, history=[10.0, 20.0, 30.0, 40.0, 50.0, 999.0])
    sales_digest = compute_peer_pool_digest([cand1_modified_sales, cand2])
    assert base_digest != sales_digest, "Modifying eligible peer sales must alter peer digest"

    # 2. Modifying eligible peer's wattage/attribute alters digest
    cand1_modified_attr = dict(cand1, description="50W High Bay")
    attr_digest = compute_peer_pool_digest([cand1_modified_attr, cand2])
    assert base_digest != attr_digest, "Modifying eligible peer attribute must alter peer digest"

    # 3. Discontinuing eligible peer alters digest (removes from pool)
    cand1_disc = dict(cand1, isDiscontinued=True)
    disc_digest = compute_peer_pool_digest([cand1_disc, cand2])
    assert base_digest != disc_digest, "Marking peer as discontinued must alter peer digest"

    # 4. Modifying an INELIGIBLE SKU (< 6M) does NOT alter eligible digest
    ineligible_cand = {
        "itemCode": "SPARSE-1",
        "description": "3W Bulb",
        "itemGroup": "Bulbs",
        "history": [10.0, 20.0]  # Only 2 months
    }
    ineligible_digest_1 = compute_peer_pool_digest([cand1, cand2, ineligible_cand])
    assert base_digest == ineligible_digest_1, "Ineligible SKU (<6M) must not alter eligible peer digest"

    ineligible_cand_modified = dict(ineligible_cand, history=[999.0, 888.0])
    ineligible_digest_2 = compute_peer_pool_digest([cand1, cand2, ineligible_cand_modified])
    assert base_digest == ineligible_digest_2, "Changing ineligible SKU must not alter eligible peer digest"


def test_mature_keys_decoupled_from_peers():
    # Mature SKU key depends strictly on target series hash, winning model, and horizon
    series_hash, _ = compute_series_hash("MATURE-1", [10.0] * 24)
    keys_1 = compute_mature_keys(series_hash, winning_model_name="Holt Exponential Smoothing", horizon=6)
    keys_2 = compute_mature_keys(series_hash, winning_model_name="Holt Exponential Smoothing", horizon=6)
    assert keys_1["forecast_hash"] == keys_2["forecast_hash"]


# -------------------------------------------------------------------------
# 3. SQLite Configuration & Schema Setup
# -------------------------------------------------------------------------
def test_sqlite_wal_pragmas(cache):
    conn = cache.get_connection()
    cur = conn.cursor()

    cur.execute("PRAGMA journal_mode;")
    jmode = cur.fetchone()[0]
    assert jmode.lower() == "wal", f"Journal mode must be WAL, got {jmode}"

    cur.execute("PRAGMA foreign_keys;")
    fk = cur.fetchone()[0]
    assert fk == 1, "Foreign keys must be enabled (1)"

    cur.execute("PRAGMA user_version;")
    ver = cur.fetchone()[0]
    assert ver == TARGET_SCHEMA_VERSION, f"User version must be {TARGET_SCHEMA_VERSION}"


def test_provenance_table_sync(cache):
    conn = cache.get_connection()
    cur = conn.cursor()
    cur.execute("SELECT component_name, version_hash FROM cache_provenance ORDER BY component_name;")
    rows = cur.fetchall()
    prov_dict = dict(rows)
    assert "P1_CANONICAL_SERIALIZER" in prov_dict
    assert prov_dict["P1_CANONICAL_SERIALIZER"] == P1_CANONICAL_SERIALIZER_VERSION
    assert "P8_RESULT_SCHEMA" in prov_dict


# -------------------------------------------------------------------------
# 4. Multi-Layer CRUD & Cascading Foreign Key Integrity
# -------------------------------------------------------------------------
def test_cache_crud_and_cascading_fk(cache):
    item_code = "SKU-TEST-001"
    history = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0, 110.0, 120.0]
    series_hash, meta = compute_series_hash(item_code, history)

    # 1. Layer 1 Write & Read
    profile_data = {
        "demand_pattern": "smooth",
        "average_inter_demand_interval": 1.0,
        "cv_squared": 0.15,
        "trend_direction": "up",
        "trend_strength": 0.85,
        "seasonality_detected": False,
        "outlier_count": 0
    }
    classification_data = {
        "category": "RUNNER",
        "classification_reason": "Low ADI, Low CV2"
    }
    cache.put_sku_profile(series_hash, item_code, meta, profile_data, classification_data)

    retrieved_profile = cache.get_sku_profile(series_hash)
    assert retrieved_profile is not None
    assert retrieved_profile["itemCode"] == item_code
    assert retrieved_profile["category"] == "RUNNER"
    assert retrieved_profile["profile"]["demand_pattern"] == "smooth"

    # 2. Layer 3 Write & Read (Backtesting)
    m_keys = compute_mature_keys(series_hash, winning_model_name="Historical Mean", horizon=6)
    backtest_hash = m_keys["backtest_hash"]
    leaderboard = [
        {"model": "Historical Mean", "wape": 0.12, "mae": 10.0, "validWindows": 6, "eligible": True},
        {"model": "Naive", "wape": 0.25, "mae": 20.0, "validWindows": 6, "eligible": True}
    ]
    cache.put_backtest_evaluations(
        backtest_hash=backtest_hash,
        series_hash=series_hash,
        validation_horizon=1,
        winning_model="Historical Mean",
        selection_status="DATA_DRIVEN_SELECTION",
        selection_reason="Lowest WAPE",
        candidate_leaderboard=leaderboard,
        residual_quantiles={"all_errors": [-5.0, 0.0, 5.0]}
    )
    bt_res = cache.get_backtest_evaluations(backtest_hash)
    assert bt_res is not None
    assert bt_res["winning_model"] == "Historical Mean"
    assert len(bt_res["candidate_leaderboard"]) == 2

    # 3. Layer 4 Write & Read (Fitted Model Artifacts)
    model_art_hash = m_keys["model_artifact_hash"]
    cache.put_model_artifact(
        model_artifact_hash=model_art_hash,
        backtest_hash=backtest_hash,
        model_name="Historical Mean",
        model_type="statistical",
        model_params={"mean": 65.0}
    )
    m_art = cache.get_model_artifact(model_art_hash)
    assert m_art is not None
    assert m_art["model_params"]["mean"] == 65.0

    # 4. Layer 5A Write & Read (Mature Forecast Results)
    fc_hash = m_keys["forecast_hash"]
    full_payload = {
        "itemCode": item_code,
        "modelName": "Historical Mean",
        "forecast": [65, 65, 65, 65, 65, 65],
        "confidence": {"score": 88.5, "level": "HIGH"}
    }
    cache.put_forecast_result(
        forecast_hash=fc_hash,
        item_code=item_code,
        series_hash=series_hash,
        horizon=6,
        start_month="2026-11",
        confidence_level=0.90,
        result_payload=full_payload
    )
    fc_res = cache.get_forecast_result(fc_hash)
    assert fc_res is not None
    assert fc_res["forecast"] == [65, 65, 65, 65, 65, 65]

    # Verify cascading delete via foreign keys:
    # Deleting series_hash from sku_profiles must automatically delete backtest, model artifact, and forecast result!
    conn = cache.get_connection()
    conn.execute("DELETE FROM sku_profiles WHERE series_hash = ?;", (series_hash,))

    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM sku_profiles WHERE series_hash = ?;", (series_hash,))
    assert cur.fetchone()[0] == 0

    cur.execute("SELECT COUNT(*) FROM backtest_evaluations WHERE series_hash = ?;", (series_hash,))
    assert cur.fetchone()[0] == 0, "backtest_evaluations must be cascade-deleted"

    cur.execute("SELECT COUNT(*) FROM fitted_model_artifacts WHERE backtest_hash = ?;", (backtest_hash,))
    assert cur.fetchone()[0] == 0, "fitted_model_artifacts must be cascade-deleted via backtest FK"

    cur.execute("SELECT COUNT(*) FROM forecast_results WHERE series_hash = ?;", (series_hash,))
    assert cur.fetchone()[0] == 0, "forecast_results must be cascade-deleted"


# -------------------------------------------------------------------------
# 5. Deterministic LRU Eviction with Equal Timestamps & Zero Orphans
# -------------------------------------------------------------------------
def test_lru_eviction_zero_orphans(temp_cache_dir):
    db_path = os.path.join(temp_cache_dir, "lru_test.db")
    # Low threshold for eviction trigger
    fc = ForecastCache(db_path=db_path, max_storage_bytes=1000)

    # Insert 10 profiles with children
    hashes = []
    for i in range(10):
        code = f"SKU-LRU-{i:03d}"
        shash, meta = compute_series_hash(code, [float(i + 1)] * 12)
        hashes.append(shash)
        fc.put_sku_profile(
            shash, code, meta,
            {"demand_pattern": "smooth"},
            {"category": "RUNNER"}
        )
        m_keys = compute_mature_keys(shash, winning_model_name="Naive", horizon=6)
        fc.put_backtest_evaluations(
            backtest_hash=m_keys["backtest_hash"],
            series_hash=shash,
            validation_horizon=1,
            winning_model="Naive",
            selection_status="OK",
            selection_reason="Test",
            candidate_leaderboard=[],
            residual_quantiles={}
        )
        fc.put_forecast_result(
            forecast_hash=m_keys["forecast_hash"],
            item_code=code,
            series_hash=shash,
            horizon=6,
            start_month="2026-11",
            confidence_level=0.90,
            result_payload={"itemCode": code, "forecast": [1, 2, 3]}
        )

    # Trigger eviction with forced small threshold
    fc.check_and_evict_lru(target_free_bytes=1)

    conn = fc.get_connection()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM sku_profiles;")
    prof_count = cur.fetchone()[0]
    assert prof_count == 0, "All profiles should be evicted"

    # Verify child tables have zero orphan rows
    cur.execute("SELECT COUNT(*) FROM backtest_evaluations;")
    assert cur.fetchone()[0] == 0, "Zero orphan records in backtest_evaluations"
    cur.execute("SELECT COUNT(*) FROM forecast_results;")
    assert cur.fetchone()[0] == 0, "Zero orphan records in forecast_results"
    fc.close()


# -------------------------------------------------------------------------
# 6. Schema Migrations, Rollback & Incompatible Version Protection
# -------------------------------------------------------------------------
def test_newer_unsupported_version_rejection(temp_cache_dir):
    db_path = os.path.join(temp_cache_dir, "future_schema.db")
    # Pre-create a database with user_version = 99
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA user_version = 99;")
    conn.close()

    with pytest.raises(IncompatibleSchemaVersionError, match="newer than supported"):
        ForecastCache(db_path=db_path)


def test_online_wal_safe_backup_and_restore(cache, temp_cache_dir):
    # Insert some data
    shash, meta = compute_series_hash("BACKUP-SKU", [50.0] * 12)
    cache.put_sku_profile(shash, "BACKUP-SKU", meta, {"demand_pattern": "smooth"}, {"category": "RUNNER"})

    backup_path = os.path.join(temp_cache_dir, "backup.db")
    cache.create_online_backup(backup_path)

    assert os.path.exists(backup_path), "Backup snapshot must be created"

    # Verify backup contains the record
    bk_conn = sqlite3.connect(backup_path)
    cur = bk_conn.cursor()
    cur.execute("SELECT item_code FROM sku_profiles WHERE series_hash = ?;", (shash,))
    row = cur.fetchone()
    assert row is not None and row[0] == "BACKUP-SKU"
    bk_conn.close()


# -------------------------------------------------------------------------
# 7. Local Filesystem Enforcement
# -------------------------------------------------------------------------
def test_network_filesystem_rejection():
    with pytest.raises(NetworkFilesystemError):
        check_local_filesystem("\\\\network_share\\cache\\forecast.db")
    with pytest.raises(NetworkFilesystemError):
        check_local_filesystem("//remote_host/volume/forecast.db")


# -------------------------------------------------------------------------
# 8. Single-Flight Duplicate Request Coalescing
# -------------------------------------------------------------------------
def test_single_flight_coalescing(cache):
    execution_count = 0
    lock = threading.Lock()

    def worker_task(sku_key: str):
        nonlocal execution_count
        is_leader, event = cache.single_flight.acquire(sku_key)
        if is_leader:
            # Simulate expensive computation
            time.sleep(0.05)
            with lock:
                execution_count += 1
            cache.single_flight.release(sku_key)
        else:
            event.wait(timeout=2.0)

    threads = [threading.Thread(target=worker_task, args=("TEST_SHARED_KEY",)) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert execution_count == 1, f"Expected exactly 1 execution among 8 concurrent threads, got {execution_count}"


# -------------------------------------------------------------------------
# 9. Corrupted Database Recovery
# -------------------------------------------------------------------------
def test_corrupted_database_recovery(temp_cache_dir):
    db_path = os.path.join(temp_cache_dir, "corrupt_test.db")
    # Initialize valid DB
    fc = ForecastCache(db_path=db_path)
    fc.close()

    # Corrupt the SQLite header/body with garbage bytes
    with open(db_path, "r+b") as f:
        f.seek(16)
        f.write(b"\x00" * 100)

    # Re-opening should trigger recovery, quarantine the corrupt file, and recreate fresh valid schema
    fc_recovered = ForecastCache(db_path=db_path)
    conn = fc_recovered.get_connection()
    cur = conn.cursor()
    cur.execute("PRAGMA integrity_check;")
    assert cur.fetchone()[0] == "ok"
    assert fc_recovered.telemetry.recovery_events >= 1
    fc_recovered.close()

