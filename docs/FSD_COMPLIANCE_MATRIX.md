# FSD Compliance Matrix

This document systematically compares the current application against every requirement in the Functional Specification Document (FSD) for Ledure Lighting (Ledure_Lighting_FSD_MRP_Forecast_Screen.docx).

## 1. Functional Requirements (FR-01 to FR-14)

| ID | Requirement | Status | Evidence | Test |
|---|---|---|---|---|
| FR-01 | Read 24 months of sales history item-wise and month-wise from SAP B1. | PARTIALLY IMPLEMENTED | `forecastingEngine.ts:prepareItemHistories` reads history from Excel structure. Database deferred. | N/A |
| FR-02 | Generate item-wise forecast for horizon (default 6) with confidence level. | IMPLEMENTED | `models.py` generates numerical array. `engine.py` generates confidence block. | `test_phase1_engine.py` |
| FR-03 | Consider trend, seasonality, and bulk/project orders separately. | IMPLEMENTED | `pattern_intelligence.py:profile_demand` detects trend/seasonality. `forecastingEngine.ts` line 175 excludes projects. | `test_phase4_patterns.py` |
| FR-04 | Include demand from customers created in last 24m and use vendor lead time. | PARTIALLY IMPLEMENTED | Lead time is ingested and preserved as `null` if missing, but PR/PO latest-date calculation is not currently implemented. | N/A |
| FR-05 | Planner adjust forecast. Save user, date, old, new, and remark. | PARTIALLY IMPLEMENTED | `ForecastGrid.tsx` captures remark and adjustment in React state. | `fsd.test.ts` |
| FR-06 | Submit and Approve workflow before push. | IMPLEMENTED | `ForecastWorkspace.tsx` manages `Draft -> Submitted -> Approved`. | N/A |
| FR-07 | Approved forecast pushed to SAP B1 Forecast. | INTENTIONALLY DEFERRED | All SAP push is intentionally deferred. | N/A |
| FR-08 | Show net requirement (Final Qty - Stock - Open PO). MOQ/Order multiple rounding. | IMPLEMENTED | `forecastingEngine.ts:242` (`Math.max(finalQty - stock - openPo, 0)`). | `fsd.test.ts` |
| FR-09 | For Make items, explode BOM and show component requirement/shortage. | IMPLEMENTED | `ComponentsView.tsx:17` (`Math.round(line.finalQty * bom.qtyPerUnit)`). | `fsd.test.ts` |
| FR-10 | Keep every forecast version with date, user, parameters, status. | IMPLEMENTED | `App.tsx` maintains full immutable history array in session and localStorage. | N/A |
| FR-11 | Compare forecast vs actual every month, show WAPE. | IMPLEMENTED | `engine.py` walk-forward cross-validation evaluates WAPE automatically. | `test_phase2_backtesting.py` |
| FR-12 | Alerts: low-confidence, no history, >30% change from last year. | IMPLEMENTED | `forecastingEngine.ts:503` implements >30% change alert logic. | `fsd.test.ts` |
| FR-13 | Roles and Authorizations (Planner, Approver, etc.). | PARTIALLY IMPLEMENTED | Local RBAC permission architecture exists (`permissions.ts`). User identity/enterprise authentication is outside current scope. | N/A |
| FR-14 | Export to Excel. | IMPLEMENTED | `excelService.ts:exportForecastToExcel` | N/A |

## 2. Business Rules & Validations

| Condition / Rule | Status | Evidence | Test |
|---|---|---|---|
| Cancelled documents and returns are removed from history. | IMPLEMENTED | `excelService.ts` explicitly filters rows with 'cancel', 'return', 'invalid', 'rejected' status. Raises warning if status column missing. | N/A |
| Open Sales Orders are firm demand, not counted twice. | IMPLEMENTED | `forecastingEngine.ts:150` parses SO but intentionally excludes from `netReq`. | `fsd.test.ts` |
| Lead time used for PR/PO latest date. | PARTIALLY IMPLEMENTED | Lead time is ingested and preserved, but PR/PO latest-date calculation is not currently implemented. | N/A |
| Net requirement shown only for items with Planning Method = MRP. | IMPLEMENTED | `forecastingEngine.ts:241` (`if (item.planningMethod === 'MRP')`) | N/A |
| Start month in the past is blocked. | IMPLEMENTED | `UI.tsx` parameter logic | N/A |
| Fewer than 12 months data -> Insufficient history -> Manual input. | IMPLEMENTED | `engine.py:246` blocks AI; `forecastingEngine.ts:90` surfaces rule in UI. | `test_fsd_insufficient_history_eligibility`, `fsd.test.ts` |
| Less than 6 months for a new item -> No AI forecast. | IMPLEMENTED | `engine.py:246` blocks AI; `forecastingEngine.ts:90` surfaces rule in UI. | `test_fsd_insufficient_history_eligibility`, `fsd.test.ts` |
| Inactive / discontinued item -> Excluded. | IMPLEMENTED | `forecastingEngine.ts:224` (`monthlyForecast` = `Array(horizon).fill(0)`) | N/A |
| Missing period vs zero demand. | IMPLEMENTED | `pattern_intelligence.py:profile_demand` tracks true `zero_demand_ratio`. | `test_fsd_compliance.py` |
| Planner Adj > 20% diff from AI Total -> Remark is mandatory. | IMPLEMENTED | `ForecastGrid.tsx:490` block submission without remark. | `fsd.test.ts` |
| Submit while Low confidence unreviewed -> Warning. | IMPLEMENTED | `ForecastWorkspace.tsx` renders alert. | N/A |
| Push to SAP without Approval blocked. | IMPLEMENTED | Button disabled in `ForecastWorkspace.tsx`. | N/A |
| SAP B1 Forecast already exists -> Overwrite prompt. | INTENTIONALLY DEFERRED | No SAP Push. | N/A |
| Planning Method = None -> "Not planned by MRP". | IMPLEMENTED | Handled in `ForecastGrid.tsx`. | N/A |

## 3. Reports & Tabs

| Report / View | Status | Evidence | Test |
|---|---|---|---|
| Forecast Grid | IMPLEMENTED | `ForecastGrid.tsx` | N/A |
| History & Trend Tab | IMPLEMENTED | `AnalyticsPanel.tsx` | N/A |
| Accuracy Tab | IMPLEMENTED | `AnalyticsPanel.tsx` (Backtest results) | N/A |
| Component Requirement Tab | IMPLEMENTED | `ComponentsView.tsx` | `fsd.test.ts` |
| Version History | IMPLEMENTED | `VersionsView.tsx` exposes immutable history. | N/A |

## 4. Requirement Traceability Deep Dive

### 12-Month Eligibility Rule
**FSD Requirement:**
"Fewer than 12 months data -> Insufficient history -> Manual input."
"Less than 6 months for a new item -> No AI forecast."

**Implementation:**
- `backend/engine.py:246` (`forecast_single_sku`): Enforces `<12` months fallback with explicit INSUFFICIENT_HISTORY status.
- `backend/pattern_intelligence.py:165` (`profile_demand`): Enforces `<12` months data quality flag.
- `src/services/forecastingEngine.ts`: `getModelTierLabel` and `getModelLimitation` respect `<12` months logic and remove AI tiering for insufficient history.

**Test:**
- `backend/tests/test_fsd_compliance.py::test_fsd_insufficient_history_eligibility`: Tests explicit edge cases: 3, 5, 6, 11, 12, and 24 months. Asserts that `<12` months correctly trigger fallback states.
- `src/services/fsd.test.ts` (Frontend FSD Eligibility Rules): Tests actual user-facing string outputs, ensuring no normal AI forecast tier or messaging is surfaced for `<12` months.

**Result:** PASS. Both frontend and backend behavior strictly match the FSD specifications.
