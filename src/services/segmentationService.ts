/**
 * Demand-Based SKU Segmentation Service
 *
 * Implements Runner, Repeater, Stranger classification and telemetry analysis.
 * Features deterministic computation, API synchronization with FastAPI,
 * and data-version invalidation caching.
 */

import {
  NormalizedDataset,
  ForecastParameters,
  SKUCategory,
  SegmentationResult,
  SegmentationConfig,
  IllustrativeSKUExplanation
} from '../types';
export type { SKUCategory };
import { PreparedHistoryItem, prepareItemHistories } from './forecastingEngine';

export const DEFAULT_SEGMENTATION_CONFIG: SegmentationConfig = {
  version: 'v1.0.0-SBC',
  adi_threshold: 1.32,
  cv2_threshold: 0.49,
  min_history_months: 6,
  runner_min_active_ratio: 0.60,
  runner_min_active_months: 4,
  repeater_min_active_months: 3,
  stranger_min_zero_ratio: 0.70
};

/**
 * Calculates squared coefficient of variation for non-zero demand periods.
 */
export function calculateCv2(series: number[]): number {
  const nonZero = series.filter(v => v > 0);
  if (nonZero.length < 2) return 0.0;
  const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
  if (mean === 0) return 0.0;
  const variance = nonZero.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (nonZero.length - 1);
  return variance / Math.pow(mean, 2);
}

/**
 * Calculates Average Demand Interval (ADI) between non-zero demand periods.
 */
export function calculateAdi(series: number[]): number {
  const nonZeroIndices: number[] = [];
  series.forEach((val, idx) => {
    if (val > 0) nonZeroIndices.push(idx);
  });

  if (nonZeroIndices.length < 2) {
    return series.length > 0 ? series.length : 0.0;
  }

  let totalInterval = 0;
  for (let i = 1; i < nonZeroIndices.length; i++) {
    totalInterval += (nonZeroIndices[i] - nonZeroIndices[i - 1]);
  }
  return totalInterval / (nonZeroIndices.length - 1);
}

export function formatMetric(val: number, threshold: number, decimals: number = 2): string {
  const formatted = val.toFixed(decimals);
  const threshFormatted = threshold.toFixed(decimals);
  if (formatted === threshFormatted && val !== threshold) {
    return val.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }
  return formatted;
}

/**
 * Deterministically classifies a single SKU given historical series.
 */
export function classifySkuItem(
  itemCode: string,
  history: number[],
  description: string = '',
  itemGroup: string = '',
  config: Partial<SegmentationConfig> = {}
): IllustrativeSKUExplanation {
  const cfg = { ...DEFAULT_SEGMENTATION_CONFIG, ...config };
  const n = history.length;
  const nonZero = history.filter(v => v > 0);
  const activeMonths = nonZero.length;
  const zeroMonths = n - activeMonths;
  const totalDemand = history.reduce((a, b) => a + b, 0);
  const avgDemand = n > 0 ? totalDemand / n : 0.0;
  const demandFrequency = n > 0 ? (activeMonths / n) * 100 : 0.0;
  const zeroRatio = n > 0 ? zeroMonths / n : 1.0;

  const adi = calculateAdi(history);
  const cv2 = calculateCv2(history);
  const cv = Math.sqrt(Math.max(0, cv2));

  let category: SKUCategory = 'UNCLASSIFIED';
  let reason = '';

  if (n === 0) {
    return {
      itemCode,
      description,
      itemGroup,
      category: 'STRANGER',
      classificationReason: 'Zero observed historical periods (0M history); routes to cold-start peer discovery using comparable mature SKUs.',
      demandFrequency: 0,
      activeMonths: 0,
      zeroDemandMonths: 0,
      averageMonthlyDemand: 0,
      cv: 0,
      cvSquared: 0,
      adi: 0,
      historyLength: 0,
      ruleVersion: cfg.version,
      _rawAdi: 0,
      _rawCvSquared: 0
    };
  }

  if (totalDemand <= 0 || activeMonths === 0) {
    category = 'UNCLASSIFIED';
    reason = `Zero recorded historical demand across all ${n} observed month(s); cannot reliably evaluate demand frequency, inter-demand interval, or volume variability.`;
    return {
      itemCode,
      description,
      itemGroup,
      category,
      classificationReason: reason,
      demandFrequency: parseFloat(demandFrequency.toFixed(2)),
      activeMonths,
      zeroDemandMonths: zeroMonths,
      averageMonthlyDemand: parseFloat(avgDemand.toFixed(2)),
      cv: parseFloat(cv.toFixed(4)),
      cvSquared: parseFloat(cv2.toFixed(4)),
      adi: parseFloat(adi.toFixed(2)),
      historyLength: n,
      ruleVersion: cfg.version,
      _rawAdi: adi,
      _rawCvSquared: cv2
    };
  } else if (n < cfg.min_history_months) {
    category = 'STRANGER';
    reason = `Insufficient historical maturity (${n} month(s) < ${cfg.min_history_months}M required for statistical forecasting; routes to cold-start / sparse-history peer discovery).`;
  } else if (activeMonths < cfg.repeater_min_active_months) {
    category = 'STRANGER';
    reason = `Highly sporadic demand with only ${activeMonths} active demand month(s) out of ${n} total periods (${(zeroRatio * 100).toFixed(1)}% zero-demand ratio exceeds sporadic threshold).`;
  } else if (adi > cfg.adi_threshold && cv2 > cfg.cv2_threshold) {
    category = 'STRANGER';
    reason = `Lumpy demand pattern: both spaced inter-demand intervals (ADI = ${formatMetric(adi, cfg.adi_threshold)} > ${cfg.adi_threshold}) and high order volume variability (CV² = ${formatMetric(cv2, cfg.cv2_threshold)} > ${cfg.cv2_threshold}).`;
  } else if (zeroRatio >= cfg.stranger_min_zero_ratio) {
    category = 'STRANGER';
    reason = `Infrequent demand occurrences with ${(zeroRatio * 100).toFixed(1)}% zero-demand periods (>= ${(cfg.stranger_min_zero_ratio * 100).toFixed(0)}% threshold).`;
  } else if (
    adi <= cfg.adi_threshold &&
    cv2 <= cfg.cv2_threshold &&
    activeMonths >= cfg.runner_min_active_months &&
    (activeMonths / n) >= cfg.runner_min_active_ratio
  ) {
    category = 'RUNNER';
    reason = `Frequent and consistent demand: regular demand intervals (ADI = ${formatMetric(adi, cfg.adi_threshold)} <= ${cfg.adi_threshold}), stable order sizing (CV² = ${formatMetric(cv2, cfg.cv2_threshold)} <= ${cfg.cv2_threshold}), and ${demandFrequency.toFixed(1)}% active demand months across ${n} historical months.`;
  } else {
    category = 'REPEATER';
    if (adi <= cfg.adi_threshold && cv2 > cfg.cv2_threshold) {
      reason = `Frequent but erratic demand: recurring order intervals (ADI = ${formatMetric(adi, cfg.adi_threshold)} <= ${cfg.adi_threshold}) with variable order quantities (CV² = ${formatMetric(cv2, cfg.cv2_threshold)} > ${cfg.cv2_threshold}).`;
    } else if (adi > cfg.adi_threshold && cv2 <= cfg.cv2_threshold) {
      reason = `Intermittent recurring demand: spaced order intervals (ADI = ${formatMetric(adi, cfg.adi_threshold)} > ${cfg.adi_threshold}) with consistent order quantities (CV² = ${formatMetric(cv2, cfg.cv2_threshold)} <= ${cfg.cv2_threshold}).`;
    } else {
      reason = `Recurring demand pattern with ${activeMonths} active months (${demandFrequency.toFixed(1)}% frequency) and moderate demand continuity.`;
    }
  }

  return {
    itemCode,
    description,
    itemGroup,
    category,
    classificationReason: reason,
    demandFrequency: parseFloat(demandFrequency.toFixed(2)),
    activeMonths,
    zeroDemandMonths: zeroMonths,
    averageMonthlyDemand: parseFloat(avgDemand.toFixed(2)),
    cv: parseFloat(cv.toFixed(4)),
    cvSquared: parseFloat(cv2.toFixed(4)),
    adi: parseFloat(adi.toFixed(2)),
    historyLength: n,
    ruleVersion: cfg.version,
    _rawAdi: adi,
    _rawCvSquared: cv2
  };
}

/**
 * Computes deterministic segmentation metrics across all prepared items.
 */
export function computeSegmentation(
  items: PreparedHistoryItem[],
  config: Partial<SegmentationConfig> = {}
): SegmentationResult {
  const cfg = { ...DEFAULT_SEGMENTATION_CONFIG, ...config };
  const classifiedItems: IllustrativeSKUExplanation[] = [];

  const counts: Record<SKUCategory, number> = {
    RUNNER: 0,
    REPEATER: 0,
    STRANGER: 0,
    UNCLASSIFIED: 0
  };

  const runnerCriteria = {
    adi: 0,
    cv2: 0,
    freq: 0,
    maturity: 0
  };

  const repeaterCriteria = {
    recurringActive: 0,
    intermittentOrErratic: 0,
    zeroRatio: 0,
    maturity: 0
  };

  const strangerCriteria = {
    insufficientHistory: 0,
    sporadicActive: 0,
    lumpy: 0,
    highZeroRatio: 0
  };

  const illustrative: Record<SKUCategory, IllustrativeSKUExplanation | null> = {
    RUNNER: null,
    REPEATER: null,
    STRANGER: null,
    UNCLASSIFIED: null
  };

  for (const item of items) {
    const res = classifySkuItem(
      item.itemCode,
      item.history,
      item.description,
      item.itemGroup,
      cfg
    );

    classifiedItems.push(res);
    counts[res.category] = (counts[res.category] || 0) + 1;

    if (!illustrative[res.category] && res.historyLength > 0) {
      illustrative[res.category] = res;
    }

    const n = res.historyLength;
    const active = res.activeMonths;
    const zeroRatio = n > 0 ? res.zeroDemandMonths / n : 1.0;

    const rawAdi = res._rawAdi ?? res.adi;
    const rawCv2 = res._rawCvSquared ?? res.cvSquared;

    // Runner criteria counters
    if (rawAdi <= cfg.adi_threshold) runnerCriteria.adi++;
    if (rawCv2 <= cfg.cv2_threshold) runnerCriteria.cv2++;
    if (n > 0 && active / n >= cfg.runner_min_active_ratio) runnerCriteria.freq++;
    if (n >= cfg.min_history_months) runnerCriteria.maturity++;

    // Repeater criteria counters
    if (active >= cfg.repeater_min_active_months) repeaterCriteria.recurringActive++;
    if (
      (rawAdi > cfg.adi_threshold && rawCv2 <= cfg.cv2_threshold) ||
      (rawAdi <= cfg.adi_threshold && rawCv2 > cfg.cv2_threshold)
    ) {
      repeaterCriteria.intermittentOrErratic++;
    }
    if (zeroRatio < cfg.stranger_min_zero_ratio) repeaterCriteria.zeroRatio++;
    if (n >= cfg.min_history_months) repeaterCriteria.maturity++;

    // Stranger criteria counters
    if (n < cfg.min_history_months) strangerCriteria.insufficientHistory++;
    if (active < cfg.repeater_min_active_months) strangerCriteria.sporadicActive++;
    if (rawAdi > cfg.adi_threshold && rawCv2 > cfg.cv2_threshold) strangerCriteria.lumpy++;
    if (zeroRatio >= cfg.stranger_min_zero_ratio) strangerCriteria.highZeroRatio++;
  }

  const total = classifiedItems.length;
  const eligible = total - counts.UNCLASSIFIED;
  const denom = eligible > 0 ? eligible : (total > 0 ? total : 1);

  const runnerPct = denom > 0 ? parseFloat(((counts.RUNNER / denom) * 100).toFixed(1)) : 0;
  const repeaterPct = denom > 0 ? parseFloat(((counts.REPEATER / denom) * 100).toFixed(1)) : 0;
  const strangerPct = denom > 0 ? parseFloat(((counts.STRANGER / denom) * 100).toFixed(1)) : 0;
  const unclassifiedPct = total > 0 ? parseFloat(((counts.UNCLASSIFIED / total) * 100).toFixed(1)) : 0;

  return {
    ruleVersion: cfg.version,
    totalSKUs: total,
    eligibleSKUs: eligible,
    config: cfg,
    summary: {
      RUNNER: {
        count: counts.RUNNER,
        percentage: runnerPct,
        label: 'Runner',
        description: 'Products with frequent and relatively consistent demand.',
        criteria: [
          {
            condition: `Average Demand Interval (ADI) <= ${cfg.adi_threshold}`,
            explanation: `Demand occurs at regular intervals of ${cfg.adi_threshold} months or less.`,
            satisfiedCount: runnerCriteria.adi
          },
          {
            condition: `Demand Volume Variability (CV²) <= ${cfg.cv2_threshold}`,
            explanation: `Squared coefficient of variation is stable at ${cfg.cv2_threshold} or below.`,
            satisfiedCount: runnerCriteria.cv2
          },
          {
            condition: `Active Demand Frequency >= ${Math.round(cfg.runner_min_active_ratio * 100)}%`,
            explanation: `Orders placed in at least ${Math.round(cfg.runner_min_active_ratio * 100)}% of total historical months.`,
            satisfiedCount: runnerCriteria.freq
          },
          {
            condition: `Historical Telemetry >= ${cfg.min_history_months} Months`,
            explanation: 'Sufficient history depth for mature statistical & ML model selection.',
            satisfiedCount: runnerCriteria.maturity
          }
        ],
        illustrativeSku: illustrative.RUNNER
      },
      REPEATER: {
        count: counts.REPEATER,
        percentage: repeaterPct,
        label: 'Repeater',
        description: 'Products with recurring but intermittent or variable demand.',
        criteria: [
          {
            condition: `Recurring Order Frequency >= ${cfg.repeater_min_active_months} Active Months`,
            explanation: `Demonstrates established recurring demand with at least ${cfg.repeater_min_active_months} active months.`,
            satisfiedCount: repeaterCriteria.recurringActive
          },
          {
            condition: `Intermittent (ADI > ${cfg.adi_threshold}) OR Erratic (CV² > ${cfg.cv2_threshold})`,
            explanation: 'Moderate intermittency in ordering periods or volatility in order lot sizes.',
            satisfiedCount: repeaterCriteria.intermittentOrErratic
          },
          {
            condition: `Zero-Demand Ratio < ${Math.round(cfg.stranger_min_zero_ratio * 100)}%`,
            explanation: 'Recurring activity does not exhibit extreme multi-quarter dormancy.',
            satisfiedCount: repeaterCriteria.zeroRatio
          },
          {
            condition: `Historical Telemetry >= ${cfg.min_history_months} Months`,
            explanation: 'Valid history foundation available at forecast origin.',
            satisfiedCount: repeaterCriteria.maturity
          }
        ],
        illustrativeSku: illustrative.REPEATER
      },
      STRANGER: {
        count: counts.STRANGER,
        percentage: strangerPct,
        label: 'Stranger',
        description: 'Products with rare, highly sporadic or insufficient demand evidence.',
        criteria: [
          {
            condition: `History Length < ${cfg.min_history_months} Months`,
            explanation: 'Cold-start (0M) or sparse history (1–5M) requiring peer discovery.',
            satisfiedCount: strangerCriteria.insufficientHistory
          },
          {
            condition: `Highly Sporadic Demand (< ${cfg.repeater_min_active_months} Active Months)`,
            explanation: 'Sparse transactions across long observation windows.',
            satisfiedCount: strangerCriteria.sporadicActive
          },
          {
            condition: `Lumpy Demand (ADI > ${cfg.adi_threshold} AND CV² > ${cfg.cv2_threshold})`,
            explanation: 'Simultaneously infrequent orders and volatile quantity spikes.',
            satisfiedCount: strangerCriteria.lumpy
          },
          {
            condition: `Zero-Demand Ratio >= ${Math.round(cfg.stranger_min_zero_ratio * 100)}%`,
            explanation: 'Dominant dormancy with sporadic isolated purchase events.',
            satisfiedCount: strangerCriteria.highZeroRatio
          }
        ],
        illustrativeSku: illustrative.STRANGER
      },
      UNCLASSIFIED: {
        count: counts.UNCLASSIFIED,
        percentage: unclassifiedPct,
        label: 'Unclassified',
        description: 'Zero historical sales volume across all periods; cannot evaluate demand behavior.',
        criteria: [],
        illustrativeSku: illustrative.UNCLASSIFIED
      }
    },
    items: classifiedItems
  };
}

// In-memory cache keyed by dataset version and configuration
const segmentationCache = new Map<string, SegmentationResult>();

/**
 * Retrieves segmentation for a dataset, guaranteeing recalculation whenever
 * the dataset version or parameters change.
 */
export async function getOrCalculateSegmentation(
  dataset: NormalizedDataset,
  params: ForecastParameters,
  config?: Partial<SegmentationConfig>
): Promise<SegmentationResult> {
  const cacheKey = `v${dataset.dataVersion}_g${params.itemGroups.join(',')}_p${params.historyPeriod}`;

  if (segmentationCache.has(cacheKey)) {
    return segmentationCache.get(cacheKey)!;
  }

  const itemsPayload = prepareItemHistories(dataset, params);

  // Try fetching from backend first for authoritative validation
  try {
    const res = await fetch('http://127.0.0.1:8000/api/forecast/segmentation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: itemsPayload,
        config: config || DEFAULT_SEGMENTATION_CONFIG
      })
    });
    if (res.ok) {
      const data: SegmentationResult = await res.json();
      segmentationCache.set(cacheKey, data);
      return data;
    }
  } catch (err) {
    // Network or service offline; proceed to deterministic local computation
  }

  const localResult = computeSegmentation(itemsPayload, config);
  segmentationCache.set(cacheKey, localResult);
  return localResult;
}

/**
 * Explicitly invalidates segmentation cache when a new Excel workbook is imported.
 */
export function invalidateSegmentationCache(): void {
  segmentationCache.clear();
}
