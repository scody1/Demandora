"""
Cold-Start and Sparse-History Forecasting Module for Demandora.

Deterministic & Traceable Methodology:
1. 0M History (Cold Start):
   - Discovers mature comparable peer SKUs (history >= 6 months) using deterministic attribute matching (Series, Wattage, Form Factor).
   - Derives a month-by-month chronological demand baseline from mature peer history (relative 6-month chronological pattern across peers).
   - Status: COLD_START, Reliability: NOT_EVALUATED, Prediction Intervals: None/null.
   - No fake WAPE, no fake confidence, no arbitrary seasonal multipliers.

2. 1-5M History (Sparse History):
   - Blends direct SKU track record with mature peer monthly baseline via transparent linear shrinkage:
     w = k / 6.0
     y_hat[h] = w * y_direct_mean + (1 - w) * y_peer_monthly_baseline[h]
   - Status: SPARSE_HISTORY, Reliability: NOT_EVALUATED, Prediction Intervals: None/null.
   - Monotonically transitions to standard >=6M short-history and >=12M walk-forward paths.
"""

import re
from typing import List, Dict, Any, Tuple, Optional
import numpy as np


def extract_sku_attributes(item_code: str, description: Optional[str] = "", item_group: Optional[str] = "") -> Dict[str, Any]:
    """
    Extracts structured product attributes from SKU code, description, and group/series.
    """
    desc = str(description or "").strip()
    group = str(item_group or "").strip()
    code = str(item_code or "").strip()
    combined_text = f"{code} {group} {desc}".lower()

    # 1. Wattage extraction (e.g., '6W', '12W', '15W', '20W', '3W', '40W')
    wattage_match = re.search(r'(\d+)\s*[wW]\b', f"{group} {desc}")
    wattage = int(wattage_match.group(1)) if wattage_match else None

    # 2. Form Factor extraction
    form_factors = [
        ('spotlight', 'Spotlight'),
        ('downlight', 'Downlight'),
        ('panel', 'Panel'),
        ('cob', 'COB'),
        ('smps', 'SMPS Driver'),
        ('driver', 'Driver'),
        ('batten', 'Batten'),
        ('strip', 'Strip Light'),
        ('bulb', 'Bulb'),
        ('flood', 'Flood Light'),
        ('street', 'Street Light'),
        ('surface', 'Surface Fixture'),
        ('light', 'Light Fixture')
    ]
    detected_form = 'General Lighting'
    for pattern, name in form_factors:
        if pattern in combined_text:
            detected_form = name
            break

    # 3. CCT / Color extraction
    cct_patterns = [
        (r'\b(w\.w\.|ww|warm white)\b', 'Warm White'),
        (r'\b(c\.w\.|cw|cool white)\b', 'Cool White'),
        (r'\b(n\.w\.|nw|neutral white|natural white)\b', 'Neutral White'),
        (r'\b(red)\b', 'Red'),
        (r'\b(pink)\b', 'Pink'),
        (r'\b(green)\b', 'Green'),
        (r'\b(blue)\b', 'Blue'),
        (r'\b(amber)\b', 'Amber'),
        (r'\b(rgb)\b', 'RGB')
    ]
    detected_cct = 'Standard'
    for pat, cct_name in cct_patterns:
        if re.search(pat, combined_text):
            detected_cct = cct_name
            break

    return {
        "itemCode": code,
        "itemGroup": group or "General Lighting",
        "description": desc,
        "wattage": wattage,
        "formFactor": detected_form,
        "cct": detected_cct
    }


def calculate_sku_similarity(target_attrs: Dict[str, Any], candidate_attrs: Dict[str, Any]) -> float:
    """
    Computes deterministic similarity score [0.0, 1.0] between two SKUs based on real attributes.
    """
    score = 0.0

    # Item Group / Series Match (Base 0.50)
    target_group = target_attrs.get("itemGroup", "").lower().strip()
    candidate_group = candidate_attrs.get("itemGroup", "").lower().strip()
    same_group = bool(target_group and candidate_group and (target_group == candidate_group or target_group in candidate_group or candidate_group in target_group))
    
    if same_group:
        score += 0.50
    else:
        score += 0.10  # cross-group baseline

    # Wattage Match (0.25)
    t_watt = target_attrs.get("wattage")
    c_watt = candidate_attrs.get("wattage")
    if t_watt is not None and c_watt is not None:
        if t_watt == c_watt:
            score += 0.25
        elif abs(t_watt - c_watt) <= 3:
            score += 0.12  # close wattage (e.g. 12W vs 15W)
    elif same_group:
        score += 0.10

    # Form Factor Match (0.15)
    t_form = target_attrs.get("formFactor")
    c_form = candidate_attrs.get("formFactor")
    if t_form and c_form and t_form == c_form:
        score += 0.15

    # CCT / Color Match (0.10)
    t_cct = target_attrs.get("cct")
    c_cct = candidate_attrs.get("cct")
    if t_cct and c_cct and t_cct == c_cct and t_cct != 'Standard':
        score += 0.10

    return min(1.0, round(score, 3))


def find_comparable_skus(
    target_item: Dict[str, Any],
    candidate_pool: List[Dict[str, Any]],
    min_history_depth: int = 6,
    top_k: int = 5
) -> List[Dict[str, Any]]:
    """
    Discovers mature comparable SKUs (>= 6 months history) from the dataset candidate pool.
    Strictly filters out sparse (<6M) items to prevent using unvalidated SKUs as peer anchors.
    """
    target_code = str(target_item.get("itemCode", target_item.get("item_code", ""))).strip().upper()
    target_attrs = extract_sku_attributes(
        target_code,
        target_item.get("description", ""),
        target_item.get("itemGroup", target_item.get("item_group", ""))
    )

    scored_peers = []
    
    # Strictly filter for mature candidates with >= min_history_depth (>= 6 months)
    # Prevent self-matching and validate candidate context data
    filtered_pool = []
    for c in (candidate_pool or []):
        if not isinstance(c, dict):
            continue
        if bool(c.get("isDiscontinued", False)):
            continue
        c_code = str(c.get("itemCode", c.get("item_code", ""))).strip().upper()
        if not c_code or c_code == target_code:
            continue
        raw_hist = c.get("history", c.get("history_values", []))
        if not isinstance(raw_hist, (list, tuple)):
            continue
        try:
            numeric_hist = [float(v) for v in raw_hist if v is not None]
        except (ValueError, TypeError):
            continue
        if len(numeric_hist) >= min_history_depth and sum(numeric_hist) > 0:
            filtered_pool.append({
                **c,
                "itemCode": c_code,
                "history": numeric_hist
            })

    for cand in filtered_pool:
        cand_code = str(cand.get("itemCode", "")).strip().upper()
        cand_attrs = extract_sku_attributes(
            cand_code,
            cand.get("description", ""),
            cand.get("itemGroup", "")
        )
        sim = calculate_sku_similarity(target_attrs, cand_attrs)
        if sim >= 0.35:  # Valid peer similarity threshold
            hist = [float(v) for v in cand.get("history", [])]
            cand_avg = float(np.mean(hist)) if hist else 0.0
            scored_peers.append({
                "itemCode": cand_code,
                "description": cand.get("description", ""),
                "itemGroup": cand.get("itemGroup", ""),
                "historyLength": len(hist),
                "historicalAverage": round(cand_avg, 2),
                "history": hist,
                "periods": cand.get("periods", []),
                "similarity": sim
            })

    # Sort descending: highest similarity, longest history depth (maturity), then volume
    scored_peers.sort(key=lambda p: (p["similarity"], p["historyLength"], p["historicalAverage"]), reverse=True)
    return scored_peers[:top_k]


def compute_traceable_peer_monthly_baseline(
    peers: List[Dict[str, Any]],
    horizon: int = 6
) -> Tuple[List[float], List[str], str, float]:
    """
    Derives deterministic month-by-month peer group chronological demand baseline (M1..M6).
    
    Traceable Methodology:
    1. For each mature comparable peer SKU (>=6M history):
       - Extracts historical demand corresponding to the relative chronological cycle:
         If peer history >= 12: uses corresponding historical months from the recent 12M cycle.
         If 6 <= peer history < 12: uses corresponding historical months from the recent 6M cycle.
    2. For each horizon step h in [1..horizon]:
       - Takes the deterministic median of peer observations at that chronological step across all peers.
    3. Falls back to constant peer median only if insufficient chronological depth.
    """
    if not peers:
        return [0.0] * horizon, [], "No Comparable Group", 0.0

    peer_codes = [p["itemCode"] for p in peers]
    avg_similarity = float(np.mean([p["similarity"] for p in peers]))
    peer_group_name = peers[0].get("itemGroup") or "Comparable Fixture Group"

    monthly_baseline = []
    
    for h in range(horizon):
        step_observations = []
        for p in peers:
            hist = p.get("history", [])
            n_hist = len(hist)
            if n_hist >= 12:
                # Use corresponding position in 12-month annual pattern
                idx = n_hist - 12 + (h % 12)
                if 0 <= idx < n_hist:
                    step_observations.append(hist[idx])
            elif n_hist >= 6:
                # Use corresponding position in 6-month recent cycle
                idx = n_hist - 6 + (h % 6)
                if 0 <= idx < n_hist:
                    step_observations.append(hist[idx])
            elif n_hist > 0:
                step_observations.append(hist[h % n_hist])

        if step_observations:
            # Deterministic median across mature peers for horizon step h
            monthly_baseline.append(round(float(np.median(step_observations)), 2))
        else:
            # Fallback to peer historical averages median
            peer_averages = [p["historicalAverage"] for p in peers if p["historicalAverage"] > 0]
            fallback_val = float(np.median(peer_averages)) if peer_averages else 0.0
            monthly_baseline.append(round(fallback_val, 2))

    return monthly_baseline, peer_codes, peer_group_name, round(avg_similarity, 3)


def generate_cold_or_sparse_forecast(
    target_item: Dict[str, Any],
    candidate_pool: List[Dict[str, Any]],
    horizon: int = 6
) -> Dict[str, Any]:
    """
    Generates deterministic 6-month forecast for 0M (Cold Start) and 1-5M (Sparse History) SKUs.
    """
    item_code = str(target_item.get("itemCode", "")).strip().upper()
    history = [float(v) for v in target_item.get("history", [])]
    n_obs = len(history)
    
    # Discover mature peers (>= 6M history)
    peers = find_comparable_skus(target_item, candidate_pool, min_history_depth=6)
    monthly_peer_baseline, peer_codes, peer_group, avg_sim = compute_traceable_peer_monthly_baseline(peers, horizon=horizon)

    has_valid_peer_demand = bool(peers and any(v > 0 for v in monthly_peer_baseline))

    if n_obs == 0:
        # ============================================================
        # 0M COLD START FORECAST
        # ============================================================
        selection_status = "COLD_START"
        if has_valid_peer_demand:
            raw_forecast = [float(round(v, 2)) for v in monthly_peer_baseline]
            discrete_forecast = [max(0, int(round(v))) for v in monthly_peer_baseline]
            model_name = "Cold Start (Comparable SKU Baseline)"
            avg_units = int(round(float(np.mean(discrete_forecast))))
            reason = (
                f"Cold-start baseline (~{avg_units} units/mo) derived from "
                f"{len(peers)} mature comparable SKUs in '{peer_group}' (Avg Similarity: {avg_sim:.2f}). "
                f"No direct historical sales."
            )
            direct_weight = 0.0
            peer_weight = 1.0
        else:
            raw_forecast = [0.0] * horizon
            discrete_forecast = [0] * horizon
            model_name = "Cold Start (No Mature Peers)"
            reason = "Cold start SKU with 0M history and no mature comparable peer SKUs (>=6M) found in dataset."
            direct_weight = 0.0
            peer_weight = 0.0

    else:
        # ============================================================
        # 1-5M SPARSE HISTORY FORECAST (Linear Shrinkage w = k / 6.0)
        # ============================================================
        selection_status = "SPARSE_HISTORY"
        direct_mean = float(np.mean(history))
        w = float(n_obs / 6.0)
        
        if has_valid_peer_demand:
            raw_forecast = []
            discrete_forecast = []
            for h in range(horizon):
                peer_val = monthly_peer_baseline[h]
                blended = (w * direct_mean) + ((1.0 - w) * peer_val)
                raw_forecast.append(float(round(blended, 2)))
                discrete_forecast.append(max(0, int(round(blended))))

            avg_peer = int(round(float(np.mean(monthly_peer_baseline))))
            model_name = f"Sparse History (Direct + Peer Blend {int(w*100)}%/{int((1.0-w)*100)}%)"
            reason = (
                f"Sparse history ({n_obs}M): Blended {w*100:.0f}% direct track record ({int(round(direct_mean))} units) "
                f"with {100*(1.0-w):.0f}% peer baseline (~{avg_peer} units from {len(peers)} SKUs). "
                f"Deterministic linear shrinkage."
            )
            direct_weight = round(w, 3)
            peer_weight = round(1.0 - w, 3)
        else:
            raw_forecast = [float(round(direct_mean, 2))] * horizon
            discrete_forecast = [max(0, int(round(direct_mean)))] * horizon
            model_name = "Sparse History (Direct Mean Baseline)"
            reason = f"Sparse history ({n_obs}M): Baseline derived from available direct historical observations."
            direct_weight = 1.0
            peer_weight = 0.0

    return {
        "itemCode": item_code,
        "modelName": model_name,
        "modelType": "cold_start" if n_obs == 0 else "sparse_history",
        "selectedModel": model_name,
        "selectionStatus": selection_status,
        "selectionReason": reason,
        "historyMonths": n_obs,
        "trainingRows": n_obs,
        "forecast": discrete_forecast,
        "rawForecast": raw_forecast,
        "selectedModelMetrics": None,  # No fake WAPE or accuracy metrics
        "modelComparison": [],
        "eligibility": [],
        "confidence": {
            "status": "NOT_EVALUATED",
            "score": None,
            "level": "NOT_EVALUATED",
            "intervalLevel": 0.90,
            "lowerBound": [None] * horizon,
            "upperBound": [None] * horizon,
            "method": "None",
            "validationObservationCount": 0,
            "errorSummary": None,
            "reasons": [reason]
        },
        "metadata": {
            "selection_status": selection_status,
            "history_months": n_obs,
            "direct_weight": direct_weight,
            "peer_weight": peer_weight,
            "peer_skus": peer_codes,
            "peer_group": peer_group,
            "peer_similarity": avg_sim,
            "peer_monthly_baseline": monthly_peer_baseline,
            "forecast_horizon": horizon
        }
    }
