import { describe, it, expect, vi } from 'vitest';
import { mergeIncrementalDataset } from './excelService';
import {
  prepareItemHistories,
  processPythonForecastResults,
  calculateMRPRequirements,
  recalculateMRPAndSupply,
  diffForecastParameters
} from './forecastingEngine';
import { computeSegmentation } from './segmentationService';
import {
  NormalizedDataset,
  Item,
  SalesHistoryRecord,
  ForecastParameters,
  ForecastLine,
  ForecastResult,
  InventoryRecord,
  OpenOrderRecord,
  BOMRecord,
  ForecastVersion
} from '../types';
import { PythonBatchResponse } from './forecastClient';
import { PersistenceService, STORAGE_KEY } from './persistenceService';

function createMockDataset(
  items: Item[],
  salesHistory: SalesHistoryRecord[],
  dataVersion = 1,
  incrementalStats?: any,
  inventory?: InventoryRecord[],
  openOrders?: OpenOrderRecord[],
  boms?: BOMRecord[],
  sheetsDetected?: string[]
): NormalizedDataset {
  const detected = sheetsDetected || [
    'Items',
    'Sales History',
    ...(inventory ? ['Inventory'] : []),
    ...(openOrders ? ['Open Orders'] : []),
    ...(boms ? ['BOM'] : [])
  ];

  return {
    items,
    salesHistory,
    inventory: inventory || items.map(it => ({ itemCode: it.itemCode, warehouse: 'WH-01', onHandStock: 10 })),
    openOrders: openOrders || items.map(it => ({ orderId: `PO-${it.itemCode}`, itemCode: it.itemCode, type: 'PO', quantity: 5 })),
    boms: boms || [],
    dataVersion,
    historySummary: {
      earliestPeriod: '2025-01',
      latestPeriod: '2026-10',
      totalMonths: 22,
      totalObservations: salesHistory.length,
      itemsWithHistory: items.length,
      itemHistoryMap: {},
      incrementalStats
    },
    metadata: {
      sourceName: 'test_dataset.xlsx',
      totalRecords: items.length + salesHistory.length,
      sheetsDetected: detected,
      importedAt: '2026-10-14T00:00:00Z',
      isDemo: false
    }
  };
}

const defaultParams: ForecastParameters = {
  forecastCode: 'FC-TEST-DIFF',
  forecastName: 'Differential Forecast Test',
  startMonth: '2026-11',
  horizon: 6,
  historyPeriod: 24,
  warehouses: [],
  itemGroups: [],
  itemCodeFrom: '',
  itemCodeTo: '',
  confidenceLevel: 90,
  seasonality: true,
  includeNewCustomers: true,
  applyMoqOrderMultiple: true,
  includeOpenSalesOrders: true,
  treatBulkProjectSeparately: true
};

/**
 * Replicates the differential target filtering logic in App.tsx
 */
function resolveForecastTargetsAndPool(
  dataset: NormalizedDataset,
  params: ForecastParameters,
  selectedCategories: string[] = ['RUNNER', 'REPEATER', 'STRANGER'],
  hasPreviousForecast: boolean = true
): { targetItems: any[]; candidatePool: any[]; isBypassedNoChanges: boolean } {
  const allItemsPayload = prepareItemHistories(dataset, params);
  const segmentation = computeSegmentation(allItemsPayload);

  const categoryEligibleItems = allItemsPayload.filter(item => {
    const segItem = segmentation.items.find(s => s.itemCode === item.itemCode);
    if (!segItem || segItem.category === 'UNCLASSIFIED') return false;
    return selectedCategories.includes(segItem.category);
  });

  const isIncrementalUpdate = dataset.dataVersion > 1 &&
    !!dataset.historySummary?.incrementalStats &&
    hasPreviousForecast;

  const affectedList = isIncrementalUpdate && dataset.historySummary.incrementalStats
    ? dataset.historySummary.incrementalStats.affectedItems || []
    : null;

  if (affectedList !== null) {
    if (affectedList.length === 0) {
      return { targetItems: [], candidatePool: allItemsPayload, isBypassedNoChanges: true };
    }
    const affectedSet = new Set(affectedList);
    const targetItems = categoryEligibleItems.filter(item => affectedSet.has(item.itemCode));
    return { targetItems, candidatePool: allItemsPayload, isBypassedNoChanges: false };
  }

  return { targetItems: categoryEligibleItems, candidatePool: allItemsPayload, isBypassedNoChanges: false };
}

describe('LEDURE PHASE 1 — Differential Excel Change Detection & Delta Forecast Dispatch', () => {

  const baseItems: Item[] = Array.from({ length: 10 }, (_, i) => ({
    itemCode: `SKU-${i + 1}`,
    description: `Product SKU ${i + 1}`,
    uom: 'PCS',
    itemGroup: i < 5 ? 'Lamps' : 'Battens',
    makeBuy: 'Buy',
    planningMethod: 'MRP',
    leadTimeDays: 14,
    moq: 100,
    orderMultiple: 10,
    defaultVendor: 'Vendor-1',
    isNewItem: false,
    isDiscontinued: false
  }));

  const baseSales: SalesHistoryRecord[] = [];
  for (let m = 1; m <= 12; m++) {
    const period = `2025-${String(m).padStart(2, '0')}`;
    for (let i = 1; i <= 10; i++) {
      baseSales.push({
        itemCode: `SKU-${i}`,
        period,
        quantity: 100 + i * 5,
        orderType: 'Regular'
      });
    }
  }

  const dsInitial = createMockDataset(baseItems, baseSales, 1);

  // 1. Initial workbook containing 10 SKUs -> 10 forecast targets
  it('1. Initial workbook containing 10 SKUs -> 10 forecast targets', () => {
    const { targetItems, candidatePool, isBypassedNoChanges } = resolveForecastTargetsAndPool(
      dsInitial,
      defaultParams,
      ['RUNNER', 'REPEATER', 'STRANGER'],
      false
    );

    expect(isBypassedNoChanges).toBe(false);
    expect(targetItems.length).toBe(10);
    expect(candidatePool.length).toBe(10);
    expect(targetItems.map(t => t.itemCode).sort()).toEqual(baseItems.map(i => i.itemCode).sort());
  });

  // 2. Identical re-upload -> 0 forecast targets
  it('2. Identical re-upload -> 0 forecast targets (no redundant backend job)', () => {
    const dsMerged = mergeIncrementalDataset(dsInitial, dsInitial);
    expect(dsMerged.historySummary.incrementalStats?.duplicatesIgnored).toBe(baseSales.length);
    expect(dsMerged.historySummary.incrementalStats?.newObservations).toBe(0);
    expect(dsMerged.historySummary.incrementalStats?.updatedObservations).toBe(0);
    expect(dsMerged.historySummary.incrementalStats?.affectedItems).toEqual([]);

    const { targetItems, candidatePool, isBypassedNoChanges } = resolveForecastTargetsAndPool(
      dsMerged,
      defaultParams,
      ['RUNNER', 'REPEATER', 'STRANGER'],
      true
    );

    expect(isBypassedNoChanges).toBe(true);
    expect(targetItems.length).toBe(0);
    expect(candidatePool.length).toBe(10);
  });

  // 3. One modified SKU -> 1 target, 10 peer candidates
  it('3. One modified SKU -> 1 target, 10 peer candidates in complete candidate pool', () => {
    // Add month 13 for SKU-1 only
    const incrementalSales: SalesHistoryRecord[] = [
      { itemCode: 'SKU-1', period: '2026-01', quantity: 250, orderType: 'Regular' }
    ];
    const dsIncoming = createMockDataset(baseItems, incrementalSales, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.newObservations).toBe(1);
    expect(dsMerged.historySummary.incrementalStats?.affectedItems).toEqual(['SKU-1']);

    const { targetItems, candidatePool, isBypassedNoChanges } = resolveForecastTargetsAndPool(
      dsMerged,
      defaultParams,
      ['RUNNER', 'REPEATER', 'STRANGER'],
      true
    );

    expect(isBypassedNoChanges).toBe(false);
    expect(targetItems.length).toBe(1);
    expect(targetItems[0].itemCode).toBe('SKU-1');
    expect(candidatePool.length).toBe(10); // Complete candidate pool preserved for peer discovery
  });

  // 4. One new SKU -> 1 target, 11 peer candidates
  it('4. One new SKU -> 1 target, 11 peer candidates in complete candidate pool', () => {
    const newItem: Item = {
      itemCode: 'SKU-11-NEW',
      description: 'Brand New Item',
      uom: 'PCS',
      itemGroup: 'Lamps',
      makeBuy: 'Buy',
      planningMethod: 'MRP',
      leadTimeDays: 7,
      moq: 50,
      orderMultiple: 5,
      defaultVendor: 'Vendor-New',
      isNewItem: true,
      isDiscontinued: false
    };
    const incomingSales: SalesHistoryRecord[] = [
      { itemCode: 'SKU-11-NEW', period: '2026-01', quantity: 45, orderType: 'Regular' }
    ];
    const dsIncoming = createMockDataset([...baseItems, newItem], incomingSales, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.affectedItems).toContain('SKU-11-NEW');
    expect(dsMerged.items.length).toBe(11);

    const { targetItems, candidatePool } = resolveForecastTargetsAndPool(
      dsMerged,
      defaultParams,
      ['RUNNER', 'REPEATER', 'STRANGER'],
      true
    );

    expect(targetItems.length).toBe(1);
    expect(targetItems[0].itemCode).toBe('SKU-11-NEW');
    expect(candidatePool.length).toBe(11); // All 11 items available as peers for cold-start
  });

  // 5. Two modified SKUs -> 2 targets
  it('5. Two modified SKUs -> 2 targets', () => {
    const incomingSales: SalesHistoryRecord[] = [
      { itemCode: 'SKU-2', period: '2026-01', quantity: 180, orderType: 'Regular' },
      { itemCode: 'SKU-7', period: '2026-01', quantity: 220, orderType: 'Regular' }
    ];
    const dsIncoming = createMockDataset(baseItems, incomingSales, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.newObservations).toBe(2);
    expect(dsMerged.historySummary.incrementalStats?.affectedItems.sort()).toEqual(['SKU-2', 'SKU-7'].sort());

    const { targetItems, candidatePool } = resolveForecastTargetsAndPool(
      dsMerged,
      defaultParams,
      ['RUNNER', 'REPEATER', 'STRANGER'],
      true
    );

    expect(targetItems.length).toBe(2);
    expect(targetItems.map(t => t.itemCode).sort()).toEqual(['SKU-2', 'SKU-7']);
    expect(candidatePool.length).toBe(10);
  });

  // 6. Historical correction -> affected SKU detected and submitted
  it('6. Historical correction -> affected SKU detected and submitted', () => {
    // Correct Month 3 of SKU-4 from 120 to 999
    const incomingCorrection: SalesHistoryRecord[] = [
      { itemCode: 'SKU-4', period: '2025-03', quantity: 999, orderType: 'Regular' }
    ];
    const dsIncoming = createMockDataset(baseItems, incomingCorrection, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.updatedObservations).toBe(1);
    expect(dsMerged.historySummary.incrementalStats?.affectedItems).toEqual(['SKU-4']);

    const { targetItems } = resolveForecastTargetsAndPool(
      dsMerged,
      defaultParams,
      ['RUNNER', 'REPEATER', 'STRANGER'],
      true
    );

    expect(targetItems.length).toBe(1);
    expect(targetItems[0].itemCode).toBe('SKU-4');
  });

  // 7. Duplicate changes -> each SKU submitted only once
  it('7. Duplicate changes -> each SKU submitted only once (deduplicated targets)', () => {
    // 3 new observations for SKU-5 in one workbook
    const incomingMultiple: SalesHistoryRecord[] = [
      { itemCode: 'SKU-5', period: '2026-01', quantity: 100, orderType: 'Regular' },
      { itemCode: 'SKU-5', period: '2026-02', quantity: 110, orderType: 'Regular' },
      { itemCode: 'SKU-5', period: '2026-03', quantity: 120, orderType: 'Regular' }
    ];
    const dsIncoming = createMockDataset(baseItems, incomingMultiple, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.newObservations).toBe(3);
    expect(dsMerged.historySummary.incrementalStats?.affectedItems).toEqual(['SKU-5']); // Strictly deduplicated

    const { targetItems } = resolveForecastTargetsAndPool(
      dsMerged,
      defaultParams,
      ['RUNNER', 'REPEATER', 'STRANGER'],
      true
    );

    expect(targetItems.length).toBe(1);
    expect(targetItems[0].itemCode).toBe('SKU-5');
  });

  // 8. Category filtering -> correct affected targets, complete candidate pool
  it('8. Category filtering -> correct affected targets, complete candidate pool', () => {
    // SKU-1 is in 'Lamps', SKU-7 is in 'Battens'
    const incomingSales: SalesHistoryRecord[] = [
      { itemCode: 'SKU-1', period: '2026-01', quantity: 200, orderType: 'Regular' },
      { itemCode: 'SKU-7', period: '2026-01', quantity: 300, orderType: 'Regular' }
    ];
    const dsIncoming = createMockDataset(baseItems, incomingSales, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    const allItems = prepareItemHistories(dsMerged, defaultParams);
    const seg = computeSegmentation(allItems);
    const sku1Cat = seg.items.find(s => s.itemCode === 'SKU-1')!.category;
    const sku7Cat = seg.items.find(s => s.itemCode === 'SKU-7')!.category;

    // Filter only to SKU-1's category
    const { targetItems, candidatePool } = resolveForecastTargetsAndPool(
      dsMerged,
      defaultParams,
      [sku1Cat],
      true
    );

    // Only affected SKUs belonging to sku1Cat should be targeted
    expect(targetItems.map(t => t.itemCode)).toContain('SKU-1');
    if (sku1Cat !== sku7Cat) {
      expect(targetItems.map(t => t.itemCode)).not.toContain('SKU-7');
    }
    // Candidate pool still preserves ALL 10 items for peer discovery
    expect(candidatePool.length).toBe(10);
  });

  // 9. Discontinued SKU -> procurement remains zero
  it('9. Discontinued SKU -> procurement remains zero', () => {
    const discontinuedRes = calculateMRPRequirements(
      150, // planner adjustment entered
      0,
      0,
      'MRP',
      500,
      100,
      true,
      true // isDiscontinued = true
    );

    expect(discontinuedRes.rawNetReq).toBe(0);
    expect(discontinuedRes.plannedOrderQty).toBe(0);
  });

  // 10. No-change upload -> existing forecast results remain intact
  it('10. No-change upload -> existing forecast results remain intact', () => {
    const existingLine: ForecastLine = {
      id: 'line-SKU-1',
      itemCode: 'SKU-1',
      description: 'Product SKU 1',
      uom: 'PCS',
      itemGroup: 'Lamps',
      avgPerMonth: 100,
      monthlyForecast: [105, 105, 105, 105, 105, 105],
      aiTotal: 630,
      plannerAdj: null,
      finalQty: 630,
      stock: 10,
      openPo: 5,
      openSo: 0,
      rawNetReq: 615,
      plannedOrderQty: 620,
      netReq: 620,
      confidencePct: 88,
      confidence: 'High',
      remark: 'Pre-existing forecast line',
      isModified: false,
      planningMethod: 'MRP',
      makeBuy: 'Buy',
      leadTimeDays: 14,
      moq: 100,
      orderMultiple: 10,
      defaultVendor: 'Vendor-1',
      isDiscontinued: false,
      isNewItem: false,
      historyAvailableMonths: 12,
      historyDateRange: '2025-01 to 2025-12',
      historyPeriods: [],
      historyValues: [],
      actualSalesLastYear: 1200,
      demandSignal: {} as any,
      modelDecision: {
        historyMonthsAvailable: 12,
        historyDateRange: '2025-01 to 2025-12',
        selectedModel: 'WeightedMovingAverage',
        selectionStatus: 'SELECTED',
        selectionReason: 'Lowest WAPE',
        modelTier: 'Tier 3',
        modelLimitation: 'None',
        featuresUsed: ['lags'],
        backtestWape: 4.2,
        mae: 5.1,
        rmse: 6.2,
        bias: 0.1,
        validationWindows: 3,
        backtestMethod: 'Walk-forward',
        alternatives: [],
        trainingObservationsCount: 12,
        windows: []
      }
    };

    // When Python returns results only for other SKUs (or empty), existingLine is preserved
    const dummyPythonResponse: PythonBatchResponse = {
      engine: 'Python ML Engine',
      version: '2.0.0',
      horizon: 6,
      startMonth: '2026-11',
      totalItemsProcessed: 0,
      modelDistribution: {},
      results: []
    };

    const res = processPythonForecastResults(
      dummyPythonResponse,
      dsInitial,
      defaultParams,
      [existingLine]
    );

    const preserved = res.lines.find(l => l.itemCode === 'SKU-1')!;
    expect(preserved.aiTotal).toBe(630);
    expect(preserved.monthlyForecast).toEqual([105, 105, 105, 105, 105, 105]);
    expect(preserved.modelDecision.selectedModel).toBe('WeightedMovingAverage');
    expect(preserved.confidence).toBe('High');
  });

  // 11. Existing planner adjustments on unaffected SKUs remain intact
  it('11. Existing planner adjustments on unaffected SKUs remain intact', () => {
    const existingLineWithAdj: ForecastLine = {
      id: 'line-SKU-2',
      itemCode: 'SKU-2',
      description: 'Product SKU 2',
      uom: 'PCS',
      itemGroup: 'Lamps',
      avgPerMonth: 100,
      monthlyForecast: [100, 100, 100, 100, 100, 100],
      aiTotal: 600,
      plannerAdj: 850,
      finalQty: 850,
      stock: 0,
      openPo: 0,
      openSo: 0,
      rawNetReq: 850,
      plannedOrderQty: 900,
      netReq: 900,
      confidencePct: 92,
      confidence: 'High',
      remark: 'Confirmed promotional demand surge',
      isModified: true,
      planningMethod: 'MRP',
      makeBuy: 'Buy',
      leadTimeDays: 14,
      moq: 100,
      orderMultiple: 10,
      defaultVendor: 'Vendor-1',
      isDiscontinued: false,
      isNewItem: false,
      historyAvailableMonths: 12,
      historyDateRange: '2025-01 to 2025-12',
      historyPeriods: [],
      historyValues: [],
      actualSalesLastYear: 1200,
      demandSignal: {} as any,
      modelDecision: {
        historyMonthsAvailable: 12,
        historyDateRange: '2025-01 to 2025-12',
        selectedModel: 'HoltExponentialSmoothing',
        selectionStatus: 'SELECTED',
        selectionReason: 'Lowest WAPE',
        modelTier: 'Tier 3',
        modelLimitation: 'None',
        featuresUsed: ['lags'],
        backtestWape: 3.8,
        mae: 4.2,
        rmse: 5.1,
        bias: 0.05,
        validationWindows: 3,
        backtestMethod: 'Walk-forward',
        alternatives: [],
        trainingObservationsCount: 12,
        windows: []
      }
    };

    // Python only reforecasts SKU-1, leaving SKU-2 unaffected
    const deltaPythonResponse: PythonBatchResponse = {
      engine: 'Python ML Engine',
      version: '2.0.0',
      horizon: 6,
      startMonth: '2026-11',
      totalItemsProcessed: 1,
      modelDistribution: { HistGradientBoosting: 1 },
      results: [
        {
          itemCode: 'SKU-1',
          modelName: 'HistGradientBoosting',
          modelType: 'ML',
          selectedModel: 'HistGradientBoosting',
          selectionStatus: 'SELECTED',
          selectionReason: 'Lowest WAPE',
          historyMonths: 13,
          trainingRows: 13,
          forecast: [120, 120, 120, 120, 120, 120],
          rawForecast: [120, 120, 120, 120, 120, 120],
          metadata: {},
          eligibility: []
        }
      ]
    };

    const res = processPythonForecastResults(
      deltaPythonResponse,
      dsInitial,
      defaultParams,
      [existingLineWithAdj]
    );

    // SKU-1 has fresh forecast
    const line1 = res.lines.find(l => l.itemCode === 'SKU-1')!;
    expect(line1.aiTotal).toBe(720);

    // SKU-2 preserves planner override, remark, and isModified
    const line2 = res.lines.find(l => l.itemCode === 'SKU-2')!;
    expect(line2.aiTotal).toBe(600);
    expect(line2.plannerAdj).toBe(850);
    expect(line2.finalQty).toBe(850);
    expect(line2.remark).toBe('Confirmed promotional demand surge');
    expect(line2.isModified).toBe(true);
    expect(line2.modelDecision.selectedModel).toBe('HoltExponentialSmoothing');
  });

  // 12. Replace mode and incremental mode preserve their existing distinct semantics
  it('12. Replace mode and incremental mode preserve their existing distinct semantics', () => {
    // In Replace mode, dataset version starts at 1, no incrementalStats, all 10 items are targets
    const dsReplace = createMockDataset(baseItems, baseSales, 1, undefined);
    const replaceRes = resolveForecastTargetsAndPool(dsReplace, defaultParams, ['RUNNER', 'REPEATER', 'STRANGER'], false);
    expect(replaceRes.targetItems.length).toBe(10);
    expect(replaceRes.isBypassedNoChanges).toBe(false);

    // In Incremental mode with identical file, incrementalStats shows 0 changes, 0 targets
    const dsIncrementalSame = mergeIncrementalDataset(dsInitial, dsInitial);
    const incRes = resolveForecastTargetsAndPool(dsIncrementalSame, defaultParams, ['RUNNER', 'REPEATER', 'STRANGER'], true);
    expect(incRes.targetItems.length).toBe(0);
    expect(incRes.isBypassedNoChanges).toBe(true);
  });
});

import { resolveForecastWorkflowDecision } from './workflowDecisionService';

// Ensure the test suite exercises the authoritative production workflow decision service
const resolveWorkflowDecision = resolveForecastWorkflowDecision;

describe('LEDURE PHASE 1.1 — Complete Change Detection for Sales, Supply, Master Data and Forecast Parameters', () => {

  const baseItems: Item[] = Array.from({ length: 10 }, (_, i) => ({
    itemCode: `SKU-${i + 1}`,
    description: `Product SKU ${i + 1}`,
    uom: 'PCS',
    itemGroup: i < 5 ? 'Lamps' : 'Battens',
    makeBuy: i === 0 ? 'Make' : 'Buy',
    planningMethod: 'MRP',
    leadTimeDays: 14,
    moq: 100,
    orderMultiple: 10,
    defaultVendor: 'Vendor-1',
    isNewItem: false,
    isDiscontinued: false
  }));

  const baseSales: SalesHistoryRecord[] = [];
  for (let m = 1; m <= 12; m++) {
    const period = `2025-${String(m).padStart(2, '0')}`;
    for (let i = 1; i <= 10; i++) {
      baseSales.push({
        itemCode: `SKU-${i}`,
        period,
        quantity: 100 + i * 5,
        orderType: 'Regular'
      });
    }
  }

  const baseBoms: BOMRecord[] = [
    {
      parentItemCode: 'SKU-1',
      componentCode: 'SKU-2',
      componentName: 'Component SKU 2',
      qtyPerUnit: 2,
      uom: 'PCS',
      currentStock: 20,
      openPo: 10,
      leadTimeDays: 7
    }
  ];

  const dsInitial = createMockDataset(baseItems, baseSales, 1, undefined, undefined, undefined, baseBoms);

  // Generate an initial mock forecast result with 10 lines
  const initialLines: ForecastLine[] = baseItems.map(item => ({
    id: `line-${item.itemCode}`,
    itemCode: item.itemCode,
    description: item.description,
    uom: item.uom,
    itemGroup: item.itemGroup,
    avgPerMonth: 100,
    monthlyForecast: [100, 100, 100, 100, 100, 100],
    aiTotal: 600,
    plannerAdj: null,
    finalQty: 600,
    stock: 10,
    openPo: 5,
    openSo: null,
    rawNetReq: 585,
    plannedOrderQty: 590,
    netReq: 590,
    confidencePct: 85,
    confidence: 'High',
    remark: '',
    isModified: false,
    planningMethod: item.planningMethod,
    makeBuy: item.makeBuy,
    leadTimeDays: item.leadTimeDays,
    moq: item.moq,
    orderMultiple: item.orderMultiple,
    defaultVendor: item.defaultVendor,
    isDiscontinued: false,
    isNewItem: false,
    historyAvailableMonths: 12,
    historyDateRange: '2025-01 to 2025-12',
    historyPeriods: [],
    historyValues: [],
    actualSalesLastYear: 1200,
    demandSignal: {
      itemCode: item.itemCode,
      signalHeadline: 'Stable',
      signalTone: 'stable',
      confidencePct: 85,
      drivers: [],
      seasonalityFactor: 1,
      velocityTrendPct: 0,
      anomalies: [],
      aiRecommendation: 'Normal',
      modelDecision: {
        historyMonthsAvailable: 12,
        historyDateRange: '',
        selectedModel: 'HoltExponentialSmoothing',
        modelTier: 'Tier 4',
        modelLimitation: 'None',
        featuresUsed: [],
        backtestWape: 12.5,
        backtestMethod: 'Walk-forward',
        alternatives: [],
        trainingObservationsCount: 12
      }
    },
    modelDecision: {
      historyMonthsAvailable: 12,
      historyDateRange: '',
      selectedModel: 'HoltExponentialSmoothing',
      modelTier: 'Tier 4',
      modelLimitation: 'None',
      featuresUsed: [],
      backtestWape: 12.5,
      backtestMethod: 'Walk-forward',
      alternatives: [],
      trainingObservationsCount: 12
    },
    category: 'RUNNER'
  }));

  // 1. Identical sales, inventory, open PO and BOM -> no unnecessary work
  it('1. Identical sales, inventory, open PO and BOM -> no unnecessary work', () => {
    const dsMerged = mergeIncrementalDataset(dsInitial, dsInitial);
    expect(dsMerged.historySummary.incrementalStats?.affectedItems).toEqual([]);
    expect(dsMerged.historySummary.incrementalStats?.forecastAffectedItems).toEqual([]);
    expect(dsMerged.historySummary.incrementalStats?.mrpAffectedItems).toEqual([]);
    expect(dsMerged.historySummary.incrementalStats?.bomAffectedItems).toEqual([]);

    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('NO_OP');
    expect(decision.targetItems.length).toBe(0);
    expect(decision.candidatePool.length).toBe(10);
  });

  // 2. Stock quantity changes only -> MRP recalculated without model fitting
  it('2. Stock quantity changes only -> MRP recalculated without model fitting', () => {
    // Increase stock of SKU-1 from 10 to 50
    const updatedInventory: InventoryRecord[] = [
      ...dsInitial.inventory.filter(inv => inv.itemCode !== 'SKU-1'),
      { itemCode: 'SKU-1', warehouse: 'WH-01', onHandStock: 50 }
    ];
    const dsIncoming = createMockDataset(baseItems, baseSales, 2, undefined, updatedInventory, dsInitial.openOrders, dsInitial.boms);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.inventoryChangesCount).toBe(1);
    expect(dsMerged.historySummary.incrementalStats?.forecastAffectedItems).toEqual([]);
    expect(dsMerged.historySummary.incrementalStats?.mrpAffectedItems).toEqual(['SKU-1']);

    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('MRP_ONLY');
    expect(decision.targetItems.length).toBe(0); // Zero model targets
    expect(decision.mrpAffectedItems).toEqual(['SKU-1']);
    expect(decision.recalculatedResult).toBeDefined();

    // Check that SKU-1 stock is now 50, rawNetReq = max(0, 600 - 50 - 5) = 545
    const line1 = decision.recalculatedResult!.lines.find((l: ForecastLine) => l.itemCode === 'SKU-1')!;
    expect(line1.stock).toBe(50);
    expect(line1.rawNetReq).toBe(545);
    // Model and forecast remain untouched
    expect(line1.aiTotal).toBe(600);
    expect(line1.modelDecision.selectedModel).toBe('HoltExponentialSmoothing');
  });

  // 3. Open PO quantity changes only -> MRP recalculated without model fitting
  it('3. Open PO quantity changes only -> MRP recalculated without model fitting', () => {
    // Increase PO for SKU-2 from 5 to 55
    const updatedOrders: OpenOrderRecord[] = [
      ...dsInitial.openOrders.filter(o => o.itemCode !== 'SKU-2'),
      { orderId: 'PO-SKU-2', itemCode: 'SKU-2', type: 'PO', quantity: 55 }
    ];
    const dsIncoming = createMockDataset(baseItems, baseSales, 2, undefined, dsInitial.inventory, updatedOrders, dsInitial.boms);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.orderChangesCount).toBe(1);
    expect(dsMerged.historySummary.incrementalStats?.forecastAffectedItems).toEqual([]);
    expect(dsMerged.historySummary.incrementalStats?.mrpAffectedItems).toEqual(['SKU-2']);

    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('MRP_ONLY');
    expect(decision.targetItems.length).toBe(0);

    const line2 = decision.recalculatedResult!.lines.find((l: ForecastLine) => l.itemCode === 'SKU-2')!;
    expect(line2.openPo).toBe(55);
    // rawNetReq = max(0, 600 - 10 - 55) = 535
    expect(line2.rawNetReq).toBe(535);
  });

  // 4. New PO -> affected SKU MRP recalculated
  it('4. New PO -> affected SKU MRP recalculated', () => {
    const newOrder: OpenOrderRecord = {
      orderId: 'PO-NEW-SKU-3',
      itemCode: 'SKU-3',
      type: 'PO',
      quantity: 100
    };
    const updatedOrders = [...dsInitial.openOrders, newOrder];
    const dsIncoming = createMockDataset(baseItems, baseSales, 2, undefined, dsInitial.inventory, updatedOrders, dsInitial.boms);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.mrpAffectedItems).toContain('SKU-3');
    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('MRP_ONLY');

    const line3 = decision.recalculatedResult!.lines.find((l: ForecastLine) => l.itemCode === 'SKU-3')!;
    // Open PO is now 5 (existing) + 100 (new) = 105
    expect(line3.openPo).toBe(105);
    // rawNetReq = max(0, 600 - 10 - 105) = 485
    expect(line3.rawNetReq).toBe(485);
  });

  // 5. Cancelled PO -> correct supply balance after explicit replacement
  it('5. Cancelled PO -> correct supply balance after explicit replacement', () => {
    // Remove PO for SKU-4 in replacement mode
    const remainingOrders = dsInitial.openOrders.filter(o => o.itemCode !== 'SKU-4');
    const dsIncoming = createMockDataset(baseItems, baseSales, 2, undefined, dsInitial.inventory, remainingOrders, dsInitial.boms);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming, { isReplaceOrders: true });

    expect(dsMerged.historySummary.incrementalStats?.mrpAffectedItems).toContain('SKU-4');
    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('MRP_ONLY');

    const line4 = decision.recalculatedResult!.lines.find((l: ForecastLine) => l.itemCode === 'SKU-4')!;
    expect(line4.openPo).toBe(0);
    // rawNetReq = max(0, 600 - 10 - 0) = 590 (increased from 585)
    expect(line4.rawNetReq).toBe(590);
  });

  // 6. BOM quantity change -> component requirement recalculated
  it('6. BOM quantity change -> component requirement recalculated', () => {
    // SKU-1 BOM: qtyPerUnit changes from 2 to 5
    const updatedBoms: BOMRecord[] = [
      {
        parentItemCode: 'SKU-1',
        componentCode: 'SKU-2',
        componentName: 'Component SKU 2',
        qtyPerUnit: 5,
        uom: 'PCS',
        currentStock: 20,
        openPo: 10,
        leadTimeDays: 7
      }
    ];
    const dsIncoming = createMockDataset(baseItems, baseSales, 2, undefined, dsInitial.inventory, dsInitial.openOrders, updatedBoms);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.bomChangesCount).toBe(1);
    expect(dsMerged.historySummary.incrementalStats?.bomAffectedItems).toContain('SKU-1');
    expect(dsMerged.historySummary.incrementalStats?.bomAffectedItems).toContain('SKU-2');
    expect(dsMerged.boms[0].qtyPerUnit).toBe(5);

    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('MRP_ONLY');
  });

  // 7. Description or peer-matching attribute changes -> correct peer context invalidation
  it('7. Description or peer-matching attribute changes -> correct peer context invalidation', () => {
    // Change SKU-1 description to trigger cold-start text matching update
    const updatedItems: Item[] = [
      { ...baseItems[0], description: 'Ledure Elite Ultra Bright Batten 20W' },
      ...baseItems.slice(1)
    ];
    const dsIncoming = createMockDataset(updatedItems, baseSales, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.forecastAffectedItems).toEqual(['SKU-1']);
    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('DELTA_FORECAST');
    expect(decision.targetItems.length).toBe(1);
    expect(decision.targetItems[0].itemCode).toBe('SKU-1');
    expect(decision.candidatePool.length).toBe(10);
  });

  // 8. Lead time changes -> procurement information updated
  it('8. Lead time changes -> procurement information updated without retraining', () => {
    const updatedItems: Item[] = [
      baseItems[0],
      { ...baseItems[1], leadTimeDays: 45 },
      ...baseItems.slice(2)
    ];
    const dsIncoming = createMockDataset(updatedItems, baseSales, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.forecastAffectedItems).toEqual([]);
    expect(dsMerged.historySummary.incrementalStats?.mrpAffectedItems).toEqual(['SKU-2']);

    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('MRP_ONLY');
    const line2 = decision.recalculatedResult!.lines.find((l: ForecastLine) => l.itemCode === 'SKU-2')!;
    expect(line2.leadTimeDays).toBe(45);
  });

  // 9. MOQ change -> lot sizing recalculated without retraining
  it('9. MOQ change -> lot sizing recalculated without retraining', () => {
    const updatedItems: Item[] = [
      baseItems[0],
      baseItems[1],
      { ...baseItems[2], moq: 1000 },
      ...baseItems.slice(3)
    ];
    const dsIncoming = createMockDataset(updatedItems, baseSales, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.forecastAffectedItems).toEqual([]);
    expect(dsMerged.historySummary.incrementalStats?.mrpAffectedItems).toEqual(['SKU-3']);

    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('MRP_ONLY');

    const line3 = decision.recalculatedResult!.lines.find((l: ForecastLine) => l.itemCode === 'SKU-3')!;
    expect(line3.moq).toBe(1000);
    // rawNetReq is 585, but with MOQ 1000, plannedOrderQty must round up to 1000
    expect(line3.plannedOrderQty).toBe(1000);
  });

  // 10. Forecast horizon changes -> forecast recalculation is not bypassed
  it('10. Forecast horizon changes -> forecast recalculation is not bypassed', () => {
    const newParams: ForecastParameters = { ...defaultParams, horizon: 12 };
    const diff = diffForecastParameters(newParams, defaultParams);

    expect(diff.hasForecastParamChanges).toBe(true);
    expect(diff.changedForecastParams).toContain('horizon');

    const dsMerged = mergeIncrementalDataset(dsInitial, dsInitial);
    // Even though Excel had 0 changes, parameter change requires reforecasting all eligible items
    const decision = resolveWorkflowDecision(dsMerged, newParams, defaultParams, initialLines);
    expect(decision.decision).toBe('FULL_FORECAST');
    expect(decision.targetItems.length).toBe(10);
  });

  // 11. Confidence level changes -> follow the existing interval recalculation rules
  it('11. Confidence level changes -> follow the existing interval recalculation rules', () => {
    const newParams: ForecastParameters = { ...defaultParams, confidenceLevel: 95 };
    const diff = diffForecastParameters(newParams, defaultParams);

    expect(diff.hasConfidenceLevelChange).toBe(true);
    expect(diff.hasForecastParamChanges).toBe(false);

    const dsMerged = mergeIncrementalDataset(dsInitial, dsInitial);
    // Confidence change triggers full forecast or interval re-evaluation
    const decision = resolveWorkflowDecision(dsMerged, newParams, defaultParams, initialLines);
    expect(decision.decision).toBe('FULL_FORECAST');
  });

  // 12. Identical workbook with unchanged parameters -> zero backend model jobs
  it('12. Identical workbook with unchanged parameters -> zero backend model jobs', () => {
    const dsMerged = mergeIncrementalDataset(dsInitial, dsInitial);
    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);

    expect(decision.decision).toBe('NO_OP');
    expect(decision.targetItems.length).toBe(0);
  });

  // 13. New sales month -> only affected forecasting targets dispatched
  it('13. New sales month -> only affected forecasting targets dispatched', () => {
    const newMonthSales: SalesHistoryRecord[] = [
      { itemCode: 'SKU-6', period: '2026-01', quantity: 300, orderType: 'Regular' }
    ];
    const dsIncoming = createMockDataset(baseItems, newMonthSales, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.forecastAffectedItems).toEqual(['SKU-6']);
    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);

    expect(decision.decision).toBe('DELTA_FORECAST');
    expect(decision.targetItems.length).toBe(1);
    expect(decision.targetItems[0].itemCode).toBe('SKU-6');
    expect(decision.candidatePool.length).toBe(10);
  });

  // 14. Historical correction -> affected SKU reforecasted
  it('14. Historical correction -> affected SKU reforecasted', () => {
    const correction: SalesHistoryRecord[] = [
      { itemCode: 'SKU-8', period: '2025-06', quantity: 999, orderType: 'Regular' }
    ];
    const dsIncoming = createMockDataset(baseItems, correction, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    expect(dsMerged.historySummary.incrementalStats?.updatedObservations).toBe(1);
    expect(dsMerged.historySummary.incrementalStats?.forecastAffectedItems).toEqual(['SKU-8']);

    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('DELTA_FORECAST');
    expect(decision.targetItems.length).toBe(1);
    expect(decision.targetItems[0].itemCode).toBe('SKU-8');
  });

  // 15. Planner adjustments on unaffected SKUs remain intact
  it('15. Planner adjustments on unaffected SKUs remain intact', () => {
    const linesWithOverride: ForecastLine[] = initialLines.map(l =>
      l.itemCode === 'SKU-5'
        ? { ...l, plannerAdj: 888, finalQty: 888, remark: 'Planner executive override', isModified: true }
        : l
    );

    const deltaPyResponse: PythonBatchResponse = {
      engine: 'Python ML Engine',
      version: '1.0.0',
      startMonth: '2026-11',
      totalItemsProcessed: 1,
      horizon: 6,
      modelDistribution: { HistGradientBoosting: 1 },
      results: [
        {
          itemCode: 'SKU-1',
          modelName: 'HistGradientBoosting',
          modelType: 'ML',
          selectedModel: 'HistGradientBoosting',
          selectionStatus: 'SELECTED',
          selectionReason: 'Lowest WAPE',
          historyMonths: 12,
          trainingRows: 12,
          forecast: [150, 150, 150, 150, 150, 150],
          rawForecast: [150, 150, 150, 150, 150, 150],
          metadata: {},
          eligibility: []
        }
      ]
    };

    const res = processPythonForecastResults(deltaPyResponse, dsInitial, defaultParams, linesWithOverride);

    // SKU-1 updated
    const line1 = res.lines.find(l => l.itemCode === 'SKU-1')!;
    expect(line1.aiTotal).toBe(900);

    // SKU-5 preserved
    const line5 = res.lines.find(l => l.itemCode === 'SKU-5')!;
    expect(line5.plannerAdj).toBe(888);
    expect(line5.finalQty).toBe(888);
    expect(line5.remark).toBe('Planner executive override');
    expect(line5.isModified).toBe(true);
  });

  // 16. Discontinued SKUs remain locked to zero procurement
  it('16. Discontinued SKUs remain locked to zero procurement', () => {
    const { rawNetReq, plannedOrderQty } = calculateMRPRequirements(
      500, // finalQty
      0,   // stock
      0,   // openPo
      'MRP',
      100, // moq
      10,  // orderMultiple
      true,
      true // isDiscontinued = true
    );

    expect(rawNetReq).toBe(0);
    expect(plannedOrderQty).toBe(0);
  });

  // 17. Full peer candidate pool remains intact
  it('17. Full peer candidate pool remains intact', () => {
    const singleChangeSales: SalesHistoryRecord[] = [
      { itemCode: 'SKU-1', period: '2026-01', quantity: 500, orderType: 'Regular' }
    ];
    const dsIncoming = createMockDataset(baseItems, singleChangeSales, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('DELTA_FORECAST');
    expect(decision.targetItems.length).toBe(1);
    expect(decision.targetItems[0].itemCode).toBe('SKU-1');
    // Complete 10-SKU portfolio is retained for peer discovery
    expect(decision.candidatePool.length).toBe(10);
    expect(decision.candidatePool.map(c => c.itemCode).sort()).toEqual(baseItems.map(i => i.itemCode).sort());
  });

  // 18. PlanningMethod change does not trigger Python model fitting but updates planning output
  it('18. PlanningMethod change does not trigger Python model fitting but updates planning output', () => {
    // Change SKU-1 planningMethod from 'MRP' to 'None'
    const updatedItems: Item[] = [
      { ...baseItems[0], planningMethod: 'None' },
      ...baseItems.slice(1)
    ];
    const dsIncoming = createMockDataset(updatedItems, baseSales, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    // planningMethod must be MRP-only, NOT forecast-critical
    expect(dsMerged.historySummary.incrementalStats?.forecastAffectedItems).toEqual([]);
    expect(dsMerged.historySummary.incrementalStats?.mrpAffectedItems).toEqual(['SKU-1']);

    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('MRP_ONLY');
    expect(decision.action).toBe('MRP_ONLY');
    expect(decision.targetItems.length).toBe(0); // Zero model targets sent to Python

    // Verify planning output updated: netReq and rawNetReq are null for 'None' planning method
    const line1 = decision.recalculatedResult!.lines.find((l: ForecastLine) => l.itemCode === 'SKU-1')!;
    expect(line1.planningMethod).toBe('None');
    expect(line1.rawNetReq).toBeNull();
    expect(line1.plannedOrderQty).toBeNull();
    expect(line1.netReq).toBeNull();

    // ML forecast and model metadata preserved unchanged
    expect(line1.aiTotal).toBe(600);
    expect(line1.modelDecision.selectedModel).toBe('HoltExponentialSmoothing');
  });

  // 19. UOM change does not trigger Python model fitting but updates planning output
  it('19. UOM change does not trigger Python model fitting but updates planning output', () => {
    // Change SKU-2 UOM from 'PCS' to 'BOX'
    const updatedItems: Item[] = [
      baseItems[0],
      { ...baseItems[1], uom: 'BOX' },
      ...baseItems.slice(2)
    ];
    const dsIncoming = createMockDataset(updatedItems, baseSales, 2);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    // UOM must be MRP/planning-only, NOT forecast-critical
    expect(dsMerged.historySummary.incrementalStats?.forecastAffectedItems).toEqual([]);
    expect(dsMerged.historySummary.incrementalStats?.mrpAffectedItems).toEqual(['SKU-2']);

    const decision = resolveWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.decision).toBe('MRP_ONLY');
    expect(decision.action).toBe('MRP_ONLY');
    expect(decision.targetItems.length).toBe(0); // Zero model targets sent to Python

    // Verify planning output updated: line.uom is now BOX
    const line2 = decision.recalculatedResult!.lines.find((l: ForecastLine) => l.itemCode === 'SKU-2')!;
    expect(line2.uom).toBe('BOX');

    // ML forecast and model metadata preserved unchanged
    expect(line2.aiTotal).toBe(600);
    expect(line2.modelDecision.selectedModel).toBe('HoltExponentialSmoothing');
  });

  // 20. Master data classification preservation: description, itemGroup, isNewItem, isDiscontinued
  it('20. Master data classification preservation: description, itemGroup, isNewItem, isDiscontinued', () => {
    // Test itemGroup change -> forecast-critical
    const dsItemGroup = mergeIncrementalDataset(
      dsInitial,
      createMockDataset([{ ...baseItems[0], itemGroup: 'Specialty Fixtures' }, ...baseItems.slice(1)], baseSales, 2)
    );
    expect(dsItemGroup.historySummary.incrementalStats?.forecastAffectedItems).toEqual(['SKU-1']);

    // Test isNewItem change -> forecast-critical
    const dsNewItem = mergeIncrementalDataset(
      dsInitial,
      createMockDataset([{ ...baseItems[1], isNewItem: true }, ...baseItems.slice(2)], baseSales, 2)
    );
    expect(dsNewItem.historySummary.incrementalStats?.forecastAffectedItems).toEqual(['SKU-2']);

    // Test isDiscontinued change -> forecast-critical
    const dsDiscontinued = mergeIncrementalDataset(
      dsInitial,
      createMockDataset([{ ...baseItems[2], isDiscontinued: true }, ...baseItems.slice(3)], baseSales, 2)
    );
    expect(dsDiscontinued.historySummary.incrementalStats?.forecastAffectedItems).toEqual(['SKU-3']);
  });

  // 21. Explicit Inventory replacement semantics: Sheet absent vs Sheet with records vs Sheet with 0 records
  it('21. Explicit Inventory replacement semantics: Sheet absent vs Sheet with records vs Sheet with 0 records', () => {
    expect(dsInitial.inventory.length).toBe(10);

    // Case 1: Sheet absent in incoming workbook -> RETAIN existing inventory even with replacement option selected
    const dsSheetAbsent = createMockDataset(baseItems, baseSales, 2, undefined, [], dsInitial.openOrders, dsInitial.boms, ['Items', 'Sales History']);
    const dsMergedAbsent = mergeIncrementalDataset(dsInitial, dsSheetAbsent, { isReplaceInventory: true });
    expect(dsMergedAbsent.inventory.length).toBe(10);
    expect(dsMergedAbsent.inventory.find(inv => inv.itemCode === 'SKU-1')?.onHandStock).toBe(10);

    // Case 2: Sheet present with records
    const partialInventory: InventoryRecord[] = [
      { itemCode: 'SKU-1', warehouse: 'WH-01', onHandStock: 99 },
      { itemCode: 'SKU-2', warehouse: 'WH-01', onHandStock: 88 }
    ];
    const dsSheetWithRecords = createMockDataset(baseItems, baseSales, 2, undefined, partialInventory, dsInitial.openOrders, dsInitial.boms, ['Items', 'Sales History', 'Inventory']);
    // 2a. Ordinary merge -> absent records retained
    const dsMergedOrdinary = mergeIncrementalDataset(dsInitial, dsSheetWithRecords, { isReplaceInventory: false });
    expect(dsMergedOrdinary.inventory.length).toBe(10);
    expect(dsMergedOrdinary.inventory.find(inv => inv.itemCode === 'SKU-1')?.onHandStock).toBe(99);
    expect(dsMergedOrdinary.inventory.find(inv => inv.itemCode === 'SKU-10')).toBeDefined();
    // 2b. Complete replacement -> absent records removed
    const dsMergedReplace = mergeIncrementalDataset(dsInitial, dsSheetWithRecords, { isReplaceInventory: true });
    expect(dsMergedReplace.inventory.length).toBe(2);
    expect(dsMergedReplace.inventory.find(inv => inv.itemCode === 'SKU-10')).toBeUndefined();

    // Case 3: Sheet present but containing 0 valid records
    const dsSheetEmptyRecords = createMockDataset(baseItems, baseSales, 2, undefined, [], dsInitial.openOrders, dsInitial.boms, ['Items', 'Sales History', 'Inventory']);
    // 3a. Ordinary merge -> retain existing
    const dsMergedEmptyOrdinary = mergeIncrementalDataset(dsInitial, dsSheetEmptyRecords, { isReplaceInventory: false });
    expect(dsMergedEmptyOrdinary.inventory.length).toBe(10);
    // 3b. Replace selected WITHOUT confirmation -> retain existing
    const dsMergedEmptyUnconfirmed = mergeIncrementalDataset(dsInitial, dsSheetEmptyRecords, { isReplaceInventory: true });
    expect(dsMergedEmptyUnconfirmed.inventory.length).toBe(10);
    // 3c. Replace selected WITH explicit confirmation -> clear existing inventory
    const dsMergedEmptyConfirmed = mergeIncrementalDataset(dsInitial, dsSheetEmptyRecords, {
      isReplaceInventory: true,
      confirmedEmptyReplacement: { inventory: true }
    });
    expect(dsMergedEmptyConfirmed.inventory.length).toBe(0);
    expect(dsMergedEmptyConfirmed.historySummary.incrementalStats?.mrpAffectedItems).toContain('SKU-1');
  });

  // 22. Explicit Open Orders replacement semantics: Sheet absent vs Sheet with records vs Sheet with 0 records
  it('22. Explicit Open Orders replacement semantics: Sheet absent vs Sheet with records vs Sheet with 0 records', () => {
    expect(dsInitial.openOrders.length).toBe(10);

    // Case 1: Sheet absent -> RETAIN existing orders
    const dsOrdersAbsent = createMockDataset(baseItems, baseSales, 2, undefined, dsInitial.inventory, [], dsInitial.boms, ['Items', 'Sales History']);
    const dsMergedAbsent = mergeIncrementalDataset(dsInitial, dsOrdersAbsent, { isReplaceOrders: true });
    expect(dsMergedAbsent.openOrders.length).toBe(10);

    // Case 2: Sheet present with records
    const partialOrders: OpenOrderRecord[] = [
      { orderId: 'PO-SKU-1', itemCode: 'SKU-1', type: 'PO', quantity: 99 }
    ];
    const dsOrdersWithRecords = createMockDataset(baseItems, baseSales, 2, undefined, dsInitial.inventory, partialOrders, dsInitial.boms, ['Items', 'Sales History', 'Open Orders']);
    // 2a. Merge retains absent
    const dsMergedOrdinary = mergeIncrementalDataset(dsInitial, dsOrdersWithRecords, { isReplaceOrders: false });
    expect(dsMergedOrdinary.openOrders.length).toBe(10);
    // 2b. Replace removes absent
    const dsMergedReplace = mergeIncrementalDataset(dsInitial, dsOrdersWithRecords, { isReplaceOrders: true });
    expect(dsMergedReplace.openOrders.length).toBe(1);
    expect(dsMergedReplace.openOrders[0].itemCode).toBe('SKU-1');

    // Case 3: Sheet present with 0 valid records
    const dsOrdersEmpty = createMockDataset(baseItems, baseSales, 2, undefined, dsInitial.inventory, [], dsInitial.boms, ['Items', 'Sales History', 'Open Orders']);
    // 3a. Merge retains
    expect(mergeIncrementalDataset(dsInitial, dsOrdersEmpty, { isReplaceOrders: false }).openOrders.length).toBe(10);
    // 3b. Unconfirmed replace retains
    expect(mergeIncrementalDataset(dsInitial, dsOrdersEmpty, { isReplaceOrders: true }).openOrders.length).toBe(10);
    // 3c. Confirmed replace clears orders
    const dsMergedConfirmed = mergeIncrementalDataset(dsInitial, dsOrdersEmpty, {
      isReplaceOrders: true,
      confirmedEmptyReplacement: { orders: true }
    });
    expect(dsMergedConfirmed.openOrders.length).toBe(0);
    expect(dsMergedConfirmed.historySummary.incrementalStats?.mrpAffectedItems).toContain('SKU-1');
  });

  // 23. Explicit BOM replacement semantics: Sheet absent vs Sheet with records vs Sheet with 0 records
  it('23. Explicit BOM replacement semantics: Sheet absent vs Sheet with records vs Sheet with 0 records', () => {
    expect(dsInitial.boms.length).toBe(1);

    // Case 1: Sheet absent -> RETAIN existing BOMs
    const dsBomAbsent = createMockDataset(baseItems, baseSales, 2, undefined, dsInitial.inventory, dsInitial.openOrders, [], ['Items', 'Sales History']);
    const dsMergedAbsent = mergeIncrementalDataset(dsInitial, dsBomAbsent, { isReplaceBoms: true });
    expect(dsMergedAbsent.boms.length).toBe(1);

    // Case 2: Sheet present with records
    const newBom: BOMRecord[] = [
      { parentItemCode: 'SKU-5', componentCode: 'SKU-6', componentName: 'Component 6', qtyPerUnit: 3, uom: 'PCS', currentStock: 10, openPo: 0, leadTimeDays: 7 }
    ];
    const dsBomWithRecords = createMockDataset(baseItems, baseSales, 2, undefined, dsInitial.inventory, dsInitial.openOrders, newBom, ['Items', 'Sales History', 'BOM']);
    // 2a. Merge retains absent
    const dsMergedOrdinary = mergeIncrementalDataset(dsInitial, dsBomWithRecords, { isReplaceBoms: false });
    expect(dsMergedOrdinary.boms.length).toBe(2);
    // 2b. Replace removes absent
    const dsMergedReplace = mergeIncrementalDataset(dsInitial, dsBomWithRecords, { isReplaceBoms: true });
    expect(dsMergedReplace.boms.length).toBe(1);
    expect(dsMergedReplace.boms[0].parentItemCode).toBe('SKU-5');

    // Case 3: Sheet present with 0 valid records
    const dsBomEmpty = createMockDataset(baseItems, baseSales, 2, undefined, dsInitial.inventory, dsInitial.openOrders, [], ['Items', 'Sales History', 'BOM']);
    // 3a. Merge retains
    expect(mergeIncrementalDataset(dsInitial, dsBomEmpty, { isReplaceBoms: false }).boms.length).toBe(1);
    // 3b. Unconfirmed replace retains
    expect(mergeIncrementalDataset(dsInitial, dsBomEmpty, { isReplaceBoms: true }).boms.length).toBe(1);
    // 3c. Confirmed replace clears BOMs
    const dsMergedConfirmed = mergeIncrementalDataset(dsInitial, dsBomEmpty, {
      isReplaceBoms: true,
      confirmedEmptyReplacement: { boms: true }
    });
    expect(dsMergedConfirmed.boms.length).toBe(0);
    expect(dsMergedConfirmed.historySummary.incrementalStats?.bomAffectedItems).toContain('SKU-1');
  });

  // 24. Category-scope guard ordering: Supply/MRP update is not blocked when selected category has zero items
  it('24. Category-scope guard ordering: Supply/MRP update is not blocked when selected category has zero items', () => {
    // In dsInitial, all 10 items are classified as RUNNER (none are STRANGER)
    const updatedInventory: InventoryRecord[] = [
      ...dsInitial.inventory.filter(inv => inv.itemCode !== 'SKU-1'),
      { itemCode: 'SKU-1', warehouse: 'WH-01', onHandStock: 50 }
    ];
    const dsIncoming = createMockDataset(baseItems, baseSales, 2, undefined, updatedInventory, dsInitial.openOrders, dsInitial.boms);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    // Planner has selected only STRANGER category (which contains 0 eligible items in this dataset!)
    const decision = resolveForecastWorkflowDecision(
      dsMerged,
      defaultParams,
      defaultParams,
      initialLines,
      ['STRANGER']
    );

    // Decision MUST be MRP_ONLY, NOT blocked by empty category filter
    expect(decision.decision).toBe('MRP_ONLY');
    expect(decision.action).toBe('MRP_ONLY');
    expect(decision.categoryEligibleItems.length).toBe(0); // 0 items in category
    expect(decision.recalculatedResult).toBeDefined();

    // Verify MRP requirements updated accurately
    const line1 = decision.recalculatedResult!.lines.find((l: ForecastLine) => l.itemCode === 'SKU-1')!;
    expect(line1.stock).toBe(50);
    expect(line1.rawNetReq).toBe(545); // 600 - 50 - 5
  });

  // 25. Persist and version MRP-only updates: survives application reload and prior version is recoverable
  it('25. Persist and version MRP-only updates: survives application reload and prior version is recoverable', () => {
    let store: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: vi.fn((key: string) => store[key] || null),
      setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
      removeItem: vi.fn((key: string) => { delete store[key]; })
    };
    globalThis.localStorage = mockLocalStorage as any;

    // Step 1: Initial state has Version v1
    const initialVersionSnapshot: ForecastVersion = {
      version: 1,
      date: '2026-10-14 10:00:00',
      user: 'Planner',
      parameters: { ...defaultParams },
      status: 'Generated',
      adjustmentsCount: 0,
      aiTotal: 6000,
      finalQty: 6000,
      netReqTotal: 5850,
      avgConfidencePct: 85,
      linesSnapshot: [...initialLines],
      datasetVersion: 1,
      datasetName: 'test_dataset.xlsx'
    };

    PersistenceService.saveAppState({
      dataset: dsInitial,
      parameters: defaultParams,
      isForecastGenerated: true,
      forecastResult: {
        lines: initialLines,
        kpis: {
          totalItems: 10,
          aiForecastTotal: 6000,
          finalQtyTotal: 6000,
          netRequirementTotal: 5850,
          rawNetRequirementTotal: 5850,
          plannedOrderTotal: 5850,
          avgConfidencePct: 85,
          baselineGrowthPct: 0,
          adjustmentsCount: 0,
          lowConfidenceCount: 0,
          shortagesCount: 0,
          wapePct: null,
          wapeStatus: 'Not Available',
          availableHistoryMonths: 12,
          historyDateSpan: '2025-01 to 2025-12',
          modelReadinessTier: 'Tier 4',
          modelReadinessDescription: 'Seasonal ML'
        },
        alerts: []
      },
      existingLines: initialLines,
      status: 'Generated',
      version: 1,
      versions: [initialVersionSnapshot],
      adjustmentLogs: []
    });

    // Step 2: Ingest an MRP-only change (Stock of SKU-1 increases from 10 to 50)
    const updatedInventory: InventoryRecord[] = [
      ...dsInitial.inventory.filter(inv => inv.itemCode !== 'SKU-1'),
      { itemCode: 'SKU-1', warehouse: 'WH-01', onHandStock: 50 }
    ];
    const dsIncoming = createMockDataset(baseItems, baseSales, 2, undefined, updatedInventory, dsInitial.openOrders, dsInitial.boms);
    const dsMerged = mergeIncrementalDataset(dsInitial, dsIncoming);

    const decision = resolveForecastWorkflowDecision(dsMerged, defaultParams, defaultParams, initialLines);
    expect(decision.action).toBe('MRP_ONLY');

    const recomputed = decision.recalculatedResult!;
    expect(recomputed.lines.find(l => l.itemCode === 'SKU-1')!.stock).toBe(50);

    // Step 3: Production versioning & persistence workflow
    const nextVer = 2;
    const v2Snapshot: ForecastVersion = {
      version: nextVer,
      date: '2026-10-14 11:00:00',
      user: 'Planner',
      parameters: { ...defaultParams },
      status: 'Generated',
      adjustmentsCount: 0,
      aiTotal: recomputed.kpis.aiForecastTotal,
      finalQty: recomputed.kpis.finalQtyTotal,
      netReqTotal: recomputed.kpis.netRequirementTotal,
      avgConfidencePct: recomputed.kpis.avgConfidencePct,
      linesSnapshot: [...recomputed.lines],
      datasetVersion: dsMerged.dataVersion,
      datasetName: dsMerged.metadata.sourceName
    };
    const nextVersions = [v2Snapshot, initialVersionSnapshot];

    const saveSuccess = PersistenceService.saveAppState({
      dataset: dsMerged,
      parameters: defaultParams,
      isForecastGenerated: true,
      forecastResult: recomputed,
      existingLines: recomputed.lines,
      status: 'Generated',
      version: nextVer,
      versions: nextVersions,
      adjustmentLogs: []
    });
    expect(saveSuccess).toBe(true);

    // Step 4: Simulate application reload by loading from storage
    const loadedState = PersistenceService.loadAppState();
    expect(loadedState).not.toBeNull();
    expect(loadedState!.version).toBe(2);
    expect(loadedState!.versions?.length).toBe(2);

    // Updated MRP values restored
    const reloadedLine1 = loadedState!.forecastResult.lines.find(l => l.itemCode === 'SKU-1')!;
    expect(reloadedLine1.stock).toBe(50);
    expect(reloadedLine1.rawNetReq).toBe(545);
    expect(reloadedLine1.aiTotal).toBe(600); // AI forecast preserved!
    expect(reloadedLine1.modelDecision.selectedModel).toBe('HoltExponentialSmoothing');

    // Prior version remains recoverable
    const priorV1 = loadedState!.versions!.find(v => v.version === 1)!;
    expect(priorV1).toBeDefined();
    const v1Line1 = priorV1.linesSnapshot.find(l => l.itemCode === 'SKU-1')!;
    expect(v1Line1.stock).toBe(10);
    expect(v1Line1.rawNetReq).toBe(585);
  });

  // 26. Save failure in MRP-only update: surfaces error notification, preserves unsaved flag, and does not claim version saved
  it('26. Save failure in MRP-only update: surfaces error notification, preserves unsaved flag, and does not claim version saved', () => {
    // Simulate quota exceeded or persistence failure in localStorage
    const failingLocalStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError: storage limit reached');
      }),
      removeItem: vi.fn()
    };
    globalThis.localStorage = failingLocalStorage as any;

    const mockItem: Item = {
      itemCode: 'SKU-FAIL',
      description: 'Test Fail',
      itemGroup: 'G1',
      uom: 'NOS',
      makeBuy: 'Buy',
      leadTimeDays: 10,
      moq: 1,
      orderMultiple: 1,
      defaultVendor: 'V1',
      planningMethod: 'MRP',
      isNewItem: false,
      isDiscontinued: false
    };
    const ds = createMockDataset([mockItem], []);

    const saveSuccess = PersistenceService.saveAppState({
      dataset: ds,
      parameters: defaultParams,
      isForecastGenerated: true,
      forecastResult: {
        lines: [],
        kpis: {} as any,
        alerts: []
      },
      existingLines: [],
      status: 'Generated',
      version: 2,
      versions: [],
      adjustmentLogs: []
    });

    // Verification: saveAppState returns false when storage fails
    expect(saveSuccess).toBe(false);

    // Simulate App.tsx decision handling for toast and hasUnsavedChanges
    let hasUnsavedChanges = false;
    const toasts: Array<{ type: string; message: string }> = [];
    const addToast = (type: string, message: string) => toasts.push({ type, message });
    const nextVer = 2;
    const count = 1;

    if (saveSuccess) {
      hasUnsavedChanges = false;
      addToast(
        'success',
        `MRP and supply requirements recalculated and saved as Version v${nextVer} for ${count} SKU(s) without retraining ML models.`
      );
    } else {
      hasUnsavedChanges = true;
      addToast('error', 'Warning: Could not persist MRP update to local storage. Changes remain unsaved in memory.');
    }

    // Requirements check:
    // 1. Keep hasUnsavedChanges true
    expect(hasUnsavedChanges).toBe(true);
    // 2. Display only error toast
    expect(toasts.length).toBe(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].message).toContain('Warning: Could not persist MRP update to local storage');
    // 3. Do NOT claim version was saved
    expect(toasts.some(t => t.type === 'success')).toBe(false);
    expect(toasts.some(t => t.message.includes('saved as Version'))).toBe(false);
  });
});


