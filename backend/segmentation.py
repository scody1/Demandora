"""
Demand-Based SKU Segmentation Module for Demandora.

Classifies products into three business-oriented categories:
1. RUNNER: Frequent and relatively consistent demand.
2. REPEATER: Recurring but intermittent or variable demand.
3. STRANGER: Rare, highly sporadic or insufficient demand evidence.
Plus UNCLASSIFIED for products with zero lifetime sales records.

Theoretical Foundation:
Syntetos-Boylan-Croston (2005) demand classification framework extended
with historical maturity and active recurrence criteria.
Reuses mathematical telemetry from pattern_intelligence.py.
"""

from typing import List, Dict, Any, Optional
import numpy as np

from .pattern_intelligence import calculate_adi, calculate_cv2


# Default transparent and configurable segmentation parameters
DEFAULT_SEGMENTATION_CONFIG: Dict[str, Any] = {
    "version": "v1.0.0-SBC",
    "adi_threshold": 1.32,             # ADI <= 1.32 indicates frequent inter-demand intervals
    "cv2_threshold": 0.49,             # CV² <= 0.49 indicates low volume variability
    "min_history_months": 6,           # Minimum history length for mature walk-forward evaluation
    "runner_min_active_ratio": 0.60,   # Active months / Total months >= 60%
    "runner_min_active_months": 4,     # At least 4 positive demand months
    "repeater_min_active_months": 3,   # At least 3 positive demand months
    "stranger_min_zero_ratio": 0.70    # >= 70% zero-demand months qualifies as sporadic
}


def format_metric(val: float, threshold: float, decimals: int = 2) -> str:
    """
    Formats metric for display without obscuring boundary threshold decisions.
    If standard rounding matches threshold display but the unrounded value differs,
    displays up to 4 decimals so that comparison reasons (e.g. 1.3201 > 1.32) are transparent.
    """
    formatted = f"{val:.{decimals}f}"
    thresh_formatted = f"{threshold:.{decimals}f}"
    if formatted == thresh_formatted and val != threshold:
        return f"{val:.4f}".rstrip('0').rstrip('.')
    return formatted


def calculate_segmentation_metrics(history_values: List[float]) -> Dict[str, Any]:
    """
    Calculates empirical demand behavior characteristics for a single SKU series.
    Strictly reuses pattern_intelligence calculations and established time-series statistics.
    """
    series = np.array(history_values, dtype=float)
    n_obs = len(series)

    if n_obs == 0:
        return {
            "history_length": 0,
            "active_months": 0,
            "zero_demand_months": 0,
            "demand_frequency": 0.0,
            "zero_demand_ratio": 1.0,
            "average_monthly_demand": 0.0,
            "total_demand": 0.0,
            "adi": 0.0,
            "cv_squared": 0.0,
            "cv": 0.0,
            "adi_raw": 0.0,
            "cv_squared_raw": 0.0,
            "cv_raw": 0.0,
            "demand_frequency_raw": 0.0,
            "zero_demand_ratio_raw": 1.0,
            "average_monthly_demand_raw": 0.0,
            "total_demand_raw": 0.0
        }

    non_zero = series[series > 0]
    active_months = int(len(non_zero))
    zero_demand_months = int(n_obs - active_months)
    demand_frequency = float((active_months / n_obs) * 100.0)
    zero_demand_ratio = float(zero_demand_months / n_obs)
    average_monthly_demand = float(np.mean(series))
    total_demand = float(np.sum(series))

    adi = float(calculate_adi(series))
    cv2 = float(calculate_cv2(series))
    cv = float(np.sqrt(cv2)) if cv2 >= 0 else 0.0

    return {
        "history_length": n_obs,
        "active_months": active_months,
        "zero_demand_months": zero_demand_months,
        "demand_frequency": round(demand_frequency, 2),
        "zero_demand_ratio": round(zero_demand_ratio, 4),
        "average_monthly_demand": round(average_monthly_demand, 2),
        "total_demand": round(total_demand, 2),
        "adi": round(adi, 2),
        "cv_squared": round(cv2, 4),
        "cv": round(cv, 4),
        "adi_raw": adi,
        "cv_squared_raw": cv2,
        "cv_raw": cv,
        "demand_frequency_raw": demand_frequency,
        "zero_demand_ratio_raw": zero_demand_ratio,
        "average_monthly_demand_raw": average_monthly_demand,
        "total_demand_raw": total_demand
    }


def classify_sku(
    item_code: str,
    history_values: List[float],
    description: str = "",
    item_group: str = "",
    config: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Deterministically classifies a single SKU into RUNNER, REPEATER, STRANGER, or UNCLASSIFIED.

    Classification is mutually exclusive and collectively exhaustive.
    Grounds decisions entirely in historical metrics available at forecast origin.
    Threshold comparisons strictly use unrounded numerical values; rounding is applied solely for display.
    """
    cfg = dict(DEFAULT_SEGMENTATION_CONFIG)
    if config:
        cfg.update(config)

    metrics = calculate_segmentation_metrics(history_values)
    version = cfg["version"]
    adi_threshold = cfg["adi_threshold"]
    cv2_threshold = cfg["cv2_threshold"]
    min_history_months = cfg["min_history_months"]
    runner_min_active_ratio = cfg["runner_min_active_ratio"]
    runner_min_active_months = cfg["runner_min_active_months"]
    repeater_min_active_months = cfg["repeater_min_active_months"]
    stranger_min_zero_ratio = cfg["stranger_min_zero_ratio"]

    n_obs = metrics["history_length"]
    active = metrics["active_months"]
    zeros = metrics["zero_demand_months"]
    total = metrics["total_demand_raw"]
    zero_ratio = metrics["zero_demand_ratio_raw"]
    freq_pct = metrics["demand_frequency_raw"]

    # Strictly use unrounded values for threshold comparisons
    adi = metrics["adi_raw"]
    cv2 = metrics["cv_squared_raw"]
    cv = metrics["cv_raw"]

    # 1. COLD-START Candidate Check: Zero observed historical periods (history = [])
    if n_obs == 0:
        category = "STRANGER"
        reason = (
            "Zero observed historical periods (0M history); "
            "routes to cold-start peer discovery using comparable mature SKUs."
        )
        return {
            "itemCode": item_code,
            "description": description,
            "itemGroup": item_group,
            "category": category,
            "classificationReason": reason,
            "demandFrequency": 0.0,
            "activeMonths": 0,
            "zeroDemandMonths": 0,
            "averageMonthlyDemand": 0.0,
            "cv": 0.0,
            "cvSquared": 0.0,
            "adi": 0.0,
            "historyLength": 0,
            "ruleVersion": version,
            "_rawAdi": 0.0,
            "_rawCvSquared": 0.0
        }

    # 2. UNCLASSIFIED Check: Observed periods with zero demand (e.g. [0, 0, 0, 0, 0, 0])
    if total <= 0 or active == 0:
        category = "UNCLASSIFIED"
        reason = (
            f"Zero recorded historical demand across all {n_obs} observed month(s); "
            "cannot reliably evaluate demand frequency, inter-demand interval, or volume variability."
        )
        return {
            "itemCode": item_code,
            "description": description,
            "itemGroup": item_group,
            "category": category,
            "classificationReason": reason,
            "demandFrequency": metrics["demand_frequency"],
            "activeMonths": active,
            "zeroDemandMonths": zeros,
            "averageMonthlyDemand": metrics["average_monthly_demand"],
            "cv": metrics["cv"],
            "cvSquared": metrics["cv_squared"],
            "adi": metrics["adi"],
            "historyLength": n_obs,
            "ruleVersion": version,
            "_rawAdi": adi,
            "_rawCvSquared": cv2
        }

    # 2. STRANGER Checks: Insufficient history length, highly sporadic occurrences, or lumpy patterns
    if n_obs < min_history_months:
        category = "STRANGER"
        reason = (
            f"Insufficient historical maturity ({n_obs} month(s) < {min_history_months}M required for statistical forecasting; "
            "routes to cold-start / sparse-history peer discovery)."
        )
    elif active < repeater_min_active_months:
        category = "STRANGER"
        reason = (
            f"Highly sporadic demand with only {active} active demand month(s) out of {n_obs} total periods "
            f"({zero_ratio * 100:.1f}% zero-demand ratio exceeds sporadic threshold)."
        )
    elif adi > adi_threshold and cv2 > cv2_threshold:
        category = "STRANGER"
        reason = (
            f"Lumpy demand pattern: both spaced inter-demand intervals (ADI = {format_metric(adi, adi_threshold)} > {adi_threshold}) "
            f"and high order volume variability (CV² = {format_metric(cv2, cv2_threshold)} > {cv2_threshold})."
        )
    elif zero_ratio >= stranger_min_zero_ratio:
        category = "STRANGER"
        reason = (
            f"Infrequent demand occurrences with {zero_ratio * 100:.1f}% zero-demand periods "
            f"(>= {stranger_min_zero_ratio * 100:.0f}% threshold)."
        )

    # 3. RUNNER Checks: High frequency, low intervals, low variance
    elif (
        adi <= adi_threshold
        and cv2 <= cv2_threshold
        and active >= runner_min_active_months
        and (active / n_obs) >= runner_min_active_ratio
    ):
        category = "RUNNER"
        reason = (
            f"Frequent and consistent demand: regular demand intervals (ADI = {format_metric(adi, adi_threshold)} <= {adi_threshold}), "
            f"stable order sizing (CV² = {format_metric(cv2, cv2_threshold)} <= {cv2_threshold}), and {round(freq_pct, 1):.1f}% active demand months "
            f"across {n_obs} historical months."
        )

    # 4. REPEATER: Recurring historical demand that is either erratic in volume or spaced in time
    else:
        category = "REPEATER"
        if adi <= adi_threshold and cv2 > cv2_threshold:
            reason = (
                f"Frequent but erratic demand: recurring order intervals (ADI = {format_metric(adi, adi_threshold)} <= {adi_threshold}) "
                f"with variable order quantities (CV² = {format_metric(cv2, cv2_threshold)} > {cv2_threshold})."
            )
        elif adi > adi_threshold and cv2 <= cv2_threshold:
            reason = (
                f"Intermittent recurring demand: spaced order intervals (ADI = {format_metric(adi, adi_threshold)} > {adi_threshold}) "
                f"with consistent order quantities (CV² = {format_metric(cv2, cv2_threshold)} <= {cv2_threshold})."
            )
        else:
            reason = (
                f"Recurring demand pattern with {active} active months ({round(freq_pct, 1):.1f}% frequency) "
                f"and moderate demand continuity."
            )

    return {
        "itemCode": item_code,
        "description": description,
        "itemGroup": item_group,
        "category": category,
        "classificationReason": reason,
        "demandFrequency": metrics["demand_frequency"],
        "activeMonths": active,
        "zeroDemandMonths": zeros,
        "averageMonthlyDemand": metrics["average_monthly_demand"],
        "cv": metrics["cv"],
        "cvSquared": metrics["cv_squared"],
        "adi": metrics["adi"],
        "historyLength": n_obs,
        "ruleVersion": version,
        "_rawAdi": adi,
        "_rawCvSquared": cv2
    }


def segment_sku_population(
    items: List[Dict[str, Any]],
    config: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Classifies a batch or population of SKUs and computes aggregate telemetry,
    category distributions, and criteria satisfaction counts for UI cards and accordions.
    """
    cfg = dict(DEFAULT_SEGMENTATION_CONFIG)
    if config:
        cfg.update(config)

    classified_items: List[Dict[str, Any]] = []
    category_counts = {
        "RUNNER": 0,
        "REPEATER": 0,
        "STRANGER": 0,
        "UNCLASSIFIED": 0
    }

    # Criteria satisfaction trackers
    runner_criteria = {
        "adiSatisfied": 0,
        "cv2Satisfied": 0,
        "frequencySatisfied": 0,
        "maturitySatisfied": 0
    }
    repeater_criteria = {
        "recurringActiveSatisfied": 0,
        "intermittentOrErraticSatisfied": 0,
        "zeroRatioSatisfied": 0,
        "maturitySatisfied": 0
    }
    stranger_criteria = {
        "insufficientHistorySatisfied": 0,
        "sporadicActiveSatisfied": 0,
        "lumpyPatternSatisfied": 0,
        "highZeroRatioSatisfied": 0
    }

    illustrative_examples = {
        "RUNNER": None,
        "REPEATER": None,
        "STRANGER": None,
        "UNCLASSIFIED": None
    }

    for item in items:
        code = str(item.get("itemCode", "")).strip().upper()
        desc = str(item.get("description", "")).strip()
        group = str(item.get("itemGroup", "")).strip()
        hist = item.get("history", [])

        res = classify_sku(code, hist, description=desc, item_group=group, config=cfg)
        classified_items.append(res)

        cat = res["category"]
        category_counts[cat] = category_counts.get(cat, 0) + 1

        # Save an illustrative SKU if not yet selected
        if illustrative_examples[cat] is None and res["historyLength"] > 0:
            illustrative_examples[cat] = res

        # Evaluate individual criteria across population using unrounded numerical metrics
        adi = res.get("_rawAdi", res["adi"])
        cv2 = res.get("_rawCvSquared", res["cvSquared"])
        n_obs = res["historyLength"]
        active = res["activeMonths"]
        freq = res["demandFrequency"]
        zeros = res["zeroDemandMonths"]
        zero_ratio = zeros / n_obs if n_obs > 0 else 1.0

        # Runner criteria checks
        if adi <= cfg["adi_threshold"]:
            runner_criteria["adiSatisfied"] += 1
        if cv2 <= cfg["cv2_threshold"]:
            runner_criteria["cv2Satisfied"] += 1
        if (active / n_obs >= cfg["runner_min_active_ratio"]) if n_obs > 0 else False:
            runner_criteria["frequencySatisfied"] += 1
        if n_obs >= cfg["min_history_months"]:
            runner_criteria["maturitySatisfied"] += 1

        # Repeater criteria checks
        if active >= cfg["repeater_min_active_months"]:
            repeater_criteria["recurringActiveSatisfied"] += 1
        if (adi > cfg["adi_threshold"] and cv2 <= cfg["cv2_threshold"]) or (adi <= cfg["adi_threshold"] and cv2 > cfg["cv2_threshold"]):
            repeater_criteria["intermittentOrErraticSatisfied"] += 1
        if zero_ratio < cfg["stranger_min_zero_ratio"]:
            repeater_criteria["zeroRatioSatisfied"] += 1
        if n_obs >= cfg["min_history_months"]:
            repeater_criteria["maturitySatisfied"] += 1

        # Stranger criteria checks
        if n_obs < cfg["min_history_months"]:
            stranger_criteria["insufficientHistorySatisfied"] += 1
        if active < cfg["repeater_min_active_months"]:
            stranger_criteria["sporadicActiveSatisfied"] += 1
        if adi > cfg["adi_threshold"] and cv2 > cfg["cv2_threshold"]:
            stranger_criteria["lumpyPatternSatisfied"] += 1
        if zero_ratio >= cfg["stranger_min_zero_ratio"]:
            stranger_criteria["highZeroRatioSatisfied"] += 1

    total_skus = len(classified_items)
    classified_eligible = total_skus - category_counts["UNCLASSIFIED"]
    denominator = classified_eligible if classified_eligible > 0 else (total_skus if total_skus > 0 else 1)

    runner_pct = round((category_counts["RUNNER"] / denominator) * 100.0, 1) if denominator > 0 else 0.0
    repeater_pct = round((category_counts["REPEATER"] / denominator) * 100.0, 1) if denominator > 0 else 0.0
    stranger_pct = round((category_counts["STRANGER"] / denominator) * 100.0, 1) if denominator > 0 else 0.0
    unclassified_pct = round((category_counts["UNCLASSIFIED"] / total_skus) * 100.0, 1) if total_skus > 0 else 0.0

    return {
        "ruleVersion": cfg["version"],
        "totalSKUs": total_skus,
        "eligibleSKUs": classified_eligible,
        "config": cfg,
        "summary": {
            "RUNNER": {
                "count": category_counts["RUNNER"],
                "percentage": runner_pct,
                "label": "Runner",
                "description": "Frequent and relatively consistent demand.",
                "criteria": [
                    {
                        "condition": f"Average Demand Interval (ADI) <= {cfg['adi_threshold']}",
                        "explanation": f"Demand occurs at regular intervals of {cfg['adi_threshold']} months or less.",
                        "satisfiedCount": runner_criteria["adiSatisfied"]
                    },
                    {
                        "condition": f"Demand Volume Variability (CV²) <= {cfg['cv2_threshold']}",
                        "explanation": f"Squared coefficient of variation is stable at {cfg['cv2_threshold']} or below.",
                        "satisfiedCount": runner_criteria["cv2Satisfied"]
                    },
                    {
                        "condition": f"Active Demand Frequency >= {int(cfg['runner_min_active_ratio'] * 100)}%",
                        "explanation": f"Orders placed in at least {int(cfg['runner_min_active_ratio'] * 100)}% of total historical months.",
                        "satisfiedCount": runner_criteria["frequencySatisfied"]
                    },
                    {
                        "condition": f"Historical Telemetry >= {cfg['min_history_months']} Months",
                        "explanation": "Sufficient history depth for mature statistical & ML model selection.",
                        "satisfiedCount": runner_criteria["maturitySatisfied"]
                    }
                ],
                "illustrativeSku": illustrative_examples["RUNNER"]
            },
            "REPEATER": {
                "count": category_counts["REPEATER"],
                "percentage": repeater_pct,
                "label": "Repeater",
                "description": "Recurring but intermittent or variable demand.",
                "criteria": [
                    {
                        "condition": f"Recurring Order Frequency >= {cfg['repeater_min_active_months']} Active Months",
                        "explanation": f"Demonstrates established recurring demand with at least {cfg['repeater_min_active_months']} active months.",
                        "satisfiedCount": repeater_criteria["recurringActiveSatisfied"]
                    },
                    {
                        "condition": f"Intermittent (ADI > {cfg['adi_threshold']}) OR Erratic (CV² > {cfg['cv2_threshold']})",
                        "explanation": "Moderate intermittency in ordering periods or volatility in order lot sizes.",
                        "satisfiedCount": repeater_criteria["intermittentOrErraticSatisfied"]
                    },
                    {
                        "condition": f"Zero-Demand Ratio < {int(cfg['stranger_min_zero_ratio'] * 100)}%",
                        "explanation": "Recurring activity does not exhibit extreme multi-quarter dormancy.",
                        "satisfiedCount": repeater_criteria["zeroRatioSatisfied"]
                    },
                    {
                        "condition": f"Historical Telemetry >= {cfg['min_history_months']} Months",
                        "explanation": "Valid history foundation available at forecast origin.",
                        "satisfiedCount": repeater_criteria["maturitySatisfied"]
                    }
                ],
                "illustrativeSku": illustrative_examples["REPEATER"]
            },
            "STRANGER": {
                "count": category_counts["STRANGER"],
                "percentage": stranger_pct,
                "label": "Stranger",
                "description": "Rare, highly sporadic or insufficient demand evidence.",
                "criteria": [
                    {
                        "condition": f"History Length < {cfg['min_history_months']} Months",
                        "explanation": "Cold-start (0M) or sparse history (1–5M) requiring peer discovery.",
                        "satisfiedCount": stranger_criteria["insufficientHistorySatisfied"]
                    },
                    {
                        "condition": f"Highly Sporadic Demand (< {cfg['repeater_min_active_months']} Active Months)",
                        "explanation": "Sparse transactions across long observation windows.",
                        "satisfiedCount": stranger_criteria["sporadicActiveSatisfied"]
                    },
                    {
                        "condition": f"Lumpy Demand (ADI > {cfg['adi_threshold']} AND CV² > {cfg['cv2_threshold']})",
                        "explanation": "Simultaneously infrequent orders and volatile quantity spikes.",
                        "satisfiedCount": stranger_criteria["lumpyPatternSatisfied"]
                    },
                    {
                        "condition": f"Zero-Demand Ratio >= {int(cfg['stranger_min_zero_ratio'] * 100)}%",
                        "explanation": "Dominant dormancy with sporadic isolated purchase events.",
                        "satisfiedCount": stranger_criteria["highZeroRatioSatisfied"]
                    }
                ],
                "illustrativeSku": illustrative_examples["STRANGER"]
            },
            "UNCLASSIFIED": {
                "count": category_counts["UNCLASSIFIED"],
                "percentage": unclassified_pct,
                "label": "Unclassified",
                "description": "Zero historical sales volume across all periods; cannot evaluate demand behavior.",
                "illustrativeSku": illustrative_examples["UNCLASSIFIED"]
            }
        },
        "items": classified_items
    }
