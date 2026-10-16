import { describe, it, expect } from 'vitest';
import { calculateMRPRequirements, processPythonForecastResults, recalculateBusinessMetrics } from './forecastingEngine';
import { NormalizedDataset, ForecastParameters, ForecastLine } from '../types';
import { PythonBatchResponse } from './forecastClient';

describe('MRP Calculation & Lot-Sizing Specification Suite', () => {

  describe('Core calculateMRPRequirements function', () => {
    it('Test 1 — Planner adjustment overrides AI forecast and calculates Raw Net before MOQ', () => {
      // AI = 246, Planner = 20, Final = 20, Stock = 0, PO = 0, MOQ = 500
      const finalQty = 20;
      const res = calculateMRPRequirements(finalQty, 0, 0, 'MRP', 500, 1, true);
      expect(res.rawNetReq).toBe(20);
      expect(res.plannedOrderQty).toBe(500);
    });

    it('Test 2 — No planner adjustment uses AI Forecast for Raw Net and Planned Order', () => {
      // AI = 246, Planner = null -> Final = 246, Stock = 0, PO = 0, MOQ = 500
      const finalQty = 246;
      const res = calculateMRPRequirements(finalQty, 0, 0, 'MRP', 500, 1, true);
      expect(res.rawNetReq).toBe(246);
      expect(res.plannedOrderQty).toBe(500);
    });

    it('Test 3 — Stock covers demand produces Raw Net = 0 and Planned Order = 0 (MOQ not applied)', () => {
      // AI = 246, Planner = 20, Stock = 100, PO = 0, MOQ = 500
      const finalQty = 20;
      const res = calculateMRPRequirements(finalQty, 100, 0, 'MRP', 500, 1, true);
      expect(res.rawNetReq).toBe(0);
      expect(res.plannedOrderQty).toBe(0);
    });

    it('Test 4 — Open PO covers demand produces Raw Net = 0 and Planned Order = 0 (MOQ not applied)', () => {
      // AI = 246, Planner = 20, Stock = 0, PO = 100, MOQ = 500
      const finalQty = 20;
      const res = calculateMRPRequirements(finalQty, 0, 100, 'MRP', 500, 1, true);
      expect(res.rawNetReq).toBe(0);
      expect(res.plannedOrderQty).toBe(0);
    });

    it('Test 5 — Requirement greater than MOQ produces Planned Order = Raw Net', () => {
      // Final Qty = 600, Stock = 0, PO = 0, MOQ = 500
      const finalQty = 600;
      const res = calculateMRPRequirements(finalQty, 0, 0, 'MRP', 500, 1, true);
      expect(res.rawNetReq).toBe(600);
      expect(res.plannedOrderQty).toBe(600);
    });

    it('Test 6 — Order multiple rounds Planned Order to next multiple ceiling', () => {
      // Raw Net = 501, MOQ = 500, Order Multiple = 500 -> Planned Order = 1000
      const finalQty = 501;
      const res = calculateMRPRequirements(finalQty, 0, 0, 'MRP', 500, 500, true);
      expect(res.rawNetReq).toBe(501);
      expect(res.plannedOrderQty).toBe(1000);
    });

    it('Test 7 — Dynamic MOQ produces distinct planned quantities for SKU A (MOQ 100) vs SKU B (MOQ 1000)', () => {
      // Raw Net = 20
      const resA = calculateMRPRequirements(20, 0, 0, 'MRP', 100, 1, true);
      const resB = calculateMRPRequirements(20, 0, 0, 'MRP', 1000, 1, true);

      expect(resA.rawNetReq).toBe(20);
      expect(resA.plannedOrderQty).toBe(100);

      expect(resB.rawNetReq).toBe(20);
      expect(resB.plannedOrderQty).toBe(1000);
    });
  });

  describe('Explicit Acceptance Criteria Cases 1–6', () => {
    // CASE 1: AI Forecast = 246, Planner Adjustment = 20, Stock = 0, Open PO = 0, MOQ = 500, Order Multiple = 100
    it('CASE 1: Final Forecast Qty = 20, Net Requirement Before Lot Sizing = 20, Planned Order Qty = 500', () => {
      const finalQty = 20; // Planner override
      const res = calculateMRPRequirements(finalQty, 0, 0, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBe(20);
      expect(res.plannedOrderQty).toBe(500);
    });

    // CASE 2: AI Forecast = 246, No Planner Adjustment, Stock = 0, Open PO = 0, MOQ = 500, Order Multiple = 100
    it('CASE 2: Final Forecast Qty = 246, Net Requirement Before Lot Sizing = 246, Planned Order Qty = 500', () => {
      const finalQty = 246; // AI Forecast total
      const res = calculateMRPRequirements(finalQty, 0, 0, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBe(246);
      expect(res.plannedOrderQty).toBe(500);
    });

    // CASE 3: Final Forecast Qty = 246, Stock = 100, Open PO = 50, MOQ = 500, Order Multiple = 100
    it('CASE 3: Net Requirement Before Lot Sizing = 96, Planned Order Qty = 500', () => {
      const finalQty = 246;
      const res = calculateMRPRequirements(finalQty, 100, 50, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBe(96);
      expect(res.plannedOrderQty).toBe(500);
    });

    // CASE 4: Final Forecast Qty = 600, Stock = 0, Open PO = 0, MOQ = 500, Order Multiple = 100
    it('CASE 4: Net Requirement Before Lot Sizing = 600, Planned Order Qty = 600', () => {
      const finalQty = 600;
      const res = calculateMRPRequirements(finalQty, 0, 0, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBe(600);
      expect(res.plannedOrderQty).toBe(600);
    });

    // CASE 5: Final Forecast Qty = 650, Stock = 0, Open PO = 0, MOQ = 500, Order Multiple = 100
    it('CASE 5: Net Requirement Before Lot Sizing = 650, Planned Order Qty = 700', () => {
      const finalQty = 650;
      const res = calculateMRPRequirements(finalQty, 0, 0, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBe(650);
      expect(res.plannedOrderQty).toBe(700);
    });

    // CASE 6: Final Forecast Qty = 100, Stock = 150, Open PO = 0, MOQ = 500, Order Multiple = 100
    it('CASE 6: Net Requirement Before Lot Sizing = 0, Planned Order Qty = 0', () => {
      const finalQty = 100;
      const res = calculateMRPRequirements(finalQty, 150, 0, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBe(0);
      expect(res.plannedOrderQty).toBe(0);
    });
  });

  describe('End-to-End Engine Integration', () => {
    const dummyDataset: NormalizedDataset = {
      items: [
        {
          itemCode: 'SKU-A', description: 'SKU A 100 MOQ', uom: 'PCS', itemGroup: 'Group1',
          makeBuy: 'Buy', planningMethod: 'MRP', leadTimeDays: 14, moq: 100,
          orderMultiple: 1, defaultVendor: 'Vendor A', isNewItem: false, isDiscontinued: false
        },
        {
          itemCode: 'SKU-B', description: 'SKU B 1000 MOQ', uom: 'PCS', itemGroup: 'Group1',
          makeBuy: 'Buy', planningMethod: 'MRP', leadTimeDays: 14, moq: 1000,
          orderMultiple: 1, defaultVendor: 'Vendor B', isNewItem: false, isDiscontinued: false
        }
      ],
      salesHistory: [],
      inventory: [
        { itemCode: 'SKU-A', warehouse: 'WH1', onHandStock: 0 },
        { itemCode: 'SKU-B', warehouse: 'WH1', onHandStock: 0 }
      ],
      openOrders: [
        { orderId: 'PO-A', itemCode: 'SKU-A', type: 'PO', quantity: 0 },
        { orderId: 'PO-B', itemCode: 'SKU-B', type: 'PO', quantity: 0 }
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
      forecastCode: 'FC-TEST',
      forecastName: 'Test MRP',
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
          itemCode: 'SKU-A', modelName: 'M1', modelType: 't1', selectedModel: 'M1', selectionStatus: 'SELECTED',
          selectionReason: '', historyMonths: 12, trainingRows: 12, forecast: [246], rawForecast: [246],
          metadata: {}, eligibility: []
        },
        {
          itemCode: 'SKU-B', modelName: 'M1', modelType: 't1', selectedModel: 'M1', selectionStatus: 'SELECTED',
          selectionReason: '', historyMonths: 12, trainingRows: 12, forecast: [246], rawForecast: [246],
          metadata: {}, eligibility: []
        }
      ]
    };

    it('flows planner adjustment into finalQty, rawNetReq, and plannedOrderQty independently per SKU', () => {
      const existing: ForecastLine[] = [
        {
          id: '1', itemCode: 'SKU-A', description: '', uom: '', itemGroup: '', avgPerMonth: 0, monthlyForecast: [246],
          aiTotal: 246, plannerAdj: 20, finalQty: 20, stock: 0, openPo: 0, openSo: 0, rawNetReq: 20, plannedOrderQty: 100, netReq: 100,
          confidencePct: null, confidence: 'Not evaluated', remark: 'Reduced demand', isModified: true, planningMethod: 'MRP', makeBuy: 'Buy',
          leadTimeDays: 0, moq: 100, orderMultiple: 1, defaultVendor: '', isDiscontinued: false, isNewItem: false,
          historyAvailableMonths: 12, historyDateRange: '', historyPeriods: [], historyValues: [], actualSalesLastYear: 0,
          demandSignal: {} as any, modelDecision: {} as any
        }
      ];

      const res = processPythonForecastResults(dummyPythonResponse, dummyDataset, dummyParams, existing);
      const lineA = res.lines.find(l => l.itemCode === 'SKU-A')!;
      const lineB = res.lines.find(l => l.itemCode === 'SKU-B')!;

      // SKU-A has planner override = 20 -> Final = 20, RawNet = 20, PlannedOrder = 100 (MOQ 100)
      expect(lineA.finalQty).toBe(20);
      expect(lineA.rawNetReq).toBe(20);
      expect(lineA.plannedOrderQty).toBe(100);

      // SKU-B has no planner override -> Final = 246, RawNet = 246, PlannedOrder = 1000 (MOQ 1000)
      expect(lineB.finalQty).toBe(246);
      expect(lineB.rawNetReq).toBe(246);
      expect(lineB.plannedOrderQty).toBe(1000);
    });

    it('recalculateBusinessMetrics updates MRP properly upon planner modification without hardcoded 500', () => {
      const initialRes = processPythonForecastResults(dummyPythonResponse, dummyDataset, dummyParams, []);
      const modifiedLines = initialRes.lines.map(l => 
        l.itemCode === 'SKU-B' ? { ...l, plannerAdj: 20 } : l
      );

      const recomputed = recalculateBusinessMetrics(modifiedLines, dummyDataset, dummyParams);
      const lineB = recomputed.lines.find(l => l.itemCode === 'SKU-B')!;

      // Final = 20, Raw Net = 20, Planned Order = 1000 (not 500!)
      expect(lineB.finalQty).toBe(20);
      expect(lineB.rawNetReq).toBe(20);
      expect(lineB.plannedOrderQty).toBe(1000);
    });
  });

  describe('Missing Supply Telemetry (Stock / Open PO) & Discontinued SKU Suite', () => {
    it('Stock = null, Open PO = 0 returns rawNetReq = null and plannedOrderQty = null', () => {
      const res = calculateMRPRequirements(100, null, 0, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBeNull();
      expect(res.plannedOrderQty).toBeNull();
    });

    it('Stock = 0, Open PO = null returns rawNetReq = null and plannedOrderQty = null', () => {
      const res = calculateMRPRequirements(100, 0, null, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBeNull();
      expect(res.plannedOrderQty).toBeNull();
    });

    it('Stock = null, Open PO = null returns rawNetReq = null and plannedOrderQty = null', () => {
      const res = calculateMRPRequirements(100, null, null, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBeNull();
      expect(res.plannedOrderQty).toBeNull();
    });

    it('Stock = 0, Open PO = 0 preserves genuine zero and computes requirements normally', () => {
      const res = calculateMRPRequirements(100, 0, 0, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBe(100);
      expect(res.plannedOrderQty).toBe(500); // MOQ 500
    });

    it('Both supply inputs populated (Stock = 50, Open PO = 30) computes shortage normally', () => {
      const res = calculateMRPRequirements(100, 50, 30, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBe(20);
      expect(res.plannedOrderQty).toBe(500); // MOQ 500
    });

    it('Planner adjustment with missing supply leaves requirements as null', () => {
      const finalQty = 250; // Planner adjusted
      const res = calculateMRPRequirements(finalQty, null, 0, 'MRP', 500, 100, true);
      expect(res.rawNetReq).toBeNull();
      expect(res.plannedOrderQty).toBeNull();
    });

    it('MOQ enabled with missing supply does NOT fabricate planned order', () => {
      const res = calculateMRPRequirements(50, null, null, 'MRP', 1000, 100, true);
      expect(res.rawNetReq).toBeNull();
      expect(res.plannedOrderQty).toBeNull();
    });

    it('Discontinued SKU locks rawNetReq and plannedOrderQty strictly to 0', () => {
      const res = calculateMRPRequirements(200, 0, 0, 'MRP', 500, 100, true, true);
      expect(res.rawNetReq).toBe(0);
      expect(res.plannedOrderQty).toBe(0);
    });

    it('Planner adjustment on discontinued SKU cannot override procurement lock (remains 0)', () => {
      const res = calculateMRPRequirements(500, 0, 0, 'MRP', 500, 100, true, true);
      expect(res.rawNetReq).toBe(0);
      expect(res.plannedOrderQty).toBe(0);
    });
  });
});

