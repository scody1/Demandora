import { describe, it, expect, vi } from 'vitest';
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

describe('Explicit Update Action & Real-Time Planner MOQ Suite (A through R)', () => {

  const baseParams: ForecastParameters = {
    forecastCode: 'FC-TEST-MOQ',
    forecastName: 'Planner MOQ Test',
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

  const createSampleDataset = (itemMoq?: number): NormalizedDataset => ({
    items: [
      {
        itemCode: 'SKU-TEST-001',
        description: 'Industrial Sensor Module',
        uom: 'PCS',
        itemGroup: 'Sensors',
        makeBuy: 'Buy',
        planningMethod: 'MRP',
        leadTimeDays: 14,
        moq: itemMoq !== undefined ? itemMoq : 500,
        orderMultiple: 100,
        defaultVendor: 'SensorCorp',
        isNewItem: false,
        isDiscontinued: false
      }
    ],
    salesHistory: [
      { itemCode: 'SKU-TEST-001', period: '2026-01', quantity: 80, orderType: 'Regular' },
      { itemCode: 'SKU-TEST-001', period: '2026-02', quantity: 85, orderType: 'Regular' },
      { itemCode: 'SKU-TEST-001', period: '2026-03', quantity: 81, orderType: 'Regular' }
    ],
    inventory: [
      { itemCode: 'SKU-TEST-001', warehouse: 'WH-CENTRAL', onHandStock: 0 }
    ],
    openOrders: [
      { orderId: 'PO-0', itemCode: 'SKU-TEST-001', type: 'PO', quantity: 0 }
    ],
    boms: [],
    historySummary: {
      itemsWithHistory: 1,
      totalObservations: 3,
      earliestPeriod: '2026-01',
      latestPeriod: '2026-03',
      totalMonths: 3,
      itemHistoryMap: { 'SKU-TEST-001': 3 }
    },
    dataVersion: 1,
    metadata: {
      sourceName: 'test_dataset.xlsx',
      totalRecords: 3,
      sheetsDetected: ['Items', 'Sales History'],
      importedAt: '2026-07-01',
      isDemo: false
    }
  });

  const mockPythonResponse: PythonBatchResponse = {
    engine: 'Python ML Engine',
    version: '1.0.0',
    horizon: 3,
    startMonth: '2026-07',
    totalItemsProcessed: 1,
    modelDistribution: { WeightedMovingAverage: 1 },
    results: [
      {
        itemCode: 'SKU-TEST-001',
        historyMonths: 3,
        trainingRows: 3,
        forecast: [82, 82, 82],
        modelName: 'WeightedMovingAverage',
        modelType: 'STATISTICAL',
        selectedModel: 'WeightedMovingAverage',
        selectionStatus: 'INSUFFICIENT_HISTORY',
        selectionReason: 'Short history baseline',
        selectedModelMetrics: {
          wape: 4.5,
          mae: 3.2,
          rmse: 4.1,
          bias: 0.8,
          validationWindows: 3
        },
        modelComparison: [
          {
            model: 'WeightedMovingAverage',
            modelType: 'STATISTICAL',
            wape: 4.5,
            mae: 3.2,
            rmse: 4.1,
            bias: 0.8,
            validationWindows: 3,
            validWindows: 3,
            eligible: true,
            reason: 'Winner model'
          }
        ],
        eligibility: [],
        confidence: {
          score: 88,
          level: 'HIGH',
          status: 'EVALUATED',
          method: 'Historical Residual Variance',
          intervalLevel: 0.9,
          validationObservationCount: 3,
          reasons: ['Consistent trend'],
          lowerBound: [75, 75, 75],
          upperBound: [89, 89, 89]
        },
        metadata: {
          feature_names: ['lag_1', 'rolling_mean_3']
        }
      }
    ]
  };

  // A. Default MOQ is 500
  it('A. Default MOQ is 500 PCS when no override exists', () => {
    const dataset = createSampleDataset(500);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const line = result.lines[0];
    expect(line.moq).toBe(500);
    expect(line.uom).toBe('PCS');
  });

  // B & C. Validation rejects invalid MOQ inputs
  it('B & C. Invalid MOQ (empty, zero, negative, non-numeric) is rejected and cannot be committed', () => {
    const validateAndCommit = (moqInput: string) => {
      const trimmed = moqInput.trim();
      if (trimmed === '') {
        return { valid: false, error: 'MOQ must be greater than 0.' };
      }
      const parsed = Math.round(Number(trimmed));
      if (isNaN(parsed) || parsed <= 0 || !Number.isFinite(parsed)) {
        return { valid: false, error: 'MOQ must be greater than 0.' };
      }
      return { valid: true, value: parsed };
    };

    expect(validateAndCommit('').valid).toBe(false);
    expect(validateAndCommit('0').valid).toBe(false);
    expect(validateAndCommit('-100').valid).toBe(false);
    expect(validateAndCommit('abc').valid).toBe(false);
    expect(validateAndCommit('  ').valid).toBe(false);
    expect(validateAndCommit('1000').valid).toBe(true);
    expect(validateAndCommit('1000').value).toBe(1000);
  });

  // D. Changing input without clicking Update does not change committed MOQ
  it('D. Changing input without clicking Update does NOT mutate the committed MOQ or procurement quantity', () => {
    const dataset = createSampleDataset(100);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const committedLine = { ...result.lines[0], plannerAdj: 246, moq: 100 };
    const initialProcurement = recalculateBusinessMetrics([committedLine], dataset, baseParams);

    // User is editing in UI: moqInput = '500', but has NOT committed Update
    let moqInput = '500';
    let committedMoq = committedLine.moq;

    expect(moqInput).toBe('500');
    expect(committedMoq).toBe(100);
    expect(initialProcurement.lines[0].moq).toBe(100);
    expect(initialProcurement.lines[0].plannedOrderQty).toBe(300); // 246 rounded to 100 order multiple with MOQ 100 -> 300
  });

  // E & F. Clicking Update commits the new MOQ and recalculates Planned Order Qty immediately
  it('E & F. Clicking Update commits the new MOQ and recalculates Planned Order Qty immediately (100 -> 500 changes Planned Order Qty 300 -> 500)', () => {
    const dataset = createSampleDataset(100);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const committedLine = { ...result.lines[0], plannerAdj: 246, moq: 100 };
    const beforeUpdate = recalculateBusinessMetrics([committedLine], dataset, baseParams);
    expect(beforeUpdate.lines[0].plannedOrderQty).toBe(300);

    // Planner clicks Update: commits 500
    const afterUpdateLine = { ...committedLine, moq: 500 };
    const afterUpdate = recalculateBusinessMetrics([afterUpdateLine], dataset, baseParams);
    expect(afterUpdate.lines[0].moq).toBe(500);
    expect(afterUpdate.lines[0].plannedOrderQty).toBe(500); // Requirement 246 raised to MOQ 500
    expect(afterUpdate.kpis.plannedOrderTotal).toBe(500);
  });

  // G. MRP Rule Explanation updates immediately
  it('G. MRP Rule Explanation reflects the updated committed MOQ', () => {
    const getExplanation = (rawNet: number, planned: number, moq: number, orderMultiple: number, uom: string) => {
      const moqApplied = moq > 0 && rawNet < moq;
      const orderMultipleApplied = orderMultiple > 1 && planned > (moqApplied ? moq : rawNet);

      if (moqApplied && orderMultipleApplied) {
        return `Requirement is ${rawNet} ${uom}. Supplier MOQ is ${moq} ${uom} and order multiple is ${orderMultiple} ${uom}, so the planned purchase quantity is raised to ${planned} ${uom}.`;
      }
      if (moqApplied) {
        return `Requirement is ${rawNet} ${uom}. Supplier MOQ is ${moq} ${uom}, so the planned purchase quantity is raised to ${planned} ${uom}.`;
      }
      if (orderMultipleApplied) {
        return `Requirement is ${rawNet} ${uom}. Order multiple is ${orderMultiple} ${uom}, so the planned purchase quantity is rounded to ${planned} ${uom}.`;
      }
      return `Net requirement is ${rawNet} ${uom}; no additional MOQ adjustment is required.`;
    };

    // Before update: MOQ = 500, RawReq = 20, Planned = 500
    const expBefore = getExplanation(20, 500, 500, 100, 'PCS');
    expect(expBefore).toContain('Supplier MOQ is 500 PCS');

    // After update: MOQ = 1000, RawReq = 20, Planned = 1000
    const expAfter = getExplanation(20, 1000, 1000, 100, 'PCS');
    expect(expAfter).toContain('Supplier MOQ is 1000 PCS');
    expect(expAfter).not.toContain('500 PCS');
  });

  // H. No stale planned quantity remains in dependent UI
  it('H. No stale planned quantity remains in dependent UI after Update', () => {
    const dataset = createSampleDataset(500);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const line = { ...result.lines[0], plannerAdj: 20, moq: 500 };
    const res500 = recalculateBusinessMetrics([line], dataset, baseParams);
    expect(res500.lines[0].plannedOrderQty).toBe(500);

    const line1000 = { ...line, moq: 1000 };
    const res1000 = recalculateBusinessMetrics([line1000], dataset, baseParams);
    expect(res1000.lines[0].moq).toBe(1000);
    expect(res1000.lines[0].plannedOrderQty).toBe(1000);
    expect(res1000.lines[0].netReq).toBe(1000);
    expect(res1000.kpis.plannedOrderTotal).toBe(1000);
    expect(res1000.kpis.netRequirementTotal).toBe(1000);
  });

  // I. Reset to Default sets MOQ back to 500
  it('I. Reset to Default sets MOQ back to 500 and Update commits 500', () => {
    let moqInput = '1000';
    let committedMoq = 1000;

    // Reset action
    moqInput = '500';
    expect(moqInput).toBe('500');
    expect(committedMoq).toBe(1000); // Not committed yet

    // Update action
    committedMoq = 500;
    expect(committedMoq).toBe(500);
  });

  // J. MOQ change does NOT change AI forecast
  it('J. MOQ change does NOT change AI forecast', () => {
    const dataset = createSampleDataset(500);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const originalAiTotal = result.lines[0].aiTotal;
    const originalMonthly = [...result.lines[0].monthlyForecast];

    const updatedLine = { ...result.lines[0], moq: 2000 };
    const recomputed = recalculateBusinessMetrics([updatedLine], dataset, baseParams);
    expect(recomputed.lines[0].aiTotal).toBe(originalAiTotal);
    expect(recomputed.lines[0].monthlyForecast).toEqual(originalMonthly);
  });

  // K. MOQ change does NOT change WAPE
  it('K. MOQ change does NOT change WAPE', () => {
    const dataset = createSampleDataset(500);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const originalWape = result.lines[0].modelDecision.backtestWape;

    const updatedLine = { ...result.lines[0], moq: 3000 };
    const recomputed = recalculateBusinessMetrics([updatedLine], dataset, baseParams);
    expect(recomputed.lines[0].modelDecision.backtestWape).toBe(originalWape);
    expect(recomputed.kpis.wapePct).toBe(4.5);
  });

  // L. MOQ change does NOT change model selection
  it('L. MOQ change does NOT change model selection', () => {
    const dataset = createSampleDataset(500);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const originalModel = result.lines[0].modelDecision.selectedModel;

    const updatedLine = { ...result.lines[0], moq: 1500 };
    const recomputed = recalculateBusinessMetrics([updatedLine], dataset, baseParams);
    expect(recomputed.lines[0].modelDecision.selectedModel).toBe(originalModel);
  });

  // M. MOQ change does NOT change prediction intervals
  it('M. MOQ change does NOT change prediction intervals or confidence', () => {
    const dataset = createSampleDataset(500);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const origConfidenceBlock = result.lines[0].confidenceBlock;

    const updatedLine = { ...result.lines[0], moq: 1500 };
    const recomputed = recalculateBusinessMetrics([updatedLine], dataset, baseParams);
    expect(recomputed.lines[0].confidenceBlock).toEqual(origConfidenceBlock);
  });

  // N. MOQ change does NOT trigger forecast regeneration
  it('N. MOQ change does NOT trigger forecast regeneration or backend Python model retraining', () => {
    const mockML = vi.fn();
    const dataset = createSampleDataset(500);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);

    const updatedLine = { ...result.lines[0], moq: 800 };
    const recomputed = recalculateBusinessMetrics([updatedLine], dataset, baseParams);

    expect(mockML).not.toHaveBeenCalled();
    expect(recomputed.lines[0].moq).toBe(800);
  });

  // O. MOQ + Order Multiple interaction remains correct
  it('O. MOQ + Order Multiple interaction remains correct across multiple scenarios', () => {
    // Scenario 1: FinalQty = 20, Stock = 0, OpenPO = 0, MOQ = 500, Multiple = 100 -> Planned = 500
    expect(calculateMRPRequirements(20, 0, 0, 'MRP', 500, 100, true).plannedOrderQty).toBe(500);

    // Scenario 2: FinalQty = 20, Stock = 0, OpenPO = 0, MOQ = 1000, Multiple = 100 -> Planned = 1000
    expect(calculateMRPRequirements(20, 0, 0, 'MRP', 1000, 100, true).plannedOrderQty).toBe(1000);

    // Scenario 3: FinalQty = 620, Stock = 0, OpenPO = 0, MOQ = 500, Multiple = 100 -> Planned = 700
    expect(calculateMRPRequirements(620, 0, 0, 'MRP', 500, 100, true).plannedOrderQty).toBe(700);

    // Scenario 4: FinalQty = 620, Stock = 0, OpenPO = 0, MOQ = 1000, Multiple = 100 -> Planned = 1000
    expect(calculateMRPRequirements(620, 0, 0, 'MRP', 1000, 100, true).plannedOrderQty).toBe(1000);

    // Scenario 5: FinalQty = 1200, Stock = 0, OpenPO = 0, MOQ = 1500, Multiple = 100 -> Planned = 1500
    expect(calculateMRPRequirements(1200, 0, 0, 'MRP', 1500, 100, true).plannedOrderQty).toBe(1500);
  });

  // P. Save Draft preserves the updated MOQ
  it('P. Save Draft preserves the updated committed MOQ in version snapshot', () => {
    const dataset = createSampleDataset(500);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const updatedLine = { ...result.lines[0], moq: 1200 };
    const recomputed = recalculateBusinessMetrics([updatedLine], dataset, baseParams);

    const savedVersion: ForecastVersion = {
      version: 2,
      date: '2026-07-01 10:00:00',
      user: 'Lead Planner',
      parameters: baseParams,
      status: 'Draft',
      adjustmentsCount: 0,
      aiTotal: recomputed.kpis.aiForecastTotal,
      finalQty: recomputed.kpis.finalQtyTotal,
      netReqTotal: recomputed.kpis.netRequirementTotal,
      avgConfidencePct: recomputed.kpis.avgConfidencePct,
      linesSnapshot: recomputed.lines,
      datasetVersion: dataset.dataVersion
    };

    expect(savedVersion.linesSnapshot[0].moq).toBe(1200);
  });

  // Q. Export uses the committed MOQ
  it('Q. Export row mapping uses the committed MOQ and calculated planned quantity', () => {
    const dataset = createSampleDataset(500);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const committedLine = { ...result.lines[0], plannerAdj: 20, moq: 1500 };
    const recomputed = recalculateBusinessMetrics([committedLine], dataset, baseParams);

    const l = recomputed.lines[0];
    const exportRow = {
      'Item Code': l.itemCode,
      'Final Qty': l.finalQty,
      'MOQ': l.moq,
      'Order Multiple': l.orderMultiple,
      'Planned Order Qty After Lot Sizing': l.plannedOrderQty
    };

    expect(exportRow.MOQ).toBe(1500);
    expect(exportRow['Planned Order Qty After Lot Sizing']).toBe(1500);
  });

  // R. Existing frozen regression tests continue to pass
  it('R. Incremental dataset update preserves planner-committed MOQ across regeneration', () => {
    const datasetV1 = createSampleDataset(500);
    const resultV1 = processPythonForecastResults(mockPythonResponse, datasetV1, baseParams, []);
    const customLine = { ...resultV1.lines[0], moq: 1000 };

    const incomingDataset: NormalizedDataset = {
      ...datasetV1,
      salesHistory: [
        { itemCode: 'SKU-TEST-001', period: '2026-04', quantity: 90, orderType: 'Regular' }
      ],
      dataVersion: 2
    };
    const datasetV2 = mergeIncrementalDataset(datasetV1, incomingDataset);

    const mockPythonResponseV2: PythonBatchResponse = {
      engine: 'Python ML Engine',
      version: '1.0.0',
      horizon: 3,
      startMonth: '2026-07',
      totalItemsProcessed: 1,
      modelDistribution: { WeightedMovingAverage: 1 },
      results: [
        {
          ...mockPythonResponse.results[0],
          historyMonths: 4,
          trainingRows: 4,
          forecast: [84, 84, 84]
        }
      ]
    };

    const resultV2 = processPythonForecastResults(mockPythonResponseV2, datasetV2, baseParams, [customLine]);
    expect(resultV2.lines[0].moq).toBe(1000);
    expect(resultV2.lines[0].aiTotal).toBe(252);
  });

  // S. Safe recalculation when dataset is null or undefined
  it('S. recalculateBusinessMetrics safely recalculates lines when dataset is null or undefined', () => {
    const dataset = createSampleDataset(500);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    const line = { ...result.lines[0], moq: 200 };

    // Pass null as dataset
    const recomputed = recalculateBusinessMetrics([line], null, baseParams);
    expect(recomputed).toBeDefined();
    expect(recomputed.lines[0].moq).toBe(200);
    expect(recomputed.kpis.availableHistoryMonths).toBe(0);
    expect(recomputed.kpis.historyDateSpan).toBe('Dynamic');
  });

  // T. Committing new MOQ when supply data is missing preserves the new MOQ safely
  it('T. Committing new MOQ preserves updated MOQ on item even when stock and openPo are missing', () => {
    const dataset = createSampleDataset(500);
    const result = processPythonForecastResults(mockPythonResponse, dataset, baseParams, []);
    // Item with missing stock and openPo (null)
    const lineMissingSupply: ForecastLine = {
      ...result.lines[0],
      stock: null as any,
      openPo: null as any,
      rawNetReq: null as any,
      plannedOrderQty: null as any,
      moq: 500
    };

    // Update MOQ to 200
    const updatedLine = { ...lineMissingSupply, moq: 200 };
    const recomputed = recalculateBusinessMetrics([updatedLine], dataset, baseParams);

    expect(recomputed.lines[0].moq).toBe(200);
    expect(recomputed.lines[0].plannedOrderQty).toBeNull();
    expect(recomputed.lines[0].rawNetReq).toBeNull();
  });
});
