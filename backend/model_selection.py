"""
Data-Driven Model Selection Module for Demandora.

Selects the best forecasting model for each SKU based strictly on
chronological walk-forward backtest performance (aggregated WAPE, MAE, RMSE, Bias).
No arbitrary preference for complexity or ML.
"""

from typing import List, Dict, Any, Optional, Tuple


def select_best_model(
    backtest_results: List[Dict[str, Any]],
    n_obs: int,
    preferred_model: Optional[str] = None
) -> Tuple[str, str, str, Optional[Dict[str, Any]]]:
    """
    Evaluates backtest candidate leaderboard and selects the winning model.

    Returns:
    (winning_model_name, selection_status, selection_reason, selected_metrics)

    Selection Status:
    - 'SELECTED': Chosen strictly via minimum WAPE from walk-forward backtesting.
    - 'INSUFFICIENT_HISTORY': Not enough observations for backtesting (N < 3). Fallback model used.
    - 'USER_OVERRIDE': User explicitly requested a specific preferred model.
    """
    if n_obs < 1:
        return (
            "Zero Allocation (No History)",
            "INSUFFICIENT_HISTORY",
            "No historical observations found in dataset.",
            None
        )

    if n_obs < 3:
        fallback = "Naive (Last Observation)" if n_obs == 1 else "Historical Mean"
        return (
            fallback,
            "INSUFFICIENT_HISTORY",
            f"Model selection unavailable because only {n_obs} historical observation{'s are' if n_obs > 1 else ' is'} available (requires >= 3).",
            None
        )

    # If user explicitly preferred a model
    if preferred_model:
        for cand in backtest_results:
            if preferred_model.lower() in cand["model"].lower():
                if cand.get("eligible", False) and cand.get("wape") is not None:
                    return (
                        cand["model"],
                        "USER_OVERRIDE",
                        f"Planner explicitly requested {cand['model']}.",
                        {
                            "wape": cand["wape"],
                            "mae": cand["mae"],
                            "rmse": cand["rmse"],
                            "bias": cand["bias"],
                            "validationWindows": cand["validationWindows"]
                        }
                    )

    # Filter eligible models with valid backtest results
    valid_candidates = [
        c for c in backtest_results
        if c.get("eligible", False) and c.get("wape") is not None and c.get("validationWindows", 0) > 0
    ]

    if not valid_candidates:
        # Fallback to simplest available
        fallback = "Naive (Last Observation)"
        return (
            fallback,
            "INSUFFICIENT_HISTORY",
            f"Insufficient history ({n_obs} observations) to complete valid backtest windows across candidates.",
            None
        )

    # Deterministic sorting rule:
    # 1. Lower WAPE (primary)
    # 2. Lower MAE (tie-breaker 1)
    # 3. Lower RMSE (tie-breaker 2)
    # 4. Lower absolute Bias (tie-breaker 3)
    def sort_key(c: Dict[str, Any]):
        wape = c.get("wape", float("inf"))
        mae = c.get("mae", float("inf"))
        rmse = c.get("rmse", float("inf"))
        bias = abs(c.get("bias", 0.0)) if c.get("bias") is not None else float("inf")
        return (round(wape, 4), round(mae, 4), round(rmse, 4), round(bias, 4))

    sorted_candidates = sorted(valid_candidates, key=sort_key)
    winner = sorted_candidates[0]

    winner_name = winner["model"]
    winner_wape = winner["wape"]
    winner_windows = winner["validationWindows"]

    status = "SELECTED"
    reason = f"Selected {winner_name} because it achieved the lowest aggregated WAPE ({winner_wape:.1f}%) across {winner_windows} chronological validation windows."

    metrics = {
        "wape": winner["wape"],
        "mae": winner["mae"],
        "rmse": winner["rmse"],
        "bias": winner["bias"],
        "validationWindows": winner["validationWindows"]
    }

    return (winner_name, status, reason, metrics)
