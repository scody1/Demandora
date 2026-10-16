Functional Specification Document (FSD)
AI-Based MRP Forecast Screen - SAP Business One
Client: Ledure Lighting
1. Document Control
2. Introduction
2.1 Purpose
This document describes the functional behaviour of the MRP Forecast screen, an AI-based forecasting window used inside SAP Business One for Ledure Lighting. It defines what the screen shows, what the user can do, and the business rules the screen follows, so that the client, the consultant and the development team share one understanding before testing and go-live.
2.2 Background
Ledure Lighting provided two years of sales, MRP and master data (including the customers and vendors created in this period). Using this data, an AI forecasting tool has been developed that predicts item-wise demand for the next 6 months. The MRP Forecast screen is the planner-facing window of this tool: it generates the forecast, lets the planner review and adjust it, and passes the approved forecast to SAP B1 MRP.
2.3 Scope
In scope:
Generation of a 6-month item-wise demand forecast from 2 years of history.
Review, adjustment, approval and version history of the forecast.
Passing the approved forecast to the SAP B1 Forecast and running MRP; net requirement and component requirement view.
Forecast accuracy tracking against actual sales.
Out of scope:
Changes to standard SAP B1 MRP logic or the standard MRP Recommendation Report (PR / PO / Production Order conversion remains standard).
Financial planning or budgeting. Forecasting of items with no sales history except through the manual fallback described in Section 6.
2.4 Abbreviations
3. Business Process
3.1 Current Process (As-Is)
MRP is run on confirmed Sales Orders and manual forecasts. Forecast quantities are prepared by the planner in Excel from memory of past sales, and the history of MRP runs is not available in one place. Seasonal peaks, large project orders and demand from new customers are handled by experience.
3.2 Proposed Process (To-Be)
4. Data Used by the Screen
The screen reads the following SAP B1 data. Customer and vendor creation data from the last 2 years is used to understand growth in the customer base and supplier changes.
5. Screen Specification
5.1 Screen Details
5.2 Screen Layout (Wireframe)
Illustrative layout with sample data. Final look follows the SAP B1 standard theme.

5.3 Header and Parameter Fields
5.4 Forecast Tab - Grid Columns
5.5 Other Tabs
5.6 Buttons and Actions
6. Functional Requirements and Business Rules
6.1 Functional Requirements
6.2 Forecast Business Rules

Cancelled documents and returns are removed from history before the forecast is calculated.
Open Sales Orders are treated as firm demand and are not counted twice in the forecast.
Lead time of each item (item master) is used to show the latest date by which a PR / PO must be raised.
Net requirement is shown only for items with Planning Method = MRP.
Details of the AI model are covered in the Technical Design; this FSD describes only the visible behaviour.
7. Validations and Messages
8. Reports and Outputs
9. User Roles and Authorizations
10. Data Storage (Proposed)
The tool stores its own data in user-defined tables so that standard SAP B1 tables are not changed.
11. Assumptions, Dependencies and Open Points
11.1 Assumptions
At least 12 months of reliable sales history is available for the main items; the client has provided 24 months.
Item master data (planning method, lead time, MOQ, Make / Buy, default vendor) is correct and complete.
BOMs for Make items are up to date.
The forecast is a planning aid; purchasing and production decisions remain with Ledure Lighting.
11.2 Open Points to be Confirmed by Ledure Lighting
12. Acceptance Criteria (UAT)
13. Approval and Sign-off

Client | Ledure Lighting
Project | AI-Based MRP Forecasting in SAP Business One
Document Title | FSD - MRP Forecast Screen (AI Forecasting Window)
Prepared By | 
Reviewed By (Client) | 
Version / Date | v0.1 (Draft) / 
Status | Draft for client review
Term | Meaning | Term | Meaning
MRP | Material Requirements Planning | WAPE | Weighted Absolute Percentage Error (forecast accuracy measure)
SKU / Item | A lighting product or component with an Item Code | SO / PO / PR | Sales Order / Purchase Order / Purchase Request
BOM | Bill of Materials (production recipe) | MOQ | Minimum Order Quantity
AI Forecast | System-generated demand quantity before planner changes | Final Qty | Quantity approved for MRP (AI Forecast or planner-adjusted)
Step | Activity | Performed By | Screen Action
1 | Planner opens the MRP Forecast screen and selects forecast month, horizon, item group and warehouse. | Planner | Header and Parameters
2 | System reads 24 months of history, stock, open orders and item MRP parameters from SAP B1. | System | Generate Forecast
3 | AI tool creates the 6-month item-wise forecast with a confidence level for each item. | System | Forecast tab
4 | Planner reviews alerts and low-confidence items, and enters adjustments where business knowledge is better. | Planner | Planner Adj. column
5 | Planner submits the forecast. Approver reviews and approves it (or returns it with a remark). | Planner / Approver | Submit / Approve
6 | Approved forecast is pushed to the SAP B1 Forecast so that it becomes available in the MRP Wizard. | System | Push to SAP B1 Forecast
7 | MRP is run; net requirement and component requirement are checked; PR / PO / Production Orders are created from the standard recommendation report. | Planner / Purchase | Run MRP
8 | Every month the forecast is compared with actual sales and accuracy is reported. | System | Accuracy tab
# | Data | SAP B1 Source | Period | Used For
1 | Sales demand by item | ORDR / RDR1, ODLN / DLN1, OINV / INV1 | 24 months, monthly | Main history for the AI forecast
2 | MRP and forecast history | OMRC, OFCT / FCT1, MRP files shared by client | 24 months | Compare earlier forecasts with actual demand; accuracy baseline
3 | Customers created | OCRD (CardType = C) | 24 months | Identify new-customer demand and its effect on item demand
4 | Vendors created | OCRD (CardType = S), OPOR / POR1 | 24 months | Lead time and supply-source changes for Buy items
5 | Item master and MRP parameters | OITM | Current | Planning method, Make / Buy, lead time, MOQ, order multiple, min / max, default vendor
6 | Stock position | OITW | Current | On hand, committed, ordered for net requirement
7 | Open demand and supply | ORDR, OPOR, OPRQ, OWOR | Current | Open SO as confirmed demand; open POs / PRs / Production Orders as supply
8 | Production BOM | OITT / ITT1 | Current | Component explosion for Make items (drivers, LED modules, housings, etc.)
Item | Details
Screen name | MRP Forecast (AI Forecasting Window)
Menu path (proposed) | Production > MRP > MRP Forecast
Screen type | Add-on window with Header, Parameters, Tabs (Forecast, History & Trend, Accuracy, Component Requirement) and Action buttons
Users | Planner, Purchase Manager, Approver, Administrator (see Section 9)
# | Field | Type | Mandatory | Default | Description / Validation
1 | Forecast Code | Display | - | Auto | Auto-number from series, e.g., FC-2026-0001
2 | Forecast Name | Input | Yes | Blank | Free text description of the forecast run
3 | Start Month | Month picker | Yes | Next month | First month of the forecast. Past months are not allowed
4 | Horizon (Months) | Input | Yes | 6 | Allowed 1 to 12
5 | Item Group | Multi-select | No | All | Limits the forecast to selected lighting item groups
6 | Item Code From / To | Input | No | Blank | Optional item range
7 | Warehouse | Multi-select | No | All | Stock and open orders are taken from these warehouses
8 | Status | Display | - | Draft | Draft, Generated, Under Review, Approved, Pushed to SAP, Cancelled
9 | Version | Display | - | 1 | Increases by 1 each time the forecast is regenerated
10 | History Period (Months) | Input | Yes | 24 | Minimum 12, maximum 36 months
11 | Seasonality | Checkbox | No | Yes | Uses yearly demand pattern (e.g., festive and project seasons) in the forecast
12 | Treat bulk / project orders separately | Checkbox | No | Yes | One-time large orders above the threshold are not treated as regular monthly demand
13 | Bulk order threshold (Qty) | Input | No | Per item group | Quantity above which a single order is treated as bulk / project
14 | Include open Sales Orders | Checkbox | No | Yes | Confirmed open orders are added as firm demand
15 | Include new customers | Checkbox | No | Yes | Customers created in the last 24 months are included in the demand base
16 | Confidence Level | Dropdown | Yes | 90% | 80% / 90% / 95%. Decides the forecast range and the safety margin
17 | Apply MOQ / Order Multiple | Checkbox | No | Yes | Rounds required quantity to item MOQ and order multiple
# | Column | Editable | Description
1 | Item Code / Description / UoM | No | Item identification from the item master
2 | Avg / Month (24M) | No | Average monthly sales quantity in the history period
3 | Month 1 to Month 6 | No | AI forecast quantity for each month of the horizon
4 | AI Total | No | Sum of the 6 monthly AI forecast quantities
5 | Planner Adj. | Yes | Total quantity entered by the planner to replace the AI Total. Blank means AI Total is accepted
6 | Final Qty | No | Planner Adj. if entered, otherwise AI Total
7 | Stock | No | Current on-hand quantity in selected warehouses
8 | Open PO | No | Quantity on open Purchase Orders and Production Orders yet to be received
9 | Net Req. | No | Final Qty - Stock - Open PO (not below zero). Rounded by MOQ / Order Multiple when selected
10 | Confidence | No | High, Medium or Low for each item. Low confidence items are highlighted for review
11 | Remark | Yes | Planner reason for the adjustment. Mandatory when Planner Adj. differs from AI Total by more than 20%
Tab | Content
History & Trend | 24-month actual sales and 6-month forecast for the selected item on a line chart, with monthly values below; shows seasonality and new-customer share
Accuracy | Forecast vs actual comparison per item and month, with WAPE. Shows earlier forecast versions for the same month
Component Requirement | BOM explosion of Final Qty for Make items into component requirement per month, with stock, open PO and shortage
Button | Action / Behaviour | Allowed Status
Generate Forecast | Reads data, runs the AI forecast and fills the grid. If the forecast already exists, a new version is created and the earlier one is kept | Draft, Generated, Under Review
Save Draft | Saves the screen as it is, including planner adjustments | Draft, Generated, Under Review
Submit for Approval | Locks editing and sends the forecast to the approver | Generated
Approve / Return | Approver approves the forecast, or returns it to the planner with a mandatory remark | Under Review
Push to SAP B1 Forecast | Creates or updates the SAP B1 Forecast with the Final Qty per item per month, so it is available in the MRP Wizard | Approved
Run MRP | Opens the standard MRP Wizard with the pushed forecast pre-selected. Recommendations are converted in the standard report | Pushed to SAP
Export to Excel | Exports the grid, parameters and alerts to Excel | All
Close | Closes the window. Prompts to save if there are unsaved changes | All
ID | Requirement | Priority
FR-01 | The screen shall read 24 months of sales history item-wise and month-wise directly from SAP B1, without manual upload. | High
FR-02 | The system shall generate an item-wise forecast for the selected horizon (default 6 months) with a confidence level for each item. | High
FR-03 | The forecast shall consider trend and seasonality of each item, and shall treat bulk / project orders separately from regular demand. | High
FR-04 | The forecast shall include demand from customers created in the last 24 months and use the vendor lead time of vendors created in this period for Buy items. | Medium
FR-05 | The planner shall be able to adjust the forecast quantity per item. Every adjustment shall store user, date, old value, new value and remark. | High
FR-06 | The forecast shall go through Submit and Approve before it can be pushed to SAP B1. | High
FR-07 | The approved forecast shall be pushed to the SAP B1 Forecast so that the standard MRP Wizard can use it. | High
FR-08 | The screen shall show net requirement per item (Final Qty - Stock - Open PO) with MOQ and order multiple rounding. | High
FR-09 | For Make items the screen shall explode the BOM and show component requirement and shortage per month. | Medium
FR-10 | The system shall keep every forecast version with date, user, parameters and status, so that MRP forecast history is always available. | High
FR-11 | The system shall compare forecast with actual sales every month and show WAPE per item, item group and overall. | Medium
FR-12 | The screen shall raise alerts for low-confidence items, items with no history, and items whose forecast changes by more than 30% from last year. | Medium
FR-13 | Access to Generate, Adjust, Approve and Push shall be controlled by user roles. | High
FR-14 | All grids and reports shall be exportable to Excel. | Low
Demand Pattern | How Identified | Treatment on the Screen
Regular demand | Sales in most months of the history with moderate variation | Forecast from trend and recent months; confidence usually High
Seasonal demand | Repeating high and low months in both years | Forecast follows the yearly pattern; peak months are not smoothed out
Project / lumpy demand | Few large orders with gaps between them | Bulk orders kept separate; forecast on regular part, confirmed project orders added from open SO; confidence Medium or Low
New item | Less than 6 months of history | No AI forecast. Planner enters quantity manually or selects a similar item to copy the pattern; marked Low
Inactive / discontinued item | Frozen item or no sales in the last 6 months | Excluded from the forecast and listed in alerts
# | Condition | Message / Behaviour
1 | Start Month is in the past | "Start Month cannot be before the current month." Generate is blocked
2 | Fewer than 12 months of data are available | "Insufficient history. Minimum 12 months required." Item is listed for manual input
3 | Planner Adj. differs from AI Total by more than 20% and Remark is blank | "Please enter a remark for this adjustment." Save is blocked for that line
4 | Submit is pressed while Low confidence items have no review remark | Warning: "Low confidence items are not reviewed. Continue?"
5 | Push is pressed for a forecast that is not Approved | "Only Approved forecasts can be pushed to SAP B1."
6 | A SAP B1 Forecast for the same period and name already exists | Choice to overwrite or cancel. The overwrite is recorded in the version history
7 | Item has Planning Method = None | Item is shown without Net Req. and a note "Not planned by MRP"
8 | Unsaved changes when closing | "Do you want to save the changes?" Yes / No / Cancel
Report | Content | Format
Item-wise Forecast Report | Item, monthly AI forecast, adjustment, final qty, net requirement | Screen, Excel
Forecast vs Actual Report | Monthly forecast and actual sales per item and item group, with WAPE | Screen, Excel
Component Requirement Report | Component-wise monthly requirement, stock, open PO and shortage | Screen, Excel
Forecast Version History | Every forecast run with date, user, parameters, status and adjustments | Screen, Excel
Role | View | Generate | Adjust | Submit | Approve | Push to SAP / Run MRP
Planner | Yes | Yes | Yes | Yes | No | Yes
Purchase Manager | Yes | No | No | No | No | Run MRP only
Approver (Management) | Yes | No | No | No | Yes | No
Administrator | Yes | Yes | Yes | Yes | Yes | Yes
Object | Content
Forecast Header (UDT) | Forecast code, name, version, status, parameters, created by / date, approved by / date
Forecast Lines (UDT) | Item, month, AI forecast, planner adjustment, final qty, confidence, remark
Adjustment Log (UDT) | Item, month, old value, new value, user, date, remark
Accuracy Data (UDT) | Item, month, forecast qty, actual qty, WAPE
# | Point | Owner | Status / Decision
1 | Forecast level: item-wise only, or also item group / customer-wise? | Client / Planner | 
2 | Time bucket: monthly only, or weekly also needed? | Client / Planner | 
3 | Approval: who approves the forecast, and is one level enough? | Management | 
4 | Bulk / project order threshold per item group | Sales / Planner | 
5 | Treatment of new items: copy a similar item or manual only? | Planner | 
6 | Which warehouses are used for stock and net requirement? | Stores | 
7 | Accuracy target (WAPE) expected by the client | Management | 
8 | Are components (LED chips, drivers, PCBs, heat sinks) planned through BOM in SAP B1? | Production | 
ID | Test Scenario | Expected Result | Result
UAT-01 | Generate a 6-month forecast for one item group | Forecast shown for all active items with confidence level; completes without error | 
UAT-02 | Compare AI history with SAP B1 sales for 3 items | Monthly history in the screen matches SAP B1 sales within agreed tolerance | 
UAT-03 | Adjust forecast by more than 20% without a remark | System blocks the save and asks for a remark | 
UAT-04 | Submit, return and approve a forecast | Status changes correctly; planner cannot edit while Under Review | 
UAT-05 | Push approved forecast to SAP B1 and open the MRP Wizard | Forecast quantities are available for selection and match the Final Qty | 
UAT-06 | Run MRP and check net requirement for a Make item | Net requirement and component shortage match manual calculation | 
UAT-07 | Regenerate forecast with changed parameters | New version is created; earlier version stays in version history | 
UAT-08 | Check alerts for a new item and a low-confidence item | Both appear in the alerts list and are highlighted in the grid | 
UAT-09 | Login with Approver and Purchase Manager roles | Only the allowed buttons are active for each role | 
UAT-10 | Compare forecast with actual sales after one month | Accuracy tab shows WAPE per item and overall | 
Role | Name | Signature | Date
Ledure Lighting - Business Owner |  |  | 
Ledure Lighting - Planning / Production Head |  |  | 
Ledure Lighting - IT / SAP B1 Administrator |  |  | 
Consultant / Project Manager |  |  | 
