import { describe, it, expect } from 'vitest';
import { processPythonForecastResults } from './forecastingEngine';
import { NormalizedDataset, ForecastParameters, ForecastLine, ForecastResult } from '../types';
import { PythonBatchResponse } from './forecastClient';

describe('Phase 5 Business Logic Validation', () => {

  const dummyDataset: NormalizedDataset = {
    items: [
      {
        itemCode: 'ITEM-1', description: 'Test', uom: 'PCS', itemGroup: 'LED',
        makeBuy: 'Make', planningMethod: 'MRP', leadTimeDays: 14, moq: 1000,
        orderMultiple: 500, defaultVendor: 'V1', isNewItem: false, isDiscontinued: false
      },
      {
        itemCode: 'ITEM-NONE', description: 'Test', uom: 'PCS', itemGroup: 'LED',
        makeBuy: 'Make', planningMethod: 'None', leadTimeDays: 14, moq: 1000,
        orderMultiple: 500, defaultVendor: 'V1', isNewItem: false, isDiscontinued: false
      }
    ],
    salesHistory: [],
    inventory: [
      { itemCode: 'ITEM-1', warehouse: 'WH1', onHandStock: 200 },
      { itemCode: 'ITEM-NONE', warehouse: 'WH1', onHandStock: 200 }
    ],
    openOrders: [
      { orderId: 'PO1', itemCode: 'ITEM-1', type: 'PO', quantity: 150, dueDate: '2026-11-01' },
      { orderId: 'SO1', itemCode: 'ITEM-1', type: 'SO', quantity: 50, dueDate: '2026-11-01' }
    ],
    historySummary: {
      itemsWithHistory: 0,
      totalObservations: 0,
      earliestPeriod: '',
      latestPeriod: '',
      totalMonths: 0,
      itemHistoryMap: {}
    },
    boms: [],
    dataVersion: 1,
    metadata: {
      sourceName: '',
      totalRecords: 0,
      sheetsDetected: [],
      importedAt: '',
      isDemo: false
    }
  };

  const dummyParams: ForecastParameters = {
    forecastCode: 'TEST-001',
    forecastName: 'Test Forecast',
    startMonth: '2026-11',
    horizon: 1,
    historyPeriod: 24,
    warehouses: ['WH1'],
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

  const dummyPythonResponse: PythonBatchResponse = {
    engine: 'test', version: '1', horizon: 1, startMonth: '2026-11', totalItemsProcessed: 2, modelDistribution: {},
    results: [
      {
        itemCode: 'ITEM-1', modelName: 'M1', modelType: 't1', selectedModel: 'M1', selectionStatus: 'SELECTED',
        selectionReason: '', historyMonths: 12, trainingRows: 12, forecast: [300], rawForecast: [300],
        metadata: {}, eligibility: []
      },
      {
        itemCode: 'ITEM-NONE', modelName: 'M1', modelType: 't1', selectedModel: 'M1', selectionStatus: 'SELECTED',
        selectionReason: '', historyMonths: 12, trainingRows: 12, forecast: [300], rawForecast: [300],
        metadata: {}, eligibility: []
      }
    ]
  };

  it('TEST 12: >30% forecast change triggers alert', () => {
    // 300 vs previous 100 (200% change)
    const existing: ForecastLine[] = [{
      id: 'e1', itemCode: 'ITEM-1', description: '', uom: '', itemGroup: '', avgPerMonth: 0, monthlyForecast: [100],
      aiTotal: 100, plannerAdj: null, finalQty: 100, stock: 0, openPo: 0, openSo: 0, rawNetReq: 0, plannedOrderQty: 0, netReq: 0,
      confidencePct: null, confidence: 'Not evaluated', remark: '', isModified: false, planningMethod: 'MRP', makeBuy: 'Make',
      leadTimeDays: 0, moq: 0, orderMultiple: 0, defaultVendor: '', isDiscontinued: false, isNewItem: false,
      historyAvailableMonths: 12, historyDateRange: '', historyPeriods: [], historyValues: [], actualSalesLastYear: 0,
      demandSignal: {} as any, modelDecision: {} as any
    }];
    
    const res = processPythonForecastResults(dummyPythonResponse, dummyDataset, dummyParams, existing);
    const alert = res.alerts.find(a => a.id === 'alt-large-change');
    expect(alert).toBeDefined();
    expect(alert?.itemCodes).toContain('ITEM-1');
  });

  it('TEST 17: Net requirement never becomes negative', () => {
    // Forecast is 300. Demand = 300.
    // Stock = 200, PO = 150.
    // Net = 300 - 200 - 150 = -50. Clipped to 0.
    const res = processPythonForecastResults(dummyPythonResponse, dummyDataset, dummyParams, []);
    const line = res.lines.find(l => l.itemCode === 'ITEM-1');
    expect(line?.netReq).toBe(0);
  });

  it('TEST 18: MOQ/order multiple rounds requirement correctly', () => {
    const py = JSON.parse(JSON.stringify(dummyPythonResponse));
    py.results[0].forecast = [1500]; 
    // Forecast 1500. Demand = 1500.
    // Stock = 200, PO = 150. Net = 1500 - 200 - 150 = 1150.
    // MOQ = 1000. Excess = 150. Multiples of 500 = ceil(150/500) = 1.
    // Result = 1000 + 1*500 = 1500.
    const res = processPythonForecastResults(py, dummyDataset, dummyParams, []);
    const line = res.lines.find(l => l.itemCode === 'ITEM-1');
    expect(line?.netReq).toBe(1500);
  });

  it('TEST 19: MOQ disabled leaves requirement unchanged', () => {
    const p = { ...dummyParams, applyMoqOrderMultiple: false };
    const py = JSON.parse(JSON.stringify(dummyPythonResponse));
    py.results[0].forecast = [1500];
    const res = processPythonForecastResults(py, dummyDataset, p, []);
    const line = res.lines.find(l => l.itemCode === 'ITEM-1');
    expect(line?.netReq).toBe(1150);
  });

  it('TEST 20 & 21: Planning Method = None does not calculate an MRP net requirement', () => {
    const res = processPythonForecastResults(dummyPythonResponse, dummyDataset, dummyParams, []);
    const lineNone = res.lines.find(l => l.itemCode === 'ITEM-NONE');
    expect(lineNone?.netReq).toBeNull(); // Should be null

    const lineMRP = res.lines.find(l => l.itemCode === 'ITEM-1');
    expect(lineMRP?.netReq).not.toBeNull();
  });

  it('TEST 23: Open SO is not double-counted into NetReq', () => {
    const py = JSON.parse(JSON.stringify(dummyPythonResponse));
    py.results[0].forecast = [500];
    const dataset = JSON.parse(JSON.stringify(dummyDataset));
    dataset.inventory[0].onHandStock = 100;
    dataset.openOrders[0].quantity = 100; // PO
    // Final=500, Stock=100, OpenPO=100
    // NetReq = 500 - 100 - 100 = 300.
    const p = { ...dummyParams, applyMoqOrderMultiple: false };
    const res = processPythonForecastResults(py, dataset, p, []);
    const line = res.lines.find(l => l.itemCode === 'ITEM-1');
    expect(line?.openSo).toBe(50); // Preserved
    expect(line?.netReq).toBe(300); // 300, not affected by SO
  });
});
