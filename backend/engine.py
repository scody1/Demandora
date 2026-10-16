"""
Forecasting Engine Core for Demandora AI Platform.

Orchestrates Phase 2:
1. Dynamic model eligibility per SKU.
2. Chronological walk-forward backtesting across expanding validation windows.
3. Multi-metric evaluation (MAE, RMSE, WAPE, Bias) without temporal data leakage.
4. Deterministic model selection (lowest WAPE wins, tie-breakers: MAE, RMSE, absolute Bias).
5. Winning model refit on ALL currently available historical data.
6. Recursive multi-step future forecasting with non-negative clipping audit.
7. Full structured metadata and comparison reporting.
"""

from typing import List, Dict, Any, Optional
from datetime import datetime, timezone
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import numpy as np

from .models import (
    NaiveModel,
    HistoricalMeanModel,
    SimpleMovingAverageModel,
    WeightedMovingAverageModel,
    LinearTrendModel,
    HoltExponentialSmoothingModel,
    HistGradientBoostingModel,
    CrostonModel,
    SBAModel
)
from .pattern_intelligence import profile_demand
from .cold_start import generate_cold_or_sparse_forecast
from .segmentation import classify_sku
from .features import (
    build_supervised_dataset,
    make_future_step_feature_extractor
)
from .backtesting import (
    WalkForwardBacktester,
    instantiate_model
)
from .model_selection import (
    select_best_model
)
from .cache import (
    ForecastCache,
    get_default_cache,
    compute_series_hash,
    compute_peer_pool_digest,
    compute_cold_start_keys,
    compute_mature_keys,
    serialize_fitted_model,
    restore_fitted_model,
    SingleFlightTimeoutError
)


class ForecastingEngine:
    def __init__(
        self,
        validation_horizon: int = 1,
        cache: Optional[ForecastCache] = None,
        use_cache: bool = True,
        follower_timeout: float = 60.0
    ):
        self.validation_horizon = max(1, validation_horizon)
        self.backtester = WalkForwardBacktester(validation_horizon=self.validation_horizon)
        self.use_cache = use_cache
        self.follower_timeout = follower_timeout
        if cache is not None:
            self.cache = cache
        elif self.use_cache:
            self.cache = get_default_cache()
        else:
            self.cache = None

    def get_candidate_models(self) -> List[Any]:
        return [
            NaiveModel(),
            HistoricalMeanModel(),
            SimpleMovingAverageModel(window=3),
            WeightedMovingAverageModel(),
            LinearTrendModel(),
            HoltExponentialSmoothingModel(),
            HistGradientBoostingModel(),
        ]

    def calculate_confidence_and_intervals(
        self,
        point_forecasts: List[float],
        winner_name: str,
        backtest_results: List[Dict[str, Any]],
        confidence_level: float = 0.90
    ) -> Dict[str, Any]:
        """
        Calculates empirical prediction intervals and confidence score using out-of-sample residuals.
        """
        winner_run = next((run for run in backtest_results if run["model"] == winner_name), None)
        
        confidence_res = {
            "status": "NOT_EVALUATED",
            "score": None,
            "level": "NOT_EVALUATED",
            "intervalLevel": confidence_level,
            "lowerBound": [None] * len(point_forecasts),
            "upperBound": [None] * len(point_forecasts),
            "method": "Empirical Residual Quantiles",
            "validationObservationCount": 0,
            "errorSummary": None,
            "reasons": ["Insufficient validation observations"]
        }

        if not winner_run or not winner_run["eligible"]:
            return confidence_res

        valid_windows = winner_run.get("validWindows", 0)
        horizon_errors = winner_run.get("horizon_errors", {})
        
        # Calculate empirical interval bounds
        alpha = 1.0 - confidence_level
        lower_q = (alpha / 2) * 100
        upper_q = (1 - alpha / 2) * 100
        
        # We need at least a few errors to make quantiles meaningful. Let's say >= 3.
        # Flatten all errors as fallback
        all_errors = []
        for errs in horizon_errors.values():
            all_errors.extend(errs)
            
        confidence_res["validationObservationCount"] = len(all_errors)
            
        if len(all_errors) >= 3:
            lower_bounds = []
            upper_bounds = []
            
            for step_idx, pred in enumerate(point_forecasts):
                h_step = step_idx + 1
                step_errs = horizon_errors.get(h_step, [])
                
                if len(step_errs) >= 3:
                    l_err = np.percentile(step_errs, lower_q)
                    u_err = np.percentile(step_errs, upper_q)
                else:
                    l_err = np.percentile(all_errors, lower_q)
                    u_err = np.percentile(all_errors, upper_q)
                    
                lower_bounds.append(max(0.0, float(pred + l_err)))
                upper_bounds.append(max(0.0, float(pred + u_err)))
                
            confidence_res["lowerBound"] = lower_bounds
            confidence_res["upperBound"] = upper_bounds
            
            # Evidence-Based Reliability Metric
            wape = float(winner_run.get("wape", 100.0))
            bias = float(winner_run.get("bias", 0.0))
            
            # 1. Accuracy Evidence (bounded 0 to 1)
            accuracy_evidence = 1.0 / (1.0 + (wape / 100.0))
            
            # 2. Bias Evidence (bounded 0 to 1)
            bias_evidence = 1.0 / (1.0 + (abs(bias) / 100.0))
            
            # 3. Interval Width Evidence (bounded 0 to 1)
            widths = [(u - l) / max(p, 1.0) for p, l, u in zip(point_forecasts, lower_bounds, upper_bounds)]
            avg_width = float(np.mean(widths)) if widths else 0.0
            interval_evidence = 1.0 / (1.0 + avg_width)
            
            # 4. Stability Evidence (bounded 0 to 1)
            if len(all_errors) > 1:
                mean_abs_err = np.mean(np.abs(all_errors))
                std_err = np.std(all_errors)
                cov = float(std_err / max(mean_abs_err, 1.0))
            else:
                cov = 1.0
            stability_evidence = 1.0 / (1.0 + cov)
            
            # Combine via weighted geometric mean
            # Weights: Accuracy (40%), Bias (20%), Interval (30%), Stability (10%)
            reliability_normalized = (
                (accuracy_evidence ** 0.4) *
                (bias_evidence ** 0.2) *
                (interval_evidence ** 0.3) *
                (stability_evidence ** 0.1)
            )
            score = float(round(reliability_normalized * 100.0, 1))
            
            reasons = []
            if valid_windows < 3:
                confidence_res["level"] = "NOT_EVALUATED"
                confidence_res["status"] = "NOT_EVALUATED"
                confidence_res["score"] = None
                reasons.append("Insufficient validation windows (< 3)")
                # Clear bounds when not evaluated
                confidence_res["lowerBound"] = [None] * len(point_forecasts)
                confidence_res["upperBound"] = [None] * len(point_forecasts)
            else:
                if score >= 75:
                    confidence_res["level"] = "HIGH"
                    reasons.append("Strong out-of-sample accuracy and stability")
                elif score >= 50:
                    confidence_res["level"] = "MEDIUM"
                    reasons.append("Acceptable out-of-sample accuracy")
                else:
                    confidence_res["level"] = "LOW"
                    reasons.append("Weak validation performance or high uncertainty")
                    
                if abs(bias) > 20:
                    reasons.append("Significant historical bias detected")
                if avg_width > 1.0:
                    reasons.append("Wide prediction intervals")
                    
                confidence_res["score"] = score
                confidence_res["status"] = "EVALUATED"
                
            confidence_res["reasons"] = reasons
            confidence_res["components"] = {
                "accuracy": float(round(accuracy_evidence, 3)),
                "bias": float(round(bias_evidence, 3)),
                "interval": float(round(interval_evidence, 3)),
                "stability": float(round(stability_evidence, 3)),
                "validationSufficiency": valid_windows
            }
            confidence_res["metrics"] = {
                "wape": float(round(wape, 2)),
                "bias": float(round(bias, 2)),
                "intervalWidthRatio": float(round(avg_width, 2)),
                "validationWindows": valid_windows
            }
            
        return confidence_res

    def evaluate_sku_eligibility(self, n_obs: int, profile: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """
        Determines static eligibility of all candidate models for a given SKU history depth.
        """
        candidates = self.get_candidate_models()
        leaderboard = []
        for model in candidates:
            eligible, reason = model.check_eligibility(n_obs, profile)
            leaderboard.append({
                "modelName": model.name,
                "modelType": model.model_type,
                "minRequiredHistory": model.min_history,
                "isEligible": eligible,
                "status": "Eligible" if eligible else "Not Eligible",
                "reason": reason
            })
        return leaderboard

    def forecast_single_sku(
        self,
        item_code: str,
        history_values: List[float],
        history_periods: Optional[List[str]] = None,
        missing_periods: Optional[List[str]] = None,
        horizon: int = 6,
        start_month: Optional[str] = "2026-11",
        preferred_model: Optional[str] = None,
        description: Optional[str] = "",
        item_group: Optional[str] = "",
        candidate_pool: Optional[List[Dict[str, Any]]] = None,
        progress_callback: Optional[Any] = None,
        is_cancelled: Optional[Any] = None,
        is_discontinued: bool = False
    ) -> Dict[str, Any]:
        """
        Phase 2 End-to-End Flow:
        1. Obtain chronological historical demand.
        2. Walk-forward backtest all eligible candidate models.
        3. Select winning model strictly via lowest backtest WAPE.
        4. Refit winning model on ALL available historical data.
        5. Extrapolate future multi-step forecast for requested horizon.
        """
        if is_cancelled and is_cancelled():
            raise RuntimeError("Forecast calculation was cancelled.")

        def emit(event_type: str, stage: str, model_name: str = "", extra: Optional[Dict[str, Any]] = None):
            if progress_callback:
                payload = {
                    "event": event_type,
                    "itemCode": item_code,
                    "stage": stage,
                    "modelName": model_name
                }
                if extra:
                    payload.update(extra)
                progress_callback(payload)

        emit("sku_started", stage="Profiling SKU demand patterns")

        # Early return for Discontinued SKUs: Suppress model fitting and lock to zero
        if is_discontinued:
            series = np.array(history_values, dtype=float)
            n_obs = len(series)
            timestamp = datetime.now(timezone.utc).isoformat()
            item_profile = profile_demand(item_code, history_values, history_periods, missing_periods)
            sku_classification = classify_sku(
                item_code=item_code,
                history_values=history_values,
                description=description or "",
                item_group=item_group or ""
            )
            disc_res = {
                "itemCode": item_code,
                "modelName": "Zero Allocation (Discontinued SKU)",
                "modelType": "discontinued",
                "selectedModel": "Zero Allocation (Discontinued SKU)",
                "selectionStatus": "DISCONTINUED_SKU",
                "selectionReason": "SKU is marked as Discontinued/Phase-out. Forecast suppressed to prevent dead inventory creation.",
                "historyMonths": n_obs,
                "trainingRows": 0,
                "forecast": [0.0] * horizon,
                "rawForecast": [0.0] * horizon,
                "selectedModelMetrics": None,
                "modelComparison": [],
                "eligibility": [],
                "demandProfile": item_profile,
                "skuCategory": sku_classification["category"],
                "skuClassification": sku_classification,
                "confidence": {
                    "status": "NOT_EVALUATED",
                    "score": None,
                    "level": "NOT_EVALUATED",
                    "intervalLevel": 0.90,
                    "lowerBound": [0.0] * horizon,
                    "upperBound": [0.0] * horizon,
                    "method": "Discontinued SKU (Zero Procurement)",
                    "validationObservationCount": 0,
                    "errorSummary": None,
                    "reasons": ["Discontinued SKU excluded from probabilistic interval evaluation"]
                },
                "metadata": {
                    "features_used": ["sku_status_flag"],
                    "training_rows": 0,
                    "history_months": n_obs,
                    "timestamp": timestamp,
                    "forecast_horizon": horizon,
                    "isDiscontinued": True
                },
                "lifecycle_regime": "CONTRACTION_PHASE_OUT",
                "lifecycleRegime": "CONTRACTION_PHASE_OUT",
                "lifecycle_description": "Discontinued item designated for phase out and inventory exhaustion.",
                "lifecycleDescription": "Discontinued item designated for phase out and inventory exhaustion.",
                "momentum_flag": "NEGATIVE",
                "momentumFlag": "NEGATIVE",
                "yoy_velocity_pct": None,
                "yoyVelocityPct": None,
                "procurement_heuristics": {
                    "lifecycle_regime": "CONTRACTION_PHASE_OUT",
                    "momentum_flag": "NEGATIVE",
                    "buffer_modifier_pct": -100.0,
                    "order_cap": 0.0,
                    "advisories": ["DISCONTINUED: Zero allocation enforced to deplete existing inventory."]
                },
                "heuristicAdvisories": ["DISCONTINUED: Zero allocation enforced to deplete existing inventory."]
            }
            emit("sku_finished", stage="Generating future demand forecasts", model_name="Zero Allocation (Discontinued SKU)")
            return disc_res

        series = np.array(history_values, dtype=float)
        n_obs = len(series)
        timestamp = datetime.now(timezone.utc).isoformat()

        series_hash, series_meta = compute_series_hash(
            item_code=item_code,
            history_values=history_values,
            history_periods=history_periods,
            missing_periods=missing_periods,
            is_discontinued=is_discontinued,
            description=description or "",
            item_group=item_group or ""
        )

        # Layer 1: SKU Profiles & Demand Intelligence Cache Retrieval
        cached_prof = self.cache.get_sku_profile(
            series_hash, description=description or "", item_group=item_group or ""
        ) if (self.use_cache and self.cache) else None
        if cached_prof is not None:
            item_profile = cached_prof["profile"]
            sku_classification = cached_prof["classification"]
            emit("demand_profiling_finished", stage="Profiling SKU demand patterns (cached)")
        else:
            item_profile = profile_demand(item_code, history_values, history_periods, missing_periods)
            emit("demand_profiling_finished", stage="Profiling SKU demand patterns")
            sku_classification = classify_sku(
                item_code=item_code,
                history_values=history_values,
                description=description or "",
                item_group=item_group or ""
            )
            if self.use_cache and self.cache:
                self.cache.put_sku_profile(
                    series_hash=series_hash,
                    item_code=item_code,
                    meta=series_meta,
                    profile=item_profile,
                    classification=sku_classification
                )

        def enrich(res_payload: Dict[str, Any]) -> Dict[str, Any]:
            if "lifecycle_regime" not in item_profile:
                if n_obs < 12:
                    item_profile["yoy_velocity_pct"] = None
                    item_profile["momentum_flag"] = "NEUTRAL"
                    item_profile["lifecycle_regime"] = "INSUFFICIENT_HISTORY"
                    item_profile["lifecycle_description"] = "Insufficient history (< 12 months) for lifecycle regime evaluation."
                else:
                    from .pattern_intelligence import calculate_yoy_velocity, assign_momentum_flag, classify_lifecycle_regime
                    vel_res = calculate_yoy_velocity(
                        series=series,
                        seasonality_detected=item_profile.get("seasonality_detected", False),
                        seasonality_strength=item_profile.get("seasonality_strength", 0.0)
                    )
                    vel = vel_res["yoy_velocity_pct"]
                    slope = float(item_profile.get("normalized_slope", 0.0))
                    r2 = float(item_profile.get("trend_strength", 0.0))
                    mom = assign_momentum_flag(vel, slope, r2)
                    reg, desc = classify_lifecycle_regime(
                        n_obs=n_obs,
                        adi=float(item_profile.get("average_inter_demand_interval", 1.0)),
                        cv2=float(item_profile.get("cv_squared", 0.0)),
                        velocity_pct=vel,
                        normalized_slope=slope,
                        r_squared=r2
                    )
                    item_profile["yoy_velocity_pct"] = vel
                    item_profile["momentum_flag"] = mom
                    item_profile["lifecycle_regime"] = reg
                    item_profile["lifecycle_description"] = desc

            from .heuristics import evaluate_procurement_heuristics
            regime = item_profile.get("lifecycle_regime", "INSUFFICIENT_HISTORY")
            regime_desc = item_profile.get("lifecycle_description", "")
            velocity = item_profile.get("yoy_velocity_pct")
            momentum = item_profile.get("momentum_flag", "NEUTRAL")
            point_forecast = res_payload.get("forecast", [])

            heur = evaluate_procurement_heuristics(
                lifecycle_regime=regime,
                momentum_flag=momentum,
                selected_model_metrics=res_payload.get("selectedModelMetrics"),
                demand_profile=item_profile
            )

            res_payload["lifecycle_regime"] = regime
            res_payload["lifecycleRegime"] = regime
            res_payload["lifecycle_description"] = regime_desc
            res_payload["lifecycleDescription"] = regime_desc
            res_payload["yoy_velocity_pct"] = velocity
            res_payload["yoyVelocityPct"] = velocity
            res_payload["momentum_flag"] = momentum
            res_payload["momentumFlag"] = momentum
            res_payload["procurement_heuristics"] = heur
            res_payload["heuristicAdvisories"] = heur.get("advisories", [])

            if "demandProfile" in res_payload and isinstance(res_payload["demandProfile"], dict):
                res_payload["demandProfile"]["lifecycle_regime"] = regime
                res_payload["demandProfile"]["lifecycle_description"] = regime_desc
                res_payload["demandProfile"]["yoy_velocity_pct"] = velocity
                res_payload["demandProfile"]["momentum_flag"] = momentum
            return res_payload

        # 0M (Cold Start) and 1-5M (Sparse History) handling
        if n_obs < 6:
            emit("feature_engineering_finished", stage="Constructing chronological features")
            _, peer_pool_hash, _, cold_forecast_key = compute_cold_start_keys(
                item_code=item_code,
                description=description or "",
                item_group=item_group or "",
                history_values=history_values,
                candidate_pool=candidate_pool or [],
                horizon=horizon,
                start_month=start_month,
                history_periods=history_periods,
                missing_periods=missing_periods,
                is_discontinued=is_discontinued
            )

            if self.use_cache and self.cache:
                cached_cold = self.cache.get_cold_forecast_result(cold_forecast_key)
                if cached_cold is not None:
                    emit("sku_finished", stage="Generating future demand forecasts", model_name=cached_cold.get("modelName", "Sparse History"))
                    return enrich(cached_cold)

            target_item = {
                "itemCode": item_code,
                "description": description or "",
                "itemGroup": item_group or "",
                "history": history_values
            }
            cold_res = generate_cold_or_sparse_forecast(target_item, candidate_pool or [], horizon=horizon)
            cold_res["demandProfile"] = item_profile
            cold_res["eligibility"] = self.evaluate_sku_eligibility(n_obs, item_profile)
            cold_res["metadata"]["timestamp"] = timestamp
            cold_res["skuCategory"] = sku_classification["category"]
            cold_res["skuClassification"] = sku_classification
            m_name = cold_res.get("modelName", "Sparse History")

            if self.use_cache and self.cache:
                self.cache.put_sku_profile(
                    series_hash=series_hash,
                    item_code=item_code,
                    meta=series_meta,
                    profile=item_profile,
                    classification=sku_classification
                )
                peer_skus = [p.get("itemCode", "") for p in cold_res.get("metadata", {}).get("comparable_skus", [])]
                peer_weights = [p.get("similarityScore", 0.0) for p in cold_res.get("metadata", {}).get("comparable_skus", [])]
                self.cache.put_cold_forecast_result(
                    cold_forecast_hash=cold_forecast_key,
                    item_code=item_code,
                    series_hash=series_hash,
                    horizon=horizon,
                    start_month=start_month or "",
                    peer_pool_hash=peer_pool_hash,
                    peer_skus=peer_skus,
                    peer_weights=peer_weights,
                    point_forecast=cold_res.get("forecast", []),
                    result_payload=cold_res
                )

            emit("sku_finished", stage="Generating future demand forecasts", model_name=m_name)
            return enrich(cold_res)

        if n_obs < 12:
            emit("feature_engineering_finished", stage="Constructing chronological features")
            reason = "Insufficient history. Minimum 12 months required for walk-forward model selection."
            res = {
                "itemCode": item_code,
                "modelName": "No AI Forecast",
                "modelType": "fallback",
                "selectedModel": "No AI Forecast",
                "selectionStatus": "INSUFFICIENT_HISTORY",
                "selectionReason": reason,
                "historyMonths": n_obs,
                "trainingRows": 0,
                "forecast": [0.0] * horizon,
                "rawForecast": [0.0] * horizon,
                "selectedModelMetrics": None,
                "modelComparison": [],
                "eligibility": self.evaluate_sku_eligibility(n_obs, item_profile),
                "demandProfile": item_profile,
                "skuCategory": sku_classification["category"],
                "skuClassification": sku_classification,
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
                    "reasons": ["Insufficient history for statistical evaluation"]
                },
                "metadata": {
                    "reason": "Insufficient history for statistical or ML forecasting.",
                    "clipped": False,
                    "raw_predictions": [0.0] * horizon,
                    "timestamp": timestamp,
                }
            }
            emit("sku_finished", stage="Generating future demand forecasts", model_name="No AI Forecast")
            return enrich(res)

        # -----------------------------------------------------------------
        # Mature SKUs (n_obs >= 12): Multi-Layer Caching & Horizon Fast Path
        # -----------------------------------------------------------------
        mature_keys = compute_mature_keys(
            series_hash=series_hash,
            winning_model_name=None,
            horizon=horizon,
            start_month=start_month or "",
            confidence_level=0.90
        )
        backtest_hash = mature_keys["backtest_hash"]

        cached_bt = self.cache.get_backtest_evaluations(backtest_hash) if (self.use_cache and self.cache) else None
        if cached_bt is not None:
            winning_model_name = cached_bt["winning_model"]
            m_keys_winner = compute_mature_keys(
                series_hash=series_hash,
                winning_model_name=winning_model_name,
                horizon=horizon,
                start_month=start_month or "",
                confidence_level=0.90
            )
            forecast_hash = m_keys_winner["forecast_hash"]

            cached_fc = self.cache.get_forecast_result(forecast_hash) if (self.use_cache and self.cache) else None
            if cached_fc is not None:
                emit("sku_finished", stage="Calculating prediction intervals and reliability", model_name=winning_model_name)
                return enrich(cached_fc)

            # Horizon Change Fast Path: candidate backtesting is 100% bypassed!
            emit("feature_engineering_finished", stage="Constructing chronological features")
            emit("backtesting_finished", stage="Running walk-forward backtesting")
            emit("winner_selection_finished", stage="Selecting the best-performing model", model_name=winning_model_name)

            winner_name = winning_model_name
            status = cached_bt["selection_status"]
            reason = cached_bt["selection_reason"]
            selected_metrics = cached_bt["selected_metrics"]
            backtest_results = cached_bt["candidate_leaderboard"]

            # Check Layer 4 fitted model artifact cache for genuine reuse
            model_art_hash = m_keys_winner["model_artifact_hash"]
            cached_art = self.cache.get_model_artifact(model_art_hash) if (self.use_cache and self.cache) else None
            chosen_model = None
            preds = None
            meta = None
            if cached_art is not None:
                chosen_model = restore_fitted_model(cached_art["model_params"])
                if chosen_model is not None:
                    # Model artifact genuinely restored without refitting!
                    if isinstance(chosen_model, HistGradientBoostingModel):
                        extractor_fn = make_future_step_feature_extractor(start_month)
                        preds, meta = chosen_model.predict_multistep(horizon, extractor_fn)
                    else:
                        preds, meta = chosen_model.predict(horizon)
                    emit("final_model_refit_finished", stage="Refitting selected models on available history (artifact reused)", model_name=chosen_model.name)
                    emit("recursive_forecasting_finished", stage="Generating future demand forecasts", model_name=chosen_model.name)

            if chosen_model is None or preds is None:
                chosen_model = instantiate_model(winner_name)
                if isinstance(chosen_model, HistGradientBoostingModel):
                    feat_data = self.cache.get_engineered_features(mature_keys["feature_hash"]) if (self.use_cache and self.cache) else None
                    if feat_data is not None:
                        X, y, feature_names = feat_data
                    else:
                        X, y, feature_names = build_supervised_dataset(history_values, history_periods)
                        if self.use_cache and self.cache and len(y) > 0:
                            self.cache.put_engineered_features(mature_keys["feature_hash"], series_hash, X, y, feature_names)

                    if len(y) >= 3:
                        chosen_model.fit(series=series, features=X, targets=y, feature_names=feature_names, periods=history_periods)
                        emit("final_model_refit_finished", stage="Refitting selected models on available history", model_name=chosen_model.name)
                        extractor_fn = make_future_step_feature_extractor(start_month)
                        preds, meta = chosen_model.predict_multistep(horizon, extractor_fn)
                        emit("recursive_forecasting_finished", stage="Generating future demand forecasts", model_name=chosen_model.name)
                    else:
                        fallback_model = HoltExponentialSmoothingModel() if n_obs >= 4 else NaiveModel()
                        fallback_model.fit(series=series)
                        emit("final_model_refit_finished", stage="Refitting selected models on available history", model_name=fallback_model.name)
                        preds, meta = fallback_model.predict(horizon)
                        chosen_model = fallback_model
                        emit("recursive_forecasting_finished", stage="Generating future demand forecasts", model_name=chosen_model.name)
                else:
                    chosen_model.fit(series=series)
                    emit("final_model_refit_finished", stage="Refitting selected models on available history", model_name=chosen_model.name)
                    preds, meta = chosen_model.predict(horizon)
                    emit("recursive_forecasting_finished", stage="Generating future demand forecasts", model_name=chosen_model.name)

                if self.use_cache and self.cache:
                    ser_params = serialize_fitted_model(chosen_model, series)
                    self.cache.put_model_artifact(
                        model_artifact_hash=model_art_hash,
                        backtest_hash=backtest_hash,
                        model_name=chosen_model.name,
                        model_type=chosen_model.model_type,
                        model_params=ser_params
                    )

            final_discrete_forecast = [int(round(p)) for p in preds]
            meta["forecast_horizon"] = horizon
            meta["training_timestamp"] = timestamp
            meta["history_months"] = n_obs
            meta["training_rows"] = chosen_model.metadata.get("training_rows", n_obs)
            if history_periods and len(history_periods) > 0:
                meta["history_start"] = history_periods[0]
                meta["history_end"] = history_periods[-1]

            confidence_block = self.calculate_confidence_and_intervals(
                point_forecasts=preds,
                winner_name=chosen_model.name,
                backtest_results=backtest_results,
                confidence_level=0.90
            )
            result = {
                "itemCode": item_code,
                "modelName": chosen_model.name,
                "modelType": chosen_model.model_type,
                "selectedModel": chosen_model.name,
                "selectionStatus": status,
                "selectionReason": reason,
                "historyMonths": n_obs,
                "trainingRows": meta["training_rows"],
                "forecast": final_discrete_forecast,
                "rawForecast": preds,
                "selectedModelMetrics": selected_metrics,
                "modelComparison": backtest_results,
                "eligibility": self.evaluate_sku_eligibility(n_obs, item_profile),
                "demandProfile": item_profile,
                "skuCategory": sku_classification["category"],
                "skuClassification": sku_classification,
                "confidence": confidence_block,
                "metadata": meta
            }
            if self.use_cache and self.cache:
                self.cache.put_forecast_result(
                    forecast_hash=forecast_hash,
                    item_code=item_code,
                    series_hash=series_hash,
                    horizon=horizon,
                    start_month=start_month or "",
                    confidence_level=0.90,
                    result_payload=result
                )
            emit("sku_finished", stage="Calculating prediction intervals and reliability", model_name=chosen_model.name)
            return enrich(result)

        # -----------------------------------------------------------------
        # Complete Miss: Execute Walk-Forward Backtesting
        # -----------------------------------------------------------------
        emit("feature_engineering_finished", stage="Constructing chronological features")
        emit("candidate_eval_started", stage="Training eligible candidate models")

        # Layer 2: Pre-emptively construct and persist engineered feature matrix for mature series
        if self.use_cache and self.cache:
            feat_cached = self.cache.get_engineered_features(mature_keys["feature_hash"])
            if feat_cached is None:
                X_full, y_full, fnames_full = build_supervised_dataset(history_values, history_periods)
                if len(y_full) > 0:
                    self.cache.put_engineered_features(
                        feature_hash=mature_keys["feature_hash"],
                        series_hash=series_hash,
                        X=X_full,
                        y=y_full,
                        feature_names=fnames_full
                    )

        def on_cand_start(c_name: str):
            emit("candidate_model_started", stage="Training eligible candidate models", model_name=c_name)

        def on_cand_finish(c_name: str, c_res: Dict[str, Any]):
            emit("candidate_model_finished", stage="Running walk-forward backtesting", model_name=c_name)

        is_leader = True
        flight_event = None
        if self.use_cache and self.cache:
            is_leader, flight_event = self.cache.single_flight.acquire(backtest_hash)
            if not is_leader:
                waited = flight_event.wait(timeout=self.follower_timeout)
                if not waited:
                    cached_bt_check = self.cache.get_backtest_evaluations(backtest_hash)
                    if cached_bt_check is not None:
                        winner_name = cached_bt_check["winning_model"]
                        m_keys_w = compute_mature_keys(series_hash, winning_model_name=winner_name, horizon=horizon, start_month=start_month, confidence_level=0.90)
                        fc_retry = self.cache.get_forecast_result(m_keys_w["forecast_hash"])
                        if fc_retry is not None:
                            return enrich(fc_retry)
                    raise SingleFlightTimeoutError(
                        f"Single-flight leader execution timed out after {self.follower_timeout}s for key {backtest_hash}. "
                        "Follower suppressed duplicate candidate backtesting."
                    )

                leader_err = self.cache.single_flight.get_error(backtest_hash)
                if leader_err:
                    raise RuntimeError(f"Single-flight leader execution failed: {leader_err}")

                # Re-check backtest cache now that leader finished
                cached_bt_retry = self.cache.get_backtest_evaluations(backtest_hash)
                if cached_bt_retry is not None:
                    # Reuse cached backtest and run fast path
                    winner_name = cached_bt_retry["winning_model"]
                    m_keys_w = compute_mature_keys(series_hash, winning_model_name=winner_name, horizon=horizon, start_month=start_month, confidence_level=0.90)
                    fc_retry = self.cache.get_forecast_result(m_keys_w["forecast_hash"])
                    if fc_retry is not None:
                        return enrich(fc_retry)

        leader_err_str = None
        try:
            backtest_results = self.backtester.backtest_all_candidates(
                series,
                history_periods,
                on_candidate_start=on_cand_start,
                on_candidate_finish=on_cand_finish,
                is_cancelled=is_cancelled
            )
            emit("backtesting_finished", stage="Running walk-forward backtesting")

            if is_cancelled and is_cancelled():
                raise RuntimeError("Forecast calculation was cancelled.")

            winner_name, status, reason, selected_metrics = select_best_model(
                backtest_results=backtest_results,
                n_obs=n_obs,
                preferred_model=preferred_model
            )
            emit("winner_selection_finished", stage="Selecting the best-performing model", model_name=winner_name)

            if self.use_cache and self.cache:
                self.cache.put_sku_profile(
                    series_hash=series_hash,
                    item_code=item_code,
                    meta=series_meta,
                    profile=item_profile,
                    classification=sku_classification
                )
                self.cache.put_backtest_evaluations(
                    backtest_hash=backtest_hash,
                    series_hash=series_hash,
                    validation_horizon=self.validation_horizon,
                    winning_model=winner_name,
                    selection_status=status,
                    selection_reason=reason,
                    candidate_leaderboard=backtest_results,
                    residual_quantiles={},
                    selected_metrics=selected_metrics
                )

            chosen_model = instantiate_model(winner_name)
            if isinstance(chosen_model, HistGradientBoostingModel):
                feat_data = self.cache.get_engineered_features(mature_keys["feature_hash"]) if (self.use_cache and self.cache) else None
                if feat_data is not None:
                    X, y, feature_names = feat_data
                else:
                    X, y, feature_names = build_supervised_dataset(history_values, history_periods)
                    if self.use_cache and self.cache and len(y) > 0:
                        self.cache.put_engineered_features(mature_keys["feature_hash"], series_hash, X, y, feature_names)

                if len(y) >= 3:
                    chosen_model.fit(
                        series=series,
                        features=X,
                        targets=y,
                        feature_names=feature_names,
                        periods=history_periods
                    )
                    emit("final_model_refit_finished", stage="Refitting selected models on available history", model_name=chosen_model.name)
                    extractor_fn = make_future_step_feature_extractor(start_month)
                    preds, meta = chosen_model.predict_multistep(horizon, extractor_fn)
                    emit("recursive_forecasting_finished", stage="Generating future demand forecasts", model_name=chosen_model.name)
                else:
                    fallback_model = HoltExponentialSmoothingModel() if n_obs >= 4 else NaiveModel()
                    fallback_model.fit(series=series)
                    emit("final_model_refit_finished", stage="Refitting selected models on available history", model_name=fallback_model.name)
                    preds, meta = fallback_model.predict(horizon)
                    chosen_model = fallback_model
                    emit("recursive_forecasting_finished", stage="Generating future demand forecasts", model_name=chosen_model.name)
            else:
                chosen_model.fit(series=series)
                emit("final_model_refit_finished", stage="Refitting selected models on available history", model_name=chosen_model.name)
                preds, meta = chosen_model.predict(horizon)
                emit("recursive_forecasting_finished", stage="Generating future demand forecasts", model_name=chosen_model.name)

            final_discrete_forecast = [int(round(p)) for p in preds]

            meta["forecast_horizon"] = horizon
            meta["training_timestamp"] = timestamp
            meta["history_months"] = n_obs
            meta["training_rows"] = chosen_model.metadata.get("training_rows", n_obs)
            if history_periods and len(history_periods) > 0:
                meta["history_start"] = history_periods[0]
                meta["history_end"] = history_periods[-1]

            confidence_block = self.calculate_confidence_and_intervals(
                point_forecasts=preds,
                winner_name=chosen_model.name,
                backtest_results=backtest_results,
                confidence_level=0.90
            )

            final_result = {
                "itemCode": item_code,
                "modelName": chosen_model.name,
                "modelType": chosen_model.model_type,
                "selectedModel": chosen_model.name,
                "selectionStatus": status,
                "selectionReason": reason,
                "historyMonths": n_obs,
                "trainingRows": meta["training_rows"],
                "forecast": final_discrete_forecast,
                "rawForecast": preds,
                "selectedModelMetrics": selected_metrics,
                "modelComparison": backtest_results,
                "eligibility": self.evaluate_sku_eligibility(n_obs, item_profile),
                "demandProfile": item_profile,
                "skuCategory": sku_classification["category"],
                "skuClassification": sku_classification,
                "confidence": confidence_block,
                "metadata": meta
            }

            if self.use_cache and self.cache:
                m_keys_w = compute_mature_keys(
                    series_hash=series_hash,
                    winning_model_name=chosen_model.name,
                    horizon=horizon,
                    start_month=start_month or "",
                    confidence_level=0.90
                )
                ser_params = serialize_fitted_model(chosen_model, series)
                self.cache.put_model_artifact(
                    model_artifact_hash=m_keys_w["model_artifact_hash"],
                    backtest_hash=backtest_hash,
                    model_name=chosen_model.name,
                    model_type=chosen_model.model_type,
                    model_params=ser_params
                )
                self.cache.put_forecast_result(
                    forecast_hash=m_keys_w["forecast_hash"],
                    item_code=item_code,
                    series_hash=series_hash,
                    horizon=horizon,
                    start_month=start_month or "",
                    confidence_level=0.90,
                    result_payload=final_result
                )

            emit("sku_finished", stage="Calculating prediction intervals and reliability", model_name=chosen_model.name)
            return enrich(final_result)
        except Exception as e:
            leader_err_str = str(e)
            raise
        finally:
            if self.use_cache and self.cache and is_leader:
                self.cache.single_flight.release(backtest_hash, error=leader_err_str)

    def forecast_batch(
        self,
        items: List[Dict[str, Any]],
        horizon: int = 6,
        start_month: Optional[str] = "2026-11",
        candidate_pool: Optional[List[Dict[str, Any]]] = None,
        progress_callback: Optional[Any] = None,
        is_cancelled: Optional[Any] = None
    ) -> Dict[str, Any]:
        """
        Executes real data-driven forecasting engine over a batch of items.
        Each item is individually evaluated with its own walk-forward backtest and model selection.
        Candidate pool for cold-start peer discovery can be explicitly supplied via candidate_pool,
        or falls back to items for backward compatibility.
        Candidate-pool-only items are read-only peer context and are never forecast.
        """
        start_time = time.time()
        results = []
        model_counts = {}
        cb_lock = threading.Lock()

        # Build effective peer discovery candidate pool (excluding discontinued SKUs)
        if candidate_pool is not None:
            pool_by_code = {
                str(c.get("itemCode", c.get("item_code", ""))).strip().upper(): c
                for c in candidate_pool
                if str(c.get("itemCode", c.get("item_code", ""))).strip() and not bool(c.get("isDiscontinued", False))
            }
            for it in items:
                it_code = str(it.get("itemCode", it.get("item_code", ""))).strip().upper()
                if it_code and it_code not in pool_by_code and not bool(it.get("isDiscontinued", False)):
                    pool_by_code[it_code] = it
            effective_pool = list(pool_by_code.values())
        else:
            effective_pool = [it for it in items if not bool(it.get("isDiscontinued", False))]

        def _safe_callback(ev: Dict[str, Any]):
            if progress_callback:
                with cb_lock:
                    progress_callback(ev)

        def _process_item(it: Dict[str, Any]) -> Dict[str, Any]:
            if is_cancelled and is_cancelled():
                raise RuntimeError("Forecast calculation was cancelled.")
            code = it.get("itemCode", "")
            hist = it.get("history", [])
            periods = it.get("periods", None)
            missing = it.get("missingPeriods", None)
            desc = it.get("description", "")
            group = it.get("itemGroup", "")
            is_disc = bool(it.get("isDiscontinued", False))
            return self.forecast_single_sku(
                item_code=code,
                history_values=hist,
                history_periods=periods,
                missing_periods=missing,
                horizon=horizon,
                start_month=start_month,
                description=desc,
                item_group=group,
                candidate_pool=effective_pool,
                progress_callback=_safe_callback if progress_callback else None,
                is_cancelled=is_cancelled,
                is_discontinued=is_disc
            )

        max_workers = min(8, max(1, (os.cpu_count() or 4)))
        if len(items) <= 1:
            results = [_process_item(it) for it in items]
        else:
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                results = list(executor.map(_process_item, items))

        if self.use_cache and self.cache:
            self.cache.flush_touched_profiles()

        for res in results:
            m_name = res["modelName"]
            model_counts[m_name] = model_counts.get(m_name, 0) + 1

        elapsed_sec = round(time.time() - start_time, 3)
        total_candidates = sum(len(r.get("modelComparison", [])) for r in results)
        total_windows = sum(
            sum(alt.get("validWindows", 0) for alt in r.get("modelComparison", []))
            for r in results
        )
        categories_processed = sorted(list(set(r.get("skuCategory") for r in results if r.get("skuCategory"))))

        telemetry = {
            "totalItems": len(results),
            "successfulItems": len([r for r in results if r.get("forecast") is not None]),
            "processingTimeSeconds": elapsed_sec,
            "avgProcessingTimePerSkuMs": round((elapsed_sec / len(results) * 1000), 2) if len(results) > 0 else 0.0,
            "candidateModelsEvaluated": total_candidates,
            "validationWindowsCompleted": total_windows,
            "categoriesProcessed": categories_processed,
            "classificationRuleVersion": "v1.0.0-SBC",
            "cache": self.cache.telemetry.get_summary() if (self.use_cache and self.cache) else None
        }

        return {
            "engine": "Demandora Python ML Engine (Walk-Forward Backtesting + Selection)",
            "version": "2.0.0",
            "horizon": horizon,
            "startMonth": start_month,
            "totalItemsProcessed": len(results),
            "modelDistribution": model_counts,
            "telemetry": telemetry,
            "results": results
        }
