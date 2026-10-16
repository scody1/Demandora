# FORECAST CONFIDENCE AND UNCERTAINTY (PHASE 5)

## 1. Forecast Reliability Methodology
Forecast Reliability explicitly replaces arbitrary confidence percentage scores with an evidence-based assessment of model robustness. It is derived using a rigorous geometric mean of normalized evidence components.

**THIS SCORE IS A FORECAST RELIABILITY DIAGNOSTIC.**
**IT IS NOT A PROBABILITY OF FORECAST CORRECTNESS.**

### Evidence Components
The current implementation mathematically defines four evidence scores, bounded in (0,1]:

A. **Accuracy Evidence**
`accuracy_evidence = 1 / (1 + WAPE / 100)`

B. **Bias Evidence**
`bias_evidence = 1 / (1 + abs(Bias) / 100)`

C. **Interval Width Evidence**
For each forecast:
`relative_width = (upperBound - lowerBound) / max(pointForecast, 1)`
Then:
`avg_width = mean(relative_width)`
`interval_evidence = 1 / (1 + avg_width)`

D. **Stability Evidence**
Using historical validation errors:
`mean_abs_error = mean(abs(errors))`
`std_error = std(errors)`
`cov = std_error / max(mean_abs_error, 1)`
`stability_evidence = 1 / (1 + cov)`

### Combined Reliability Formulation
The combined reliability represents a weighted geometric mean. These weights are product-level diagnostic weights used to summarize multiple observed forecast-quality signals. They are NOT statistically estimated probabilities and the score is NOT calibrated probability.

**Current Weights:**
- Accuracy = 40%
- Bias = 20%
- Prediction interval width = 30%
- Stability = 10%

`reliability_normalized = accuracy_evidence^0.4 * bias_evidence^0.2 * interval_evidence^0.3 * stability_evidence^0.1`

Then:
`score = round(reliability_normalized * 100, 1)`

## 2. Reliability Categories
This is an operational diagnostic categorization, not a statistically calibrated probability threshold. The current implementation uses:

- **HIGH**: `score >= 75`
- **MEDIUM**: `score >= 50 and < 75`
- **LOW**: `score < 50`

**Insufficient-Data Behavior (NOT_EVALUATED):**
If `validation windows < 3`:
- `status = NOT_EVALUATED`
- `level = NOT_EVALUATED`
- `score = null`

## 3. Reliability Reasons
Diagnostic reasons are provided directly from actual evidence evaluating the quality of the backtested model. Generated reasons include:
- Insufficient validation windows (if windows < 3)
- Strong/weak out-of-sample accuracy
- Significant bias
- Wide prediction intervals

The system does not claim or generate reasons that are not directly supported by the implementation's observed error distributions.

## 4. Prediction Interval Method
The system implements Empirical Residual Quantiles for prediction intervals. 
Instead of assuming a normal distribution, the engine calculates intervals based on actual out-of-sample forecast errors from chronological walk-forward backtesting.

`error = actual - prediction`

For each horizon where enough errors exist:
- `lower = pointForecast + lower empirical residual quantile`
- `upper = pointForecast + upper empirical residual quantile`

For a 90% interval:
- 5th percentile
- 95th percentile

Negative lower demand is explicitly clipped to zero since demand cannot be negative.

If horizon-specific errors are insufficient, the current implementation gracefully falls back to the flattened residual distribution across all horizons.

**Insufficient Validation Fallback:**
If total validation observations are insufficient (`validation windows < 3`):
- `lowerBound = null`
- `upperBound = null`
- `status = NOT_EVALUATED`

A null interval explicitly communicates a lack of statistical confidence. It is NOT described as zero uncertainty.

## 5. FSD Business Calculations

### Net Requirement Calculation
Calculated strictly in the business logic layer for the Forecast grid:
`Net Requirement = max(FinalQty - Stock - OpenPO, 0)`

Open Sales Orders (Open SO) remain visible in the dataset as firm demand but are strictly **not** added or double-counted into the Forecast Grid Net Requirement calculation.

### Final Quantity
Final Qty remains the Planner Adjustment if explicitly entered, otherwise it is the AI Total.

### Planning Method Validation
The system strictly honors the `Planning Method`. 
- **MRP** → numerical Net Requirement
- **anything else** → `null` / `N/A`

Items marked as `'None'` or any other methodology explicitly receive a Net Requirement of `null`.

### MOQ / Order Multiple
If applied, MOQ and Order Multiple behave sequentially AFTER the raw Net Requirement calculation:
- If `NetReq == 0`, it yields `0`.
- If `NetReq < MOQ`, it yields `MOQ`.
- If `NetReq > MOQ`, it yields `MOQ + (ceil(excess / OrderMultiple) * OrderMultiple)`.

## 6. Phase Alerts and Governance
- **Low-Reliability Warnings**: Items flagged with `LOW` reliability generate a Warning alert.
- **Forecast-Change Alerts**: An alert tracks items where the newly generated AI forecast deviates from the previously preserved `aiTotal` by > 30% (`abs(new_aiTotal - previous_aiTotal) / previous_aiTotal > 0.30`).
- **Planner Adjustment Validation**: The frontend architecture enforces a ">20% adjustment" check before saving or submitting. Remarks are required for planners modifying the AI baseline by more than 20% to preserve auditability.
