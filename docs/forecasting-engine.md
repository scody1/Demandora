# Demandora Forecasting Engine

The Demandora forecasting engine combines classical statistical time-series methods with modern supervised machine learning. Rather than assuming one model fits all SKU behaviors, Demandora runs a **multi-model statistical tournament** on each individual SKU using **chronological walk-forward backtesting**.

---

## 1. Candidate Models

Demandora evaluates up to 9 distinct forecasting algorithms per SKU, depending on historical data availability:

| Model Name | Class | Minimum History | Mathematical Foundation |
|---|---|---:|---|
| **Naive (Last Observation)** | Baseline | 1 month | $\hat{y}_{t+h} = y_t$ |
| **Historical Mean** | Baseline | 1 month | $\hat{y}_{t+h} = \frac{1}{t}\sum_{i=1}^t y_i$ |
| **Simple Moving Average (SMA-3)** | Statistical | 3 months | $\hat{y}_{t+1} = \frac{1}{k}\sum_{i=0}^{k-1} y_{t-i}$ with $k=3$ |
| **Weighted Moving Average (WMA-3)** | Statistical | 3 months | $\hat{y}_{t+1} = \sum_{i=0}^{k-1} w_i y_{t-i}$ with weights $[0.5, 0.3, 0.2]$ |
| **Linear Trend Regression (OLS)** | Statistical | 3 months | Fits $y_t = \alpha + \beta t$ via ordinary least squares |
| **Holt's Linear Exponential Smoothing** | Statistical | 4 months | Level and trend smoothing using `statsmodels.tsa.holtwinters.Holt` |
| **Croston's Method** | Intermittent | 4 months | Separate estimation of non-zero demand size and inter-arrival intervals |
| **Syntetos-Boylan Approximation (SBA)** | Intermittent | 4 months | Bias-corrected Croston formulation: $\hat{y} = (1 - \frac{\alpha}{2}) \frac{z_t}{p_t}$ |
| **Histogram Gradient Boosting** | Machine Learning | 6 months | Supervised tree ensemble (`HistGradientBoostingRegressor`) trained on lag and rolling features |

---

## 2. Dynamic Model Eligibility

A model is only eligible for tournament evaluation if the SKU has sufficient observed periods:
- **0–5 months (Sparse / Cold-Start)**: Evaluated using category peer-group baselines and attribute similarity weighting (`backend/cold_start.py`).
- **6–11 months (Emerging SKUs)**: Baseline models, moving averages, and linear trend models are evaluated. Complex models requiring seasonal lags are filtered out.
- **12+ months (Mature SKUs)**: All 9 candidate models enter the tournament across multiple expanding walk-forward splits.

---

## 3. Chronological Walk-Forward Backtesting

To avoid **temporal data leakage** (look-ahead bias), cross-validation uses strictly chronological expanding windows:

```
Window 1:  [ Train: Months 1..12 ] -> [ Validate: Month 13 ]
Window 2:  [ Train: Months 1..13 ] -> [ Validate: Month 14 ]
...
Window 12: [ Train: Months 1..23 ] -> [ Validate: Month 24 ]
```

At each fold $k$:
1. The model is fitted strictly on $y_{1..t}$.
2. A forecast is generated for $y_{t+1 .. t+h}$.
3. Errors are recorded out-of-sample against actual ground truth.

### Evaluation Metrics
- **WAPE (Weighted Absolute Percentage Error)**:
  $$\text{WAPE} = \frac{\sum |y_t - \hat{y}_t|}{\sum y_t}$$
- **MAE (Mean Absolute Error)**: $\frac{1}{N}\sum |y_t - \hat{y}_t|$
- **RMSE (Root Mean Squared Error)**: $\sqrt{\frac{1}{N}\sum (y_t - \hat{y}_t)^2}$
- **Normalized Mean Bias**: $\frac{\sum (\hat{y}_t - y_t)}{\sum y_t}$

### Deterministic Tie-Breaking
1. Lowest **WAPE** wins.
2. If WAPE is tied within $10^{-4}$, lowest **MAE** wins.
3. If MAE is tied, lowest **RMSE** wins.
4. If RMSE is tied, model with absolute bias closest to zero wins.

---

## 4. SKU Demand Segmentation

Every SKU is categorized into a business regime based on its Average Demand Interval ($ADI$) and squared Coefficient of Variation ($CV^2$):

- **RUNNER ($ADI < 1.32, CV^2 < 0.49$)**: High-velocity, smooth, consistent monthly demand. Suitable for exponential smoothing and gradient boosting.
- **REPEATER ($ADI \ge 1.32, CV^2 < 0.49$ or intermittent)**: Variable or lumpy demand. Croston or SBA models frequently outperform.
- **STRANGER ($ADI \ge 1.32, CV^2 \ge 0.49$)**: Sporadic, highly erratic demand with extended zero periods. Requires conservative procurement buffering.
- **UNCLASSIFIED**: Items with zero historical sales records.

---

## 5. Final Horizon Projection & Prediction Intervals

Once the tournament selects the winning model:
1. The winning algorithm is **refitted on all available history** ($t = 1..T$).
2. A multi-step recursive projection is generated for the chosen planning horizon (default: 6 months).
3. Non-negative clipping is enforced: $\hat{y}_t = \max(0, \hat{y}_t)$.
4. Upper and lower confidence bounds (80% and 95%) are derived from historical backtest residuals.
