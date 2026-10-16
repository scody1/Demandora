import { describe, it, expect } from 'vitest';
import { mergeIncrementalDataset } from './excelService';
import { NormalizedDataset, Item, SalesHistoryRecord } from '../types';

const createDataset = (items: Item[], sales: SalesHistoryRecord[], dataVersion = 1): NormalizedDataset => {
  return {
    items,
    salesHistory: sales,
    inventory: [],
    openOrders: [],
    boms: [],
    dataVersion,
    historySummary: {
      earliestPeriod: '2026-01',
      latestPeriod: '2026-12',
      totalMonths: 12,
      totalObservations: sales.length,
      itemsWithHistory: items.length,
      itemHistoryMap: {}
    },
    metadata: {
      sourceName: 'test',
      totalRecords: items.length + sales.length,
      sheetsDetected: [],
      importedAt: '',
      isDemo: false
    }
  };
};

describe('Phase 3 - Incremental Data Learning', () => {
  
  it('TEST 1 - FIRST UPLOAD', () => {
    const ds1 = createDataset(
      [{ itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }],
      [
        { itemCode: 'A', period: '2026-01', quantity: 100, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-02', quantity: 110, orderType: 'Regular' }
      ]
    );
    expect(ds1.salesHistory.length).toBe(2);
    expect(ds1.salesHistory[0].period).toBe('2026-01');
  });

  it('TEST 2 - ADD NEW MONTHS', () => {
    const ds1 = createDataset(
      [{ itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }],
      [
        { itemCode: 'A', period: '2026-01', quantity: 100, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-02', quantity: 110, orderType: 'Regular' }
      ]
    );

    const ds2 = createDataset(
      [{ itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }],
      [
        { itemCode: 'A', period: '2026-01', quantity: 100, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-02', quantity: 110, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-03', quantity: 120, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-04', quantity: 130, orderType: 'Regular' }
      ]
    );

    const merged = mergeIncrementalDataset(ds1, ds2);
    expect(merged.salesHistory.length).toBe(4);
    expect(merged.historySummary.incrementalStats?.newObservations).toBe(2);
    expect(merged.historySummary.incrementalStats?.duplicatesIgnored).toBe(2);
  });

  it('TEST 3 - SAME FILE TWICE', () => {
    const ds1 = createDataset(
      [{ itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }],
      [
        { itemCode: 'A', period: '2026-01', quantity: 100, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-02', quantity: 110, orderType: 'Regular' }
      ]
    );
    const merged = mergeIncrementalDataset(ds1, ds1);
    expect(merged.historySummary.incrementalStats?.newObservations).toBe(0);
    expect(merged.historySummary.incrementalStats?.updatedObservations).toBe(0);
    expect(merged.historySummary.incrementalStats?.duplicatesIgnored).toBe(2);
    expect(merged.salesHistory.length).toBe(2);
  });

  it('TEST 4 - CORRECTION', () => {
    const ds1 = createDataset(
      [{ itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }],
      [
        { itemCode: 'A', period: '2026-03', quantity: 100, orderType: 'Regular' }
      ]
    );

    const ds2 = createDataset(
      [{ itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }],
      [
        { itemCode: 'A', period: '2026-03', quantity: 150, orderType: 'Regular' }
      ]
    );

    const merged = mergeIncrementalDataset(ds1, ds2);
    expect(merged.historySummary.incrementalStats?.updatedObservations).toBe(1);
    expect(merged.salesHistory[0].quantity).toBe(150);
  });

  it('TEST 5 - OUT-OF-ORDER OLDER FILE', () => {
    const ds1 = createDataset(
      [{ itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }],
      [
        { itemCode: 'A', period: '2026-01', quantity: 10, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-02', quantity: 20, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-05', quantity: 50, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-06', quantity: 60, orderType: 'Regular' }
      ]
    );

    const ds2 = createDataset(
      [{ itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }],
      [
        { itemCode: 'A', period: '2026-01', quantity: 10, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-02', quantity: 20, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-03', quantity: 30, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-04', quantity: 40, orderType: 'Regular' }
      ]
    );

    const merged = mergeIncrementalDataset(ds1, ds2);
    expect(merged.salesHistory.length).toBe(6);
    expect(merged.salesHistory.find(s => s.period === '2026-05')?.quantity).toBe(50);
    expect(merged.salesHistory.find(s => s.period === '2026-06')?.quantity).toBe(60);
  });

  it('TEST 6 - NEW ITEM', () => {
    const ds1 = createDataset(
      [{ itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }],
      []
    );

    const ds2 = createDataset(
      [{ itemCode: 'B', description: 'Item B', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }],
      []
    );

    const merged = mergeIncrementalDataset(ds1, ds2);
    expect(merged.items.length).toBe(2);
  });

  it('TEST 7 - DIFFERENT HISTORY LENGTHS', () => {
    const ds1 = createDataset(
      [
        { itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' },
        { itemCode: 'B', description: 'Item B', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }
      ],
      [
        { itemCode: 'A', period: '2026-01', quantity: 10, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-02', quantity: 20, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-03', quantity: 30, orderType: 'Regular' },
        { itemCode: 'A', period: '2026-04', quantity: 40, orderType: 'Regular' },
        
        { itemCode: 'B', period: '2026-01', quantity: 100, orderType: 'Regular' },
        { itemCode: 'B', period: '2026-02', quantity: 200, orderType: 'Regular' },
        { itemCode: 'B', period: '2026-03', quantity: 300, orderType: 'Regular' },
        { itemCode: 'B', period: '2026-04', quantity: 400, orderType: 'Regular' },
        { itemCode: 'B', period: '2026-05', quantity: 500, orderType: 'Regular' },
        { itemCode: 'B', period: '2026-06', quantity: 600, orderType: 'Regular' },
        { itemCode: 'B', period: '2026-07', quantity: 700, orderType: 'Regular' },
        { itemCode: 'B', period: '2026-08', quantity: 800, orderType: 'Regular' }
      ]
    );
    const merged = mergeIncrementalDataset(createDataset([], []), ds1);
    expect(merged.historySummary.itemHistoryMap['A']).toBe(4);
    expect(merged.historySummary.itemHistoryMap['B']).toBe(8);
  });

  it('TEST 16 - MULTI-ITEM ISOLATION', () => {
    const ds1 = createDataset(
      [
        { itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' },
        { itemCode: 'B', description: 'Item B', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' }
      ],
      [
        { itemCode: 'A', period: '2026-01', quantity: 10, orderType: 'Regular' },
        { itemCode: 'B', period: '2026-01', quantity: 20, orderType: 'Regular' }
      ]
    );

    const ds2 = createDataset(
      [
        { itemCode: 'A', description: 'Item A', itemGroup: 'G1', uom: 'PCS', leadTimeDays: 0, moq: 0, orderMultiple: 0, planningMethod: 'None', makeBuy: 'Make', defaultVendor: '' },
      ],
      [
        { itemCode: 'A', period: '2026-01', quantity: 50, orderType: 'Regular' }
      ]
    );

    const merged = mergeIncrementalDataset(ds1, ds2);
    expect(merged.salesHistory.find(s => s.itemCode === 'B')?.quantity).toBe(20);
    expect(merged.salesHistory.find(s => s.itemCode === 'A')?.quantity).toBe(50);
  });
});
