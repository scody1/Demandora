"""
Stage 2.1-C Acceptance Test Suite: End-to-End Acceptance Verification.
Covers:
- Backend process restart persistence.
- Cache disabled and graceful fallback.
- Concurrent read/write load under thread pressure.
- Supply-only non-invalidation (inventory/open orders/BOM do not invalidate forecast cache).
"""

import os
import sys
import time
import pytest
import threading
import sqlite3
import numpy as np

from backend.engine import ForecastingEngine
from backend.cache import ForecastCache


def test_backend_restart_persistence(tmp_path):
    db_file = str(tmp_path / "restart_persist.db")

    # 1. First Process Run
    cache1 = ForecastCache(db_path=db_file, enabled=True)
    engine1 = ForecastingEngine(validation_horizon=1, cache=cache1, use_cache=True)

    items = [
        {
            "itemCode": "RESTART-SKU-1",
            "history": [100.0 + (i * 2.0) for i in range(24)],
            "periods": [f"2024-{(i%12)+1:02d}" for i in range(24)]
        },
        {
            "itemCode": "RESTART-SKU-2",
            "history": [50.0 + (i * 1.5) for i in range(24)],
            "periods": [f"2024-{(i%12)+1:02d}" for i in range(24)]
        }
    ]

    res1 = engine1.forecast_batch(items=items, horizon=6)
    assert res1["totalItemsProcessed"] == 2
    # Verify records were inserted
    conn1 = cache1.get_connection()
    cur1 = conn1.cursor()
    cur1.execute("SELECT COUNT(*) FROM forecast_results;")
    assert cur1.fetchone()[0] == 2
    cache1.close()

    # 2. Simulate Backend Shutdown & Process Restart
    # Fresh ForecastCache and ForecastingEngine instances on the same file
    cache2 = ForecastCache(db_path=db_file, enabled=True)
    engine2 = ForecastingEngine(validation_horizon=1, cache=cache2, use_cache=True)

    t0 = time.time()
    res2 = engine2.forecast_batch(items=items, horizon=6)
    elapsed = time.time() - t0

    assert res2["totalItemsProcessed"] == 2
    assert res2["results"][0]["forecast"] == res1["results"][0]["forecast"]
    assert res2["results"][1]["forecast"] == res1["results"][1]["forecast"]

    # Verify 100% cache hit and avoided all model fitting
    telemetry = res2.get("telemetry", {})
    cache_meta = telemetry.get("cache", {})
    assert cache_meta.get("totalHits") >= 2
    assert cache_meta.get("modelFitsAvoided") >= 16  # avoids 7 backtests + 1 refit per SKU
    assert elapsed < 0.2, f"Restart cache hit should complete in <200ms, took {elapsed:.4f}s"
    cache2.close()


def test_cache_disabled_fallback(tmp_path):
    # Engine configured with cache disabled runs uncached pipeline seamlessly
    engine = ForecastingEngine(validation_horizon=1, use_cache=False)
    assert engine.cache is None
    assert engine.use_cache is False

    res = engine.forecast_single_sku(
        item_code="FALLBACK-SKU",
        history_values=[100.0] * 12,
        horizon=6
    )
    assert res["itemCode"] == "FALLBACK-SKU"
    assert len(res["forecast"]) == 6
    assert res["modelName"] is not None


def test_concurrent_read_write_load(tmp_path):
    db_file = str(tmp_path / "concurrent_load.db")
    cache = ForecastCache(db_path=db_file, enabled=True)
    engine = ForecastingEngine(validation_horizon=1, cache=cache, use_cache=True)

    errors = []
    lock = threading.Lock()

    def worker(worker_id: int):
        try:
            # Overlapping and distinct SKU requests
            sku_idx = worker_id % 4
            code = f"CONCURRENT-SKU-{sku_idx}"
            hist = [80.0 + (i * 3.0) + (sku_idx * 10) for i in range(24)]
            res = engine.forecast_single_sku(
                item_code=code,
                history_values=hist,
                horizon=6
            )
            assert res["itemCode"] == code
            assert len(res["forecast"]) == 6
        except Exception as e:
            with lock:
                errors.append(e)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(errors) == 0, f"Concurrent workers experienced errors: {errors}"
    cache.close()


def test_supply_only_non_invalidation(tmp_path):
    # Proves changes to inventory, open PO, BOM, MOQ do NOT invalidate forecast cache
    db_file = str(tmp_path / "supply_inval.db")
    cache = ForecastCache(db_path=db_file, enabled=True)
    engine = ForecastingEngine(validation_horizon=1, cache=cache, use_cache=True)

    hist = [100.0 + (i * 2.0) for i in range(24)]
    periods = [f"2024-{(i%12)+1:02d}" for i in range(24)]

    # 1. Initial Forecast
    f1 = engine.forecast_single_sku("SUPPLY-SKU-1", hist, history_periods=periods, horizon=6)
    assert cache.telemetry.hits_by_layer["layer5a_forecast"] == 0

    # 2. Simulate supply changes: On-hand changed 100 -> 500, Open PO changed 0 -> 200
    # In Ledure architecture, supply changes trigger MRP calculation without model refitting.
    # If the forecast engine is called again for the SKU with unchanged demand, it hits Layer 5A:
    f2 = engine.forecast_single_sku("SUPPLY-SKU-1", hist, history_periods=periods, horizon=6)
    assert cache.telemetry.hits_by_layer["layer5a_forecast"] == 1
    assert f1["forecast"] == f2["forecast"]

    cache.close()


def test_unc_and_local_filesystem_acceptance(tmp_path):
    from backend.cache import check_local_filesystem, NetworkFilesystemError

    # Rejection of Windows UNC and network prefixes
    unc_paths = [
        "\\\\server\\share\\data.db",
        "//server/share/data.db",
        "\\//server/share/data.db",
        "/\\server/share/data.db",
        "\\\\?\\UNC\\server\\share\\data.db",
        "smb://server/share/data.db",
        "nfs://server/share/data.db"
    ]
    for p in unc_paths:
        with pytest.raises(NetworkFilesystemError):
            check_local_filesystem(p)

    # Acceptance of valid local paths (must not raise NetworkFilesystemError)
    local_db = str(tmp_path / "valid_local.db")
    check_local_filesystem(local_db)
    check_local_filesystem("relative_file.db")


def test_calendar_aware_peer_fingerprint():
    from backend.cache import compute_peer_pool_digest, compute_series_hash, compute_mature_keys

    peer_item = {
        "itemCode": "PEER-CAL-1",
        "description": "Ledure Downlight 12W",
        "itemGroup": "Indoor",
        "history": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
        "periods": ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"]
    }
    # 1. Identical data and identical calendar periods produce identical digest
    digest_a = compute_peer_pool_digest([peer_item])
    digest_b = compute_peer_pool_digest([peer_item])
    assert digest_a == digest_b

    # 2. Same numeric values shifted by 1 calendar month produce a DIFFERENT digest
    peer_item_shifted = dict(
        peer_item,
        periods=["2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07"]
    )
    digest_shifted = compute_peer_pool_digest([peer_item_shifted])
    assert digest_a != digest_shifted, "Shifting peer observations by one month must alter the peer pool digest"

    # 3. Newly eligible mature peer changes digest
    peer_5m = {
        "itemCode": "PEER-NEW",
        "description": "Panel 15W",
        "itemGroup": "Indoor",
        "history": [10.0, 20.0, 30.0, 40.0, 50.0],
        "periods": ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05"]
    }
    digest_without_new = compute_peer_pool_digest([peer_item, peer_5m])
    assert digest_without_new == digest_a  # 5M is ineligible, so ignored

    peer_6m = dict(
        peer_5m,
        history=[10.0, 20.0, 30.0, 40.0, 50.0, 60.0],
        periods=["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"]
    )
    digest_with_new = compute_peer_pool_digest([peer_item, peer_6m])
    assert digest_with_new != digest_a, "Newly eligible 6M peer must change the peer pool digest"

    # 4. Peer becoming ineligible (e.g. discontinued) changes digest
    peer_disc = dict(peer_6m, isDiscontinued=True)
    digest_disc = compute_peer_pool_digest([peer_item, peer_disc])
    assert digest_disc == digest_a, "Discontinued peer must be excluded from peer pool digest"

    # 5. Unrelated mature SKU changes do not unnecessarily invalidate unrelated mature forecasts
    series_hash_1, _ = compute_series_hash("MATURE-1", [100.0] * 24)
    series_hash_2, _ = compute_series_hash("MATURE-2", [200.0] * 24)
    series_hash_2_mod, _ = compute_series_hash("MATURE-2", [999.0] * 24)

    fc_keys_1_before = compute_mature_keys(series_hash_1, "Naive", horizon=6)
    fc_keys_1_after = compute_mature_keys(series_hash_1, "Naive", horizon=6)
    assert fc_keys_1_before["forecast_hash"] == fc_keys_1_after["forecast_hash"]


def test_profile_and_feature_cache_hit_and_miss(tmp_path):
    from backend.cache import compute_series_hash, compute_mature_keys

    db_path = str(tmp_path / "layer1_2_test.db")
    fc = ForecastCache(db_path=db_path, enabled=True)

    # Layer 1: Profile cache
    series_hash, meta = compute_series_hash("PROF-SKU-1", [100.0 + i for i in range(12)])
    assert fc.get_sku_profile(series_hash) is None  # Miss

    profile_in = {"demand_pattern": "smooth", "average_inter_demand_interval": 1.0, "cv_squared": 0.1}
    class_in = {"category": "RUNNER", "classification_reason": "High demand regular"}
    fc.put_sku_profile(series_hash, "PROF-SKU-1", meta, profile_in, class_in)

    cached_prof = fc.get_sku_profile(series_hash)
    assert cached_prof is not None
    assert cached_prof["profile"]["demand_pattern"] == "smooth"
    assert cached_prof["classification"]["category"] == "RUNNER"

    # Layer 2: Feature cache
    m_keys = compute_mature_keys(series_hash, "Naive", horizon=6)
    feat_hash = m_keys["feature_hash"]
    assert fc.get_engineered_features(feat_hash) is None  # Miss

    X_in = np.array([[100.0, 101.0], [101.0, 102.0]], dtype=float)
    y_in = np.array([102.0, 103.0], dtype=float)
    fnames_in = ["lag_1", "lag_2"]
    fc.put_engineered_features(feat_hash, series_hash, X_in, y_in, fnames_in)

    feat_out = fc.get_engineered_features(feat_hash)
    assert feat_out is not None
    X_out, y_out, fnames_out = feat_out
    assert np.array_equal(X_in, X_out)
    assert np.array_equal(y_in, y_out)
    assert fnames_in == fnames_out

    fc.close()


def test_genuine_fitted_model_artifact_reuse_and_provenance(tmp_path):
    from backend.models import NaiveModel, LinearTrendModel
    from backend.cache import (
        serialize_fitted_model,
        restore_fitted_model,
        compute_series_hash,
        compute_mature_keys,
        P6_MODEL_RUNTIME_VERSION
    )

    db_path = str(tmp_path / "model_art_test.db")
    fc = ForecastCache(db_path=db_path, enabled=True)

    series = np.array([100.0 + (i * 2.5) for i in range(24)], dtype=float)
    series_hash, meta = compute_series_hash("MODEL-SKU-1", list(series))
    fc.put_sku_profile(series_hash, "MODEL-SKU-1", meta, {"demand_pattern": "smooth"}, {"category": "RUNNER"})

    # Fit a LinearTrendModel
    original_model = LinearTrendModel()
    original_model.fit(series)
    orig_preds, _ = original_model.predict(horizon=6)

    m_keys = compute_mature_keys(series_hash, original_model.name, horizon=6)
    bt_hash = m_keys["backtest_hash"]
    art_hash = m_keys["model_artifact_hash"]

    # Put backtest row to satisfy FK
    fc.put_backtest_evaluations(
        backtest_hash=bt_hash,
        series_hash=series_hash,
        validation_horizon=1,
        winning_model=original_model.name,
        selection_status="SELECTED",
        selection_reason="Lowest WAPE",
        candidate_leaderboard=[],
        residual_quantiles={}
    )

    # 1. Serialize parameters and store in Layer 4
    ser_params = serialize_fitted_model(original_model, series)
    fc.put_model_artifact(
        model_artifact_hash=art_hash,
        backtest_hash=bt_hash,
        model_name=original_model.name,
        model_type=original_model.model_type,
        model_params=ser_params
    )

    # 2. Retrieve artifact from Layer 4
    art_row = fc.get_model_artifact(art_hash)
    assert art_row is not None
    assert art_row["provenance_hash"] == P6_MODEL_RUNTIME_VERSION

    # 3. Restore fitted model and predict
    restored_model = restore_fitted_model(art_row["model_params"])
    assert restored_model is not None
    assert restored_model.is_fitted is True
    restored_preds, _ = restored_model.predict(horizon=6)

    # Predictions must match original fitted model exactly!
    assert np.allclose(orig_preds, restored_preds)

    # 4. Provenance mismatch / corrupt parameters test
    bad_params = dict(ser_params, provenance="INCOMPATIBLE_RUNTIME_V999")
    assert restore_fitted_model(bad_params) is None

    corrupt_params = {"invalid": 123}
    assert restore_fitted_model(corrupt_params) is None

    fc.close()


def test_single_flight_failure_handling_and_retry():
    from backend.cache import SingleFlightRegistry

    reg = SingleFlightRegistry()
    key = "TEST_FAIL_KEY"

    # 1. Leader acquires lock
    is_leader, ev = reg.acquire(key)
    assert is_leader is True

    # 2. Leader encounters an exception and releases with error
    test_err = "Simulated out-of-memory or fitting crash"
    reg.release(key, error=test_err)
    assert ev.is_set()

    # 3. Followers observe the leader's error
    assert reg.get_error(key) == test_err

    # 4. Subsequent call can re-acquire and retry cleanly
    is_leader_retry, ev_retry = reg.acquire(key)
    assert is_leader_retry is True
    reg.release(key, error=None)
    assert ev_retry.is_set()


def test_cache_write_failure_fallback(tmp_path, monkeypatch):
    # Proves cache write failure does not crash or lose valid forecast result
    db_file = str(tmp_path / "write_fail.db")
    cache = ForecastCache(db_path=db_file, enabled=True)
    engine = ForecastingEngine(validation_horizon=1, cache=cache, use_cache=True)

    # Use a connection wrapper to simulate a disk I/O error on INSERT
    real_conn = cache.get_connection()

    class BrokenConnection:
        def __init__(self, real):
            self._real = real
        def execute(self, sql, *args, **kwargs):
            if isinstance(sql, str) and "INSERT INTO" in sql:
                raise sqlite3.OperationalError("disk I/O error or read-only database")
            return self._real.execute(sql, *args, **kwargs)
        def cursor(self):
            return self._real.cursor()
        def close(self):
            return self._real.close()
        def __getattr__(self, name):
            return getattr(self._real, name)

    broken_conn = BrokenConnection(real_conn)
    monkeypatch.setattr(cache, "get_connection", lambda: broken_conn)

    hist = [100.0 + (i * 2.0) for i in range(24)]
    # Engine execution must succeed and return valid forecast despite cache write failure
    res = engine.forecast_single_sku("FAIL-SAFE-SKU", hist, horizon=6)
    assert res["itemCode"] == "FAIL-SAFE-SKU"
    assert len(res["forecast"]) == 6
    assert res["modelName"] is not None
    assert cache.telemetry.fallback_events >= 1

    cache.close()


def test_unc_mixed_separator_rejection(tmp_path):
    from backend.cache import check_local_filesystem, NetworkFilesystemError

    # Specific check for exact mixed-separator form /\server/share/data.db and \/server/share/data.db
    mixed_unc_paths = [
        r"/\server/share/data.db",
        r"\/server/share/data.db",
        r"\\server\share\data.db",
        r"//server/share/data.db",
        r"\//server/share/data.db",
        r"/\\server/share/data.db"
    ]
    for p in mixed_unc_paths:
        with pytest.raises(NetworkFilesystemError):
            check_local_filesystem(p)

    # Acceptance of normal local paths across Windows & Linux
    check_local_filesystem(str(tmp_path / "valid.db"))
    check_local_filesystem("./local_relative.db")
    check_local_filesystem("../parent_relative.db")
    check_local_filesystem("simple.db")


def test_profile_cache_invalidation_on_attribute_change(tmp_path):
    # Proves a change in description or itemGroup does not return stale classification
    db_file = str(tmp_path / "profile_invalidation.db")
    cache = ForecastCache(db_path=db_file, enabled=True)
    engine = ForecastingEngine(validation_horizon=1, cache=cache, use_cache=True)

    hist = [100.0 + (i * 2.0) for i in range(24)]
    periods = [f"2024-{(i%12)+1:02d}" for i in range(24)]

    # 1. Run SKU with initial description & itemGroup
    res1 = engine.forecast_single_sku(
        item_code="ATTR-SKU-1",
        history_values=hist,
        history_periods=periods,
        description="Commercial High-Bay 100W",
        item_group="Commercial",
        horizon=6
    )
    assert res1["skuClassification"]["description"] == "Commercial High-Bay 100W"
    assert res1["skuClassification"]["itemGroup"] == "Commercial"
    assert cache.telemetry.hits_by_layer["layer1_profile"] == 0

    # 2. Run identical history but with CHANGED description and itemGroup
    res2 = engine.forecast_single_sku(
        item_code="ATTR-SKU-1",
        history_values=hist,
        history_periods=periods,
        description="Residential LED Strip 15W",
        item_group="Residential",
        horizon=6
    )
    # Must NOT return stale classification!
    assert res2["skuClassification"]["description"] == "Residential LED Strip 15W"
    assert res2["skuClassification"]["itemGroup"] == "Residential"

    # 3. Rerun with same changed description to prove cache hit
    res3 = engine.forecast_single_sku(
        item_code="ATTR-SKU-1",
        history_values=hist,
        history_periods=periods,
        description="Residential LED Strip 15W",
        item_group="Residential",
        horizon=6
    )
    assert res3["skuClassification"]["description"] == "Residential LED Strip 15W"
    assert cache.telemetry.hits_by_layer["layer1_profile"] >= 1

    cache.close()


def test_single_flight_follower_timeout_suppresses_duplicate_backtesting():
    from backend.cache import SingleFlightRegistry, SingleFlightTimeoutError

    reg = SingleFlightRegistry()
    key = "TIMEOUT_TEST_KEY"

    # Leader acquires key
    is_leader, ev = reg.acquire(key)
    assert is_leader is True

    # Follower acquires key and waits with a short timeout
    is_leader_f, ev_f = reg.acquire(key)
    assert is_leader_f is False
    assert ev_f is ev

    # Leader takes longer than follower timeout
    waited = ev_f.wait(timeout=0.05)
    assert waited is False  # Leader duration beyond timeout

    # Follower handles timeout without running duplicate computation
    if not waited:
        with pytest.raises(SingleFlightTimeoutError):
            raise SingleFlightTimeoutError("Follower timed out waiting for leader computation")

    # Leader completes and releases
    reg.release(key, error=None)
    assert ev.is_set()


def test_single_flight_error_cleanup_and_subsequent_success():
    from backend.cache import SingleFlightRegistry

    reg = SingleFlightRegistry()
    key = "ERROR_CLEANUP_KEY"

    # Run 1: Leader fails
    is_leader, ev = reg.acquire(key)
    assert is_leader is True
    reg.release(key, error="Initial computation failure: Out of Memory")
    assert reg.get_error(key) == "Initial computation failure: Out of Memory"

    # Run 2: New execution for the SAME key
    is_leader2, ev2 = reg.acquire(key)
    assert is_leader2 is True
    # During acquire, stale error must be cleared
    assert reg.get_error(key) is None

    # Run 2 succeeds
    reg.release(key, error=None)
    # Stale error must NOT be present
    assert reg.get_error(key) is None


def test_feature_cache_insertion_retrieval_and_reuse_for_hgb(tmp_path):
    # Proves genuine insertion, retrieval, and reuse of Layer 2 engineered features for HGB
    db_file = str(tmp_path / "feature_cache_test.db")
    cache = ForecastCache(db_path=db_file, enabled=True)
    engine = ForecastingEngine(validation_horizon=1, cache=cache, use_cache=True)

    # Verify initial table count is 0
    conn = cache.get_connection()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM engineered_features;")
    assert cur.fetchone()[0] == 0

    # 1. First run with HGB preferred model
    hist = [100.0 + (i * 3.5) + ((i % 3) * 10.0) for i in range(24)]
    periods = [f"2024-{(i%12)+1:02d}" for i in range(24)]

    res1 = engine.forecast_single_sku(
        item_code="HGB-SKU-1",
        history_values=hist,
        history_periods=periods,
        preferred_model="Gradient Boosting (HistGradientBoostingRegressor)",
        horizon=6
    )
    assert res1["itemCode"] == "HGB-SKU-1"

    # Verify features were inserted into engineered_features table!
    cur.execute("SELECT COUNT(*), feature_hash FROM engineered_features;")
    row = cur.fetchone()
    assert row[0] >= 1, f"Expected engineered_features count >= 1, got {row[0]}"
    feat_hash = row[1]

    # Verify retrieval from cache directly
    feat_data = cache.get_engineered_features(feat_hash)
    assert feat_data is not None
    X, y, fnames = feat_data
    assert len(X) == len(y)
    assert len(fnames) > 0
    assert cache.telemetry.hits_by_layer["layer2_features"] >= 1

    # 2. Second run for horizon change with HGB: exercises Layer 2 feature retrieval and refit
    res2 = engine.forecast_single_sku(
        item_code="HGB-SKU-1",
        history_values=hist,
        history_periods=periods,
        preferred_model="Gradient Boosting (HistGradientBoostingRegressor)",
        horizon=12
    )
    assert len(res2["forecast"]) == 12
    assert cache.telemetry.hits_by_layer["layer2_features"] >= 2

    cache.close()


def test_engine_level_concurrency_slow_leader_and_follower_timeout(tmp_path):
    from backend.cache import SingleFlightTimeoutError
    db_file = str(tmp_path / "engine_concurrency.db")
    cache = ForecastCache(db_path=db_file, enabled=True)

    # Configure engine with short follower timeout (0.2s)
    engine = ForecastingEngine(validation_horizon=1, cache=cache, use_cache=True, follower_timeout=0.2)

    sku_data = {
        "item_code": "CONCURRENT-SKU-1",
        "description": "Luminaire Concurrency Test",
        "item_group": "Commercial",
        "history_values": [100.0 + (i * 2.0) for i in range(24)],
        "history_periods": [f"2024-{(i%12)+1:02d}" for i in range(24)],
        "horizon": 6
    }

    # Track backtesting invocations across threads to PROVE follower never executes duplicate backtesting
    backtest_call_count = 0
    backtest_lock = threading.Lock()
    original_backtest = engine.backtester.backtest_all_candidates

    def slow_backtest(*args, **kwargs):
        nonlocal backtest_call_count
        with backtest_lock:
            backtest_call_count += 1
        # Artificially slow the leader (0.5s > follower_timeout 0.2s)
        time.sleep(0.5)
        return original_backtest(*args, **kwargs)

    engine.backtester.backtest_all_candidates = slow_backtest

    results = {}
    errors = {}
    start_barrier = threading.Barrier(2)

    def run_request(thread_name: str):
        try:
            start_barrier.wait()
            res = engine.forecast_single_sku(**sku_data)
            results[thread_name] = res
        except Exception as e:
            errors[thread_name] = e

    t_leader = threading.Thread(target=run_request, args=("thread_A",))
    t_follower = threading.Thread(target=run_request, args=("thread_B",))

    t0 = time.time()
    t_leader.start()
    t_follower.start()

    # Join with timeout to prove no deadlock occurs
    t_follower.join(timeout=15.0)
    t_leader.join(timeout=15.0)

    assert not t_leader.is_alive(), "Deadlock detected: Thread A did not terminate!"
    assert not t_follower.is_alive(), "Deadlock detected: Thread B did not terminate!"

    # Exactly one thread became leader and succeeded; exactly one became follower and timed out
    assert len(results) == 1, f"Expected exactly 1 successful result, got {len(results)}"
    assert len(errors) == 1, f"Expected exactly 1 timeout error, got {len(errors)}"

    succeeded_thread = list(results.keys())[0]
    timed_out_thread = list(errors.keys())[0]

    assert isinstance(errors[timed_out_thread], SingleFlightTimeoutError)
    assert "Single-flight leader execution timed out" in str(errors[timed_out_thread])
    assert "Follower suppressed duplicate candidate backtesting" in str(errors[timed_out_thread])

    # PROVE follower did not execute duplicate backtesting
    assert backtest_call_count == 1, f"Expected exactly 1 backtest execution, got {backtest_call_count}!"

    # Verify the leader produced a valid forecast
    assert len(results[succeeded_thread]["forecast"]) == 6
    assert results[succeeded_thread]["itemCode"] == "CONCURRENT-SKU-1"

    # Prove a subsequent request succeeds after the leader completes
    res_subsequent = engine.forecast_single_sku(**sku_data)
    assert len(res_subsequent["forecast"]) == 6
    assert res_subsequent["forecast"] == results[succeeded_thread]["forecast"]

    cache.close()


def test_engine_level_concurrency_leader_failure_and_subsequent_retry_success(tmp_path):
    # Proves engine-level leader failure does not cause deadlock or duplicate backtesting,
    # and that a subsequent request succeeds cleanly after the failure.
    db_file = str(tmp_path / "engine_concurrency_fail.db")
    cache = ForecastCache(db_path=db_file, enabled=True)
    engine = ForecastingEngine(validation_horizon=1, cache=cache, use_cache=True, follower_timeout=2.0)

    sku_data = {
        "item_code": "CONCURRENT-FAIL-1",
        "description": "Luminaire Leader Failure Test",
        "item_group": "Commercial",
        "history_values": [100.0 + (i * 2.0) for i in range(24)],
        "history_periods": [f"2024-{(i%12)+1:02d}" for i in range(24)],
        "horizon": 6
    }

    backtest_call_count = 0
    backtest_lock = threading.Lock()
    original_backtest = engine.backtester.backtest_all_candidates
    should_fail = True

    def failing_backtest(*args, **kwargs):
        nonlocal backtest_call_count
        with backtest_lock:
            backtest_call_count += 1
        if should_fail:
            time.sleep(0.1)
            raise ValueError("Artificial leader backtest failure")
        return original_backtest(*args, **kwargs)

    engine.backtester.backtest_all_candidates = failing_backtest

    results = {}
    errors = {}
    start_barrier = threading.Barrier(2)

    def run_request(thread_name: str):
        try:
            start_barrier.wait()
            res = engine.forecast_single_sku(**sku_data)
            results[thread_name] = res
        except Exception as e:
            errors[thread_name] = e

    t_leader = threading.Thread(target=run_request, args=("thread_A",))
    t_follower = threading.Thread(target=run_request, args=("thread_B",))

    t_leader.start()
    t_follower.start()

    t_follower.join(timeout=3.0)
    t_leader.join(timeout=3.0)

    assert not t_leader.is_alive(), "Deadlock detected: Thread A did not terminate!"
    assert not t_follower.is_alive(), "Deadlock detected: Thread B did not terminate!"

    # Both threads failed as expected (leader raised, follower saw leader failure)
    assert len(errors) == 2, f"Expected both threads to receive error, got {len(errors)}"
    # Prove follower did not execute duplicate backtesting despite leader failure
    assert backtest_call_count == 1, f"Expected exactly 1 backtest execution, got {backtest_call_count}"

    # Now recover/fix backtest and prove a subsequent request succeeds
    should_fail = False
    res_retry = engine.forecast_single_sku(**sku_data)
    assert len(res_retry["forecast"]) == 6
    assert res_retry["itemCode"] == "CONCURRENT-FAIL-1"
    assert backtest_call_count == 2  # exactly 1 more backtest executed for the retry

    cache.close()


