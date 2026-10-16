"""
Comprehensive Test Suite for Cold-Start (0M) and Sparse-History (1-5M) Forecasting.

Requirements verified:
1. 0M Cold-Start:
   - Discovers mature comparable peer SKUs strictly requiring >= 6M history.
   - Derives a month-by-month chronological demand baseline from mature peer history.
   - Produces 6 distinct, traceable forecast values (M1..M6).
   - Status: COLD_START, Reliability: NOT_EVALUATED, Prediction Intervals: null.
   - No fake WAPE, no fake confidence, no arbitrary seasonal multipliers.
2. 1-5M Sparse-History:
   - Blends direct SKU track record with mature peer monthly baseline via transparent linear shrinkage:
     w = k / 6.0
     y_hat[h] = w * y_direct_mean + (1 - w) * y_peer_monthly_baseline[h]
   - Status: SPARSE_HISTORY, Reliability: NOT_EVALUATED, Prediction Intervals: null.
3. Spectrum test: 0M, 1M, 2M, 3M, 4M, 5M, 6M, 11M, 12M, 24M.
4. Exactly 6 forecast periods, non-negative quantities, deterministic output.
5. Incremental transition as history grows.
6. Real Excel regression on SAMPLE_SALE_DATA.xlsx (27 SKUs, 3M history, SPARSE_HISTORY routing).
"""

import os
import pytest
import numpy as np
import pandas as pd

from backend.cold_start import (
    extract_sku_attributes,
    calculate_sku_similarity,
    find_comparable_skus,
    compute_traceable_peer_monthly_baseline,
    generate_cold_or_sparse_forecast
)
from backend.engine import ForecastingEngine


class TestAttributeMatchingAndPeerMaturity:
    def test_attribute_extraction(self):
        attrs = extract_sku_attributes(
            item_code="LD-SP-12W-WW",
            description="Ledure 12W Warm White Slim Spotlight Fixture",
            item_group="Spotlight Series"
        )
        assert attrs["wattage"] == 12
        assert attrs["formFactor"] == "Spotlight"
        assert attrs["cct"] == "Warm White"
        assert attrs["itemGroup"] == "Spotlight Series"

    def test_similarity_scoring(self):
        target = extract_sku_attributes("LD-SP-12W-WW", "12W Spotlight Warm White", "Spotlight Series")
        peer_exact_group = extract_sku_attributes("LD-SP-12W-CW", "12W Spotlight Cool White", "Spotlight Series")
        peer_diff_watt = extract_sku_attributes("LD-SP-15W-WW", "15W Spotlight Warm White", "Spotlight Series")
        peer_diff_group = extract_sku_attributes("LD-PL-40W-CW", "40W Panel Cool White", "Panel Series")

        sim_exact = calculate_sku_similarity(target, peer_exact_group)
        sim_diff_watt = calculate_sku_similarity(target, peer_diff_watt)
        sim_diff_group = calculate_sku_similarity(target, peer_diff_group)

        assert sim_exact >= 0.85
        assert sim_diff_watt >= 0.70
        assert sim_exact > sim_diff_watt > sim_diff_group

    def test_peer_maturity_requirement_ge_6m(self):
        """
        Mature peer selection strictly requires >= 6M history.
        Items with <6M history (e.g. 3M) must NOT be selected as mature peers for 0M cold start.
        """
        target = {"itemCode": "TARGET-0M", "description": "12W Spotlight Warm White", "itemGroup": "Spotlight", "history": []}
        pool = [
            {"itemCode": "SPARSE-3M", "description": "12W Spotlight Cool White", "itemGroup": "Spotlight", "history": [100.0, 110.0, 120.0]},
            {"itemCode": "MATURE-6M", "description": "12W Spotlight Cool White", "itemGroup": "Spotlight", "history": [100.0, 110.0, 120.0, 130.0, 140.0, 150.0]},
            {"itemCode": "MATURE-12M", "description": "12W Spotlight Neutral White", "itemGroup": "Spotlight", "history": [200.0] * 12}
        ]

        peers = find_comparable_skus(target, pool, min_history_depth=6)
        peer_codes = [p["itemCode"] for p in peers]

        assert "SPARSE-3M" not in peer_codes
        assert "MATURE-6M" in peer_codes
        assert "MATURE-12M" in peer_codes


class TestColdStartAndSparseHistoryChronologicalForecasts:
    def test_0m_cold_start_chronological_peer_baseline(self):
        """
        0M SKU:
        - Discovers mature peers (>=6M)
        - Uses chronological month-by-month demand from peers
        - Yields 6 non-negative quantities (M1..M6)
        - Status: COLD_START, Reliability: NOT_EVALUATED
        - Prediction intervals: null
        - No fake WAPE
        """
        target = {"itemCode": "NEW-SKU-0M", "description": "12W Spotlight Warm White", "itemGroup": "Spotlight", "history": []}
        pool = [
            {"itemCode": "PEER-1", "description": "12W Spotlight Cool White", "itemGroup": "Spotlight", "history": [100.0, 110.0, 120.0, 130.0, 140.0, 150.0]},
            {"itemCode": "PEER-2", "description": "12W Spotlight Neutral White", "itemGroup": "Spotlight", "history": [200.0, 210.0, 220.0, 230.0, 240.0, 250.0]}
        ]

        res = generate_cold_or_sparse_forecast(target, pool, horizon=6)

        assert res["selectionStatus"] == "COLD_START"
        assert res["modelType"] == "cold_start"
        assert res["historyMonths"] == 0
        assert len(res["forecast"]) == 6
        assert len(res["rawForecast"]) == 6
        assert all(q >= 0 for q in res["forecast"])

        # Median of [100, 200] = 150, [110, 210] = 160, [120, 220] = 170, etc.
        assert res["forecast"] == [150, 160, 170, 180, 190, 200]
        assert res["selectedModelMetrics"] is None
        assert res["confidence"]["status"] == "NOT_EVALUATED"
        assert res["confidence"]["score"] is None
        assert res["confidence"]["lowerBound"] == [None] * 6
        assert res["confidence"]["upperBound"] == [None] * 6
        assert set(res["metadata"]["peer_skus"]) == {"PEER-1", "PEER-2"}

    def test_0m_cold_start_no_mature_peers(self):
        """When no >=6M peers exist, safely returns zero forecast without inventing fake demand."""
        target = {"itemCode": "ISOLATED-SKU", "description": "Exotic Product", "itemGroup": "Exotic Series", "history": []}
        sparse_pool = [
            {"itemCode": "SPARSE-PEER", "description": "Exotic Product", "itemGroup": "Exotic Series", "history": [50.0, 60.0]}
        ]
        res = generate_cold_or_sparse_forecast(target, sparse_pool, horizon=6)

        assert res["selectionStatus"] == "COLD_START"
        assert res["forecast"] == [0, 0, 0, 0, 0, 0]
        assert res["confidence"]["status"] == "NOT_EVALUATED"

    @pytest.mark.parametrize("k", [1, 2, 3, 4, 5])
    def test_sparse_history_monthly_shrinkage(self, k):
        """
        1-5M SKUs:
        w = k / 6.0
        y_hat[h] = w * direct_mean + (1 - w) * peer_baseline[h]
        """
        direct_sales = [300.0] * k
        target = {"itemCode": f"SPARSE-{k}M", "description": "12W Spotlight Warm White", "itemGroup": "Spotlight", "history": direct_sales}
        pool = [
            {"itemCode": "PEER-1", "description": "12W Spotlight Cool White", "itemGroup": "Spotlight", "history": [100.0, 110.0, 120.0, 130.0, 140.0, 150.0]}
        ]

        res = generate_cold_or_sparse_forecast(target, pool, horizon=6)

        assert res["selectionStatus"] == "SPARSE_HISTORY"
        assert res["historyMonths"] == k
        assert len(res["forecast"]) == 6
        assert res["selectedModelMetrics"] is None
        assert res["confidence"]["status"] == "NOT_EVALUATED"
        assert res["confidence"]["lowerBound"] == [None] * 6
        assert res["confidence"]["upperBound"] == [None] * 6

        w = k / 6.0
        # Check M1: direct=300, peer[0]=100 => w*300 + (1-w)*100
        expected_m1 = round((w * 300.0) + ((1.0 - w) * 100.0), 2)
        # Check M6: direct=300, peer[5]=150 => w*300 + (1-w)*150
        expected_m6 = round((w * 300.0) + ((1.0 - w) * 150.0), 2)

        assert res["forecast"][0] == int(round(expected_m1))
        assert res["forecast"][5] == int(round(expected_m6))
        assert res["metadata"]["direct_weight"] == round(w, 3)
        assert res["metadata"]["peer_weight"] == round(1.0 - w, 3)


class TestFullHistorySpectrumRouting:
    """
    Tests engine routing across the full spectrum:
    0M, 1M, 2M, 3M, 4M, 5M, 6M, 11M, 12M, 24M
    """
    def test_spectrum_routing(self):
        engine = ForecastingEngine()
        peer_pool = [
            {"itemCode": "MATURE-PEER", "description": "12W Spotlight Cool White", "itemGroup": "Spotlight", "history": [100.0 + i*5 for i in range(24)]}
        ]

        # 0M
        r0 = engine.forecast_single_sku("SKU-0M", [], description="12W Spotlight Warm White", item_group="Spotlight", candidate_pool=peer_pool)
        assert r0["selectionStatus"] == "COLD_START"
        assert r0["confidence"]["status"] == "NOT_EVALUATED"
        assert len(r0["forecast"]) == 6
        assert all(q >= 0 for q in r0["forecast"])

        # 1M to 5M
        for m in [1, 2, 3, 4, 5]:
            r_m = engine.forecast_single_sku(f"SKU-{m}M", [120.0]*m, description="12W Spotlight Warm White", item_group="Spotlight", candidate_pool=peer_pool)
            assert r_m["selectionStatus"] == "SPARSE_HISTORY"
            assert r_m["confidence"]["status"] == "NOT_EVALUATED"
            assert len(r_m["forecast"]) == 6

        # 6M and 11M (Insufficient for walk-forward)
        for m in [6, 11]:
            r_insuf = engine.forecast_single_sku(f"SKU-{m}M", [120.0]*m, description="12W Spotlight Warm White", item_group="Spotlight")
            assert r_insuf["selectionStatus"] == "INSUFFICIENT_HISTORY"
            assert r_insuf["confidence"]["status"] == "NOT_EVALUATED"
            assert len(r_insuf["forecast"]) == 6

        # 12M and 24M (Walk-forward model selection)
        for m in [12, 24]:
            r_mature = engine.forecast_single_sku(f"SKU-{m}M", [100.0 + (i%4)*20 for i in range(m)], description="12W Spotlight Warm White", item_group="Spotlight")
            assert r_mature["selectionStatus"] == "SELECTED"
            assert r_mature["selectedModelMetrics"] is not None
            assert len(r_mature["forecast"]) == 6


class TestBatchAndExcelRegression:
    def test_heterogeneous_batch_forecast(self):
        """
        Mixed batch containing:
        - SKU A = 0M
        - SKU B = 3M
        - SKU C = 8M
        - SKU D = 18M
        - SKU E = 28M
        """
        engine = ForecastingEngine()
        batch_items = [
            {"itemCode": "SKU-A", "description": "12W Spotlight Warm White", "itemGroup": "Spotlight", "history": []},
            {"itemCode": "SKU-B", "description": "12W Spotlight Cool White", "itemGroup": "Spotlight", "history": [80.0, 90.0, 100.0]},
            {"itemCode": "SKU-C", "description": "40W Panel Cool White", "itemGroup": "Panel", "history": [50.0] * 8},
            {"itemCode": "SKU-D", "description": "12W Spotlight Neutral White", "itemGroup": "Spotlight", "history": [100.0 + (i%3)*10 for i in range(18)]},
            {"itemCode": "SKU-E", "description": "40W Panel Warm White", "itemGroup": "Panel", "history": [60.0 + (i%5)*15 for i in range(28)]},
        ]

        batch_response = engine.forecast_batch(batch_items, horizon=6)
        results = {r["itemCode"]: r for r in batch_response["results"]}

        # Check SKU A (0M) -> COLD_START with mature peers found in batch (SKU-D)
        assert results["SKU-A"]["selectionStatus"] == "COLD_START"
        assert len(results["SKU-A"]["forecast"]) == 6
        assert results["SKU-A"]["confidence"]["status"] == "NOT_EVALUATED"

        # Check SKU B (3M) -> SPARSE_HISTORY
        assert results["SKU-B"]["selectionStatus"] == "SPARSE_HISTORY"
        assert len(results["SKU-B"]["forecast"]) == 6
        assert results["SKU-B"]["confidence"]["status"] == "NOT_EVALUATED"

        # Check SKU C (8M) -> INSUFFICIENT_HISTORY
        assert results["SKU-C"]["selectionStatus"] == "INSUFFICIENT_HISTORY"
        assert len(results["SKU-C"]["forecast"]) == 6

        # Check SKU D (18M) -> SELECTED
        assert results["SKU-D"]["selectionStatus"] == "SELECTED"
        assert results["SKU-D"]["selectedModelMetrics"] is not None

        # Check SKU E (28M) -> SELECTED
        assert results["SKU-E"]["selectionStatus"] == "SELECTED"
        assert results["SKU-E"]["selectedModelMetrics"] is not None

    def test_sample_sale_data_excel_regression(self):
        """
        Loads SAMPLE_SALE_DATA.xlsx and runs real batch forecasting on all 27 SKUs (3M history).
        Verifies:
        - 27 SKUs loaded
        - 3M history detected
        - SPARSE_HISTORY routing for all SKUs
        - 6 forecast periods returned for each SKU
        - Non-negative integer forecasts
        """
        excel_path = os.path.join(os.path.dirname(__file__), "..", "..", "src", "services", "testdata", "SAMPLE_SALE_DATA.xlsx")
        if not os.path.exists(excel_path):
            excel_path = os.path.join(os.path.dirname(__file__), "..", "..", "SAMPLE_SALE_DATA.xlsx")
        
        assert os.path.exists(excel_path), f"Excel fixture not found at {excel_path}"

        # Find header row containing 'Code'
        raw = pd.read_excel(excel_path, header=None)
        header_idx = None
        for idx, row in raw.iterrows():
            if any('code' == str(v).strip().lower() for v in row.values):
                header_idx = idx
                break
        
        assert header_idx is not None, "Could not find 'Code' header in SAMPLE_SALE_DATA.xlsx"
        df = pd.read_excel(excel_path, header=header_idx)
        assert not df.empty

        # Extract items
        items_dict = {}
        for _, row in df.iterrows():
            code = str(row['Code']).strip()
            if not code or code == 'nan':
                continue
            # Month columns are the trailing numeric columns (e.g. 2026-03, 2026-04, 2026-05)
            month_cols = [c for c in df.columns if '2026' in str(c) or '26' in str(c)]
            hist = [float(row[c]) if pd.notna(row[c]) else 0.0 for c in month_cols]
            desc = str(row.get('Name', code))
            group = str(row.get('Series', 'General Lighting'))
            items_dict[code] = {
                "itemCode": code,
                "history": hist,
                "description": desc,
                "itemGroup": group
            }

        batch_payload = list(items_dict.values())
        assert len(batch_payload) == 27, f"Expected 27 SKUs, got {len(batch_payload)}"

        engine = ForecastingEngine()
        res = engine.forecast_batch(batch_payload, horizon=6)
        assert res["totalItemsProcessed"] == 27

        for r in res["results"]:
            assert r["historyMonths"] == 3
            assert r["selectionStatus"] == "SPARSE_HISTORY"
            assert len(r["forecast"]) == 6
            assert all(q >= 0 for q in r["forecast"])
            assert r["confidence"]["status"] == "NOT_EVALUATED"
