import {
  NormalizedDataset,
  ForecastParameters,
  ForecastLine,
  ForecastResult,
  SegmentationResult
} from '../types';
import {
  prepareItemHistories,
  diffForecastParameters,
  recalculateMRPAndSupply,
  ParameterDiff,
  PreparedHistoryItem
} from './forecastingEngine';
import { computeSegmentation } from './segmentationService';

export type ForecastWorkflowAction = 'FULL_FORECAST' | 'DELTA_FORECAST' | 'MRP_ONLY' | 'NO_OP';

export interface ForecastWorkflowDecision {
  action: ForecastWorkflowAction;
  decision: ForecastWorkflowAction; // Backward-compatible alias
  targetItems: PreparedHistoryItem[];
  candidatePool: PreparedHistoryItem[];
  categoryEligibleItems: PreparedHistoryItem[];
  forecastAffectedItemCodes: string[];
  mrpAffectedItemCodes: string[];
  mrpAffectedItems: string[]; // Backward-compatible alias
  bomAffectedItemCodes: string[];
  paramDiff: ParameterDiff;
  recalculatedResult?: ForecastResult;
  isIncrementalUpdate: boolean;
  reason: string;
}

/**
 * Authoritative production workflow decision engine.
 * Determines whether a forecast request requires:
 * 1. FULL_FORECAST (initial run, replace mode, or forecast-critical parameter change)
 * 2. DELTA_FORECAST (only forecast-affected SKUs dispatched to Python ML models)
 * 3. MRP_ONLY (instantaneous client-side MRP/BOM/lot-sizing recalculation without retraining)
 * 4. NO_OP (identical upload with unchanged parameters; existing forecast remains authoritative)
 */
export function resolveForecastWorkflowDecision(
  dataset: NormalizedDataset,
  parameters: ForecastParameters,
  lastForecastParams?: ForecastParameters | null,
  existingLines: ForecastLine[] = [],
  selectedCategories: string[] = ['RUNNER', 'REPEATER', 'STRANGER'],
  cachedSegmentation?: SegmentationResult | null
): ForecastWorkflowDecision {
  const allItemsPayload = prepareItemHistories(dataset, parameters);
  const segmentation = cachedSegmentation || computeSegmentation(allItemsPayload);

  const categoryEligibleItems = allItemsPayload.filter(item => {
    const segItem = segmentation.items.find((s: any) => s.itemCode === item.itemCode);
    if (!segItem || segItem.category === 'UNCLASSIFIED') return false;
    return selectedCategories.includes(segItem.category);
  });

  const isIncrementalUpdate = dataset.dataVersion > 1 &&
    !!dataset.historySummary?.incrementalStats &&
    existingLines.length > 0;

  const paramDiff = diffForecastParameters(parameters, lastForecastParams);

  if (isIncrementalUpdate && !paramDiff.hasForecastParamChanges && !paramDiff.hasConfidenceLevelChange) {
    const stats = dataset.historySummary.incrementalStats!;
    const forecastAffected = stats.forecastAffectedItems || stats.affectedItems || [];
    const mrpAffected = stats.mrpAffectedItems || [];
    const bomAffected = stats.bomAffectedItems || [];

    if (forecastAffected.length > 0) {
      const affectedSet = new Set(forecastAffected);
      const targetItems = categoryEligibleItems.filter(item => affectedSet.has(item.itemCode));

      if (targetItems.length === 0) {
        if (mrpAffected.length > 0 || bomAffected.length > 0 || paramDiff.hasMrpParamChanges) {
          const recomputed = recalculateMRPAndSupply(existingLines, dataset, parameters);
          return {
            action: 'MRP_ONLY',
            decision: 'MRP_ONLY',
            targetItems: [],
            candidatePool: allItemsPayload,
            categoryEligibleItems,
            forecastAffectedItemCodes: forecastAffected,
            mrpAffectedItemCodes: mrpAffected,
            mrpAffectedItems: mrpAffected,
            bomAffectedItemCodes: bomAffected,
            paramDiff,
            recalculatedResult: recomputed,
            isIncrementalUpdate,
            reason: 'Forecast-affected items outside category scope, but supply/MRP changes detected.'
          };
        }
        return {
          action: 'NO_OP',
          decision: 'NO_OP',
          targetItems: [],
          candidatePool: allItemsPayload,
          categoryEligibleItems,
          forecastAffectedItemCodes: forecastAffected,
          mrpAffectedItemCodes: [],
          mrpAffectedItems: [],
          bomAffectedItemCodes: [],
          paramDiff,
          isIncrementalUpdate,
          reason: 'None of the forecast-affected items belong to selected category scope.'
        };
      }

      return {
        action: 'DELTA_FORECAST',
        decision: 'DELTA_FORECAST',
        targetItems,
        candidatePool: allItemsPayload,
        categoryEligibleItems,
        forecastAffectedItemCodes: forecastAffected,
        mrpAffectedItemCodes: mrpAffected,
        mrpAffectedItems: mrpAffected,
        bomAffectedItemCodes: bomAffected,
        paramDiff,
        isIncrementalUpdate,
        reason: `${targetItems.length} affected SKU(s) dispatched for delta forecasting.`
      };
    } else if (mrpAffected.length > 0 || bomAffected.length > 0 || paramDiff.hasMrpParamChanges) {
      const recomputed = recalculateMRPAndSupply(existingLines, dataset, parameters);
      return {
        action: 'MRP_ONLY',
        decision: 'MRP_ONLY',
        targetItems: [],
        candidatePool: allItemsPayload,
        categoryEligibleItems,
        forecastAffectedItemCodes: [],
        mrpAffectedItemCodes: mrpAffected,
        mrpAffectedItems: mrpAffected,
        bomAffectedItemCodes: bomAffected,
        paramDiff,
        recalculatedResult: recomputed,
        isIncrementalUpdate,
        reason: 'Supply, inventory, open orders, BOM, or MRP parameters updated without retraining ML models.'
      };
    } else {
      return {
        action: 'NO_OP',
        decision: 'NO_OP',
        targetItems: [],
        candidatePool: allItemsPayload,
        categoryEligibleItems,
        forecastAffectedItemCodes: [],
        mrpAffectedItemCodes: [],
        mrpAffectedItems: [],
        bomAffectedItemCodes: [],
        paramDiff,
        isIncrementalUpdate,
        reason: 'Identical workbook with unchanged parameters. Existing forecast is authoritative.'
      };
    }
  }

  return {
    action: 'FULL_FORECAST',
    decision: 'FULL_FORECAST',
    targetItems: categoryEligibleItems,
    candidatePool: allItemsPayload,
    categoryEligibleItems,
    forecastAffectedItemCodes: [],
    mrpAffectedItemCodes: [],
    mrpAffectedItems: [],
    bomAffectedItemCodes: [],
    paramDiff,
    isIncrementalUpdate,
    reason: 'Initial dataset, reset mode, or forecast-affecting parameter change requiring full reforecasting.'
  };
}
