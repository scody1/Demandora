# Demandora Inventory Planning & Material Requirements Planning (MRP)

Demandora connects demand forecasting directly with supply-chain execution. The Material Requirements Planning (MRP) engine translates multi-month demand projections into actionable purchase requisitions and manufacturing work orders.

---

## 1. Gross-to-Net Calculation Logic

For every finished item and component governed by `Planning Method = MRP`:

$$\text{Gross Requirement} = \text{Forecasted Final Demand (AI Forecast + Planner Adjustments)}$$
$$\text{Projected Available Supply} = \text{Current On-Hand Stock} + \text{Open Purchase Orders (PO)}$$
$$\text{Raw Net Requirement} = \max\left(0, \text{Gross Requirement} - \text{Projected Available Supply}\right)$$

### Order Sizing Rules
1. **Minimum Order Quantity (MOQ)**:
   If $\text{Raw Net Requirement} > 0$ and $\text{Raw Net Requirement} < \text{MOQ}$, order quantity is raised to $\text{MOQ}$.
2. **Order Multiples**:
   If an order multiple $M$ is configured, the planned quantity is rounded up to the nearest integer multiple of $M$:
   $$\text{Planned Order Qty} = \left\lceil \frac{\max(\text{Raw Net Req}, \text{MOQ})}{M} \right\rceil \times M$$

---

## 2. Lead-Time Offset & Procurement Deadlines

Demandora computes the latest permissible order date based on ingested item master parameters:

$$\text{Latest Order Date} = \text{Requirement Month Start Date} - \text{Lead Time Days}$$

If the computed `Latest Order Date` precedes the current planning date, the item is flagged as **OVERDUE / EXPEDITE REQUIRED** in the UI.

---

## 3. Multi-Tier Bill of Materials (BOM) Explosion

For manufactured assemblies (`Make / Buy = Make`):
1. **Parent Demand Propagation**:
   Component Gross Requirement is computed as:
   $$\text{Component Demand} = \text{Parent Assembly Final Qty} \times \text{Quantity Per Assembly}$$
2. **Recursive Explosion**:
   Multi-level assemblies are recursively resolved down to the lowest purchaseable sub-components.
3. **Component Netting**:
   Sub-components are netted against existing component stock and incoming component POs.
4. **Shortage Detection**:
   Critical shortages that would halt assembly lines are surfaced with required replenishment timelines.

---

## 4. Procurement Decision Guardrails & Heuristics

To prevent bullwhip effect distortions and uncalibrated safety stock over-ordering, Demandora applies deterministic heuristic guardrails:

- **Chronic Model Over-Forecasting (Positive Bias)**: When backtesting indicates a model chronically over-predicts demand, suggested safety stock buffers are reduced by up to 20%.
- **Under-Forecasting on Fast-Movers (Negative Bias)**: On high-velocity RUNNER SKUs where stockouts cause severe lost revenue, safety stock multipliers are dynamically increased.
- **Excess Buffer Cap**: Prevents automated recommendations from exceeding maximum working capital constraints.
