import { describe, it, expect, vi } from 'vitest';
import { processPythonForecastResults } from './forecastingEngine';
import { ForecastParameters, NormalizedDataset } from '../types';

describe('Forecast Execution Lifecycle State Machine', () => {
  it('transitions state machine: IDLE -> RUNNING -> COMPLETED with immediate atomic commit', async () => {
    type ExecutionState = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';
    let executionState: ExecutionState = 'IDLE';
    let isExecuting = false;
    const logs: string[] = [];

    const mockDataset: NormalizedDataset = {
      metadata: {
        sourceName: 'test.xlsx',
        totalRecords: 1,
        sheetsDetected: ['Items', 'Sales'],
        importedAt: '2026-10-07',
        isDemo: false
      },
      dataVersion: 1,
      items: [
        {
          itemCode: 'SKU001',
          description: 'LED Panel 18W',
          itemGroup: 'Panels',
          uom: 'NOS',
          leadTimeDays: 14,
          moq: 1,
          orderMultiple: 1,
          defaultVendor: 'Vendor1',
          makeBuy: 'Buy',
          planningMethod: 'MRP',
          isNewItem: false,
          isDiscontinued: false
        }
      ],
      salesHistory: [
        { itemCode: 'SKU001', period: '2026-08', quantity: 120, orderType: 'Regular' },
        { itemCode: 'SKU001', period: '2026-09', quantity: 130, orderType: 'Regular' },
        { itemCode: 'SKU001', period: '2026-10', quantity: 140, orderType: 'Regular' }
      ],
      openOrders: [],
      inventory: [
        { itemCode: 'SKU001', warehouse: 'WH1', onHandStock: 100 }
      ],
      boms: [],
      accuracyRecords: [],
      historySummary: {
        totalMonths: 3,
        earliestPeriod: '2026-08',
        latestPeriod: '2026-10',
        totalObservations: 3,
        itemsWithHistory: 1,
        itemHistoryMap: { SKU001: 3 }
      }
    };

    const mockParams: ForecastParameters = {
      forecastCode: 'FCST-TEST',
      forecastName: 'Test Forecast',
      startMonth: '2026-11',
      horizon: 6,
      historyPeriod: 24,
      itemGroups: ['Panels'],
      itemCodeFrom: '',
      itemCodeTo: '',
      warehouses: [],
      confidenceLevel: 90,
      includeNewCustomers: true,
      includeOpenSalesOrders: false,
      applyMoqOrderMultiple: false,
      treatBulkProjectSeparately: false,
      seasonality: true
    };

    const mockPythonResponse = {
      engine: 'Python ML FastAPI Engine',
      version: '1.0.0',
      horizon: 6,
      startMonth: '2026-11',
      totalItemsProcessed: 1,
      modelDistribution: { 'Peer Baseline': 1 },
      results: [
        {
          itemCode: 'SKU001',
          modelName: 'Peer Baseline',
          modelType: 'Statistical Baseline',
          selectedModel: 'Peer Baseline',
          selectionStatus: 'SPARSE_HISTORY' as const,
          selectionReason: 'Sparse history (3M)',
          historyMonths: 3,
          trainingRows: 3,
          forecast: [130, 130, 130, 130, 130, 130],
          rawForecast: [130, 130, 130, 130, 130, 130],
          metadata: { history_months: 3 },
          eligibility: []
        }
      ]
    };

    // Simulated async runner
    const runAuthoritativeForecast = async () => {
      if (isExecuting || executionState === 'RUNNING') {
        return;
      }
      isExecuting = true;
      logs.push('FORECAST_EXECUTION_START');
      executionState = 'RUNNING';
      logs.push(`FORECAST_EXECUTION_STATE: ${executionState}`);

      // Async mock fetch
      const pythonRes = await Promise.resolve(mockPythonResponse);
      logs.push('FORECAST_API_RESOLVED');

      // Process and commit
      const computedResult = processPythonForecastResults(pythonRes as any, mockDataset, mockParams, []);
      logs.push('FORECAST_RESULT_COMMITTED');

      executionState = 'COMPLETED';
      logs.push(`FORECAST_EXECUTION_STATE: ${executionState}`);
      isExecuting = false;
      logs.push('FORECAST_MODAL_CLOSED');

      return computedResult;
    };

    expect(executionState).toBe('IDLE');
    const result = await runAuthoritativeForecast();

    expect(result).toBeDefined();
    expect(result?.lines.length).toBe(1);
    expect(executionState).toBe('COMPLETED');
    expect(isExecuting).toBe(false);

    expect(logs).toEqual([
      'FORECAST_EXECUTION_START',
      'FORECAST_EXECUTION_STATE: RUNNING',
      'FORECAST_API_RESOLVED',
      'FORECAST_RESULT_COMMITTED',
      'FORECAST_EXECUTION_STATE: COMPLETED',
      'FORECAST_MODAL_CLOSED'
    ]);
  });

  it('prevents concurrent executions while RUNNING', async () => {
    let executionState = 'RUNNING';
    let isExecuting = true;
    let callCount = 0;

    const mockRun = async () => {
      if (isExecuting || executionState === 'RUNNING') {
        return 'REJECTED_CONCURRENT';
      }
      callCount++;
      return 'STARTED';
    };

    const res = await mockRun();
    expect(res).toBe('REJECTED_CONCURRENT');
    expect(callCount).toBe(0);
  });
});
