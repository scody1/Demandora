# FSD UAT Checklist

Executable UAT scenarios based strictly on the FSD.

| ID | FSD Requirement | Preconditions | Input | Expected Result | Implementation Evidence | Test Evidence | Status |
|---|---|---|---|---|---|---|---|
| UAT-01 | FR-02: Generate 6-month forecast | Valid Excel history loaded | Click Generate | Forecast populated for active items | `models.py` generates array of length 6 | `test_fsd_forecast_total_calculation` | PASSED |
| UAT-02 | FR-01: Compare AI history with SAP | Excel source | Read file | Current phase validates imported Excel history. SAP B1 source reconciliation is deferred to SAP integration. | `excelService.ts:parseExcelDataset` | `test_fsd_missing_vs_zero` | INTENTIONALLY DEFERRED |
| UAT-03 | FR-05: Adjust >20% without remark | Generated forecast | Planner adjustment > 20% diff without remark | Save blocked, alert prompts for remark | `ForecastGrid.tsx:490` block logic | `fsd.test.ts` (Large Adj Rule) | PASSED |
| UAT-04 | FR-06: Submit and Approve workflow | Saved draft | Click Submit | Status changes, editing locked | `ForecastWorkspace.tsx:115` state machine | Manual (React UI) | NOT EXECUTED |
| UAT-05 | FR-07: Push approved forecast to SAP | Approved forecast | Click Push | Forecast pushed to SAP B1 | N/A | N/A | INTENTIONALLY DEFERRED |
| UAT-06 | FR-08, FR-09: Component Requirement | Generated forecast | Review Net Req and BOM | Net Req = Final - Stock - Open PO. BOM explodes for Make items. | `ComponentsView.tsx:17` & `forecastingEngine.ts:242` | `fsd.test.ts` (Net Req / BOM Component Req) | PASSED |
| UAT-07 | FR-10: Regenerate forecast versioning | Existing forecast | Change parameters, Click Generate | New version created, old retained | `ForecastWorkspace.tsx` active session states | `src/services/phase9.test.ts` | PASSED |
| UAT-08 | FR-12: Check alerts for new item & low-conf | Item with <6m history, Item with low confidence | Review alerts | Items listed in alerts and highlighted | `forecastingEngine.ts:473` | `test_fsd_insufficient_history_eligibility` | PASSED |
| UAT-09 | FR-13: Roles and permissions | N/A | Login as Approver | Only allowed buttons active | `Permissions.ts` | `src/services/phase9.test.ts` | PASSED |
| UAT-10 | FR-11: Forecast vs Actual Accuracy | 24m history loaded | View Analytics | Accuracy (WAPE) displayed | `engine.py` / `models.py` cross validation | `test_phase2_backtesting.py` | PASSED |
| UAT-11 | FR-12: >30% change alert | Forecast generated | Item forecast > 30% diff from previous | ">30% Forecast Change" alert displayed | `forecastingEngine.ts:503` | `fsd.test.ts` (>30% Rule) | PASSED |

---

# Final Audit Report

- **Total FSD Items Audited**: 33 (14 FRs + 14 Business Rules + 5 Reports/Tabs)
- **IMPLEMENTED Count**: 24
- **PARTIALLY IMPLEMENTED Count**: 6
- **MISSING Count**: 0
- **INTENTIONALLY DEFERRED Count**: 3
- **Total UAT Scenarios**: 11
- **NOT EXECUTED UAT Count**: 1
- **INTENTIONALLY DEFERRED UAT Count**: 2
- **Total Automated FSD Tests**: 10
- **Automated Test Result**: PASSED (10/10 FSD-specific tests + 77/77 backend regression tests + 48 frontend tests)
- **Remaining limitations/gaps**: 
  - PR/PO latest-date calculation from lead time (deferred for Phase 10 or future MRP scheduling module).
  - Enterprise authentication/identity (local RBAC is implemented, but enterprise SSO is out of scope).
  - SAP B1 Integration (intentionally OUT OF SCOPE; application remains standalone Excel-driven).
