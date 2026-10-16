import { describe, it, expect } from 'vitest';
import { processPythonForecastResults, recalculateBusinessMetrics } from './forecastingEngine';
import { NormalizedDataset, ForecastParameters, ForecastLine } from '../types';
import { ComponentsView } from '../components/ComponentsView';
import React from 'react';
import { renderToString } from 'react-dom/server';

const MOCK_DATASET: NormalizedDataset = {
  items: [
    { itemCode: 'MAKE1', description: 'Make item 1', uom: 'PCs', itemGroup: 'MakeGrp', isNewItem: false, isDiscontinued: false, planningMethod: 'MRP', makeBuy: 'Make', leadTimeDays: 10, moq: 1, orderMultiple: 1, defaultVendor: '' },
    { itemCode: 'BUY1', description: 'Buy item 1', uom: 'PCs', itemGroup: 'BuyGrp', isNewItem: false, isDiscontinued: false, planningMethod: 'MRP', makeBuy: 'Buy', leadTimeDays: 5, moq: 1, orderMultiple: 1, defaultVendor: 'V1' },
    { itemCode: 'SO1', description: 'Item for Open SO test', uom: 'PCs', itemGroup: 'Grp', isNewItem: false, isDiscontinued: false, planningMethod: 'MRP', makeBuy: 'Make', leadTimeDays: 10, moq: 1, orderMultiple: 1, defaultVendor: '' },
    { itemCode: 'ITEM-ADJ', description: 'Item for adjustment', uom: 'PCs', itemGroup: 'Grp', isNewItem: false, isDiscontinued: false, planningMethod: 'MRP', makeBuy: 'Make', leadTimeDays: 1, moq: 1, orderMultiple: 1, defaultVendor: '' },
  ],
  inventory: [
    { itemCode: 'MAKE1', warehouse: 'WH1', onHandStock: 50 },
    { itemCode: 'COMP1', warehouse: 'WH1', onHandStock: 50 },
    { itemCode: 'SO1', warehouse: 'WH1', onHandStock: 10 },
  ],
  openOrders: [
    { orderId: 'PO001', itemCode: 'MAKE1', type: 'PO', quantity: 30, dueDate: '2026-12-01' },
    { orderId: 'PO002', itemCode: 'COMP1', type: 'PO', quantity: 30, dueDate: '2026-12-01' },
    { orderId: 'SO001', itemCode: 'SO1', type: 'SO', quantity: 15, dueDate: '2026-12-01' },
    { orderId: 'PO003', itemCode: 'SO1', type: 'PO', quantity: 5, dueDate: '2026-12-01' },
  ],
  boms: [
    { parentItemCode: 'MAKE1', componentCode: 'COMP1', componentName: 'Component 1', qtyPerUnit: 2, uom: 'PCs', currentStock: 50, openPo: 30 }
  ],
  salesHistory: [
    { itemCode: 'MAKE1', period: '2026-01', quantity: 100 },
    { itemCode: 'BUY1', period: '2026-01', quantity: 50 },
    { itemCode: 'SO1', period: '2026-01', quantity: 100 },
    { itemCode: 'ITEM-ADJ', period: '2026-01', quantity: 100 },
  ],
  historySummary: { totalMonths: 1, earliestPeriod: '2026-01', latestPeriod: '2026-01', itemsWithHistory: 4, totalObservations: 4, itemHistoryMap: { 'MAKE1': 1, 'BUY1': 1, 'SO1': 1, 'ITEM-ADJ': 1 } },
  dataVersion: 1,
  metadata: {
    sourceName: 'test_fsd.xlsx',
    totalRecords: 10,
    sheetsDetected: ['Items', 'SalesHistory'],
    importedAt: new Date().toISOString(),
    isDemo: true
  }
};

const MOCK_PARAMS: ForecastParameters = {
  forecastCode: 'TEST-FC-001',
  forecastName: 'Test Forecast',
  startMonth: '2026-11',
  horizon: 6,
  itemGroups: [],
  itemCodeFrom: '',
  itemCodeTo: '',
  warehouses: ['WH1'],
  historyPeriod: 24,
  seasonality: true,
  treatBulkProjectSeparately: true,
  includeOpenSalesOrders: true,
  includeNewCustomers: true,
  confidenceLevel: 90,
  applyMoqOrderMultiple: true
};

const MOCK_PYTHON_RESPONSE = {
  itemsAnalyzed: 4,
  horizon: 6,
  results: [
    { itemCode: 'MAKE1', forecast: [100,0,0,0,0,0], demandProfile: 'Stable', confidence: { level: 'HIGH', score: 95 } },
    { itemCode: 'BUY1', forecast: [50,0,0,0,0,0], demandProfile: 'Stable', confidence: { level: 'HIGH', score: 90 } },
    { itemCode: 'SO1', forecast: [10, 10, 10, 10, 10, 10], demandProfile: 'Stable', confidence: { level: 'HIGH', score: 95 } }, // Total = 60
    { itemCode: 'ITEM-ADJ', forecast: [100,0,0,0,0,0], demandProfile: 'Stable', confidence: { level: 'HIGH', score: 95 } },
  ]
};

describe('FSD Compliance (Phase 8)', () => {
  it('FR-09: Component Requirement matches FSD via real React component', () => {
    // Generate lines
    const result = processPythonForecastResults(MOCK_PYTHON_RESPONSE as any, MOCK_DATASET, MOCK_PARAMS);
    const lines = result.lines;

    // Render ComponentsView to string
    const html = renderToString(React.createElement(ComponentsView, { lines, dataset: MOCK_DATASET, parameters: MOCK_PARAMS }));

    // Expected logic for MAKE1:
    // AI total = 100.
    // Qty per unit = 2 => Required = 200
    // Stock = 50, PO = 30 => Shortage = 120
    expect(html).toContain('200'); // required
    expect(html).toContain('50');  // stock
    expect(html).toContain('30');  // po
    expect(html).toContain('120'); // shortage string
    expect(html).toContain('Short'); // shortage string
  });

  it('FR-08: Net Requirement calculation does not double-count Open SO', () => {
    const result = processPythonForecastResults(MOCK_PYTHON_RESPONSE as any, MOCK_DATASET, MOCK_PARAMS);
    const soLine = result.lines.find(l => l.itemCode === 'SO1')!;
    
    // 1. Verify Open SO is successfully tracked from the dataset (15)
    expect(soLine.openSo).toBe(15);
    
    // 2. Verify AI forecast generated independently = 60
    expect(soLine.aiTotal).toBe(60);
    
    // 3. Verify Final Qty remains identical to AI Total (not summing Open SO)
    expect(soLine.finalQty).toBe(60);
    
    // 4. Verify Net Req = 60 - Stock (10) - Open PO (5) = 45.
    // If Open SO was incorrectly added: Net Req = 60 + 15 - 10 - 5 = 60.
    expect(soLine.netReq).toBe(45);
  });

  it('>20% Planner Adjustment Rule generates an alert via actual logic', () => {
    const initialResult = processPythonForecastResults(MOCK_PYTHON_RESPONSE as any, MOCK_DATASET, MOCK_PARAMS);
    
    // Modify one line to have > 20% diff
    const modifiedLines = initialResult.lines.map(l => 
      l.itemCode === 'ITEM-ADJ' ? { ...l, plannerAdj: 130 } : l
    );

    const updatedResult = recalculateBusinessMetrics(modifiedLines, MOCK_DATASET, MOCK_PARAMS);
    const largeAdjAlerts = updatedResult.alerts.filter(a => a.filterType === 'large-adj');
    
    expect(largeAdjAlerts.length).toBe(1);
    expect(largeAdjAlerts[0].itemCodes).toContain('ITEM-ADJ');
  });

  it('<=20% Planner Adjustment Rule does NOT generate an alert via actual logic', () => {
    const initialResult = processPythonForecastResults(MOCK_PYTHON_RESPONSE as any, MOCK_DATASET, MOCK_PARAMS);
    
    // Modify to have exactly 20% diff (100 -> 120)
    const modifiedLines = initialResult.lines.map(l => 
      l.itemCode === 'ITEM-ADJ' ? { ...l, plannerAdj: 120 } : l
    );

    const updatedResult = recalculateBusinessMetrics(modifiedLines, MOCK_DATASET, MOCK_PARAMS);
    const largeAdjAlerts = updatedResult.alerts.filter(a => a.filterType === 'large-adj');
    
    // 20% exactly is permitted without alert
    expect(largeAdjAlerts.length).toBe(0);
  });

  it('>30% Forecast Change Rule generates an alert via actual logic', () => {
    // Generate base lines first
    const baseLines = processPythonForecastResults(MOCK_PYTHON_RESPONSE as any, MOCK_DATASET, MOCK_PARAMS).lines;
    
    // Now simulate generating a NEW forecast where the AI total for ITEM-ADJ changed from 100 to 135 (35% change)
    const newPythonResponse = {
      ...MOCK_PYTHON_RESPONSE,
      results: MOCK_PYTHON_RESPONSE.results.map(r => r.itemCode === 'ITEM-ADJ' ? { ...r, forecast: [135, 0, 0, 0, 0, 0] } : r)
    };

    const newResult = processPythonForecastResults(newPythonResponse as any, MOCK_DATASET, MOCK_PARAMS, baseLines);
    
    const largeChangeAlerts = newResult.alerts.filter(a => a.filterType === 'large-change' as any);
    
    expect(largeChangeAlerts.length).toBe(1);
    expect(largeChangeAlerts[0].itemCodes).toContain('ITEM-ADJ');
  });
});

describe('Frontend FSD Eligibility Rules', () => {
  const checkEligibility = (months: number) => {
    // We pass a mock dataset where the item has a specific length of history
    // and rely on processPythonForecastResults to assign tier and limitations.
    
    // Create sales history of exactly 'months' length
    const salesHistory = Array.from({ length: months }).map((_, i) => ({
      itemCode: 'TEST', period: `2026-${(i+1).toString().padStart(2, '0')}`, quantity: 10
    }));

    const ds: NormalizedDataset = {
      ...MOCK_DATASET,
      items: [{ ...MOCK_DATASET.items[0], itemCode: 'TEST' }],
      salesHistory,
    };

    const pyResponse = {
      itemsAnalyzed: 1,
      horizon: 6,
      results: [{ 
        itemCode: 'TEST', forecast: [0,0,0,0,0,0], demandProfile: 'Stable',
        // Simulate python engine NOT providing an explicit status to test frontend fallback logic
        selectionStatus: undefined, 
        selectionReason: undefined 
      }]
    };

    const result = processPythonForecastResults(pyResponse as any, ds, MOCK_PARAMS);
    return result.lines[0];
  };

  it('0 months -> cold start peer baseline state', () => {
    const line = checkEligibility(0);
    expect(line.modelDecision.modelTier).toContain('Cold Start / Peer Baseline (0M)');
    expect(line.modelDecision.modelLimitation).toContain('Zero historical telemetry');
  });

  it('3 months -> sparse history shrinkage blend state', () => {
    const line = checkEligibility(3);
    expect(line.modelDecision.modelTier).toContain('Sparse History / Shrinkage Blend (1-5M)');
    expect(line.modelDecision.modelLimitation).toContain('Sparse historical telemetry');
  });

  it('5 months -> sparse history shrinkage blend state', () => {
    const line = checkEligibility(5);
    expect(line.modelDecision.modelTier).toContain('Sparse History / Shrinkage Blend (1-5M)');
  });

  it('6 months -> insufficient history -> no forecasting tier', () => {
    const line = checkEligibility(6);
    expect(line.modelDecision.modelTier).toContain('Insufficient History / Manual Handling (6-11M)');
    expect(line.modelDecision.modelLimitation).toContain('Minimum 12 months required');
  });

  it('11 months -> insufficient history -> no forecasting tier', () => {
    const line = checkEligibility(11);
    expect(line.modelDecision.modelTier).toContain('Insufficient History / Manual Handling (6-11M)');
  });

  it('12 months -> normal forecasting eligible', () => {
    const line = checkEligibility(12);
    expect(line.modelDecision.modelTier).toContain('Normal Forecasting (12-23M)');
    expect(line.modelDecision.selectionStatus).toBe('SELECTED');
  });

  it('24 months -> full forecasting eligible', () => {
    const line = checkEligibility(24);
    expect(line.modelDecision.modelTier).toContain('Full Historical Forecasting (24M+)');
    expect(line.modelDecision.selectionStatus).toBe('SELECTED');
  });
});
