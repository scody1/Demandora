/**
 * REGRESSION TEST: SAMPLE SALE DATA (1).xlsx
 *
 * Tests that the actual Excel workbook uploaded by the user
 * is parsed correctly with the correct history span and values.
 *
 * DO NOT replace with a synthetic workbook.
 * This test is data-driven against the real file.
 */
import { describe, it, expect } from 'vitest';
import { parseExcelWorkbook } from './excelService';
import type { SalesHistoryRecord } from '../types';
import * as fs from 'fs';
import * as path from 'path';

describe('REGRESSION: SAMPLE SALE DATA (1).xlsx', () => {
  const fixturePath = path.join(__dirname, 'testdata', 'SAMPLE_SALE_DATA.xlsx');

  it('FIXTURE: test fixture file exists', () => {
    expect(fs.existsSync(fixturePath)).toBe(true);
  });

  const getResult = () => {
    const buf = fs.readFileSync(fixturePath);
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return parseExcelWorkbook(arrayBuffer, 'SAMPLE SALE DATA (1).xlsx');
  };

  it('REG-01: Workbook loads successfully without errors', () => {
    const result = getResult();
    // May have warnings but should NOT have errors that prevent dataset from loading
    expect(result.dataset).not.toBeNull();
  });

  it('REG-02: 27 SKU records are detected', () => {
    const result = getResult();
    expect(result.dataset).not.toBeNull();
    expect(result.dataset!.items.length).toBe(27);
  });

  it('REG-03: 81 sales observations are detected (27 SKUs × 3 months)', () => {
    const result = getResult();
    expect(result.dataset).not.toBeNull();
    expect(result.dataset!.salesHistory.length).toBe(81);
  });

  it('REG-04: Total historical span = 3 months', () => {
    const result = getResult();
    expect(result.dataset).not.toBeNull();
    expect(result.dataset!.historySummary.totalMonths).toBe(3);
  });

  it('REG-05: Earliest period = 2026-03', () => {
    const result = getResult();
    expect(result.dataset).not.toBeNull();
    expect(result.dataset!.historySummary.earliestPeriod).toBe('2026-03');
  });

  it('REG-06: Latest period = 2026-05', () => {
    const result = getResult();
    expect(result.dataset).not.toBeNull();
    expect(result.dataset!.historySummary.latestPeriod).toBe('2026-05');
  });

  it('REG-07: SKU 29053FG has exactly 3 months of history', () => {
    const result = getResult();
    expect(result.dataset).not.toBeNull();
    const histMap = result.dataset!.historySummary.itemHistoryMap;
    expect(histMap['29053FG']).toBe(3);
  });

  it('REG-08: SKU 29053FG has correct values: 2026-03=2376, 2026-04=1615, 2026-05=2425', () => {
    const result = getResult();
    expect(result.dataset).not.toBeNull();
    const history = result.dataset!.salesHistory.filter(
      (h: SalesHistoryRecord) => h.itemCode === '29053FG'
    );
    expect(history.length).toBe(3);

    const mar = history.find((h: SalesHistoryRecord) => h.period === '2026-03');
    const apr = history.find((h: SalesHistoryRecord) => h.period === '2026-04');
    const may = history.find((h: SalesHistoryRecord) => h.period === '2026-05');

    expect(mar).toBeDefined();
    expect(apr).toBeDefined();
    expect(may).toBeDefined();
    expect(mar!.quantity).toBe(2376);
    expect(apr!.quantity).toBe(1615);
    expect(may!.quantity).toBe(2425);
  });

  it('REG-09: 3 months is in the <6M "No AI Forecast" tier (FSD rule preserved)', () => {
    const result = getResult();
    expect(result.dataset).not.toBeNull();
    const totalMonths = result.dataset!.historySummary.totalMonths;
    // FSD: <6 months → No AI Forecast / Insufficient History
    // 3 months MUST NOT trigger normal AI forecasting
    expect(totalMonths).toBeLessThan(6);
  });

  it('REG-10: No SKU has more than 3 months of history (data integrity check)', () => {
    const result = getResult();
    expect(result.dataset).not.toBeNull();
    const histMap = result.dataset!.historySummary.itemHistoryMap;
    for (const [sku, months] of Object.entries(histMap)) {
      expect(months).toBeLessThanOrEqual(3);
    }
  });
});
