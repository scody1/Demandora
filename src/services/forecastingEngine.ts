/**
 * Non-ML Business Orchestration & Transformation Layer.
 *
 * NOTE: Numerical forecasting mathematics are authoritative in the Python ML service (FastAPI).
 * This module performs:
 *  1. Extraction of item histories from normalized Excel data for transmission to Python.
 *  2. Transformation of authoritative Python forecast results into ForecastLine objects.
 *  3. Client-side supply chain business calculations:
 *     - Stock and Open PO / SO aggregation
 *     - MRP Net Requirements calculation with MOQ and Order Multiple steps
 *     - Planner adjustments and remark preservation
 *     - Dynamic alerts and portfolio KPIs
 *
 * All pseudo-ML (linearized tree splits, fake HistGradientBoostingRegressor,
 * fake WAPE numbers, and hardcoded seasonal multipliers) has been REMOVED.
 */

import {
  NormalizedDataset,
  ForecastParameters,
  ForecastLine,
  ForecastResult,
  ItemDemandSignal,
  DemandDriver,
  AlertItem,
  ConfidenceLevel,
  ItemModelDecision,
  ModelAlternative,
  PlanningMethod
} from '../types';
import { PythonBatchResponse, PythonForecastResult } from './forecastClient';
import { classifySkuItem } from './segmentationService';

export interface PreparedHistoryItem {
  itemCode: string;
  history: number[];
  description?: string;
  itemGroup?: string;
  periods: string[];
  missingPeriods?: string[];
  isDiscontinued?: boolean;
}

/**
 * Prepares chronological item histories from the normalized Excel dataset.
 * Adapts to each SKU's actual available history (e.g. 0M, 4M, 7M, 16M, 24M, 37M).
 * Respects the planner's history-window parameter when configured.
 */
export function prepareItemHistories(
  dataset: NormalizedDataset,
  params: ForecastParameters
): PreparedHistoryItem[] {
  const itemsPayload: PreparedHistoryItem[] = [];

  for (const item of dataset.items) {
    if (params.itemGroups.length > 0 && !params.itemGroups.includes(item.itemGroup)) {
      continue;
    }

    const itemHistory = dataset.salesHistory.filter(r => r.itemCode === item.itemCode);
    const filteredHistory = params.treatBulkProjectSeparately
      ? itemHistory.filter(h => h.orderType !== 'Project')
      : itemHistory;

    // Aggregate by period
    const periodMap = new Map<string, number>();
    for (const rec of filteredHistory) {
      periodMap.set(rec.period, (periodMap.get(rec.period) || 0) + rec.quantity);
    }

    const aggregated = Array.from(periodMap.entries())
      .map(([period, qty]) => ({ period, qty }))
      .sort((a, b) => a.period.localeCompare(b.period));

    const windowCap = params.historyPeriod || 24;
    const historyMonths = aggregated.length > windowCap ? aggregated.slice(-windowCap) : aggregated;

    const missingPeriods = dataset.historySummary.incrementalStats?.missingPeriodsMap?.[item.itemCode] || [];

    itemsPayload.push({
      itemCode: String(item.itemCode).trim().toUpperCase(),
      description: String(item.description || ''),
      itemGroup: String(item.itemGroup || ''),
      history: historyMonths.map(h => Number(h.qty) || 0),
      periods: historyMonths.map(h => String(h.period)),
      missingPeriods: missingPeriods.map(p => String(p)),
      isDiscontinued: !!item.isDiscontinued
    });
  }

  return itemsPayload;
}

/**
 * Determines model readiness tier label based on data length.
 */
function getModelTierLabel(months: number, isNewItem: boolean = false): string {
  if (months === 0) return 'Cold Start / Peer Baseline (0M)';
  if (months <= 5) return 'Sparse History / Shrinkage Blend (1-5M)';
  if (months <= 11) return 'Insufficient History / Manual Handling (6-11M)';
  if (months <= 23) return 'Normal Forecasting (12-23M)';
  return 'Full Historical Forecasting (24M+)';
}

function getModelLimitation(months: number): string {
  if (months === 0) {
    return 'Zero historical telemetry (0 months). Deterministic baseline derived from mature comparable peer SKUs. Reliability: NOT_EVALUATED.';
  }
  if (months <= 5) {
    return 'Sparse historical telemetry (1–5 months). Direct track record blended with mature peer baseline via linear shrinkage (k/6). Reliability: NOT_EVALUATED.';
  }
  if (months <= 11) {
    return 'Insufficient history for walk-forward model selection. Minimum 12 months required by FSD. Manual planning is required.';
  }
  if (months <= 23) {
    return 'Single annual cycle verified. Eligible for statistical smoothing and basic machine learning.';
  }
  return 'Full multi-year telemetry verified. Eligible for candidate ML pipelines and multi-fold cross-validation.';
}

/**
 * Calculates raw shortage and planned order quantity according to MRP and MOQ/lot-sizing rules.
 */
export function calculateMRPRequirements(
  finalQty: number,
  stock: number | null,
  openPo: number | null,
  planningMethod: PlanningMethod,
  moq: number,
  orderMultiple: number,
  applyMoqOrderMultiple: boolean,
  isDiscontinued?: boolean
): { rawNetReq: number | null; plannedOrderQty: number | null } {
  // If discontinued: procurement quantities locked to 0
  if (isDiscontinued) {
    return { rawNetReq: 0, plannedOrderQty: 0 };
  }

  if (planningMethod !== 'MRP') {
    return { rawNetReq: null, plannedOrderQty: null };
  }

  // If Stock or Open PO is unknown/unavailable (null or undefined), raw net requirement is unknown
  if (stock === null || stock === undefined || openPo === null || openPo === undefined) {
    return { rawNetReq: null, plannedOrderQty: null };
  }

  const s = stock;
  const po = openPo;

  // Raw Net Requirement: Shortage before lot sizing
  const rawNet = Math.max(0, finalQty - s - po);

  // If no shortage, planned order quantity is 0 (MOQ is NEVER applied when shortage is 0)
  if (rawNet <= 0) {
    return { rawNetReq: 0, plannedOrderQty: 0 };
  }

  // If lot sizing disabled
  if (!applyMoqOrderMultiple) {
    return { rawNetReq: rawNet, plannedOrderQty: rawNet };
  }

  // Lot sizing with dynamic MOQ and Order Multiple
  let planned = rawNet;
  if (moq > 0 && planned < moq) {
    planned = moq;
  }
  if (orderMultiple > 1) {
    planned = Math.ceil(planned / orderMultiple) * orderMultiple;
  }

  return { rawNetReq: rawNet, plannedOrderQty: planned };
}

/**
 * Transforms authoritative Python forecast results into complete ForecastLine objects
 * with client-side supply-chain calculations (stock, open orders, net requirements, BOM).
 */
export function processPythonForecastResults(
  pythonResponse: PythonBatchResponse,
  dataset: NormalizedDataset,
  params: ForecastParameters,
  existingLines: ForecastLine[] = []
): ForecastResult {
  const horizon = params.horizon || pythonResponse.horizon || 6;

  // Map Python results by itemCode
  const pyResultMap = new Map<string, PythonForecastResult>();
  for (const res of pythonResponse.results) {
    pyResultMap.set(res.itemCode, res);
  }

  const existingMap = new Map<string, { plannerAdj: number | null; remark: string; previousAiTotal: number; moq?: number }>();
  for (const line of existingLines) {
    existingMap.set(line.itemCode, { plannerAdj: line.plannerAdj, remark: line.remark, previousAiTotal: line.aiTotal, moq: line.moq });
  }

  // Aggregate inventory by item code across selected warehouses
  const stockMap = new Map<string, number>();
  for (const inv of (dataset.inventory || [])) {
    if (params.warehouses.length === 0 || params.warehouses.some(w => inv.warehouse.includes(w) || w.includes(inv.warehouse))) {
      stockMap.set(inv.itemCode, (stockMap.get(inv.itemCode) || 0) + inv.onHandStock);
    }
  }

  // Aggregate open orders by item code
  const openPoMap = new Map<string, number>();
  const openSoMap = new Map<string, number>();
  for (const ord of (dataset.openOrders || [])) {
    if (ord.type === 'PO') {
      openPoMap.set(ord.itemCode, (openPoMap.get(ord.itemCode) || 0) + ord.quantity);
    } else if (ord.type === 'SO') {
      openSoMap.set(ord.itemCode, (openSoMap.get(ord.itemCode) || 0) + ord.quantity);
    }
  }

  // Group sales history by item for metadata display
  const salesMap = new Map<string, { period: string; qty: number; orderType?: string }[]>();
  for (const rec of dataset.salesHistory) {
    const list = salesMap.get(rec.itemCode) || [];
    list.push({ period: rec.period, qty: rec.quantity, orderType: rec.orderType });
    salesMap.set(rec.itemCode, list);
  }

  const lines: ForecastLine[] = [];
  let maxHistoryFound = 0;

  for (const item of dataset.items) {
    // Filter by item group if configured
    if (params.itemGroups.length > 0 && !params.itemGroups.includes(item.itemGroup)) {
      continue;
    }

    const rawHistory = salesMap.get(item.itemCode) || [];
    
    // Filter project orders if enabled
    const filteredHistory = params.treatBulkProjectSeparately
      ? rawHistory.filter(h => h.orderType !== 'Project')
      : rawHistory;

    // Aggregate by period
    const periodMap = new Map<string, number>();
    for (const rec of filteredHistory) {
      periodMap.set(rec.period, (periodMap.get(rec.period) || 0) + rec.qty);
    }
    
    const aggregated = Array.from(periodMap.entries())
      .map(([period, qty]) => ({ period, qty }))
      .sort((a, b) => a.period.localeCompare(b.period));

    const windowCap = params.historyPeriod || 24;
    const historyMonths = aggregated.length > windowCap ? aggregated.slice(-windowCap) : aggregated;
    const historyValues = historyMonths.map(h => h.qty);
    const historyPeriods = historyMonths.map(h => h.period);

    if (historyMonths.length > maxHistoryFound) {
      maxHistoryFound = historyMonths.length;
    }

    const regularHistory = historyValues; // since it's already filtered and aggregated

    // Velocity metrics from actual history
    const recent12 = regularHistory.slice(-12);
    const prior12 = regularHistory.slice(-24, -12);
    const recentTotal = recent12.reduce((a, b) => a + b, 0);
    const priorTotal = prior12.reduce((a, b) => a + b, 0);
    const avgPerMonth = recent12.length > 0
      ? Math.round(recentTotal / recent12.length)
      : regularHistory.length > 0
        ? Math.round(regularHistory.reduce((a, b) => a + b, 0) / regularHistory.length)
        : 0;
    const velocityTrendPct = priorTotal > 0
      ? parseFloat((((recentTotal - priorTotal) / priorTotal) * 100).toFixed(1))
      : 0;
    const actualSalesLastYear = recentTotal;

    // Inventory & Orders (null if not present in source dataset)
    const hasInventoryData = dataset.inventory && dataset.inventory.length > 0;
    const hasOpenPoData = dataset.openOrders && dataset.openOrders.some(o => o.type === 'PO');
    const hasOpenSoData = dataset.openOrders && dataset.openOrders.some(o => o.type === 'SO');

    const stock = hasInventoryData ? (stockMap.get(item.itemCode) || 0) : null;
    const openPo = hasOpenPoData ? (openPoMap.get(item.itemCode) || 0) : null;
    const openSo = hasOpenSoData ? (openSoMap.get(item.itemCode) || 0) : null;
    const isNewItem = !!item.isNewItem;
    const isDiscontinued = item.isDiscontinued;

    // Retrieve Authoritative Forecast from Python response or preserve existing line
    const pyResult = pyResultMap.get(item.itemCode);
    const existingFullLine = existingLines.find(l => l.itemCode === item.itemCode);

    const monthlyForecast = isDiscontinued
      ? new Array(horizon).fill(0)
      : (pyResult?.forecast && pyResult.forecast.length === horizon)
        ? pyResult.forecast
        : (existingFullLine?.monthlyForecast && existingFullLine.monthlyForecast.length === horizon)
          ? existingFullLine.monthlyForecast
          : new Array(horizon).fill(0);

    const aiTotal = monthlyForecast.reduce((a, b) => a + b, 0);

    // Existing planner adjustment & planner-editable MOQ
    const existing = existingMap.get(item.itemCode);
    const plannerAdj = existing ? existing.plannerAdj : null;
    const remark = existing ? existing.remark : '';
    const isModified = plannerAdj !== null;
    const finalQty = (plannerAdj !== null && plannerAdj !== undefined) ? plannerAdj : aiTotal;
    const isMasterMoqChanged = !!(
      dataset.historySummary?.incrementalStats?.mrpAffectedItems?.includes(item.itemCode) &&
      item.moq !== existing?.moq
    );
    const activeMoq = isMasterMoqChanged
      ? (item.moq || 500)
      : (existing?.moq !== undefined ? existing.moq : (item.moq || 500));

    // MRP Requirements calculation (Raw Shortage vs Planned Order Qty after Lot Sizing)
    const { rawNetReq, plannedOrderQty } = calculateMRPRequirements(
      finalQty,
      stock,
      openPo,
      item.planningMethod,
      activeMoq,
      item.orderMultiple,
      params.applyMoqOrderMultiple,
      isDiscontinued
    );
    const netReq = plannedOrderQty;

    // Model Decision metadata from Authoritative Python Result
    const historyDateRange = historyPeriods.length > 0
      ? `${historyPeriods[0]} to ${historyPeriods[historyPeriods.length - 1]}`
      : 'No History';

    const selectedModelName = isDiscontinued
      ? 'Zero Allocation (Discontinued SKU)'
      : (pyResult?.selectedModel || pyResult?.modelName || existingFullLine?.modelDecision?.selectedModel || (historyMonths.length === 0 ? 'Zero Allocation (No History)' : 'No AI Forecast'));

    const modelTier = getModelTierLabel(historyMonths.length, isNewItem);
    const modelLimitation = isDiscontinued
      ? 'SKU is marked as Discontinued/Phase-out. Forecast suppressed to prevent dead inventory creation.'
      : getModelLimitation(historyMonths.length);

    const featuresUsed = isDiscontinued
      ? ['sku_status_flag']
      : (pyResult?.metadata?.features_used || pyResult?.metadata?.feature_names || existingFullLine?.modelDecision?.featuresUsed || []);

    const trainingObservationsCount = pyResult?.historyMonths ?? existingFullLine?.modelDecision?.trainingObservationsCount ?? historyMonths.length;
    const trainingRows = pyResult?.trainingRows ?? existingFullLine?.modelDecision?.trainingObservationsCount ?? trainingObservationsCount;

    // Real backtest performance metrics from authoritative Python selection
    const backtestWape = pyResult?.selectedModelMetrics?.wape ?? existingFullLine?.modelDecision?.backtestWape ?? null;
    const mae = pyResult?.selectedModelMetrics?.mae ?? existingFullLine?.modelDecision?.mae ?? null;
    const rmse = pyResult?.selectedModelMetrics?.rmse ?? existingFullLine?.modelDecision?.rmse ?? null;
    const bias = pyResult?.selectedModelMetrics?.bias ?? existingFullLine?.modelDecision?.bias ?? null;
    const validationWindows = pyResult?.selectedModelMetrics?.validationWindows ?? existingFullLine?.modelDecision?.validationWindows ?? 0;
    const selectionStatus = pyResult?.selectionStatus ?? existingFullLine?.modelDecision?.selectionStatus ?? (historyMonths.length < 12 ? 'INSUFFICIENT_HISTORY' : 'SELECTED');
    const selectionReason = pyResult?.selectionReason ?? existingFullLine?.modelDecision?.selectionReason ?? (
      historyMonths.length < 12
        ? `Model selection unavailable because only ${historyMonths.length} historical observation(s) available. Minimum 12 months required.`
        : `Selected ${selectedModelName} based on historical performance.`
    );

    // Build candidate alternatives from real Python backtest leaderboard
    const alternatives: ModelAlternative[] = pyResult?.modelComparison
      ? pyResult.modelComparison.map(c => ({
          modelName: c.model,
          modelType: c.modelType,
          backtestWape: c.wape,
          mae: c.mae,
          rmse: c.rmse,
          bias: c.bias,
          validationWindows: c.validationWindows,
          eligibility: c.eligible ? ('Eligible' as const) : ('Insufficient Data' as const),
          notes: c.reason
        }))
      : (pyResult?.eligibility
        ? pyResult.eligibility.map(e => ({
            modelName: e.modelName,
            modelType: e.modelType,
            backtestWape: null,
            eligibility: e.isEligible ? ('Eligible' as const) : ('Insufficient Data' as const),
            notes: e.reason
          }))
        : []);

    // Find winning model's detailed windows
    const winnerComparison = pyResult?.modelComparison?.find(c => c.model === selectedModelName);
    const windows = winnerComparison?.windows || existingFullLine?.modelDecision?.windows || [];

    const modelDecision: ItemModelDecision = {
      historyMonthsAvailable: historyMonths.length,
      historyDateRange,
      selectedModel: selectedModelName,
      selectionStatus,
      selectionReason,
      modelTier,
      modelLimitation,
      featuresUsed,
      backtestWape,
      mae,
      rmse,
      bias,
      validationWindows,
      backtestMethod: validationWindows > 0
        ? `Chronological walk-forward validation (${validationWindows} windows)`
        : 'Walk-forward backtesting (N < 3)',
      alternatives,
      trainingObservationsCount,
      windows
    };

    // Demand drivers (causal business factors)
    const drivers: DemandDriver[] = [];
    if (historyMonths.length < 6) {
      drivers.push({
        label: 'Limited History Telemetry',
        impact: 'negative',
        detail: `Only ${historyMonths.length} months available. Statistical models active; ML pipeline constrained.`
      });
    } else if (velocityTrendPct > 5) {
      drivers.push({ label: 'Recent Velocity', impact: 'positive', detail: `+${velocityTrendPct}% YoY demand expansion` });
    } else if (velocityTrendPct < -5) {
      drivers.push({ label: 'Recent Velocity', impact: 'negative', detail: `${velocityTrendPct}% YoY contraction` });
    } else {
      drivers.push({ label: 'Recent Velocity', impact: 'neutral', detail: `Stable trailing baseline over ${historyMonths.length} periods` });
    }

    if (openSo !== null && openSo > 0) {
      drivers.push({ label: 'Firm Customer Backlog', impact: 'positive', detail: `${openSo.toLocaleString()} confirmed units on open SO` });
    }

    let signalHeadline = 'Stable Baseline Demand';
    let signalTone: ItemDemandSignal['signalTone'] = 'stable';
    if (historyMonths.length <= 2) {
      signalHeadline = 'Minimal History / Fallback Baseline';
      signalTone = 'volatile';
    } else if (historyMonths.length <= 5) {
      signalHeadline = 'Short-Horizon Adaptive Baseline';
      signalTone = 'moderate-growth';
    } else if (velocityTrendPct > 15) {
      signalHeadline = 'Strong Upward Demand Acceleration';
      signalTone = 'strong-growth';
    } else if (velocityTrendPct > 5) {
      signalHeadline = 'Moderate Demand Growth';
      signalTone = 'moderate-growth';
    } else if (velocityTrendPct < -10) {
      signalHeadline = 'Contraction / Phase-Out Pattern';
      signalTone = 'declining';
    }

    let aiRecommendation = `Maintain regular monthly replenishment of ~${Math.round(avgPerMonth).toLocaleString()} units.`;
    if (netReq !== null && netReq > 0) {
      aiRecommendation = `Net shortage of ${netReq.toLocaleString()} units detected. Immediate ${item.makeBuy === 'Make' ? 'production order' : 'purchase order'} release recommended.`;
    } else if (historyMonths.length <= 2) {
      aiRecommendation = `Minimal historical telemetry (${historyMonths.length} month${historyMonths.length === 1 ? '' : 's'}). Requires planner manual baseline seeding.`;
    }

    // Phase 5: Probabilistic intervals and confidence score from Python
    let confidence: ConfidenceLevel = 'Not evaluated';
    let confidencePct: number | null = null;
    let confidenceBlock = pyResult?.confidence ?? existingFullLine?.demandSignal?.confidenceBlock;

    if (confidenceBlock) {
      if (confidenceBlock.level === 'HIGH') confidence = 'High';
      else if (confidenceBlock.level === 'MEDIUM') confidence = 'Medium';
      else if (confidenceBlock.level === 'LOW') confidence = 'Low';
      
      confidencePct = confidenceBlock.score;
    } else if (existingFullLine?.confidence) {
      confidence = existingFullLine.confidence;
      confidencePct = existingFullLine.confidencePct;
    }

    // FSD Rule: >20% Planner Adjustment Remark Validation
    // This doesn't throw here, but we will attach a property or expect the UI to validate it.
    // We already have `remark` from existing state. If abs(planner - ai)/ai > 0.2, remark must not be empty.
    // The UI handles the blocking, we just pass the values through.

    const demandSignal: ItemDemandSignal = {
      itemCode: item.itemCode,
      signalHeadline,
      signalTone,
      confidencePct,
      confidenceBlock,
      drivers,
      seasonalityFactor: 1.0, // NO hardcoded seasonal multipliers
      velocityTrendPct,
      anomalies: Math.abs(velocityTrendPct) > 30 ? ['High YoY Variance detected'] : [],
      aiRecommendation,
      modelDecision,
      demandProfile: pyResult?.demandProfile
    };

    const classification = pyResult?.skuClassification || classifySkuItem(item.itemCode, regularHistory, item.description, item.itemGroup);

    lines.push({
      id: `line-${item.itemCode}`,
      itemCode: item.itemCode,
      description: item.description,
      uom: item.uom,
      itemGroup: item.itemGroup,
      avgPerMonth,
      monthlyForecast,
      aiTotal,
      plannerAdj,
      finalQty,
      stock,
      openPo,
      openSo,
      rawNetReq,
      plannedOrderQty,
      netReq,
      confidencePct,
      confidence,
      confidenceBlock,
      remark,
      isModified,
      planningMethod: item.planningMethod,
      makeBuy: item.makeBuy,
      leadTimeDays: item.leadTimeDays,
      moq: activeMoq,
      orderMultiple: item.orderMultiple,
      defaultVendor: item.defaultVendor,
      isDiscontinued,
      isNewItem,
      historyAvailableMonths: historyMonths.length,
      historyDateRange,
      historyPeriods,
      historyValues: regularHistory,
      actualSalesLastYear,
      demandSignal,
      modelDecision,
      category: (pyResult?.skuCategory as any) || classification.category,
      classificationReason: classification.classificationReason,
      lifecycleRegime: (pyResult?.lifecycleRegime || pyResult?.lifecycle_regime) as any,
      momentumFlag: (pyResult?.momentumFlag || pyResult?.momentum_flag) as any,
      yoyVelocityPct: pyResult?.yoyVelocityPct ?? pyResult?.yoy_velocity_pct ?? null,
      heuristicAdvisories: pyResult?.heuristicAdvisories ?? pyResult?.procurement_heuristics?.advisories ?? [],
      procurementSchedule: item.leadTimeDays ? {
        leadTimeDays: item.leadTimeDays,
        requirementStartDate: params.startMonth ? `${params.startMonth}-01` : null,
        latestOrderDate: (() => {
          if (!params.startMonth) return null;
          const reqD = new Date(`${params.startMonth}-01`);
          reqD.setDate(reqD.getDate() - (item.leadTimeDays || 0));
          return reqD.toISOString().slice(0, 10);
        })(),
        daysUntilOrderDeadline: (() => {
          if (!params.startMonth) return null;
          const reqD = new Date(`${params.startMonth}-01`);
          reqD.setDate(reqD.getDate() - (item.leadTimeDays || 0));
          const now = new Date();
          return Math.floor((reqD.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        })(),
        isOverdue: (() => {
          if (!params.startMonth) return false;
          const reqD = new Date(`${params.startMonth}-01`);
          reqD.setDate(reqD.getDate() - (item.leadTimeDays || 0));
          return reqD.getTime() < Date.now();
        })(),
        urgency: (() => {
          if (!params.startMonth) return 'NO_LEAD_TIME' as const;
          const reqD = new Date(`${params.startMonth}-01`);
          reqD.setDate(reqD.getDate() - (item.leadTimeDays || 0));
          const diff = Math.floor((reqD.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          if (diff < 0) return 'OVERDUE' as const;
          if (diff <= 14) return 'IMMINENT' as const;
          return 'NORMAL' as const;
        })(),
        message: item.leadTimeDays ? `Standard ${item.leadTimeDays}-day vendor lead time maintained.` : 'Lead time not maintained.'
      } : undefined
    });
  }

  // Derive dynamic alerts
  const alerts: AlertItem[] = [];

  const lowConf = lines.filter(l => l.confidence === 'Low');
  if (lowConf.length > 0) {
    alerts.push({
      id: 'alt-low-conf',
      title: `${lowConf.length} Low Confidence Items`,
      description: 'Items with limited historical transactions (<6 months) requiring careful planner review.',
      severity: 'Warning',
      count: lowConf.length,
      filterType: 'low-confidence',
      itemCodes: lowConf.map(l => l.itemCode)
    });
  }

  const shortHistory = lines.filter(l => l.historyAvailableMonths < 6);
  if (shortHistory.length > 0) {
    alerts.push({
      id: 'alt-short-hist',
      title: `${shortHistory.length} Items with Short History (<6M)`,
      description: 'Statistical models active. Sub-annual depth limits long-term seasonal decomposition.',
      severity: 'Information',
      count: shortHistory.length,
      filterType: 'no-history',
      itemCodes: shortHistory.map(l => l.itemCode)
    });
  }

  const largeAdj = lines.filter(l =>
    l.plannerAdj !== null &&
    l.aiTotal > 0 &&
    (Math.abs(l.plannerAdj - l.aiTotal) / l.aiTotal) > 0.20
  );
  if (largeAdj.length > 0) {
    alerts.push({
      id: 'alt-large-adj',
      title: `${largeAdj.length} Large Planner Adjustments (>20%)`,
      description: 'Audit justification required for planner modifications exceeding 20%.',
      severity: 'Critical',
      count: largeAdj.length,
      filterType: 'large-adj',
      itemCodes: largeAdj.map(l => l.itemCode)
    });
  }

  const largeChange = lines.filter(l => {
    const prev = existingMap.get(l.itemCode)?.previousAiTotal;
    if (prev === undefined) return false;
    if (prev === 0) return l.aiTotal > 0;
    return Math.abs(l.aiTotal - prev) / prev > 0.30;
  });
  if (largeChange.length > 0) {
    alerts.push({
      id: 'alt-large-change',
      title: `${largeChange.length} Forecasts Changed >30%`,
      description: 'AI baseline forecast shifted significantly compared to previous version.',
      severity: 'Information',
      count: largeChange.length,
      filterType: 'large-change' as any,
      itemCodes: largeChange.map(l => l.itemCode)
    });
  }

  const shortages = lines.filter(l => (l.rawNetReq !== null ? l.rawNetReq > 0 : (l.plannedOrderQty !== null && l.plannedOrderQty > 0)));
  if (shortages.length > 0) {
    alerts.push({
      id: 'alt-shortages',
      title: `${shortages.length} Net Requirement Shortages`,
      description: 'Demand horizon exceeds existing warehouse inventory and open PO pipeline.',
      severity: 'Warning',
      count: shortages.length,
      filterType: 'shortage',
      itemCodes: shortages.map(l => l.itemCode)
    });
  }

  const disc = lines.filter(l => l.isDiscontinued);
  if (disc.length > 0) {
    alerts.push({
      id: 'alt-disc',
      title: `${disc.length} Discontinued / Phase-out Items`,
      description: 'Zero AI forecast allocated. Review safety stock liquidation.',
      severity: 'Information',
      count: disc.length,
      filterType: 'inactive',
      itemCodes: disc.map(l => l.itemCode)
    });
  }

  // Calculate portfolio KPIs
  const totalItems = lines.length;
  const aiForecastTotal = lines.reduce((a, b) => a + b.aiTotal, 0);
  const finalQtyTotal = lines.reduce((a, b) => a + b.finalQty, 0);
  const netRequirementTotal = lines.reduce((a, b) => a + (b.plannedOrderQty ?? b.netReq ?? 0), 0);
  const rawNetRequirementTotal = lines.reduce((a, b) => a + (b.rawNetReq ?? 0), 0);
  const plannedOrderTotal = netRequirementTotal;
  
  const confScores = lines.filter(l => l.confidencePct !== null).map(l => l.confidencePct as number);
  const avgConfidencePct = confScores.length > 0 
    ? parseFloat((confScores.reduce((a, b) => a + b, 0) / confScores.length).toFixed(1))
    : null;

  const baselineGrowthPct = lines.reduce((a, b) => a + b.actualSalesLastYear, 0) > 0
    ? parseFloat((((finalQtyTotal * (12 / horizon) - lines.reduce((a, b) => a + b.actualSalesLastYear, 0)) / lines.reduce((a, b) => a + b.actualSalesLastYear, 0)) * 100).toFixed(1))
    : 0;

  // Calculate Portfolio Walk-Forward Backtest WAPE across evaluated items
  const itemsWithWape = lines.filter(l => l.modelDecision.backtestWape !== null && l.modelDecision.validationWindows && l.modelDecision.validationWindows > 0);
  const wapePct: number | null = itemsWithWape.length > 0
    ? parseFloat((itemsWithWape.reduce((acc, l) => acc + (l.modelDecision.backtestWape || 0), 0) / itemsWithWape.length).toFixed(1))
    : null;
  const wapeStatus = wapePct !== null ? ('Calculated' as const) : ('Not Available' as const);

  const availableHistoryMonths = dataset.historySummary?.totalMonths || maxHistoryFound;
  const historyDateSpan = dataset.historySummary
    ? `${dataset.historySummary.earliestPeriod} to ${dataset.historySummary.latestPeriod}`
    : 'Dynamic';

  let modelReadinessTier = 'Tier 5: Full Candidate Suite (24M+)';
  let modelReadinessDescription = 'Multi-year telemetry verified. Eligible for candidate ML pipelines in Python.';

  if (availableHistoryMonths <= 2) {
    modelReadinessTier = 'Tier 1: Minimal Fallback (1–2M)';
    modelReadinessDescription = 'Minimal observations available. Pure naive fallback active; requires manual planner baseline seeding.';
  } else if (availableHistoryMonths <= 5) {
    modelReadinessTier = 'Tier 2: Basic Statistical (3–5M)';
    modelReadinessDescription = 'Short-term horizon. Moving averages active with 1-period holdout backtesting.';
  } else if (availableHistoryMonths <= 11) {
    modelReadinessTier = 'Tier 3: Trend & Exponential Smoothing (6–11M)';
    modelReadinessDescription = "Sub-annual history. Holt's Double Exponential Smoothing and Trend OLS active.";
  } else if (availableHistoryMonths <= 23) {
    modelReadinessTier = 'Tier 4: ML & Seasonal Baseline (12–23M)';
    modelReadinessDescription = 'Annual cycle verified. HistGradientBoostingRegressor ML and Holt-Winters active.';
  }

  return {
    lines,
    kpis: {
      totalItems,
      aiForecastTotal,
      finalQtyTotal,
      rawNetRequirementTotal,
      plannedOrderTotal,
      netRequirementTotal,
      avgConfidencePct,
      baselineGrowthPct,
      adjustmentsCount: lines.filter(l => l.plannerAdj !== null).length,
      lowConfidenceCount: lowConf.length,
      shortagesCount: shortages.length,
      wapePct,
      wapeStatus,
      availableHistoryMonths,
      historyDateSpan,
      modelReadinessTier,
      modelReadinessDescription
    },
    alerts,
    parameters: { ...params }
  };
}

/**
 * Recomputes Net Requirements, MOQ/Order Multiples, dynamic alerts, and portfolio KPIs
 * when a planner modifies adjustments or remarks without re-running the forecasting model.
 */
export function recalculateBusinessMetrics(
  existingLines: ForecastLine[],
  dataset: NormalizedDataset | null | undefined,
  params: ForecastParameters
): ForecastResult {
  const horizon = params.horizon || 6;

  // Re-evaluate rawNetReq, plannedOrderQty, netReq and finalQty for each line
  const updatedLines = existingLines.map(line => {
    const finalQty = (line.plannerAdj !== null && line.plannerAdj !== undefined) ? line.plannerAdj : line.aiTotal;
    const { rawNetReq, plannedOrderQty } = calculateMRPRequirements(
      finalQty,
      line.stock,
      line.openPo,
      line.planningMethod,
      line.moq,
      line.orderMultiple,
      params ? params.applyMoqOrderMultiple : true,
      line.isDiscontinued
    );
    const netReq = plannedOrderQty;

    return {
      ...line,
      finalQty,
      rawNetReq,
      plannedOrderQty,
      netReq,
      isModified: line.plannerAdj !== null
    };
  });

  // Dynamic alerts
  const alerts: AlertItem[] = [];
  const lowConf = updatedLines.filter(l => l.confidence === 'Low');
  if (lowConf.length > 0) {
    alerts.push({
      id: 'alt-low-conf',
      title: `${lowConf.length} Low Confidence Items`,
      description: 'Items with limited historical transactions (<6 months) requiring careful planner review.',
      severity: 'Warning',
      count: lowConf.length,
      filterType: 'low-confidence',
      itemCodes: lowConf.map(l => l.itemCode)
    });
  }

  const shortHistory = updatedLines.filter(l => l.historyAvailableMonths < 6);
  if (shortHistory.length > 0) {
    alerts.push({
      id: 'alt-short-hist',
      title: `${shortHistory.length} Items with Short History (<6M)`,
      description: 'Statistical models active. Sub-annual depth limits long-term seasonal decomposition.',
      severity: 'Information',
      count: shortHistory.length,
      filterType: 'no-history',
      itemCodes: shortHistory.map(l => l.itemCode)
    });
  }

  const largeAdj = updatedLines.filter(l =>
    l.plannerAdj !== null &&
    l.aiTotal > 0 &&
    (Math.abs(l.plannerAdj - l.aiTotal) / l.aiTotal) > 0.20
  );
  if (largeAdj.length > 0) {
    alerts.push({
      id: 'alt-large-adj',
      title: `${largeAdj.length} Large Planner Adjustments (>20%)`,
      description: 'Audit justification required for planner modifications exceeding 20%.',
      severity: 'Critical',
      count: largeAdj.length,
      filterType: 'large-adj',
      itemCodes: largeAdj.map(l => l.itemCode)
    });
  }

  const shortages = updatedLines.filter(l => (l.rawNetReq !== null ? l.rawNetReq > 0 : (l.plannedOrderQty !== null && l.plannedOrderQty > 0)));
  if (shortages.length > 0) {
    alerts.push({
      id: 'alt-shortages',
      title: `${shortages.length} Net Requirement Shortages`,
      description: 'Demand horizon exceeds existing warehouse inventory and open PO pipeline.',
      severity: 'Warning',
      count: shortages.length,
      filterType: 'shortage',
      itemCodes: shortages.map(l => l.itemCode)
    });
  }

  const disc = updatedLines.filter(l => l.isDiscontinued);
  if (disc.length > 0) {
    alerts.push({
      id: 'alt-disc',
      title: `${disc.length} Discontinued / Phase-out Items`,
      description: 'Zero AI forecast allocated. Review safety stock liquidation.',
      severity: 'Information',
      count: disc.length,
      filterType: 'inactive',
      itemCodes: disc.map(l => l.itemCode)
    });
  }

  const totalItems = updatedLines.length;
  const aiForecastTotal = updatedLines.reduce((a, b) => a + b.aiTotal, 0);
  const finalQtyTotal = updatedLines.reduce((a, b) => a + b.finalQty, 0);
  const netRequirementTotal = updatedLines.reduce((a, b) => a + (b.plannedOrderQty ?? b.netReq ?? 0), 0);
  const rawNetRequirementTotal = updatedLines.reduce((a, b) => a + (b.rawNetReq ?? 0), 0);
  const plannedOrderTotal = netRequirementTotal;
  const confScores = updatedLines.filter(l => l.confidencePct !== null).map(l => l.confidencePct as number);
  const avgConfidencePct = confScores.length > 0 
    ? parseFloat((confScores.reduce((a, b) => a + b, 0) / confScores.length).toFixed(1))
    : null;

  // Calculate Portfolio Walk-Forward Backtest WAPE across evaluated items
  const itemsWithWape = updatedLines.filter(l => l.modelDecision?.backtestWape !== null && l.modelDecision?.validationWindows && l.modelDecision.validationWindows > 0);
  const wapePct: number | null = itemsWithWape.length > 0
    ? parseFloat((itemsWithWape.reduce((acc, l) => acc + (l.modelDecision.backtestWape || 0), 0) / itemsWithWape.length).toFixed(1))
    : null;
  const wapeStatus = wapePct !== null ? ('Calculated' as const) : ('Not Available' as const);

  const baselineGrowthPct = updatedLines.reduce((a, b) => a + b.actualSalesLastYear, 0) > 0
    ? parseFloat((((finalQtyTotal * (12 / horizon) - updatedLines.reduce((a, b) => a + b.actualSalesLastYear, 0)) / updatedLines.reduce((a, b) => a + b.actualSalesLastYear, 0)) * 100).toFixed(1))
    : 0;

  const availableHistoryMonths = dataset?.historySummary?.totalMonths || 0;
  const historyDateSpan = dataset?.historySummary
    ? `${dataset.historySummary.earliestPeriod} to ${dataset.historySummary.latestPeriod}`
    : 'Dynamic';

  let modelReadinessTier = 'Tier 5: Full Candidate Suite (24M+)';
  let modelReadinessDescription = 'Multi-year telemetry verified. Eligible for candidate ML pipelines in Python.';

  if (availableHistoryMonths <= 2) {
    modelReadinessTier = 'Tier 1: Minimal Fallback (1–2M)';
    modelReadinessDescription = 'Minimal observations available. Pure naive fallback active; requires manual planner baseline seeding.';
  } else if (availableHistoryMonths <= 5) {
    modelReadinessTier = 'Tier 2: Basic Statistical (3–5M)';
    modelReadinessDescription = 'Short-term horizon. Moving averages active with 1-period holdout backtesting.';
  } else if (availableHistoryMonths <= 11) {
    modelReadinessTier = 'Tier 3: Trend & Exponential Smoothing (6–11M)';
    modelReadinessDescription = "Sub-annual history. Holt's Double Exponential Smoothing and Trend OLS active.";
  } else if (availableHistoryMonths <= 23) {
    modelReadinessTier = 'Tier 4: ML & Seasonal Baseline (12–23M)';
    modelReadinessDescription = 'Annual cycle verified. HistGradientBoostingRegressor ML and Holt-Winters active.';
  }

  return {
    lines: updatedLines,
    kpis: {
      totalItems,
      aiForecastTotal,
      finalQtyTotal,
      rawNetRequirementTotal,
      plannedOrderTotal,
      netRequirementTotal,
      avgConfidencePct,
      baselineGrowthPct,
      adjustmentsCount: updatedLines.filter(l => l.plannerAdj !== null).length,
      lowConfidenceCount: lowConf.length,
      shortagesCount: shortages.length,
      wapePct,
      wapeStatus,
      availableHistoryMonths,
      historyDateSpan,
      modelReadinessTier,
      modelReadinessDescription
    },
    alerts,
    parameters: { ...params }
  };
}

/**
 * Fast client-side recalculation of MRP, stock, open orders, master data attributes,
 * dynamic alerts, and portfolio KPIs across the portfolio without re-fitting ML models.
 */
export function recalculateMRPAndSupply(
  existingLines: ForecastLine[],
  dataset: NormalizedDataset,
  params: ForecastParameters
): ForecastResult {
  const emptyBatch: PythonBatchResponse = {
    engine: 'Demandora ML Engine',
    version: '1.0.0',
    horizon: params.horizon,
    startMonth: params.startMonth,
    totalItemsProcessed: 0,
    modelDistribution: {},
    results: []
  };
  return processPythonForecastResults(
    emptyBatch,
    dataset,
    params,
    existingLines
  );
}

export interface ParameterDiff {
  hasForecastParamChanges: boolean;
  hasMrpParamChanges: boolean;
  hasConfidenceLevelChange: boolean;
  changedForecastParams: string[];
  changedMrpParams: string[];
}

/**
 * Categorizes forecast parameters into forecast-affecting vs MRP-only vs confidence changes.
 */
export function diffForecastParameters(
  current: ForecastParameters,
  previous?: ForecastParameters | null
): ParameterDiff {
  if (!previous) {
    return {
      hasForecastParamChanges: false,
      hasMrpParamChanges: false,
      hasConfidenceLevelChange: false,
      changedForecastParams: [],
      changedMrpParams: []
    };
  }

  const changedForecastParams: string[] = [];
  const changedMrpParams: string[] = [];

  // Model-affecting parameters:
  if (current.horizon !== previous.horizon) changedForecastParams.push('horizon');
  if (current.startMonth !== previous.startMonth) changedForecastParams.push('startMonth');
  if (current.historyPeriod !== previous.historyPeriod) changedForecastParams.push('historyPeriod');
  if (current.seasonality !== previous.seasonality) changedForecastParams.push('seasonality');
  if (current.treatBulkProjectSeparately !== previous.treatBulkProjectSeparately) changedForecastParams.push('treatBulkProjectSeparately');
  if (current.includeNewCustomers !== previous.includeNewCustomers) changedForecastParams.push('includeNewCustomers');
  if (current.itemCodeFrom !== previous.itemCodeFrom) changedForecastParams.push('itemCodeFrom');
  if (current.itemCodeTo !== previous.itemCodeTo) changedForecastParams.push('itemCodeTo');

  const curGroups = [...(current.itemGroups || [])].sort();
  const prevGroups = [...(previous.itemGroups || [])].sort();
  if (curGroups.length !== prevGroups.length || curGroups.some((g, i) => g !== prevGroups[i])) {
    changedForecastParams.push('itemGroups');
  }

  // MRP-only parameters:
  if (current.applyMoqOrderMultiple !== previous.applyMoqOrderMultiple) changedMrpParams.push('applyMoqOrderMultiple');
  if (current.includeOpenSalesOrders !== previous.includeOpenSalesOrders) changedMrpParams.push('includeOpenSalesOrders');

  const curWhs = [...(current.warehouses || [])].sort();
  const prevWhs = [...(previous.warehouses || [])].sort();
  if (curWhs.length !== prevWhs.length || curWhs.some((w, i) => w !== prevWhs[i])) {
    changedMrpParams.push('warehouses');
  }

  const hasConfidenceLevelChange = current.confidenceLevel !== previous.confidenceLevel;

  return {
    hasForecastParamChanges: changedForecastParams.length > 0,
    hasMrpParamChanges: changedMrpParams.length > 0,
    hasConfidenceLevelChange,
    changedForecastParams,
    changedMrpParams
  };
}

export {
  resolveForecastWorkflowDecision,
  type ForecastWorkflowDecision,
  type ForecastWorkflowAction
} from './workflowDecisionService';

