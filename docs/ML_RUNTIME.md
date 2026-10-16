# Machine Learning Runtime Evaluation & Specification

> **Phase 0: Runtime Determination & Architectural Boundary**

---

## 1. Selected Runtime Architecture

```
+-------------------------------------------------------+
|                 REACT / TYPESCRIPT CLIENT              |
|                     (Vite / Port 5173)                |
|                                                       |
|  - Excel (.xlsx) file intake & client-side parsing    |
|  - Schema normalization & natural-key deduplication   |
|  - Planner review & >20% adjustment remarks           |
|  - MRP Net Requirement & BOM component explosion      |
|  - Visual workspaces (Forecast Grid, Intelligence)    |
+---------------------------+---------------------------+
                            |
                     REST / HTTP JSON
               (e.g., http://127.0.0.1:8000)
                            |
+---------------------------v---------------------------+
|             PYTHON ML FORECASTING SERVICE             |
|                   (FastAPI / Uvicorn)                 |
|                                                       |
|  - Automated Data Profiling & Continuity Check        |
|  - Temporal Feature Engineering (Lags, Windows)       |
|  - Candidate Models:                                  |
|      * Statistical: Naive, Mean, SMA, WMA, Drift     |
|      * Exponential Smoothing: Holt's Linear, HW      |
|      * Machine Learning: HistGradientBoosting, Ridge |
|  - Walk-Forward Cross-Validation (TimeSeriesSplit)    |
|  - Empirical Confidence Intervals (Residual variance) |
|  - Feature Importance & Driver Attribution            |
+-------------------------------------------------------+
```

---

## 2. Why Python is the Superior Runtime for Forecasting ML

Executing genuine machine learning in a browser-based JavaScript engine (or simulated JS functions) suffers from fundamental limitations:

| Evaluation Dimension | Browser JavaScript (Node/V8) | Python ML Runtime (pandas, numpy, scikit-learn) |
| :--- | :--- | :--- |
| **Numeric Vectorization** | Single-threaded loops, boxed numbers, GC pressure on large matrices. | Highly optimized C/Fortran/BLAS backends via NumPy for vectorized array math. |
| **Model Ecosystem** | Immature time-series ML libraries; JS implementations are usually abandoned hobby ports. | Battle-tested, mathematically rigorous implementations in `scikit-learn`, `statsmodels`, and `scipy`. |
| **Non-Linear Optimizers** | Limited Nelder-Mead or gradient descent solvers; prone to convergence failure in JS. | Robust L-BFGS-B, SLSQP, and Powell solvers in `scipy.optimize` for parameter estimation. |
| **Tree Ensembles** | No production LightGBM or HistGradientBoosting runtime in client JS. | Native histogram-based gradient boosting (`HistGradientBoostingRegressor`) with fast binning and missing value support. |
| **UI Responsiveness** | Complex backtesting on 2,000 SKUs blocks the UI main thread or requires Web Worker serialization. | Asynchronous offloading: React remains 60 FPS while the service processes batches concurrently. |

---

## 3. Technology Stack & Library Allocation

The host environment has verified availability of **Python 3.12.10** with the following production libraries pre-installed:

1. **Python 3.12**:
   - Modern, high-performance async execution runtime.
2. **FastAPI (0.141.1) + Uvicorn (0.52.3)**:
   - Ultra-low latency asynchronous API layer with automatic OpenAPI/Pydantic validation.
3. **NumPy (2.5.2) & Pandas (3.0.5)**:
   - Efficient column-oriented time-series indexing, rolling window aggregations, lag formulations, and missing value interpolations.
4. **Scikit-Learn (1.9.0)**:
   - `HistGradientBoostingRegressor` for gradient boosted decision tree forecasting.
   - `RidgeCV` / `ElasticNetCV` for penalized autoregression.
   - `TimeSeriesSplit` for leak-free walk-forward temporal cross-validation.
5. **SciPy (1.18.0)**:
   - Mathematical optimization for exponential smoothing parameters ($\alpha, \beta, \gamma$).

---

## 4. Communication Protocol & Error Resilience

1. **Decoupled Architecture**:
   - The React frontend does not depend on Python to boot or ingest Excel files.
   - The user can import Excel, view workbook sheets, inspect column mappings, review inventory positions, and browse BOM structures even if the ML service is initializing.
2. **Graceful Degradation / Service Status**:
   - The frontend queries `GET /health` on the forecasting service.
   - If the ML service is offline, the UI displays a clean status indicator: `AI ENGINE · CONNECTING TO LOCAL ML SERVICE` with instructions on launching the service.
3. **Determinism & Reproducibility**:
   - Random seeds are fixed (`random_state=42`) across cross-validation splits and tree training to guarantee identical forecasts given identical Excel inputs.
