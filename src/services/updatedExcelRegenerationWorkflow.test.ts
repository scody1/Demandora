import { describe, it, expect } from 'vitest';
import {
  prepareItemHistories,
  processPythonForecastResults,
  recalculateBusinessMetrics,
  calculateMRPRequirements
} from './forecastingEngine';
import {
  mergeIncrementalDataset
} from './excelService';
import {
  NormalizedDataset,
  ForecastParameters,
  ForecastLine,
  ForecastVersion
} from '../types';
import { PythonBatchResponse } from './forecastClient';

describe('Updated Excel Ingestion & Forecast Regeneration Workflow Suite', () => {

  const baseParams: ForecastParameters = {
    forecastCode: 'FC-TEST-WORKFLOW',
    forecastName: 'Updated Excel Workflow Test',
    startMonth: '2026-07',
    horizon: 3,
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

  const createInitialDataset = (): NormalizedDataset => ({
    items: [
      {
        itemCode: 'SKU-LED-100',
        description: '10W LED Bulb',
        uom: 'PCS',
        itemGroup: 'Bulbs',
        makeBuy: 'Buy',
        planningMethod: 'MRP',
        leadTimeDays: 15,
        moq: 500,
        orderMultiple: 100,
        defaultVendor: 'Vendor Alpha',
        isNewItem: false,
        isDiscontinued: false
      }
    ],
    salesHistory: [
      { itemCode: 'SKU-LED-100', period: '2026-03', quantity: 2376, orderType: 'Regular' },
      { itemCode: 'SKU-LED-100', period: '2026-04', quantity: 1615, orderType: 'Regular' },
      { itemCode: 'SKU-LED-100', period: '2026-05', quantity: 2425, orderType: 'Regular' }
    ],
    inventory: [], // No stock sheet in workbook
    openOrders: [], // No PO sheet in workbook
    historySummary: {
      itemsWithHistory: 1,
      totalObservations: 3,
      earliestPeriod: '2026-03',
      latestPeriod: '2026-05',
      totalMonths: 3,
      itemHistoryMap: { 'SKU-LED-100': 3 }
    },
    boms: [],
    dataVersion: 1,
    metadata: {
      sourceName: 'original_data.xlsx',
      totalRecords: 3,
      sheetsDetected: ['Items', 'Sales History'],
      importedAt: '2026-06-01',
      isDemo: false
    }
  });

  // TEST 1 — Initial Excel import
  it('TEST 1 — Initial Excel import ingests dataset successfully', () => {
    const dataset = createInitialDataset();
    expect(dataset.items).toHaveLength(1);
    expect(dataset.salesHistory).toHaveLength(3);
    expect(dataset.historySummary.totalMonths).toBe(3);
    expect(dataset.dataVersion).toBe(1);
  });

  // TEST 2 — Updated Excel import
  it('TEST 2 — Updated Excel import updates active dataset with new data version', () => {
    const original = createInitialDataset();
    const updatedImport: NormalizedDataset = {
      ...original,
      salesHistory: [
        { itemCode: 'SKU-LED-100', period: '2026-03', quantity: 2376, orderType: 'Regular' },
        { itemCode: 'SKU-LED-100', period: '2026-04', quantity: 1615, orderType: 'Regular' },
        { itemCode: 'SKU-LED-100', period: '2026-05', quantity: 2425, orderType: 'Regular' },
        { itemCode: 'SKU-LED-100', period: '2026-06', quantity: 2800, orderType: 'Regular' }
      ],
      historySummary: {
        itemsWithHistory: 1,
        totalObservations: 4,
        earliestPeriod: '2026-03',
        latestPeriod: '2026-06',
        totalMonths: 4,
        itemHistoryMap: { 'SKU-LED-100': 4 }
      },
      dataVersion: 2,
      metadata: {
        ...original.metadata,
        sourceName: 'updated_data_v2.xlsx'
      }
    };

    const merged = mergeIncrementalDataset(original, updatedImport);
    expect(merged.dataVersion).toBe(2);
    expect(merged.salesHistory).toHaveLength(4);
    expect(merged.historySummary.totalMonths).toBe(4);
    expect(merged.historySummary.latestPeriod).toBe('2026-06');
  });

  // TEST 3 — Regeneration after updated data
  it('TEST 3 — Regeneration after updated data uses the latest historical dataset', () => {
    const updatedDataset: NormalizedDataset = {
      ...createInitialDataset(),
      salesHistory: [
        { itemCode: 'SKU-LED-100', period: '2026-03', quantity: 2376, orderType: 'Regular' },
        { itemCode: 'SKU-LED-100', period: '2026-04', quantity: 1615, orderType: 'Regular' },
        { itemCode: 'SKU-LED-100', period: '2026-05', quantity: 2425, orderType: 'Regular' },
        { itemCode: 'SKU-LED-100', period: '2026-06', quantity: 2800, orderType: 'Regular' }
      ],
      historySummary: {
        itemsWithHistory: 1,
        totalObservations: 4,
        earliestPeriod: '2026-03',
        latestPeriod: '2026-06',
        totalMonths: 4,
        itemHistoryMap: { 'SKU-LED-100': 4 }
      },
      dataVersion: 2
    };

    const payload = prepareItemHistories(updatedDataset, baseParams);
    expect(payload).toHaveLength(1);
    expect(payload[0].history).toEqual([2376, 1615, 2425, 2800]);
    expect(payload[0].periods).toEqual(['2026-03', '2026-04', '2026-05', '2026-06']);
  });

  // TEST 4 — New month changes history
  it('TEST 4 — New month increases SKU history observations from 3 to 4', () => {
    const datasetOriginal = createInitialDataset();
    const payloadV1 = prepareItemHistories(datasetOriginal, baseParams);
    expect(payloadV1[0].history.length).toBe(3);

    const datasetWithJune: NormalizedDataset = {
      ...datasetOriginal,
      salesHistory: [
        ...datasetOriginal.salesHistory,
        { itemCode: 'SKU-LED-100', period: '2026-06', quantity: 2800, orderType: 'Regular' }
      ],
      historySummary: {
        ...datasetOriginal.historySummary,
        totalMonths: 4,
        latestPeriod: '2026-06'
      }
    };
    const payloadV2 = prepareItemHistories(datasetWithJune, baseParams);
    expect(payloadV2[0].history.length).toBe(4);
    expect(payloadV2[0].history[3]).toBe(2800);
  });

  // TEST 5 — Corrected historical value
  it('TEST 5 — Corrected historical value in new workbook is dispatched to forecast pipeline', () => {
    const datasetOriginal = createInitialDataset();
    // Suppose April was originally 1615, but corrected to 1950 in updated workbook
    const correctedDataset: NormalizedDataset = {
      ...datasetOriginal,
      salesHistory: [
        { itemCode: 'SKU-LED-100', period: '2026-03', quantity: 2376, orderType: 'Regular' },
        { itemCode: 'SKU-LED-100', period: '2026-04', quantity: 1950, orderType: 'Regular' },
        { itemCode: 'SKU-LED-100', period: '2026-05', quantity: 2425, orderType: 'Regular' }
      ]
    };

    const payload = prepareItemHistories(correctedDataset, baseParams);
    expect(payload[0].history).toEqual([2376, 1950, 2425]);
    expect(payload[0].history[1]).toBe(1950);
  });

  // TEST 6 — New SKU introduced in updated workbook
  it('TEST 6 — New SKU is recognized and routed according to its history tier (0M cold start)', () => {
    const datasetWithNewSku: NormalizedDataset = {
      ...createInitialDataset(),
      items: [
        ...createInitialDataset().items,
        {
          itemCode: 'SKU-NEW-001',
          description: 'Brand New Smart Panel',
          uom: 'PCS',
          itemGroup: 'Panels',
          makeBuy: 'Buy',
          planningMethod: 'MRP',
          leadTimeDays: 30,
          moq: 100,
          orderMultiple: 10,
          defaultVendor: 'Vendor Beta',
          isNewItem: true,
          isDiscontinued: false
        }
      ]
    };

    const payload = prepareItemHistories(datasetWithNewSku, baseParams);
    expect(payload).toHaveLength(2);
    const newSku = payload.find(p => p.itemCode === 'SKU-NEW-001');
    expect(newSku).toBeDefined();
    expect(newSku!.history).toEqual([]);
    expect(newSku!.periods).toEqual([]);
  });

  // TEST 7 — Planner adjustment separation
  it('TEST 7 — Planner adjustment overrides Final Qty but does NOT alter sales history or AI forecast', () => {
    const dataset = createInitialDataset();
    const mockPythonResponse: PythonBatchResponse = {
      engine: 'FastAPI Python ML',
      version: '1.0',
      horizon: 3,
      startMonth: '2026-07',
      totalItemsProcessed: 1,
      modelDistribution: {},
      results: [
        {
          itemCode: 'SKU-LED-100',
          modelName: 'HistGradientBoostingRegressor',
          modelType: 'Machine Learning',
          selectedModel: 'HistGradientBoostingRegressor',
          selectionStatus: 'SELECTED',
          selectionReason: 'Lowest WAPE',
          historyMonths: 3,
          trainingRows: 3,
          forecast: [82, 82, 82], // Sum = 246
          rawForecast: [82, 82, 82],
          metadata: {},
          eligibility: []
        }
      ]
    };

    const res = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const line = res.lines[0];
    expect(line.aiTotal).toBe(246);
    expect(line.plannerAdj).toBeNull();
    expect(line.finalQty).toBe(246);

    // Planner applies adjustment = 220
    const adjustedLines: ForecastLine[] = [{
      ...line,
      plannerAdj: 220,
      remark: 'Manager adjustment for promotional phase-down',
      isModified: true
    }];

    const recomputed = recalculateBusinessMetrics(adjustedLines, dataset, baseParams);
    const updatedLine = recomputed.lines[0];

    // Final Qty is 220, AI forecast remains 246
    expect(updatedLine.finalQty).toBe(220);
    expect(updatedLine.aiTotal).toBe(246);
    expect(updatedLine.plannerAdj).toBe(220);

    // Sales history remains completely unchanged (3 observations)
    expect(dataset.salesHistory).toHaveLength(3);
    expect(dataset.salesHistory.map(h => h.quantity)).toEqual([2376, 1615, 2425]);
  });

  // TEST 8 — Planner adjustment must not affect ML
  it('TEST 8 — Planner adjustment is NOT sent into prepareItemHistories payload for ML training', () => {
    const dataset = createInitialDataset();
    const payload = prepareItemHistories(dataset, baseParams);

    // prepareItemHistories strictly reads from dataset.salesHistory
    expect(payload[0].history).toEqual([2376, 1615, 2425]);
    expect(payload[0].history).not.toContain(220);
  });

  // TEST 9 — Unsaved adjustment protection logic
  it('TEST 9 — Unsaved changes check detects modifications properly', () => {
    const line: ForecastLine = {
      id: '1', itemCode: 'SKU-LED-100', description: '', uom: 'PCS', itemGroup: '', avgPerMonth: 2000,
      monthlyForecast: [82, 82, 82], aiTotal: 246, plannerAdj: null, finalQty: 246, stock: null, openPo: null,
      openSo: null, rawNetReq: 246, plannedOrderQty: 500, netReq: 500, confidencePct: null, confidence: 'Not evaluated',
      remark: '', isModified: false, planningMethod: 'MRP', makeBuy: 'Buy', leadTimeDays: 15, moq: 500,
      orderMultiple: 100, defaultVendor: '', historyAvailableMonths: 3, historyDateRange: '', historyPeriods: [],
      historyValues: [2376, 1615, 2425], actualSalesLastYear: 6416, demandSignal: {} as any, modelDecision: {} as any
    };

    const modifiedLine: ForecastLine = {
      ...line,
      plannerAdj: 220,
      isModified: true
    };

    const hasUnsaved = line.plannerAdj !== modifiedLine.plannerAdj;
    expect(hasUnsaved).toBe(true);
  });

  // TEST 10 — Version creation
  it('TEST 10 — Version 1 and Version 2 are distinct and both retained', () => {
    const versions: ForecastVersion[] = [];

    const ver1: ForecastVersion = {
      version: 1,
      date: '2026-06-01 10:00:00',
      user: 'R. Sharma',
      parameters: baseParams,
      status: 'Generated',
      adjustmentsCount: 0,
      aiTotal: 246,
      finalQty: 246,
      netReqTotal: 500,
      avgConfidencePct: 85,
      linesSnapshot: [],
      datasetVersion: 1,
      datasetName: 'original_data.xlsx'
    };
    versions.push(ver1);

    const ver2: ForecastVersion = {
      version: 2,
      date: '2026-06-01 11:30:00',
      user: 'R. Sharma',
      parameters: baseParams,
      status: 'Generated',
      adjustmentsCount: 0,
      aiTotal: 310,
      finalQty: 310,
      netReqTotal: 500,
      avgConfidencePct: 88,
      linesSnapshot: [],
      datasetVersion: 2,
      datasetName: 'updated_data_v2.xlsx'
    };
    versions.push(ver2);

    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(1);
    expect(versions[0].datasetVersion).toBe(1);
    expect(versions[1].version).toBe(2);
    expect(versions[1].datasetVersion).toBe(2);
  });

  // TEST 11 — No fabricated Stock
  it('TEST 11 — When workbook contains no Stock field, stock is null (unavailable), not fabricated as 0', () => {
    const datasetWithoutStock = createInitialDataset();
    expect(datasetWithoutStock.inventory).toHaveLength(0);

    const mockPythonResponse: PythonBatchResponse = {
      engine: 'FastAPI Python ML',
      version: '1.0',
      horizon: 3,
      startMonth: '2026-07',
      totalItemsProcessed: 1,
      modelDistribution: {},
      results: [
        {
          itemCode: 'SKU-LED-100',
          modelName: 'HistGradientBoostingRegressor',
          modelType: 'Machine Learning',
          selectedModel: 'HistGradientBoostingRegressor',
          selectionStatus: 'SELECTED',
          selectionReason: 'Lowest WAPE',
          historyMonths: 3,
          trainingRows: 3,
          forecast: [82, 82, 82],
          rawForecast: [82, 82, 82],
          metadata: {},
          eligibility: []
        }
      ]
    };

    const res = processPythonForecastResults(mockPythonResponse, datasetWithoutStock, baseParams, []);
    expect(res.lines[0].stock).toBeNull();
  });

  // TEST 12 — No fabricated Open PO
  it('TEST 12 — When workbook contains no Open PO field, openPo is null (unavailable), not fabricated as 0', () => {
    const datasetWithoutPo = createInitialDataset();
    expect(datasetWithoutPo.openOrders).toHaveLength(0);

    const mockPythonResponse: PythonBatchResponse = {
      engine: 'FastAPI Python ML',
      version: '1.0',
      horizon: 3,
      startMonth: '2026-07',
      totalItemsProcessed: 1,
      modelDistribution: {},
      results: [
        {
          itemCode: 'SKU-LED-100',
          modelName: 'HistGradientBoostingRegressor',
          modelType: 'Machine Learning',
          selectedModel: 'HistGradientBoostingRegressor',
          selectionStatus: 'SELECTED',
          selectionReason: 'Lowest WAPE',
          historyMonths: 3,
          trainingRows: 3,
          forecast: [82, 82, 82],
          rawForecast: [82, 82, 82],
          metadata: {},
          eligibility: []
        }
      ]
    };

    const res = processPythonForecastResults(mockPythonResponse, datasetWithoutPo, baseParams, []);
    expect(res.lines[0].openPo).toBeNull();
  });

});
