# Demand Pattern Intelligence (Phase 4)

This document describes the mathematical logic and business rules implemented in the Phase 4 Demand Pattern Intelligence module (`backend/pattern_intelligence.py`).

## 1. Mathematical Formulas

### Intermittency and Lumpiness (ADI & CV²)

We use the Syntetos-Boylan criteria to classify time-series data based on Average Demand Interval (ADI) and the Squared Coefficient of Variation ($CV^2$).

**Average Demand Interval (ADI):**
The average number of periods between non-zero demands.
$$ \text{ADI} = \frac{\text{Total Periods}}{\text{Number of periods with demand} > 0} $$

**Squared Coefficient of Variation ($CV^2$):**
Measures the variance of the non-zero demands relative to the mean of the non-zero demands.
$$ CV^2 = \left( \frac{\sigma_{demand>0}}{\mu_{demand>0}} \right)^2 $$

Where:
*   $\sigma_{demand>0}$: Standard deviation of non-zero demand periods.
*   $\mu_{demand>0}$: Mean of non-zero demand periods.

**Classification Rules:**
*   **Smooth/Stable:** ADI $< 1.32$ and $CV^2 < 0.49$
*   **Intermittent:** ADI $\ge 1.32$ and $CV^2 < 0.49$
*   **Erratic:** ADI $< 1.32$ and $CV^2 \ge 0.49$
*   **Lumpy:** ADI $\ge 1.32$ and $CV^2 \ge 0.49$

### Trend Calculation (OLS)
We apply Ordinary Least Squares (OLS) regression over the time indices $t = 0, 1, 2, \dots, N-1$.
The regression equation is:
$$ y_t = \beta_0 + \beta_1 t + \epsilon $$

If the resulting R-squared value $R^2 > 0.4$ and the absolute slope $\beta_1 > 0$, we classify the trend as:
*   **Increasing:** if $\beta_1 > 0.05 \times \text{mean}(y)$
*   **Decreasing:** if $\beta_1 < -0.05 \times \text{mean}(y)$
*   **Flat:** otherwise

### Seasonality Detection (Autocorrelation)
We calculate the Pearson autocorrelation coefficient at a lag of 12 months.
For a series $y_t$:
$$ r_{12} = \frac{\sum (y_t - \bar{y})(y_{t-12} - \bar{y})}{\sum (y_t - \bar{y})^2} $$

If $N \ge 24$ (at least 2 years of history) and $r_{12} > 0.4$, we flag the series as **Seasonal** with a period of 12.

### Outlier Detection (IQR)
Outliers are detected using the Interquartile Range (IQR) method on non-zero demands.
*   $Q1 = \text{25th percentile}$
*   $Q3 = \text{75th percentile}$
*   $IQR = Q3 - Q1$
*   Upper Bound = $Q3 + 1.5 \times IQR$

Any observation strictly greater than the Upper Bound is flagged as an outlier.
**Important:** Outliers are flagged for planner review but are *not* automatically deleted or overwritten in the raw time-series data.

## 2. Business Rules & Exclusions

### Insufficient History (FSD Rules)
If a SKU has fewer than **6 months** of historical demand data:
*   The system sets `forecast_eligibility = "insufficient_history"`.
*   The UI explicitly warns the user that no AI model can produce a reliable statistical forecast.
*   The raw backtesting engine may fall back to Naive (baseline) execution internally for 1-5 months to provide *some* reference point, but the system marks the model's confidence and overall eligibility as insufficient.

### Pattern-Based Model Exclusions
The Demand Intelligence profile actively shapes the model selection pool by rejecting incompatible models before they are even backtested. This saves computation and avoids catastrophic overfitting.

| Demand Pattern | Excluded Models | Reason |
| :--- | :--- | :--- |
| **Stable** | Croston, SBA | Intermittent models systematically underforecast stable demand |
| **Intermittent** | Holt Exponential Smoothing, HistGradientBoosting | Traditional time-series models will oscillate wildly or heavily overforecast during zero-demand periods |
| **Lumpy** | Holt Exponential Smoothing, HistGradientBoosting, Linear Trend | Extremely volatile demand will completely mislead trend and gradient-based approaches |
| **Seasonal** | Croston, SBA | Intermittent models do not have mechanisms to track repeating seasonal waves |
