import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseExcelWorkbook, mergeIncrementalDataset } from './excelService';

function makeBuffer(rows: any[]) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sales History');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

describe('Phase 3 - Data Integrity', () => {

  it('TEST A & B: same logical key same value (duplicate), different value (CONFLICT)', () => {
    // 100 vs 100 -> ok
    // 150 vs 250 -> conflict
    const data = makeBuffer([
      { ItemCode: 'ITEM-001', Period: '2026-05', Qty: 100, OrderType: 'Regular' },
      { ItemCode: 'ITEM-001', Period: '2026-05', Qty: 100, OrderType: 'Regular' }, // identical
      { ItemCode: 'ITEM-001', Period: '2026-06', Qty: 150, OrderType: 'Regular' },
      { ItemCode: 'ITEM-001', Period: '2026-06', Qty: 250, OrderType: 'Regular' }  // conflict
    ]);
    const result = parseExcelWorkbook(data, 'test.xlsx');
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.stats.conflictingObservations).toBe(1);
    expect(result.errors[0]).toContain('CONFLICT');
  });

  it('TEST C: same item + same month + different order types -> correct monthly demand grain', () => {
    // Different order types for the same month shouldn't conflict, they should be aggregated downstream
    const data = makeBuffer([
      { ItemCode: 'ITEM-002', Period: '2026-05', Qty: 100, OrderType: 'Regular' },
      { ItemCode: 'ITEM-002', Period: '2026-05', Qty: 50, OrderType: 'Project' }
    ]);
    const result = parseExcelWorkbook(data, 'test.xlsx');
    expect(result.success).toBe(true);
    expect(result.stats.salesRecordsCount).toBe(2);
  });

  it('TEST D & E: missing detection vs actual 0', () => {
    const data = makeBuffer([
      { ItemCode: 'ITEM-003', Period: '2026-01', Qty: 10 },
      { ItemCode: 'ITEM-003', Period: '2026-02', Qty: 20 },
      { ItemCode: 'ITEM-003', Period: '2026-03', Qty: 30 },
      // April is missing entirely
      { ItemCode: 'ITEM-003', Period: '2026-05', Qty: 50 },

      { ItemCode: 'ITEM-004', Period: '2026-01', Qty: 10 },
      { ItemCode: 'ITEM-004', Period: '2026-02', Qty: 20 },
      { ItemCode: 'ITEM-004', Period: '2026-03', Qty: 30 },
      { ItemCode: 'ITEM-004', Period: '2026-04', Qty: 0 }, // Actual 0
      { ItemCode: 'ITEM-004', Period: '2026-05', Qty: 50 }
    ]);
    const res = parseExcelWorkbook(data, 'test.xlsx');
    // Mock existing to trigger merge to see incremental stats
    const existing: any = {
      items: [],
      salesHistory: [],
      inventory: [],
      openOrders: [],
      boms: [],
      dataVersion: 1,
      historySummary: { totalMonths: 0, earliestPeriod: '', latestPeriod: '' },
      metadata: { sheetsDetected: [], sourceName: 'empty' }
    };
    const merged = mergeIncrementalDataset(existing, res.dataset!);
    
    const missing = merged.historySummary.incrementalStats!.missingPeriodsMap;
    // ITEM-003 should have April missing
    expect(missing['ITEM-003']).toBeDefined();
    expect(missing['ITEM-003']).toContain('2026-04');
    // ITEM-004 should NOT have April missing
    expect(missing['ITEM-004']).toBeUndefined();
  });

  it('TEST F: invalid record -> invalid count -> not included in forecasting history', () => {
    const data = makeBuffer([
      { ItemCode: 'ITEM-005', Period: '2026-01', Qty: 100 },
      { ItemCode: 'ITEM-005', Period: '2026-02', Qty: 'InvalidString' }
    ]);
    const result = parseExcelWorkbook(data, 'test.xlsx');
    expect(result.stats.invalidObservations).toBe(1);
    expect(result.dataset?.salesHistory.length).toBe(1); // The invalid one is skipped
  });

  it('TEST G: affected item list is correct', () => {
    const data1 = makeBuffer([
      { ItemCode: 'ITEM-001', Period: '2026-01', Qty: 10 },
      { ItemCode: 'ITEM-002', Period: '2026-01', Qty: 20 }
    ]);
    const existing = parseExcelWorkbook(data1, 'd1.xlsx').dataset!;

    // Modify ITEM-001, leave ITEM-002 alone, add ITEM-003
    const data2 = makeBuffer([
      { ItemCode: 'ITEM-001', Period: '2026-01', Qty: 999 }, // modified
      { ItemCode: 'ITEM-003', Period: '2026-01', Qty: 30 }   // new
    ]);
    const incoming = parseExcelWorkbook(data2, 'd2.xlsx').dataset!;

    const merged = mergeIncrementalDataset(existing, incoming);
    const affected = merged.historySummary.incrementalStats!.affectedItems;
    expect(affected).toContain('ITEM-001');
    expect(affected).toContain('ITEM-003');
    // ITEM-002 was not in the incoming dataset, so it shouldn't be affected
    expect(affected).not.toContain('ITEM-002');
  });

});
