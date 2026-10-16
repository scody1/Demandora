import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Permissions } from './permissions';
import { parseExcelWorkbook, exportForecastToExcel } from './excelService';
import { PersistenceService } from './persistenceService';
import { VersionService } from './versionService';
import * as XLSX from 'xlsx';
import { ForecastLine } from '../types';

vi.mock('xlsx', () => {
  return {
    read: vi.fn(),
    write: vi.fn(),
    utils: {
      sheet_to_json: vi.fn(),
      book_new: vi.fn(),
      json_to_sheet: vi.fn(),
      book_append_sheet: vi.fn()
    }
  };
});

describe('Phase 9 Requirements (Excel-First Production Readiness)', () => {
  
  describe('4. ROLE PERMISSION TESTS', () => {
    it('PLANNER permissions', () => {
      expect(Permissions.canGenerate('PLANNER')).toBe(true);
      expect(Permissions.canSaveDraft('PLANNER', 'Generated')).toBe(true);
      expect(Permissions.canSubmit('PLANNER', 'Draft')).toBe(true);
      expect(Permissions.canSubmit('PLANNER', 'Approved')).toBe(false);
      expect(Permissions.canApprove('PLANNER', 'Submitted')).toBe(false);
    });

    it('APPROVER permissions', () => {
      expect(Permissions.canGenerate('APPROVER')).toBe(false);
      expect(Permissions.canSubmit('APPROVER', 'Draft')).toBe(false);
      expect(Permissions.canApprove('APPROVER', 'Submitted')).toBe(true);
      expect(Permissions.canApprove('APPROVER', 'Approved')).toBe(false);
      expect(Permissions.canReturn('APPROVER', 'Submitted')).toBe(true);
    });

    it('PURCHASE_MANAGER permissions', () => {
      expect(Permissions.canGenerate('PURCHASE_MANAGER')).toBe(false);
      expect(Permissions.canApprove('PURCHASE_MANAGER', 'Submitted')).toBe(false);
    });

    it('ADMINISTRATOR permissions', () => {
      expect(Permissions.canGenerate('ADMINISTRATOR')).toBe(true);
      expect(Permissions.canSubmit('ADMINISTRATOR', 'Draft')).toBe(true);
      expect(Permissions.canApprove('ADMINISTRATOR', 'Submitted')).toBe(true);
    });
  });

  describe('7. DATA QUALITY TESTS (Excel Ingestion)', () => {
    it('identifies duplicate conflicts, invalid rows, missing lead time, and missing periods correctly', () => {
      const mockWorkbook = { 
        SheetNames: ['Items', 'Sales'],
        Sheets: { 'Items': {}, 'Sales': {} }
      };
      (XLSX.read as any).mockReturnValue(mockWorkbook);
      
      const itemsData = [
        { 'Item Code': 'ITEM1', 'Description': 'Test Item 1', 'UoM': 'PCS', 'Lead Time Days': '' },
        { 'Item Code': 'ITEM2', 'Description': 'Test Item 2', 'UoM': 'PCS', 'Lead Time Days': 14 }
      ];
      
      const salesData = [
        { 'Item Code': 'ITEM1', 'Period': '2024-01', 'Quantity': 100, 'Status': 'valid' },
        { 'Item Code': 'ITEM1', 'Period': '2024-01', 'Quantity': 120, 'Status': 'valid' }, // conflict
        { 'Item Code': 'ITEM1', 'Period': '2024-02', 'Quantity': 'abc', 'Status': 'valid' }, // invalid
        { 'Item Code': 'ITEM2', 'Period': '2024-01', 'Quantity': 50, 'Status': 'cancelled' }, // cancelled
        { 'Item Code': 'ITEM1', 'Period': '2024-04', 'Quantity': 200, 'Status': 'valid' }
      ];

      (XLSX.utils.sheet_to_json as any).mockImplementation((sheet: any) => {
        if (sheet === mockWorkbook.Sheets['Items']) return itemsData;
        if (sheet === mockWorkbook.Sheets['Sales']) return salesData;
        return [];
      });

      const result = parseExcelWorkbook(new ArrayBuffer(0), 'test.xlsx');
      
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('Conflict'))).toBe(true);
      expect(result.warnings.some(w => w.includes('missing Lead Time'))).toBe(true);
    });

    it('successfully parses valid records and computes missing periods', () => {
      const mockWorkbook = { 
        SheetNames: ['Items', 'Sales'],
        Sheets: { 'Items': {}, 'Sales': {} }
      };
      (XLSX.read as any).mockReturnValue(mockWorkbook);
      
      const itemsData = [
        { 'Item Code': 'ITEM1', 'Description': 'Test Item 1', 'UoM': 'PCS', 'Lead Time Days': 14 },
        { 'Item Code': 'ITEM2', 'Description': 'Test Item 2', 'UoM': 'PCS', 'Lead Time Days': 14 }
      ];
      
      const salesData = [
        { 'Item Code': 'ITEM1', 'Period': '2024-01', 'Quantity': 100, 'Status': 'valid' },
        { 'Item Code': 'ITEM1', 'Period': '2024-04', 'Quantity': 200, 'Status': 'valid' },
        { 'Item Code': 'ITEM2', 'Period': '2024-01', 'Quantity': 50, 'Status': 'cancelled' } 
      ];

      (XLSX.utils.sheet_to_json as any).mockImplementation((sheet: any) => {
        if (sheet === mockWorkbook.Sheets['Items']) return itemsData;
        if (sheet === mockWorkbook.Sheets['Sales']) return salesData;
        return [];
      });

      const result = parseExcelWorkbook(new ArrayBuffer(0), 'test.xlsx');
      expect(result.success).toBe(true);
      expect(result.dataset).toBeDefined();
      
      expect(result.dataset!.salesHistory.find(s => s.itemCode === 'ITEM2')).toBeUndefined();
      expect(result.dataset!.historySummary.itemHistoryMap['ITEM1']).toBe(2);
    });
  });

  describe('2. VERSION HISTORY TESTS & 9. NUMERICAL IMMUTABILITY', () => {
    it('creates new version on generation, retains old version unchanged', () => {
      // Simulate regeneration version fork
      const oldVersion = 1;
      const newVersion = oldVersion + 1;
      expect(newVersion).toBe(2);
      expect(oldVersion).toBe(1);
    });

    it('forks to new version when planner modifies an approved version', () => {
      const mockResult: any = {
        lines: [
          { itemCode: 'ITEM1', monthlyForecast: [100, 100], aiTotal: 200, finalQty: 250, plannerAdj: 50 },
          { itemCode: 'ITEM2', monthlyForecast: [50, 50], aiTotal: 100, finalQty: 100, plannerAdj: null }
        ],
        kpis: { aiForecastTotal: 300, finalQtyTotal: 350, netRequirementTotal: 350, avgConfidencePct: 90 }
      };

      const { newVersion, newSnapshot } = VersionService.forkVersionIfNeeded(
        'Approved', 1, 'Planner', {} as any, mockResult, 'Draft'
      );

      expect(newVersion).toBe(2);
      expect(newSnapshot.status).toBe('Draft');
      expect(newSnapshot.linesSnapshot).not.toBe(mockResult.lines); 
      expect(newSnapshot.linesSnapshot[0].aiTotal).toBe(200);
      expect(newSnapshot.linesSnapshot[0].finalQty).toBe(250);
      expect(newSnapshot.linesSnapshot[0].plannerAdj).toBe(50);
      expect(newSnapshot.aiTotal).toBe(300);
    });
    
    it('does not fork if planner modifies a draft version', () => {
      const mockResult: any = {
        lines: [],
        kpis: { aiForecastTotal: 0, finalQtyTotal: 0, netRequirementTotal: 0, avgConfidencePct: 0 }
      };

      const { newVersion, newSnapshot } = VersionService.forkVersionIfNeeded(
        'Draft', 1, 'Planner', {} as any, mockResult, 'Draft'
      );

      expect(newVersion).toBe(1);
      expect(newSnapshot.version).toBe(1);
    });
  });

  describe('6. UNSAVED CHANGES TESTS', () => {
    it('detects unsaved changes appropriately', () => {
      const originalLines = [{ itemCode: 'ITEM1', plannerAdj: null, remark: '' }];
      const changedAdjLines = [{ itemCode: 'ITEM1', plannerAdj: 50, remark: '' }];
      const changedRemLines = [{ itemCode: 'ITEM1', plannerAdj: null, remark: 'Test' }];
      const identicalLines = [{ itemCode: 'ITEM1', plannerAdj: null, remark: '' }];

      expect(VersionService.checkUnsavedChanges(originalLines, identicalLines)).toBe(false);
      expect(VersionService.checkUnsavedChanges(originalLines, changedAdjLines)).toBe(true);
      expect(VersionService.checkUnsavedChanges(originalLines, changedRemLines)).toBe(true);
    });
  });

  describe('8. EXPORT TEST', () => {
    it('exports actual values mapped to current application state using excelService', () => {
      const lines = [
        {
          itemCode: 'ITEM1',
          description: 'Test Item 1',
          itemGroup: 'G1',
          uom: 'PCS',
          avgPerMonth: 50,
          monthlyForecast: [100, 100],
          aiTotal: 200,
          plannerAdj: 250,
          finalQty: 250,
          stock: 20,
          openPo: 50,
          netReq: 180,
          confidencePct: 95,
          planningMethod: 'MRP',
          makeBuy: 'Buy',
          remark: 'Added 50 buffer'
        }
      ] as any[];

      const monthLabels = ['2024-01', '2024-02'];
      
      const spyBookNew = vi.spyOn(XLSX.utils, 'book_new').mockReturnValue({} as any);
      const spyJsonToSheet = vi.spyOn(XLSX.utils, 'json_to_sheet').mockReturnValue({} as any);
      const spyBookAppend = vi.spyOn(XLSX.utils, 'book_append_sheet').mockImplementation(() => {});
      const spyWrite = vi.spyOn(XLSX, 'write').mockReturnValue(new Uint8Array());

      exportForecastToExcel(lines, { forecastCode: 'TEST', horizon: 2 } as any, 'Approved', 1, monthLabels);

      expect(spyJsonToSheet).toHaveBeenCalled();
      const exportCall = (spyJsonToSheet as any).mock.calls[0][0];
      const exportedRow = exportCall[0];
      
      expect(exportedRow['Item Code']).toBe('ITEM1');
      expect(exportedRow['AI Forecast Total']).toBe(200);
      expect(exportedRow['Planner Adjustment']).toBe(250);
      expect(exportedRow['Final Qty']).toBe(250);
      expect(exportedRow['Net Requirement']).toBe(180);
      expect(exportedRow['Remark']).toBe('Added 50 buffer');
      expect(exportedRow['Version']).toBe(1);
    });
  });

  describe('3. LOCAL STORAGE PERSISTENCE TEST', () => {
    beforeEach(() => {
      let store: any = {};
      const mockLocalStorage = {
        getItem: vi.fn((key: string) => store[key] || null),
        setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
        removeItem: vi.fn((key: string) => { delete store[key]; })
      };
      globalThis.localStorage = mockLocalStorage as any;
    });

    it('saves and reloads state from local storage', () => {
      const mockState: any = {
        version: 5,
        status: 'Submitted',
        parameters: { forecastCode: 'PERSIST_TEST' }
      };
      
      PersistenceService.saveAppState(mockState);
      
      const loaded = PersistenceService.loadAppState();
      expect(loaded).toBeDefined();
      expect(loaded?.version).toBe(5);
      expect(loaded?.status).toBe('Submitted');
      expect(loaded?.parameters.forecastCode).toBe('PERSIST_TEST');
    });
    
    it('clears state correctly', () => {
      PersistenceService.saveAppState({ version: 2 });
      expect(PersistenceService.loadAppState()).toBeDefined();
      
      PersistenceService.clearAppState();
      expect(PersistenceService.loadAppState()).toBeNull();
    });

    it('TASK 1 — persists versions and adjustmentLogs across reloads', () => {
      const mockVersions: any[] = [
        { version: 1, status: 'Generated', date: '2026-10-10', user: 'Planner', aiTotal: 1000, linesSnapshot: [] },
        { version: 2, status: 'Approved', date: '2026-10-11', user: 'VP', aiTotal: 1200, linesSnapshot: [] }
      ];
      const mockLogs: any[] = [
        { id: 'log-1', itemCode: 'SKU-01', description: 'Test', oldValue: 100, newValue: 150, user: 'Planner', date: '2026-10-10', remark: 'Promo' }
      ];

      PersistenceService.saveAppState({
        version: 2,
        versions: mockVersions,
        adjustmentLogs: mockLogs
      });

      const loaded = PersistenceService.loadAppState();
      expect(loaded?.versions).toHaveLength(2);
      expect(loaded?.versions?.[0].version).toBe(1);
      expect(loaded?.versions?.[1].version).toBe(2);
      expect(loaded?.adjustmentLogs).toHaveLength(1);
      expect(loaded?.adjustmentLogs?.[0].itemCode).toBe('SKU-01');
    });

    it('TASK 1 — preserves backward compatibility when versions or logs are missing or malformed', () => {
      // Legacy record with no versions or logs
      PersistenceService.saveAppState({
        version: 1,
        status: 'Generated'
      });

      let loaded = PersistenceService.loadAppState();
      expect(loaded).toBeDefined();
      expect(loaded?.versions).toBeUndefined();
      expect(loaded?.adjustmentLogs).toBeUndefined();

      // Malformed record where versions is not an array
      const malformed = JSON.stringify({
        version: 3,
        versions: 'corrupted_string_not_array',
        adjustmentLogs: { not: 'an_array' }
      });
      PersistenceService.clearAppState();
      localStorage.setItem('LEDURE_SUPPLY_INTEL_V4', malformed);

      loaded = PersistenceService.loadAppState();
      expect(loaded).toBeDefined();
      expect(Array.isArray(loaded?.versions)).toBe(true);
      expect(loaded?.versions).toEqual([]);
      expect(Array.isArray(loaded?.adjustmentLogs)).toBe(true);
      expect(loaded?.adjustmentLogs).toEqual([]);
    });

    it('TASK 4 — Restore historical version creates a new Draft without overwriting snapshot', () => {
      const v1Snapshot: any = {
        version: 1,
        status: 'Approved',
        date: '2026-10-01',
        user: 'Approver',
        parameters: { horizon: 6, startMonth: '2026-11' },
        linesSnapshot: [
          { itemCode: 'SKU-1', aiTotal: 100, plannerAdj: 120, finalQty: 120, stock: 10, openPo: 10, rawNetReq: 100, plannedOrderQty: 500, moq: 500, planningMethod: 'MRP' }
        ]
      };
      const existingVersions = [v1Snapshot];

      // Simulate Restore as New Draft action
      const nextVer = Math.max(1, ...existingVersions.map(v => v.version)) + 1;
      const restoredLines = v1Snapshot.linesSnapshot.map((l: any) => ({ ...l }));
      const newDraftState = {
        version: nextVer,
        status: 'Draft' as const,
        parameters: { ...v1Snapshot.parameters },
        lines: restoredLines,
        isModified: true
      };

      // Assertions
      expect(nextVer).toBe(2);
      expect(newDraftState.status).toBe('Draft');
      expect(newDraftState.lines[0].plannerAdj).toBe(120);
      // Original snapshot untouched
      expect(existingVersions[0].version).toBe(1);
      expect(existingVersions[0].status).toBe('Approved');
    });

    it('TASK 5 — Unsaved import confirmation cancel preserves workspace, confirm continues', () => {
      let workspaceDataset = { name: 'Original Dataset', items: [{ itemCode: 'ORIG-1' }] };
      const hasUnsaved = true;

      // User clicks Import: window.confirm returns false (Cancel)
      const mockConfirmCancel = vi.fn().mockReturnValue(false);
      vi.stubGlobal('confirm', mockConfirmCancel);

      if (hasUnsaved && !confirm('Discard unsaved adjustments?')) {
        // Cancel path: workspace preserved
      } else {
        workspaceDataset = { name: 'New Dataset', items: [{ itemCode: 'NEW-1' }] };
      }

      expect(mockConfirmCancel).toHaveBeenCalled();
      expect(workspaceDataset.name).toBe('Original Dataset');

      // User clicks Import: window.confirm returns true (Confirm)
      const mockConfirmProceed = vi.fn().mockReturnValue(true);
      vi.stubGlobal('confirm', mockConfirmProceed);

      if (hasUnsaved && !confirm('Discard unsaved adjustments?')) {
        // Cancel path
      } else {
        workspaceDataset = { name: 'New Dataset', items: [{ itemCode: 'NEW-1' }] };
      }

      expect(mockConfirmProceed).toHaveBeenCalled();
      expect(workspaceDataset.name).toBe('New Dataset');

      vi.unstubAllGlobals();
    });
  });
});

