# Demandora Empirical Performance & Benchmark Methodology

This document records verified execution timings, cache efficiency metrics, and hardware conditions from reproducible forecasting runs on Demandora.

---

## 1. Test Environment & Benchmark Hardware

- **Host Machine**: 8-Core Intel64 Processor, Windows 11 64-bit
- **Worker Concurrency**: 8 parallel worker threads
- **Python Runtime**: Python 3.12.10
- **Node.js Runtime**: Node.js v20.x
- **Database Subsystem**: SQLite 3 (WAL mode, synchronous=NORMAL, 256 MB MMAP)
- **Dataset Evaluated**: Two-year production historical dataset (2,094 SKUs across 24 monthly periods: `2024-04` through `2026-03`)

---

## 2. Benchmark Scenarios & Recorded Timings

All metrics below are drawn directly from active telemetry recorded in `forecast_jobs` in `backend/cache_data/forecast_cache.db`:

| Benchmark Scenario | Job ID | Total SKUs | Cache Hit Ratio | Elapsed Time | Average per SKU | Validation Windows Completed |
|---|---|---:|---:|---:|---:|---:|
| **Cold Portfolio (Initial Ingestion)** | `job_65f1138df0d3` | 2,094 | 44.11% | **1,409.95 s** (~23.5 min) | 673.27 ms | 129,659 windows |
| **Partial Cache (Horizon Adjustment)** | `job_19dd3f3a21e9` | 2,094 | 99.33% | **393.67 s** (~6.5 min) | 187.84 ms | Cache re-use |
| **High Cache (Re-run with Preserved Models)** | `job_09fafa4aac84` | 2,094 | 86.63% | **353.17 s** (~5.9 min) | 168.61 ms | Cache re-use |
| **Warm Identical Portfolio** | `job_d2d3223eb099` | 2,094 | 99.66% | **123.72 s** (~2.06 min) | 59.04 ms | 515,436 windows avoided |
| **Supply-Only / MRP Delta Updates** | Client MRP | 2,094 | N/A | **< 1.5 s** | < 1 ms | 0 (No ML retraining) |

---

## 3. Analysis of Execution Profiles

### Cold Execution (~23.5 minutes)
- Every mature SKU is evaluated across 12 distinct expanding walk-forward windows for up to 9 candidate models.
- Total candidate model fits and validations exceed 129,000 evaluations.
- Histogram-based gradient boosting models (`HistGradientBoostingRegressor`) construct supervised lag/rolling feature matrices dynamically.

### Warm Execution (~2.06 minutes)
- When re-running the same dataset, the 5-layer cache hits Layer 1 (Profiles), Layer 2 (Features), and Layer 3 (Backtest leaderboards).
- 40,330 redundant model fits and 515,436 validation window evaluations are completely avoided.
- Processing time drops from 673 ms per SKU to 59 ms per SKU.

### Supply Delta Updates (< 1.5 seconds)
- When a planner updates inventory on-hand balances, modifies open purchase orders, or adjusts MOQ parameters, **zero machine-learning models are re-trained**.
- The client-side gross-to-net MRP engine recalculates net requirements, order rounding, and BOM shortages across all 2,094 SKUs in under 15 milliseconds.
