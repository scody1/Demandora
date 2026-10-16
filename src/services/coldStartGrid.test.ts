import { describe, it, expect } from 'vitest';
import { processPythonForecastResults } from './forecastingEngine';
import type { NormalizedDataset, ForecastParameters } from '../types';
import type { PythonBatchResponse } from './forecastClient';

describe('Cold Start and Sparse History UI Grid & Calculation Tests', () => {
  const mockDataset: NormalizedDataset = {
    items: [
      { itemCode: 'SKU-0M', description: '12W Spotlight Warm White', uom: 'PCS', itemGroup: 'Spotlight', isNewItem: true, isDiscontinued: false, planningMethod: 'MRP', makeBuy: 'Make', leadTimeDays: 30, moq: 100, orderMultiple: 1, defaultVendor: '' },
      { itemCode: 'SKU-3M', description: '12W Spotlight Cool White', uom: 'PCS', itemGroup: 'Spotlight', isNewItem: false, isDiscontinued: false, planningMethod: 'MRP', makeBuy: 'Make', leadTimeDays: 15, moq: 50, orderMultiple: 1, defaultVendor: '' }
    ],
    salesHistory: [
      { itemCode: 'SKU-3M', period: '2026-03', quantity: 100, orderType: 'Regular' },
      { itemCode: 'SKU-3M', period: '2026-04', quantity: 120, orderType: 'Regular' },
      { itemCode: 'SKU-3M', period: '2026-05', quantity: 140, orderType: 'Regular' }
    ],
    inventory: [
      { itemCode: 'SKU-0M', warehouse: 'WH1', onHandStock: 100 },
      { itemCode: 'SKU-3M', warehouse: 'WH1', onHandStock: 200 }
    ],
    openOrders: [
      { orderId: 'PO001', itemCode: 'SKU-0M', type: 'PO', quantity: 50, dueDate: '2026-11-15' },
      { orderId: 'SO001', itemCode: 'SKU-0M', type: 'SO', quantity: 20, dueDate: '2026-11-10' }
    ],
    boms: [],
    historySummary: {
      totalMonths: 3,
      earliestPeriod: '2026-03',
      latestPeriod: '2026-05',
      itemsWithHistory: 1,
      totalObservations: 3,
      itemHistoryMap: { 'SKU-0M': 0, 'SKU-3M': 3 }
    },
    metadata: {
      sourceName: 'test.xlsx',
      totalRecords: 2,
      sheetsDetected: [],
      importedAt: '',
      isDemo: true
    },
    dataVersion: 1
  };

  const mockParams: ForecastParameters = {
    forecastCode: 'TEST-FC-001',
    forecastName: 'Test Forecast',
    horizon: 6,
    startMonth: '2026-11',
    itemGroups: [],
    itemCodeFrom: '',
    itemCodeTo: '',
    warehouses: ['WH1'],
    historyPeriod: 24,
    seasonality: true,
    treatBulkProjectSeparately: false,
    includeOpenSalesOrders: true,
    includeNewCustomers: true,
    applyMoqOrderMultiple: true,
    confidenceLevel: 90
  };

  it('TEST A & C: 0M Cold-Start SKU processes 6 forecast values without suppression', () => {
    const pyResponse: PythonBatchResponse = {
      engine: 'Ledure Python ML Engine',
      version: '2.0.0',
      horizon: 6,
      startMonth: '2026-11',
      totalItemsProcessed: 1,
      modelDistribution: { 'Cold Start (Comparable SKU Baseline)': 1 },
      results: [
        {
          itemCode: 'SKU-0M',
          modelName: 'Cold Start (Comparable SKU Baseline)',
          modelType: 'cold_start',
          selectedModel: 'Cold Start (Comparable SKU Baseline)',
          selectionStatus: 'COLD_START',
          selectionReason: 'Cold-start baseline derived from 2 mature comparable SKUs',
          historyMonths: 0,
          trainingRows: 0,
          forecast: [150, 160, 170, 180, 190, 200],
          rawForecast: [150.0, 160.0, 170.0, 180.0, 190.0, 200.0],
          selectedModelMetrics: null,
          eligibility: [],
          confidence: {
            status: 'NOT_EVALUATED',
            score: null,
            level: 'NOT_EVALUATED',
            intervalLevel: 0.90,
            lowerBound: [null, null, null, null, null, null],
            upperBound: [null, null, null, null, null, null],
            method: 'None',
            validationObservationCount: 0,
            reasons: ['Cold start SKU']
          },
          metadata: {
            peer_skus: ['PEER-1', 'PEER-2']
          }
        }
      ]
    };

    const res = processPythonForecastResults(pyResponse, mockDataset, mockParams);
    const line0m = res.lines.find(l => l.itemCode === 'SKU-0M')!;

    expect(line0m).toBeDefined();
    expect(line0m.historyAvailableMonths).toBe(0);
    expect(line0m.monthlyForecast).toEqual([150, 160, 170, 180, 190, 200]);
    expect(line0m.aiTotal).toBe(1050); // Sum of 150..200
    expect(line0m.confidence).toBe('Not evaluated');
    expect(line0m.confidenceBlock?.status).toBe('NOT_EVALUATED');
    expect(line0m.modelDecision.selectionStatus).toBe('COLD_START');
    expect(line0m.modelDecision.modelTier).toContain('Cold Start / Peer Baseline (0M)');
  });

  it('TEST B & F: 1-5M Sparse-History SKU processes 6 blended forecast values', () => {
    const pyResponse: PythonBatchResponse = {
      engine: 'Ledure Python ML Engine',
      version: '2.0.0',
      horizon: 6,
      startMonth: '2026-11',
      totalItemsProcessed: 1,
      modelDistribution: { 'Sparse History (Direct + Peer Blend 50%/50%)': 1 },
      results: [
        {
          itemCode: 'SKU-3M',
          modelName: 'Sparse History (Direct + Peer Blend 50%/50%)',
          modelType: 'sparse_history',
          selectedModel: 'Sparse History (Direct + Peer Blend 50%/50%)',
          selectionStatus: 'SPARSE_HISTORY',
          selectionReason: 'Sparse history (3M): Blended 50% direct track record with 50% peer baseline',
          historyMonths: 3,
          trainingRows: 3,
          forecast: [135, 140, 145, 150, 155, 160],
          rawForecast: [135.0, 140.0, 145.0, 150.0, 155.0, 160.0],
          selectedModelMetrics: null,
          eligibility: [],
          confidence: {
            status: 'NOT_EVALUATED',
            score: null,
            level: 'NOT_EVALUATED',
            intervalLevel: 0.90,
            lowerBound: [null, null, null, null, null, null],
            upperBound: [null, null, null, null, null, null],
            method: 'None',
            validationObservationCount: 0,
            reasons: ['Sparse history']
          },
          metadata: {
            direct_weight: 0.5,
            peer_weight: 0.5
          }
        }
      ]
    };

    const res = processPythonForecastResults(pyResponse, mockDataset, mockParams);
    const line3m = res.lines.find(l => l.itemCode === 'SKU-3M')!;

    expect(line3m).toBeDefined();
    expect(line3m.historyAvailableMonths).toBe(3);
    expect(line3m.monthlyForecast).toEqual([135, 140, 145, 150, 155, 160]);
    expect(line3m.aiTotal).toBe(885);
    expect(line3m.confidence).toBe('Not evaluated');
    expect(line3m.confidenceBlock?.status).toBe('NOT_EVALUATED');
    expect(line3m.modelDecision.selectionStatus).toBe('SPARSE_HISTORY');
    expect(line3m.modelDecision.modelTier).toContain('Sparse History / Shrinkage Blend (1-5M)');
  });
});
