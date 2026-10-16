# Demandora — Forecasting Architecture Audit

> **Architectural Specification & Baseline Audit**  
> This document records the core architecture of Demandora's AI demand forecasting and supply planning system.

---

## 1. Baseline System Architecture

### A. Current Excel Ingestion Flow
1. **File Drop / Binary Intake**:
   - Location: `src/components/ExcelImportModal.tsx` and `src/services/excelService.ts`.
   - The user drops or selects an `.xlsx` workbook via an HTML file input or Drag & Drop API.
   - The file is read via `FileReader.readAsArrayBuffer()` and passed to `parseExcelWorkbook(binary, fileName)`.
2. **Sheet Detection**:
   - `XLSX.read(binary)` parses the workbook into SheetJS sheets.
   - Detected sheet names are matched case-insensitively against keywords:
     - `Item Master` / `Items` / `Products`
     - `Sales History` / `Sales` / `Demand` / `Transactions`
     - `Inventory` / `Stock` / `OnHand`
     - `Open Sales Orders` / `Sales Orders` / `Orders` / `SO`
     - `Purchase Orders` / `PO`
     - `BOM` / `Bill of Materials` / `Components`
     - `Accuracy` / `Forecast Accuracy` / `Benchmark`
3. **Column Recognition & Mapping**:
   - `HEADER_ALIASES` dictionary maps common Excel column header variations (e.g., `"Item Code"`, `"SKU"`, `"ItemNo"` $\rightarrow$ `itemCode`).
4. **Validation & Deduplication**:
   - SKU presence, mandatory columns, numeric quantities, and non-empty dates are validated.
   - If merging incrementally into an existing dataset (`mergeIncrementalDataset`), records are deduplicated using a natural compound key:
     $$\text{Key} = \text{itemCode} + \text{period} + \text{orderType}$$

---

### B. Current Normalized Dataset Structure
The normalized dataset is defined in `src/types.ts` as `NormalizedDataset`:
```typescript
interface NormalizedDataset {
  metadata: {
    sourceName: string;
    importedAt: string;
    isDemo: boolean;
  };
  dataVersion: number; // Increments on each incremental merge
  items: ItemMaster[]; // SKU, description, group, make/buy, MOQ, order multiple
  salesHistory: SalesRecord[]; // itemCode, period (YYYY-MM), quantity, orderType
  inventory: InventoryPosition[]; // itemCode, warehouse, onHandStock
  openOrders: OpenOrder[]; // itemCode, type (PO/SO), quantity, expectedDate
  boms: BomLink[]; // parentItemCode, componentItemCode, componentQty, scrapFactor
  accuracyRecords?: AccuracyRecord[]; // Optional historical forecast vs actual benchmarks
  historySummary: {
    totalObservations: number;
    itemsWithHistory: number;
    earliestPeriod: string;
    latestPeriod: string;
    totalMonths: number;
    incrementalStats?: {
      newObservations: number;
      updatedObservations: number;
      duplicatesIgnored: number;
    };
  };
}
```

---

### C. Current Forecasting Engine Flow
Located in `src/services/forecastingEngine.ts` (`executeForecastEngine`):
1. **Scope & Window Filtering**:
   - Extracts `startMonth` (e.g., `2026-11`) and `horizon` (default 6 months).
   - Groups sales history by `itemCode` and sorts chronologically.
   - Caps history to the planner's selected window (`historyPeriod`, e.g., 24 months) or uses all available periods if shorter.
2. **Item-Level Evaluation**:
   - For each item, calls `evaluateAndForecastItem(history, periods, horizon, startMonthNum, params, openSo, isNewItem, isDiscontinued)`.
   - Selects an internal tier based on history length ($N$).
3. **Net Requirement & Inventory Rules**:
   - Aggregates on-hand stock and open PO/SO by item code.
   - Calculates Net Requirement:
     $$\text{Net Requirement} = \max(0, \text{Final Quantity} + \text{Firm Open SO} - \text{Stock} - \text{Open PO})$$
   - Applies MOQ and Order Multiple step rounding.
4. **Summary & Portfolio KPIs**:
   - Calculates total AI forecast, total net requirement, low confidence count, shortage count, baseline YoY growth, and overall portfolio readiness tier.

---

### D. Current Pseudo-ML Implementations (Explicit Audit)

> [!CAUTION]
> **CRITICAL AUDIT FINDING: Pseudo-ML Identification**  
> The implementations currently labeled with machine-learning terminology in `src/services/forecastingEngine.ts` are **NOT genuine machine learning algorithms**. They are deterministic, manually written JavaScript approximations and static formulas.

#### 1. "Gradient Boosted Autoregressive ML"
- **File**: `src/services/forecastingEngine.ts` (lines 397–420)
- **Code**:
  ```typescript
  let pred = 0.40 * rm3 + 0.25 * rm6 + 0.20 * l1 + 0.15 * l6;
  if (params.seasonality) pred *= SEASONAL_INDEX[mIdx];
  ```
- **Reality**: This is **NOT** a gradient boosted tree model (such as XGBoost, LightGBM, or CatBoost). It is a fixed, hand-coded linear combination of trailing moving averages and lags. There is no loss function optimization, no gradient computation, no decision trees, no leaf splits, and no iterative boosting.

#### 2. "Multi-Model Seasonal Ensemble (LightGBM + Holt-Winters)"
- **File**: `src/services/forecastingEngine.ts` (lines 519–541)
- **Code**:
  ```typescript
  const yoyGrowth = pTotal > 0 ? (rTotal - pTotal) / pTotal : 0.05;
  const clampedGrowth = Math.min(Math.max(yoyGrowth, -0.25), 0.35);
  let q = Math.round(basePerMonth * (1 + clampedGrowth * 0.5) * seasonFactor);
  ```
- **Reality**: This is **NOT** LightGBM and **NOT** a trained ensemble. It is an unweighted annual percentage change multiplied by a hardcoded seasonal factor. No gradient-boosted decision trees exist in the JavaScript runtime.

#### 3. "Auto-ARIMA (SARIMAX proxy)"
- **File**: `src/services/forecastingEngine.ts` (lines 554–570)
- **Code**:
  ```typescript
  const lastDiff = (diff[diff.length - 1] + diff[diff.length - 2]) / 2;
  curr += lastDiff * 0.8;
  ```
- **Reality**: This is **NOT** ARIMA and **NOT** SARIMAX. Real ARIMA/SARIMAX requires Box-Jenkins stationarity testing, differencing order selection ($d, D$), autocorrelation/partial autocorrelation fitting, and Maximum Likelihood Estimation (MLE) or least squares optimization over AR($p$) and MA($q$) polynomials with seasonal parameters ($P, D, Q, s$). The current implementation simply computes a 2-period average difference and scales it by 0.8.

#### 4. "Feature Engineering"
- **File**: `src/services/forecastingEngine.ts` (lines 69–75)
- **Code**:
  ```typescript
  const featuresUsed: string[] = [];
  if (N >= 3) featuresUsed.push('lag_1', 'lag_2', 'rolling_mean_2', 'short_term_trend');
  if (N >= 12) featuresUsed.push('lag_6', 'month_of_year', 'festive_lead_indicator');
  ```
- **Reality**: No numerical feature matrix ($X$) is ever constructed, scaled, normalized, or fed into an estimator. The code merely populates strings into an informational UI list.

---

### E. Current Statistical Implementations
The simpler statistical methods in `forecastingEngine.ts` are standard arithmetic:
1. **Naive Last-Observation / Mean**:
   - `history.reduce((a, b) => a + b, 0) / N`
2. **Simple Moving Average (SMA-3)**:
   - Arithmetic average of trailing 3 periods.
3. **Weighted Moving Average (WMA-3)**:
   - `data[len - 3] * 0.2 + data[len - 2] * 0.3 + data[len - 1] * 0.5`
4. **Linear Trend Extrapolation**:
   - Ordinary least-squares slope calculated over period index $0 \dots N-1$.
5. **Holt's Double Exponential Smoothing**:
   - Recursive level and trend updating with fixed hyperparameters ($\alpha = 0.35, \beta = 0.15$). It lacks numerical optimization (e.g. L-BFGS-B minimizing sum of squared errors).
6. **Seasonal Multipliers**:
   - Hardcoded 12-month array `SEASONAL_INDEX = [0.92, 0.95, ..., 1.08]`. It is not dynamically decomposed from the incoming SKU demand series.

---

### F. Current Backtesting Implementation
- **Mechanism**:
  - In Tier 2: A 1-period holdout comparing predictions on period $N-1$ against actual $N$.
  - In Tier 3: A 2-period walk-forward comparing holdouts for periods $N-1$ and $N$.
  - In Tier 4: A 3-period walk-forward comparing holdouts for periods $N-2, N-1, N$.
  - In Tier 5: A 6-period holdout comparing holdouts for periods $N-5 \dots N$.
- **Model Selection**:
  - Runs the candidate JavaScript formulas over the truncated series, calculates WAPE against the holdout slice, and picks the function with the lowest scalar WAPE.

---

### G. Current Confidence Calculation
Confidence is calculated via heuristic empirical formulas clamped within hard boundaries:
- **Tier 1 (1–2M)**: $25.0 + N \times 4$ (clamped at 34%)
- **Tier 2 (3–5M)**: $40.0 + (N - 3) \times 5.0 - (\text{bestWape} \times 0.15)$ (clamped 35%–55%)
- **Tier 3 (6–11M)**: $56.0 + (N - 6) \times 2.5 - (\text{bestWape} \times 0.2)$ (clamped 52%–72%)
- **Tier 4 (12–23M)**: $72.0 + (N - 12) \times 1.1 - (\text{bestWape} \times 0.25)$ (clamped 65%–85%)
- **Tier 5 (24M+)**: $85.0 - (\text{bestWape} \times 0.4) + (\text{openSO} > 0 ? 4 : 0)$ (clamped 78%–97.5%)
- **Limitation**: Not derived from prediction variance, standard error of the residuals, or formal conformal prediction intervals.

---

### H. Current UI → Forecasting-Engine Dependencies
The React application directly imports and invokes the forecasting engine in:
1. `src/App.tsx`:
   - Imports `executeForecastEngine` directly from `src/services/forecastingEngine.ts`.
   - Computes `forecastResult` synchronously via `useMemo` whenever `dataset`, `parameters`, or `existingLines` change.
2. `src/components/DatasetStagingView.tsx`:
   - Directly displays heuristic tiers (`Tier 1` through `Tier 5`) and references candidate algorithms.
3. `src/components/ForecastWorkspace.tsx` & `src/components/ForecastGrid.tsx`:
   - Expects `ForecastLine` structures containing `monthlyForecast`, `confidencePct`, `demandSignal`, and `modelDecision`.
4. `src/components/DemandIntelligenceView.tsx`:
   - References `SEASONAL_INDEX` directly to render the Indian festive seasonality chart.

---

### I. Current Persistence & Versioning
- **Storage**: `localStorage` key `'LEDURE_SUPPLY_INTEL_V4'`.
- **Payload**: Serializes `dataset`, `parameters`, `existingLines`, `status`, `version`, `versions` array, and `isForecastGenerated`.
- **Versioning**: When a forecast is regenerated, submitted, or edited, a snapshot object `{ version, timestamp, status, author, linesSnapshot }` is prepended to `versions[]`.

---

### J. Known Problems to be Replaced in Phase 1
1. **Absence of Real Estimators**: The client application claims advanced algorithms that are currently arithmetic proxies.
2. **Main Thread Computation**: As SKU counts scale to thousands of items, running multi-period backtesting loops inside React will cause UI thread lockups and dropped frames.
3. **Static Seasonality**: Hardcoded festive indices fail to capture SKU-specific seasonal variations (e.g., streetlights vs. decorative Diwali lights).
4. **Heuristic Confidence**: Confidence must be grounded in empirical forecast residuals and prediction intervals, not hardcoded scalar offsets.
5. **Coupled Business Rules**: Forecasting math and MRP inventory net requirement calculations are currently bundled in the same file.

---

## 2. Intended Target Architecture

```
Excel Workbook (.xlsx)
        ↓
Ingestion (SheetJS)
        ↓
Normalization (Typed Domain Entities)
        ↓
Data Profiling & Quality Scoring
        ↓
History Detection (Empirical Depth per SKU)
        ↓
Feature Engineering (Lags, Rolling Means, Calendar/Holiday Regressors)
        ↓
Candidate Model Suite (Naive, SMA, WMA, Linear Trend, Holt, Gradient Boosting)
        ↓
Walk-Forward Backtesting (Temporal Holdouts)
        ↓
Model Selection (Minimum Holdout Error WAPE/MAE)
        ↓
Final Model Refit (Full Series)
        ↓
Multi-Period Forecast Generation
        ↓
Confidence & Prediction Intervals (Residual Standard Error)
        ↓
Business & MRP Calculations (Net Req = Final Qty - Stock - PO, MOQ, BOM Explosion)
        ↓
React UI Workspaces
```

---

## 3. Incremental Learning Flow

```
Existing Dataset (vN)
        +
New Excel Data Batch
        ↓
Deduplication & Correction (Natural Key: itemCode + period + orderType)
        ↓
Expanded Historical Series
        ↓
Re-profile (Updated data depth, trend changes)
        ↓
Re-engineer Features (New lags, updated rolling statistics)
        ↓
Re-backtest (Walk-forward evaluation over newly available periods)
        ↓
Re-select Model (Optimal model may shift, e.g. from SMA to Holt or Gradient Boosting)
        ↓
Refit Candidate Models
        ↓
New Multi-Period Forecast & Calibrated Confidence
```

> [!IMPORTANT]
> **Core Architectural Rule**:
> *"New data must not simply trigger recalculation of the existing hand-written formulas."*  
> An incremental batch must re-profile the time series, update feature matrices, run temporal backtesting across eligible model candidates, select the top performer for each SKU, and refit model parameters.
