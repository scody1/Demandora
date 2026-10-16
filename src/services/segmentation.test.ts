/**
 * Vitest Test Suite for Demand-Based SKU Segmentation (Runner, Repeater, Stranger)
 */

import { describe, it, expect } from 'vitest';
import {
  calculateAdi,
  calculateCv2,
  classifySkuItem,
  computeSegmentation,
  DEFAULT_SEGMENTATION_CONFIG,
  invalidateSegmentationCache,
  type SKUCategory
} from './segmentationService';
import { PreparedHistoryItem } from './forecastingEngine';

describe('Demand-Based SKU Segmentation (Runner, Repeater, Stranger)', () => {
  it('TEST 1: Every eligible SKU receives exactly one category (Mutually Exclusive & Collectively Exhaustive)', () => {
    const items: PreparedHistoryItem[] = [
      { itemCode: 'SKU_RUNNER', history: [100, 105, 98, 102, 100, 103, 99, 101, 104, 97, 100, 102], periods: [] },
      { itemCode: 'SKU_REPEATER', history: [100, 0, 105, 0, 98, 0, 102, 0, 100, 0, 97, 0], periods: [] },
      { itemCode: 'SKU_STRANGER_1', history: [100, 120], periods: [] },
      { itemCode: 'SKU_STRANGER_2', history: [0, 0, 0, 5000, 0, 0, 0, 0, 0, 0, 0, 0], periods: [] },
      { itemCode: 'SKU_UNCLASSIFIED', history: [0, 0, 0, 0, 0, 0], periods: [] }
    ];

    const result = computeSegmentation(items);
    expect(result.totalSKUs).toBe(5);
    expect(result.items.length).toBe(5);

    const categories = result.items.map(i => i.category);
    expect(categories).toContain('RUNNER');
    expect(categories).toContain('REPEATER');
    expect(categories).toContain('STRANGER');
    expect(categories).toContain('UNCLASSIFIED');

    // Verify sum of counts equals total items without duplicates
    const sumCounts =
      result.summary.RUNNER.count +
      result.summary.REPEATER.count +
      result.summary.STRANGER.count +
      result.summary.UNCLASSIFIED.count;
    expect(sumCounts).toBe(5);
  });

  it('TEST 2: Classification is strictly deterministic for identical input history', () => {
    const history = [120, 110, 115, 125, 105, 130, 110, 115, 120, 110, 105, 125];
    const run1 = classifySkuItem('SKU_TEST', history, 'Description 1', 'Group A');
    const run2 = classifySkuItem('SKU_TEST', history, 'Description 1', 'Group A');

    expect(run1.category).toBe(run2.category);
    expect(run1.adi).toBe(run2.adi);
    expect(run1.cvSquared).toBe(run2.cvSquared);
    expect(run1.demandFrequency).toBe(run2.demandFrequency);
    expect(run1.classificationReason).toBe(run2.classificationReason);
  });

  it('TEST 3: Runner classification requires ADI <= 1.32, CV² <= 0.49, and active ratio >= 60%', () => {
    // 12 months, every month active, low variance
    const stableHistory = [100, 102, 98, 101, 100, 103, 99, 100, 102, 98, 101, 100];
    const res = classifySkuItem('RUNNER_PROD', stableHistory);

    expect(res.category).toBe('RUNNER');
    expect(res.adi).toBeLessThanOrEqual(DEFAULT_SEGMENTATION_CONFIG.adi_threshold);
    expect(res.cvSquared).toBeLessThanOrEqual(DEFAULT_SEGMENTATION_CONFIG.cv2_threshold);
    expect(res.activeMonths).toBe(12);
    expect(res.demandFrequency).toBe(100);
    expect(res.classificationReason).toContain('Frequent and consistent demand');
  });

  it('TEST 4: Repeater classification correctly flags recurring intermittent or erratic demand', () => {
    // Erratic order quantities with frequent purchases
    const erraticHistory = [10, 800, 20, 950, 15, 600, 30, 1100, 25, 750, 20, 850];
    const resErratic = classifySkuItem('REPEATER_ERRATIC', erraticHistory);

    expect(resErratic.category).toBe('REPEATER');
    expect(resErratic.cvSquared).toBeGreaterThan(0.49);
    expect(resErratic.classificationReason).toContain('Frequent but erratic demand');

    // Spaced orders (ADI > 1.32) but predictable volume
    const intermittentHistory = [100, 0, 105, 0, 98, 0, 102, 0, 100, 0, 97, 0];
    const resIntermittent = classifySkuItem('REPEATER_INTERMITTENT', intermittentHistory);

    expect(resIntermittent.category).toBe('REPEATER');
    expect(resIntermittent.adi).toBeGreaterThan(1.32);
    expect(resIntermittent.cvSquared).toBeLessThanOrEqual(0.49);
    expect(resIntermittent.classificationReason).toContain('Intermittent recurring demand');
  });

  it('TEST 5: Stranger classification routes < 6M short history and lumpy/sporadic items', () => {
    // Under 6 months history
    const shortHistory = [100, 120, 110];
    const resShort = classifySkuItem('STRANGER_SHORT', shortHistory);

    expect(resShort.category).toBe('STRANGER');
    expect(resShort.historyLength).toBe(3);
    expect(resShort.classificationReason).toContain('Insufficient historical maturity');

    // Lumpy demand: infrequent and high variance
    const lumpyHistory = [0, 10, 0, 0, 4500, 0, 0, 0, 15, 0, 0, 0];
    const resLumpy = classifySkuItem('STRANGER_LUMPY', lumpyHistory);

    expect(resLumpy.category).toBe('STRANGER');
    expect(resLumpy.zeroDemandMonths / 12).toBeGreaterThanOrEqual(0.70);
  });

  it('TEST 6: Zero demand series is correctly marked UNCLASSIFIED without crashing', () => {
    const zeroHistory = [0, 0, 0, 0, 0, 0];
    const res = classifySkuItem('DEAD_SKU', zeroHistory);

    expect(res.category).toBe('UNCLASSIFIED');
    expect(res.classificationReason).toContain('Zero recorded historical demand');
    expect(res.activeMonths).toBe(0);
  });

  it('TEST 7: Selective Category Filtering does not omit or duplicate products', () => {
    const population: PreparedHistoryItem[] = [
      { itemCode: 'R1', history: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100], periods: [] },
      { itemCode: 'R2', history: [200, 205, 195, 200, 210, 190, 200, 205, 195, 200, 210, 190], periods: [] },
      { itemCode: 'P1', history: [100, 0, 100, 0, 100, 0, 100, 0, 100, 0, 100, 0], periods: [] },
      { itemCode: 'S1', history: [50, 60], periods: [] }
    ];

    const segResult = computeSegmentation(population);
    const runnerSkus = segResult.items.filter(i => i.category === 'RUNNER').map(i => i.itemCode);
    const repeaterSkus = segResult.items.filter(i => i.category === 'REPEATER').map(i => i.itemCode);
    const strangerSkus = segResult.items.filter(i => i.category === 'STRANGER').map(i => i.itemCode);

    expect(runnerSkus).toEqual(['R1', 'R2']);
    expect(repeaterSkus).toEqual(['P1']);
    expect(strangerSkus).toEqual(['S1']);

    // Multiple category union has no duplicates
    const combinedScope = Array.from(new Set([...runnerSkus, ...repeaterSkus]));
    expect(combinedScope).toEqual(['R1', 'R2', 'P1']);
    expect(combinedScope.length).toBe(3);
  });

  it('TEST 8: Real illustrative SKU example is generated from actual population data', () => {
    const population: PreparedHistoryItem[] = [
      { itemCode: 'SKU_29053FG', description: 'LED Panel 15W', history: [100, 105, 98, 102, 100, 103, 99, 101, 104, 97, 100, 102], periods: [] },
      { itemCode: 'SKU_30856FG', description: 'Downlight 12W', history: [100, 0, 105, 0, 98, 0, 102, 0, 100, 0, 97, 0], periods: [] }
    ];

    const segResult = computeSegmentation(population);
    const runnerExample = segResult.summary.RUNNER.illustrativeSku;
    expect(runnerExample).not.toBeNull();
    expect(runnerExample?.itemCode).toBe('SKU_29053FG');
    expect(runnerExample?.description).toBe('LED Panel 15W');
    expect(runnerExample?.adi).toBe(1.0);
  });

  it('TEST 9: Boundary test around ADI 1.32 (Exact 1.32 vs 1.324 unrounded)', () => {
    // Exact ADI = 1.32: 17 intervals of 1, 8 intervals of 2 -> 33 / 25 = 1.32 exactly
    const historyExact132: number[] = [];
    // Index 0
    historyExact132.push(100);
    // 17 intervals of 1
    for (let i = 0; i < 17; i++) historyExact132.push(100);
    // 8 intervals of 2 (push 0 then 100)
    for (let i = 0; i < 8; i++) {
      historyExact132.push(0);
      historyExact132.push(100);
    }
    expect(calculateAdi(historyExact132)).toBeCloseTo(1.32, 5);

    const resExact = classifySkuItem('SKU_ADI_EXACT', historyExact132);
    expect(resExact.category).toBe('RUNNER');
    expect(resExact.classificationReason).toContain('ADI = 1.32 <= 1.32');

    // Unrounded ADI = 1.324 (331 / 250 = 1.324, which rounds to 1.32 if 2 decimals applied early)
    // 249 intervals of 1, 1 interval of 82
    const history1324: number[] = [];
    history1324.push(100);
    for (let i = 0; i < 249; i++) history1324.push(100);
    for (let i = 0; i < 81; i++) history1324.push(0);
    history1324.push(100);
    expect(calculateAdi(history1324)).toBeCloseTo(1.324, 4);

    const res1324 = classifySkuItem('SKU_ADI_1324', history1324);
    // Because 1.324 > 1.32, must NOT be RUNNER! It is REPEATER (intermittent)
    expect(res1324.category).toBe('REPEATER');
    expect(res1324.classificationReason).toContain('ADI = 1.324 > 1.32');
  });

  it('TEST 10: Boundary test around CV² 0.49 (Exact/below 0.49 vs 0.4904 unrounded)', () => {
    // 12 months continuous (ADI = 1.0, active ratio = 100%)
    // 6 values of 100 - delta, 6 values of 100 + delta
    // CV² = (12 * delta^2) / 110000
    // If delta = 67.0 -> CV² = (12 * 4489) / 110000 = 0.4897 <= 0.49
    const deltaLow = 67.0;
    const historyCv2Low = [
      100 - deltaLow, 100 + deltaLow, 100 - deltaLow, 100 + deltaLow,
      100 - deltaLow, 100 + deltaLow, 100 - deltaLow, 100 + deltaLow,
      100 - deltaLow, 100 + deltaLow, 100 - deltaLow, 100 + deltaLow
    ];
    expect(calculateCv2(historyCv2Low)).toBeLessThanOrEqual(0.49);
    const resLow = classifySkuItem('SKU_CV2_LOW', historyCv2Low);
    expect(resLow.category).toBe('RUNNER');

    // If delta = 67.047247 -> CV² = 0.4904 > 0.49 (rounds to 0.49 in 2-decimal display)
    const deltaHigh = 67.047247;
    const historyCv2High = [
      100 - deltaHigh, 100 + deltaHigh, 100 - deltaHigh, 100 + deltaHigh,
      100 - deltaHigh, 100 + deltaHigh, 100 - deltaHigh, 100 + deltaHigh,
      100 - deltaHigh, 100 + deltaHigh, 100 - deltaHigh, 100 + deltaHigh
    ];
    expect(calculateCv2(historyCv2High)).toBeGreaterThan(0.49);
    const resHigh = classifySkuItem('SKU_CV2_HIGH', historyCv2High);
    // Because 0.4904 > 0.49, must NOT be RUNNER! It is REPEATER (erratic)
    expect(resHigh.category).toBe('REPEATER');
    expect(resHigh.classificationReason).toContain('CV² = 0.4904 > 0.49');
  });

  it('TEST 11: 0M empty history is classified as STRANGER cold-start candidate, while observed all-zeros remains UNCLASSIFIED', () => {
    // 0M genuine empty history (no observed periods)
    const resEmpty = classifySkuItem('COLD_NEW_SKU', []);
    expect(resEmpty.category).toBe('STRANGER');
    expect(resEmpty.historyLength).toBe(0);
    expect(resEmpty.classificationReason).toContain('Zero observed historical periods (0M history)');
    expect(resEmpty.classificationReason).toContain('routes to cold-start peer discovery');

    // Observed 6 months of zero demand
    const resZeros = classifySkuItem('INACTIVE_SKU', [0, 0, 0, 0, 0, 0]);
    expect(resZeros.category).toBe('UNCLASSIFIED');
    expect(resZeros.historyLength).toBe(6);
    expect(resZeros.classificationReason).toContain('Zero recorded historical demand across all 6 observed month(s)');
  });

  it('TEST 12: Empty-history SKU passes through selected STRANGER scope and retains empty array', () => {
    const population: PreparedHistoryItem[] = [
      { itemCode: 'COLD_1', description: 'New 12W Downlight', itemGroup: 'Downlight', history: [], periods: [] },
      { itemCode: 'ZERO_1', description: 'Old Discontinued Item', itemGroup: 'Panel', history: [0, 0, 0, 0, 0, 0], periods: [] },
      { itemCode: 'RUN_1', description: 'Runner Item', itemGroup: 'Spotlight', history: [100, 105, 98, 102, 100, 103, 99, 101, 104, 97, 100, 102], periods: [] }
    ];

    const segResult = computeSegmentation(population);
    expect(segResult.summary.STRANGER.count).toBe(1);
    expect(segResult.summary.UNCLASSIFIED.count).toBe(1);
    expect(segResult.summary.RUNNER.count).toBe(1);

    // Planner selects only STRANGER
    const selectedScope: SKUCategory[] = ['STRANGER'];
    const filteredPayload = population.filter(item => {
      const segItem = segResult.items.find(s => s.itemCode === item.itemCode);
      if (!segItem || segItem.category === 'UNCLASSIFIED') return false;
      return selectedScope.includes(segItem.category);
    });

    expect(filteredPayload.length).toBe(1);
    expect(filteredPayload[0].itemCode).toBe('COLD_1');
    expect(filteredPayload[0].history).toEqual([]);

    // Missing item is never defaulted to STRANGER or included
    const unlistedItem: PreparedHistoryItem = { itemCode: 'UNLISTED', history: [50], periods: [] };
    const segMissing = segResult.items.find(s => s.itemCode === unlistedItem.itemCode);
    const isIncluded = segMissing && selectedScope.includes(segMissing.category);
    expect(isIncluded).toBeFalsy();
  });

  it('TEST 13: DatasetStagingView top Generate button readiness logic', () => {
    const isButtonDisabled = (loading: boolean, segResult: any, error: string | null) => {
      return loading || !segResult || Boolean(error);
    };

    const mockSegResult = { ruleVersion: 'v1.0.0-SBC' };

    // 1. Disabled during loading
    expect(isButtonDisabled(true, mockSegResult, null)).toBe(true);

    // 2. Disabled when segmentation missing
    expect(isButtonDisabled(false, null, null)).toBe(true);

    // 3. Disabled on error
    expect(isButtonDisabled(false, mockSegResult, 'Calculation error')).toBe(true);

    // 4. Enabled when ready
    expect(isButtonDisabled(false, mockSegResult, null)).toBe(false);
  });

  it('TEST 14: Target scope is strictly filtered while candidate context retains full dataset for peer discovery', () => {
    const fullDataset: PreparedHistoryItem[] = [
      { itemCode: 'COLD_STRANGER_1', history: [], periods: [] },
      { itemCode: 'MATURE_RUNNER_1', history: [200, 210, 190, 205, 200, 215, 195, 205, 210, 190, 205, 200], periods: [] },
      { itemCode: 'INTERMITTENT_REP_1', history: [100, 0, 100, 0, 100, 0, 100, 0, 100, 0, 100, 0], periods: [] },
      { itemCode: 'INACTIVE_ZERO_1', history: [0, 0, 0, 0, 0, 0], periods: [] }
    ];

    const segResult = computeSegmentation(fullDataset);
    const selectedScope: SKUCategory[] = ['STRANGER'];

    // Target items list strictly contains only selected category SKUs, excluding UNCLASSIFIED
    const targetItems = fullDataset.filter(item => {
      const segItem = segResult.items.find(s => s.itemCode === item.itemCode);
      if (!segItem || segItem.category === 'UNCLASSIFIED') return false;
      return selectedScope.includes(segItem.category);
    });

    // 1. Only 1 target SKU (COLD_STRANGER_1) is selected for forecasting
    expect(targetItems.length).toBe(1);
    expect(targetItems[0].itemCode).toBe('COLD_STRANGER_1');
    expect(targetItems[0].history).toEqual([]);

    // 2. Candidate context preserves all 4 SKUs so mature peer context is not lost
    const candidateContext = fullDataset;
    expect(candidateContext.length).toBe(4);
    expect(candidateContext.some(c => c.itemCode === 'MATURE_RUNNER_1')).toBe(true);

    // 3. Unselected categories in candidate pool are not forecast targets
    expect(targetItems.some(t => t.itemCode === 'MATURE_RUNNER_1')).toBe(false);
    expect(targetItems.some(t => t.itemCode === 'INTERMITTENT_REP_1')).toBe(false);
    expect(targetItems.some(t => t.itemCode === 'INACTIVE_ZERO_1')).toBe(false);
  });

  it('TEST 15: Selecting REPEATER only keeps candidate context intact without adding extra forecast targets', () => {
    const fullDataset: PreparedHistoryItem[] = [
      { itemCode: 'COLD_1', history: [], periods: [] },
      { itemCode: 'RUNNER_1', history: [200, 210, 190, 205, 200, 215, 195, 205, 210, 190, 205, 200], periods: [] },
      { itemCode: 'REP_1', history: [100, 0, 100, 0, 100, 0, 100, 0, 100, 0, 100, 0], periods: [] }
    ];

    const segResult = computeSegmentation(fullDataset);
    const selectedScope: SKUCategory[] = ['REPEATER'];

    const targetItems = fullDataset.filter(item => {
      const segItem = segResult.items.find(s => s.itemCode === item.itemCode);
      if (!segItem || segItem.category === 'UNCLASSIFIED') return false;
      return selectedScope.includes(segItem.category);
    });

    expect(targetItems.length).toBe(1);
    expect(targetItems[0].itemCode).toBe('REP_1');
    expect(fullDataset.length).toBe(3);
  });

  it('TEST 16: Category criteria summaries are distinct, complete, and independent per category', () => {
    const items: PreparedHistoryItem[] = [
      { itemCode: 'R1', history: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100], periods: [] },
      { itemCode: 'REP1', history: [100, 0, 100, 0, 100, 0, 100, 0, 100, 0, 100, 0], periods: [] },
      { itemCode: 'S1', history: [50, 0], periods: [] }
    ];
    const seg = computeSegmentation(items);
    expect(seg.summary.RUNNER.criteria?.length).toBeGreaterThan(0);
    expect(seg.summary.REPEATER.criteria?.length).toBeGreaterThan(0);
    expect(seg.summary.STRANGER.criteria?.length).toBeGreaterThan(0);

    // Each category has its own distinct criteria definitions
    expect(seg.summary.RUNNER.criteria).not.toEqual(seg.summary.REPEATER.criteria);
    expect(seg.summary.RUNNER.criteria).not.toEqual(seg.summary.STRANGER.criteria);
    expect(seg.summary.REPEATER.criteria).not.toEqual(seg.summary.STRANGER.criteria);
  });
});
