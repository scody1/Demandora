import { describe, it, expect } from 'vitest';
import { parseExcelWorkbook } from './excelService';
import type { SalesHistoryRecord } from '../types';
import * as XLSX from 'xlsx';

describe('Historical Data Detection & Wide-Table Parsing', () => {
  it('TEST 1 & 8: Workbook with 3 valid historical periods should return historyMonths = 3', async () => {
    // Create a mock workbook with 3 months
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item Code', 'Description', 'Item Group', 'Mar-2026', 'April 2026', '2026-05'],
      ['SKU-1', 'Desc 1', 'Group 1', 2376, 1615, 2425],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    
    const { dataset } = parseExcelWorkbook(buffer) as any;
    expect(dataset.items.length).toBe(1);
    expect(dataset.salesHistory.length).toBe(3);
    
    // Check history summary
    expect(dataset.historySummary?.totalMonths).toBe(3);
    expect(dataset.historySummary?.itemHistoryMap['SKU-1']).toBe(3);
  });

  it('TEST 2: Workbook with 0 historical observations', async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item Code', 'Description', 'Item Group'],
      ['SKU-1', 'Desc 1', 'Group 1'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    
    const { dataset } = parseExcelWorkbook(buffer) as any;
    expect(dataset.salesHistory.length).toBe(0);
    expect(dataset.historySummary?.totalMonths).toBe(0);
    expect(dataset.historySummary?.itemHistoryMap['SKU-1']).toBe(0);
  });

  it('TEST 3: Workbook with exactly 6 historical periods', async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item Code', 'Jan-26', 'Feb-26', 'Mar-26', 'Apr-26', 'May-26', 'Jun-26'],
      ['SKU-1', 10, 20, 30, 40, 50, 60],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    
    const { dataset } = parseExcelWorkbook(buffer) as any;
    expect(dataset.salesHistory.length).toBe(6);
    expect(dataset.historySummary?.itemHistoryMap['SKU-1']).toBe(6);
  });

  it('TEST 4: Workbook with 12 historical periods', async () => {
    const wb = XLSX.utils.book_new();
    const header = ['Item Code'];
    const row = ['SKU-1'];
    for (let i = 1; i <= 12; i++) {
        header.push(`2026-${i.toString().padStart(2, '0')}`);
        row.push('100');
    }
    const ws = XLSX.utils.aoa_to_sheet([header, row]);
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    
    const { dataset } = parseExcelWorkbook(buffer) as any;
    expect(dataset.salesHistory.length).toBe(12);
    expect(dataset.historySummary?.itemHistoryMap['SKU-1']).toBe(12);
  });

  it('TEST 5: A historical month with quantity = 0 counts as an observation', async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item Code', 'Mar-26', 'Apr-26', 'May-26'],
      ['SKU-1', 0, 100, 150],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    
    const { dataset } = parseExcelWorkbook(buffer) as any;
    expect(dataset.salesHistory.length).toBe(3); // The 0 is included
    expect(dataset.salesHistory.find((h: SalesHistoryRecord) => h.period.endsWith('-03'))?.quantity).toBe(0);
  });

  it('TEST 6: A missing historical period is skipped and not silently zeroed', async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item Code', 'Mar-26', 'Apr-26', 'May-26'],
      ['SKU-1', 10, null, 150], // Apr-26 is missing
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    
    const { dataset } = parseExcelWorkbook(buffer) as any;
    expect(dataset.salesHistory.length).toBe(2);
    expect(dataset.historySummary?.itemHistoryMap['SKU-1']).toBe(2);
  });

  it('TEST 7: Wide table sales sheet parsing fallback works', async () => {
    const wb = XLSX.utils.book_new();
    // No explicit 'Sales' sheet, but we can put it in 'Sales' with wide format
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item Code', 'Mar-26', 'Apr-26', 'May-26'],
      ['SKU-1', 50, 60, 70],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sales Data');
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    
    const { dataset } = parseExcelWorkbook(buffer) as any;
    expect(dataset.salesHistory.length).toBe(3);
    expect(dataset.historySummary?.itemHistoryMap['SKU-1']).toBe(3);
  });
});
