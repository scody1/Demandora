"""
Procurement Heuristics & Decision Guardrails Engine for Demandora.

Phase 2.2 Core Capabilities:
1. Translates demand lifecycle regimes and model bias into concrete procurement limits.
2. Evaluates working capital protection guardrails (contraction buffer throttling & order caps).
3. Evaluates service-level protection guardrails (growth buffer expansion & lead-time buffers).
4. Calculates lead-time latest order dates and overdue procurement flags.
5. Operates independently from statistical estimators without altering raw forecast values.
"""

from typing import List, Dict, Any, Optional
from datetime import datetime, timedelta


def evaluate_procurement_heuristics(
    lifecycle_regime: str,
    momentum_flag: str,
    selected_model_metrics: Optional[Dict[str, Any]] = None,
    demand_profile: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Evaluates enterprise procurement decision heuristics based on lifecycle regime and error metrics.
    """
    metrics = selected_model_metrics or {}
    bias = metrics.get("bias", 0.0)
    wape = metrics.get("wape", 0.0)
    
    actions: List[Dict[str, Any]] = []
    regime = lifecycle_regime or "INSUFFICIENT_HISTORY"
    
    if regime == "CONTRACTION_PHASE_OUT":
        if bias > 0:
            actions.append({
                "ruleId": "POL-CAPITAL-01",
                "ruleName": "Contraction Positive Bias Throttle",
                "triggerCondition": "Contraction pattern + Model over-forecasting (Bias > 0)",
                "recommendedAction": "Throttle safety buffer by 25% and apply 1.1x order cap to prevent stranded inventory.",
                "bufferAdjustmentPct": -25.0,
                "orderCapMultiplier": 1.10,
                "severity": "WARNING"
            })
        else:
            actions.append({
                "ruleId": "POL-CAPITAL-02",
                "ruleName": "Phase-Out Working Capital Guardrail",
                "triggerCondition": "Contraction pattern detected",
                "recommendedAction": "Flag phase-out advisory; reduce replenishment buffer by 15% and suppress long-horizon re-orders.",
                "bufferAdjustmentPct": -15.0,
                "orderCapMultiplier": 1.20,
                "severity": "WARNING"
            })
            
    elif regime == "SUSTAINED_GROWTH_RAMP":
        if bias < 0:
            actions.append({
                "ruleId": "POL-STOCKOUT-01",
                "ruleName": "Growth Under-Forecast Buffer Expansion",
                "triggerCondition": "Sustained growth pattern + Model under-forecasting (Bias < 0)",
                "recommendedAction": "Expand replenishment buffer by 20% and add 7 days vendor lead-time buffer to mitigate stockout risks.",
                "bufferAdjustmentPct": 20.0,
                "orderCapMultiplier": None,
                "severity": "OPPORTUNITY"
            })
        else:
            actions.append({
                "ruleId": "POL-STOCKOUT-02",
                "ruleName": "Growth Momentum Protection",
                "triggerCondition": "Sustained growth pattern detected",
                "recommendedAction": "Maintain growth buffer (+10%); monitor supplier production capacity for sustained demand expansion.",
                "bufferAdjustmentPct": 10.0,
                "orderCapMultiplier": None,
                "severity": "INFO"
            })
            
    elif regime == "INTERMITTENT_LUMPY":
        actions.append({
            "ruleId": "POL-LUMPY-01",
            "ruleName": "Intermittent Batch Ordering Policy",
            "triggerCondition": "Intermittent or lumpy demand pattern detected",
            "recommendedAction": "Sporadic order intervals detected; enforce MOQ batch ordering and avoid fractional replenishment schedules.",
            "bufferAdjustmentPct": 0.0,
            "orderCapMultiplier": None,
            "severity": "INFO"
        })
        
    elif regime == "STABLE_STATIONARY":
        if wape is not None and wape < 15.0:
            actions.append({
                "ruleId": "POL-STABLE-01",
                "ruleName": "Stable High-Accuracy Lean Buffer",
                "triggerCondition": "Stable demand + High out-of-sample accuracy (WAPE < 15%)",
                "recommendedAction": "High stability baseline; eligible for lean replenishment with 10% lower safety buffer.",
                "bufferAdjustmentPct": -10.0,
                "orderCapMultiplier": 1.30,
                "severity": "INFO"
            })

    # Summary buffer adjustment (net sum of active policy adjustments)
    net_buffer_adj = sum(a["bufferAdjustmentPct"] for a in actions)
    order_caps = [a["orderCapMultiplier"] for a in actions if a["orderCapMultiplier"] is not None]
    min_order_cap = min(order_caps) if order_caps else None

    advisories = [a["recommendedAction"] for a in actions]
    return {
        "lifecycleRegime": regime,
        "lifecycle_regime": regime,
        "momentumFlag": momentum_flag or "NEUTRAL",
        "momentum_flag": momentum_flag or "NEUTRAL",
        "netBufferAdjustmentPct": round(net_buffer_adj, 1),
        "buffer_modifier_pct": round(net_buffer_adj, 1),
        "orderCapMultiplier": min_order_cap,
        "order_cap": min_order_cap,
        "policyActions": actions,
        "policyCount": len(actions),
        "advisories": advisories
    }


def calculate_procurement_schedule(
    start_month: str,
    lead_time_days: Optional[int],
    reference_date: Optional[str] = None
) -> Dict[str, Any]:
    """
    Calculates latest date by which a PR/PO must be raised:
    Latest Order Date = Requirement Month Start Date - Lead Time (Days)
    """
    if not lead_time_days or lead_time_days <= 0:
        return {
            "leadTimeDays": None,
            "requirementStartDate": None,
            "latestOrderDate": None,
            "daysUntilOrderDeadline": None,
            "isOverdue": False,
            "urgency": "NO_LEAD_TIME",
            "message": "Lead time not maintained in Item Master."
        }

    # Determine requirement start date (1st day of start_month, e.g. '2026-11' -> '2026-11-01')
    try:
        if len(start_month) == 7 and start_month[4] == '-':
            req_date = datetime.strptime(f"{start_month}-01", "%Y-%m-%d")
        else:
            req_date = datetime.strptime(start_month, "%Y-%m-%d")
    except Exception:
        # Fallback to next month 1st
        now = datetime.now()
        req_date = datetime(now.year, now.month + 1 if now.month < 12 else 1, 1)

    latest_order_dt = req_date - timedelta(days=int(lead_time_days))
    
    # Compare with reference date
    if reference_date:
        try:
            ref_dt = datetime.strptime(reference_date[:10], "%Y-%m-%d")
        except Exception:
            ref_dt = datetime.now()
    else:
        ref_dt = datetime.now()

    days_until_deadline = (latest_order_dt - ref_dt).days
    is_overdue = days_until_deadline < 0

    if is_overdue:
        urgency = "OVERDUE"
        message = f"Procurement overdue by {abs(days_until_deadline)} days. Place PR/PO immediately."
    elif days_until_deadline <= 14:
        urgency = "IMMINENT"
        message = f"Procurement deadline imminent in {days_until_deadline} days."
    else:
        urgency = "NORMAL"
        message = f"Procurement on schedule ({days_until_deadline} days until release deadline)."

    return {
        "leadTimeDays": int(lead_time_days),
        "requirementStartDate": req_date.strftime("%Y-%m-%d"),
        "latestOrderDate": latest_order_dt.strftime("%Y-%m-%d"),
        "daysUntilOrderDeadline": days_until_deadline,
        "isOverdue": is_overdue,
        "urgency": urgency,
        "message": message
    }
