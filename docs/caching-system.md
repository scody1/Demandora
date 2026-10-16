# Demandora Caching & Performance Subsystem

Backtesting multiple candidate machine-learning and time-series models across thousands of SKUs is computationally intensive. Demandora implements a **5-layer content-addressable persistent caching subsystem** backed by SQLite in Write-Ahead Logging (WAL) mode.

---

## 1. Multi-Layer Cache Architecture

The cache is structured in hierarchical layers so that changes at one stage do not invalidate unrelated upstream calculations:

```
+-------------------------------------------------------------------------------+
| Layer 1: SKU Demand Profile Cache                                            |
| Key: SHA-256(item_code, demand_history_series)                                |
| Stores: ADI, CV², seasonality, trend, classification (Runner/Repeater/Stranger) |
+-------------------------------------------------------------------------------+
                                        |
                                        v
+-------------------------------------------------------------------------------+
| Layer 2: Engineered Feature Set Cache                                         |
| Key: SHA-256(series_hash, lag_windows, rolling_windows)                       |
| Stores: Compressed feature matrices for supervised ML models                  |
+-------------------------------------------------------------------------------+
                                        |
                                        v
+-------------------------------------------------------------------------------+
| Layer 3: Walk-Forward Backtesting Evaluation Cache                           |
| Key: SHA-256(series_hash, validation_folds, model_registry_version)           |
| Stores: Cross-validation metric leaderboards (WAPE, MAE, RMSE, Bias)          |
+-------------------------------------------------------------------------------+
                                        |
                                        v
+-------------------------------------------------------------------------------+
| Layer 4: Winning Model Artifact Cache                                         |
| Key: SHA-256(backtest_hash, winning_model_name, hyperparameters)              |
| Stores: Serialized fitted model parameters                                    |
+-------------------------------------------------------------------------------+
                                        |
                                        v
+-------------------------------------------------------------------------------+
| Layer 5: Horizon Forecast & Prediction Bounds Cache                           |
| Key: SHA-256(series_hash, winning_model_hash, horizon, confidence_level)      |
| Stores: Point forecasts, upper/lower bounds, telemetry JSON                   |
+-------------------------------------------------------------------------------+
```

---

## 2. SQLite Database Concurrency & Storage Design

The persistent cache database is located at `backend/cache_data/forecast_cache.db`.

### PRAGMA Configuration
- `journal_mode = WAL`: Write-Ahead Logging enables non-blocking concurrent readers while a single writer operates.
- `synchronous = NORMAL`: Minimizes disk I/O latency while preserving database integrity against application crashes.
- `mmap_size = 268435456` (256 MB): Memory-mapped I/O for direct memory-speed cache queries.
- `temp_store = MEMORY`: Temporary tables and indices reside in RAM.
- `cache_size = -64000`: Allocates 64 MB of page cache per database connection.

---

## 3. Selective Invalidation Logic

A critical feature of Demandora is distinguishing **demand-side changes** from **supply-side changes**:

1. **Demand-Side Changes (Sales History, Planning Horizon)**:
   - When historical sales for SKU $X$ are edited or extended, the `series_hash` for SKU $X$ changes.
   - Layers 1–5 for SKU $X$ are selectively invalidated and re-evaluated.
   - All other unaffected SKUs in the portfolio retain their cached results.

2. **Supply-Side Changes (Current Stock, Open POs, Open SOs, Lead Time, MOQ)**:
   - Supply-side parameters affect gross-to-net MRP netting, NOT customer demand behavior.
   - **Zero ML cache invalidation**: All statistical models, backtests, and point forecasts remain completely intact.
   - Gross-to-net netting recalculates in under 15 milliseconds on the client.
