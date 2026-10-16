import React, { useState, useRef, useMemo } from 'react';
import {
  FileSpreadsheet,
  Upload,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Download,
  Database,
  FileCheck2,
  Table,
  Check,
  RotateCcw,
  Sparkles,
  GitMerge,
  Layers,
  Calendar,
  RefreshCw
} from 'lucide-react';
import { Modal, formatNumber } from './UI';
import {
  parseExcelWorkbook,
  mergeIncrementalDataset,
  downloadExcelTemplate,
  isSheetDetected,
  INVENTORY_SHEET_ALIASES,
  ORDERS_SHEET_ALIASES,
  BOM_SHEET_ALIASES,
  IngestionResult
} from '../services/excelService';
import { NormalizedDataset } from '../types';

interface ExcelImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDatasetImported: (dataset: NormalizedDataset) => void;
  existingDataset?: NormalizedDataset | null;
}

export function ExcelImportModal({
  isOpen,
  onClose,
  onDatasetImported,
  existingDataset = null
}: ExcelImportModalProps) {
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [fileName, setFileName] = useState<string>('');
  const [rawImportResult, setRawImportResult] = useState<IngestionResult | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [ingestionMode, setIngestionMode] = useState<'replace' | 'merge'>(existingDataset ? 'merge' : 'replace');
  const [isReplaceInventory, setIsReplaceInventory] = useState<boolean>(false);
  const [isReplaceOrders, setIsReplaceOrders] = useState<boolean>(false);
  const [isReplaceBoms, setIsReplaceBoms] = useState<boolean>(false);
  const [confirmEmptyInventory, setConfirmEmptyInventory] = useState<boolean>(false);
  const [confirmEmptyOrders, setConfirmEmptyOrders] = useState<boolean>(false);
  const [confirmEmptyBoms, setConfirmEmptyBoms] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleReset = () => {
    setCurrentStep(1);
    setFileName('');
    setRawImportResult(null);
    setIsProcessing(false);
    setIngestionMode(existingDataset ? 'merge' : 'replace');
    setIsReplaceInventory(false);
    setIsReplaceOrders(false);
    setIsReplaceBoms(false);
    setConfirmEmptyInventory(false);
    setConfirmEmptyOrders(false);
    setConfirmEmptyBoms(false);
  };

  const handleClose = () => {
    handleReset();
    onClose();
  };

  const processWorkbookBinary = (binary: ArrayBuffer | Uint8Array, name: string, isDemo = false) => {
    setIsProcessing(true);
    setFileName(name);

    setTimeout(() => {
      const result = parseExcelWorkbook(binary, name, isDemo);
      setRawImportResult(result);
      setIsProcessing(false);

      if (result.success && result.dataset) {
        setCurrentStep(2); // Move to Step 2: Detect
      }
    }, 400);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (evt.target?.result) {
          processWorkbookBinary(evt.target.result as ArrayBuffer, file.name);
        }
      };
      reader.readAsArrayBuffer(file);
    }
  };

  // Final Dataset resolution (Merged vs Replaced)
  const resolvedDataset = useMemo<NormalizedDataset | null>(() => {
    if (!rawImportResult?.dataset) return null;
    if (ingestionMode === 'merge' && existingDataset) {
      return mergeIncrementalDataset(existingDataset, rawImportResult.dataset, {
        isReplaceInventory,
        isReplaceOrders,
        isReplaceBoms,
        confirmedEmptyReplacement: {
          inventory: confirmEmptyInventory,
          orders: confirmEmptyOrders,
          boms: confirmEmptyBoms
        }
      });
    }
    return rawImportResult.dataset;
  }, [
    rawImportResult,
    ingestionMode,
    existingDataset,
    isReplaceInventory,
    isReplaceOrders,
    isReplaceBoms,
    confirmEmptyInventory,
    confirmEmptyOrders,
    confirmEmptyBoms
  ]);

  const handleFinalImport = () => {
    if (resolvedDataset) {
      onDatasetImported(resolvedDataset);
      handleClose();
    }
  };

  const historySummary = resolvedDataset?.historySummary || rawImportResult?.dataset?.historySummary;
  const incStats = historySummary?.incrementalStats;

  return (
    <Modal
      isOpen={isOpen}
      title="Data-Length-Aware Excel Ingestion Pipeline"
      onClose={handleClose}
      maxWidth="820px"
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <div>
            {currentStep > 1 && currentStep < 5 && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setCurrentStep((prev) => (prev > 1 ? ((prev - 1) as any) : 1))}
                style={{ fontSize: 12 }}
              >
                ← Back
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="btn-ghost"
              onClick={handleClose}
              style={{ fontSize: 12 }}
            >
              Cancel
            </button>

            {currentStep === 2 && (
              <button
                type="button"
                className="btn-ai"
                onClick={() => setCurrentStep(3)}
                style={{ fontSize: 12 }}
              >
                <span>Review Column Mappings →</span>
              </button>
            )}

            {currentStep === 3 && (
              <button
                type="button"
                className="btn-ai"
                onClick={() => setCurrentStep(4)}
                style={{ fontSize: 12 }}
              >
                <span>Validate & Detect History →</span>
              </button>
            )}

            {currentStep === 4 && (
              <button
                type="button"
                className="btn-ai"
                onClick={() => setCurrentStep(5)}
                disabled={!rawImportResult?.success}
                style={{ fontSize: 12 }}
              >
                <span>Review Ingestion & Deduplication</span>
                <ArrowRight size={13} />
              </button>
            )}

            {currentStep === 5 && (
              <button
                type="button"
                className="btn-ai"
                onClick={handleFinalImport}
                style={{ fontSize: 12, padding: '7px 18px' }}
              >
                <Sparkles size={14} />
                <span>Launch Forecast Workspace (v{resolvedDataset?.dataVersion || 1}) →</span>
              </button>
            )}
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Step Indicator */}
        <div className="import-steps-indicator">
          {[
            { step: 1, label: 'Upload' },
            { step: 2, label: 'Detect' },
            { step: 3, label: 'Map' },
            { step: 4, label: 'Validate History' },
            { step: 5, label: 'Merge & Ingest' }
          ].map((s) => (
            <div
              key={s.step}
              className={`import-step-item ${currentStep === s.step ? 'active' : currentStep > s.step ? 'completed' : ''}`}
            >
              <div className="step-number-circle">
                {currentStep > s.step ? <Check size={12} /> : s.step}
              </div>
              <span className="step-label-text">{s.label}</span>
            </div>
          ))}
        </div>

        {/* STEP 1: UPLOAD */}
        {currentStep === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Upload your supply-chain planning workbook in <strong>.xlsx</strong> format. The engine dynamically detects actual historical telemetry (4M, 11M, 24M, 37M) without assuming fixed 24 months.
            </p>

            {existingDataset && (
              <div style={{ background: '#f8fafc', border: '1px solid var(--border-medium)', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                    Active Dataset: v{existingDataset.dataVersion} ({existingDataset.historySummary?.totalMonths || 24}M History, {existingDataset.items.length} SKUs)
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                    Span: {existingDataset.historySummary?.earliestPeriod} to {existingDataset.historySummary?.latestPeriod}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    className={`btn-ghost ${ingestionMode === 'merge' ? 'active' : ''}`}
                    onClick={() => setIngestionMode('merge')}
                    style={{ fontSize: 11, padding: '4px 10px', background: ingestionMode === 'merge' ? 'var(--ai-subtle)' : 'transparent', borderColor: ingestionMode === 'merge' ? 'var(--ai-border)' : 'var(--border-subtle)', color: ingestionMode === 'merge' ? 'var(--ai-primary)' : 'inherit', fontWeight: ingestionMode === 'merge' ? 700 : 500 }}
                  >
                    <GitMerge size={12} />
                    <span>Incremental Merge (v{existingDataset.dataVersion + 1})</span>
                  </button>
                  <button
                    type="button"
                    className={`btn-ghost ${ingestionMode === 'replace' ? 'active' : ''}`}
                    onClick={() => setIngestionMode('replace')}
                    style={{ fontSize: 11, padding: '4px 10px', background: ingestionMode === 'replace' ? '#fef2f2' : 'transparent', borderColor: ingestionMode === 'replace' ? '#fecaca' : 'var(--border-subtle)', color: ingestionMode === 'replace' ? '#991b1b' : 'inherit', fontWeight: ingestionMode === 'replace' ? 700 : 500 }}
                  >
                    <RefreshCw size={12} />
                    <span>Replace Entire Dataset</span>
                  </button>
                </div>
              </div>
            )}

            <input
              type="file"
              ref={fileInputRef}
              accept=".xlsx, .xls, .xlsm, .csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
              style={{ display: 'none' }}
              onChange={handleFileInputChange}
            />

            <div
              className="import-dropzone"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                  const file = e.dataTransfer.files[0];
                  const reader = new FileReader();
                  reader.onload = (evt) => {
                    if (evt.target?.result) {
                      processWorkbookBinary(evt.target.result as ArrayBuffer, file.name);
                    }
                  };
                  reader.readAsArrayBuffer(file);
                }
              }}
            >
              <FileSpreadsheet size={40} color="var(--ai-primary)" />
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
                {isProcessing ? 'Analyzing Excel workbook structure & telemetry...' : 'Drop Excel workbook here, or click to browse'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                Supported formats: <strong>.xlsx</strong>, <strong>.xls</strong>, <strong>.xlsm</strong>, <strong>.csv</strong>
              </div>
            </div>

            {/* Ingestion Error Alert if parsing had issues */}
            {rawImportResult && !rawImportResult.success && rawImportResult.errors.length > 0 && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 14px', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#991b1b', fontWeight: 700 }}>
                  <AlertTriangle size={15} color="#dc2626" />
                  <span>File Ingestion Error in {fileName}</span>
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, color: '#b91c1c', fontSize: 11.5 }}>
                  {rawImportResult.errors.map((err, idx) => (
                    <li key={idx}>{err}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Requirement 8: Adaptive Historical Demand Specification */}
            <div style={{ background: '#f8fafc', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <Sparkles size={16} color="var(--ai-primary)" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong style={{ fontSize: 12, color: 'var(--text-primary)', display: 'block', marginBottom: 2 }}>
                  Historical Demand
                </strong>
                <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  Monthly demand history by SKU. The forecasting engine automatically adapts to the amount of historical data available.
                </span>
              </div>
            </div>

            {/* Quick Options */}
            <div className="import-quick-options">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>

                <button
                  type="button"
                  className="btn-ghost"
                  onClick={downloadExcelTemplate}
                  style={{ fontSize: 11.5 }}
                >
                  <Download size={13} />
                  <span>Blank Template</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: DETECT SHEETS */}
        {currentStep === 2 && rawImportResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <h4 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Workbook Sheets Detected</h4>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  File: <strong>{fileName}</strong> · {rawImportResult.stats.detectedSheets.length} sheets recognized
                </p>
              </div>
              <span className="badge-pill green">
                <Check size={12} /> Format Validated
              </span>
            </div>

            <div className="sheet-detect-grid">
              {rawImportResult.stats.detectedSheets.map((sheet, i) => (
                <div key={i} className="sheet-detect-card">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <CheckCircle2 size={18} color="var(--success)" />
                    <div>
                      <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{sheet}</strong>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {sheet.toLowerCase().includes('item')
                          ? `${rawImportResult.stats.itemsCount} SKUs parsed`
                          : sheet.toLowerCase().includes('sales')
                          ? `${formatNumber(rawImportResult.stats.salesRecordsCount)} monthly observations`
                          : sheet.toLowerCase().includes('inv')
                          ? `${rawImportResult.stats.inventoryCount} warehouse positions`
                          : sheet.toLowerCase().includes('order')
                          ? `${rawImportResult.stats.openOrdersCount} open orders`
                          : sheet.toLowerCase().includes('bom')
                          ? `${rawImportResult.stats.bomsCount} component links`
                          : 'Benchmark records'}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* STEP 3: COLUMN MAPPINGS */}
        {currentStep === 3 && rawImportResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <h4 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Recognized Column Mappings</h4>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Fuzzy header aliases automatically linked to the normalized supply chain schema
              </p>
            </div>

            <div className="modern-table-container" style={{ maxHeight: 280, overflowY: 'auto' }}>
              <table className="modern-data-table">
                <thead>
                  <tr>
                    <th>Sheet</th>
                    <th>Excel Column Header</th>
                    <th>Application Field</th>
                    <th>Sample Value</th>
                    <th style={{ textAlign: 'center' }}>Mapping Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rawImportResult.detectedMappings.map((m, idx) => (
                    <tr key={idx}>
                      <td style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{m.sheetName}</td>
                      <td><strong>{m.excelColumn}</strong></td>
                      <td style={{ color: 'var(--ai-primary)', fontWeight: 600 }}>{m.mappedField}</td>
                      <td className="num" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{m.sampleValue}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span className="badge-pill green" style={{ fontSize: 10 }}>
                          ✓ Mapped
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* STEP 4: VALIDATE & DYNAMIC HISTORY DETECTION */}
        {currentStep === 4 && rawImportResult && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <h4 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                Dynamic History Detection & Data Quality Check
              </h4>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Calculated directly from actual transaction timestamps without assuming a 24-month default
              </p>
            </div>

            {/* Dynamic Telemetry Metric Cards */}
            <div className="validation-summary-grid">
              <div className="validation-stat-box">
                <span className="v-label">Available History</span>
                <span className="v-num" style={{ color: 'var(--ai-primary)' }}>
                  {historySummary?.totalMonths || rawImportResult.stats.historyMonthsSpan} Mo.
                </span>
              </div>
              <div className="validation-stat-box">
                <span className="v-label">Date Span</span>
                <span className="v-num" style={{ fontSize: 13 }}>
                  {historySummary ? `${historySummary.earliestPeriod} → ${historySummary.latestPeriod}` : 'Dynamic'}
                </span>
              </div>
              <div className="validation-stat-box">
                <span className="v-label">Total Observations</span>
                <span className="v-num">{formatNumber(historySummary?.totalObservations || rawImportResult.stats.salesRecordsCount)}</span>
              </div>
              <div className="validation-stat-box">
                <span className="v-label">Items with History</span>
                <span className="v-num">{formatNumber(historySummary?.itemsWithHistory || rawImportResult.stats.itemsCount)}</span>
              </div>
              <div className="validation-stat-box">
                <span className="v-label">Open PO / SO</span>
                <span className="v-num">{rawImportResult.stats.openOrdersCount}</span>
              </div>
              <div className="validation-stat-box">
                <span className="v-label">BOM Components</span>
                <span className="v-num">{rawImportResult.stats.bomsCount}</span>
              </div>
            </div>

            {/* Mode Confirmation & Explicit Replacement Semantics */}
            {existingDataset && (
              <div style={{ background: '#f8fafc', border: '1px solid var(--border-medium)', borderRadius: 8, padding: '12px 14px', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <strong>Ingestion Strategy:</strong>
                    <div style={{ color: ingestionMode === 'merge' ? 'var(--ai-primary)' : '#991b1b', fontWeight: 700, marginTop: 2 }}>
                      {ingestionMode === 'merge' ? 'Incremental Merge (Preserve & Update)' : 'Replace Entire Dataset (Full Reset)'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className={`btn-ghost ${ingestionMode === 'merge' ? 'active' : ''}`}
                      onClick={() => setIngestionMode('merge')}
                      style={{ fontSize: 11, padding: '4px 8px' }}
                    >
                      Merge
                    </button>
                    <button
                      type="button"
                      className={`btn-ghost ${ingestionMode === 'replace' ? 'active' : ''}`}
                      onClick={() => setIngestionMode('replace')}
                      style={{ fontSize: 11, padding: '4px 8px' }}
                    >
                      Full Replace
                    </button>
                  </div>
                </div>

                {ingestionMode === 'merge' && (
                  <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8, marginTop: 4 }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
                      Supply & BOM Synchronization Policy:
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={isReplaceInventory}
                          onChange={(e) => {
                            setIsReplaceInventory(e.target.checked);
                            if (!e.target.checked) setConfirmEmptyInventory(false);
                          }}
                        />
                        <span>
                          <strong>Complete Inventory Replacement</strong> (remove positions absent from this upload; retained if sheet is absent)
                        </span>
                      </label>
                      {isReplaceInventory && isSheetDetected(rawImportResult.stats.detectedSheets, INVENTORY_SHEET_ALIASES) && rawImportResult.stats.inventoryCount === 0 && (
                        <div style={{ marginLeft: 24, padding: '6px 10px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 6, fontSize: 11 }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#92400e', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={confirmEmptyInventory}
                              onChange={(e) => setConfirmEmptyInventory(e.target.checked)}
                            />
                            <span><strong>Confirm Empty Replacement:</strong> Inventory sheet is present with 0 valid records. Check to confirm clearing all existing inventory positions.</span>
                          </label>
                        </div>
                      )}

                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={isReplaceOrders}
                          onChange={(e) => {
                            setIsReplaceOrders(e.target.checked);
                            if (!e.target.checked) setConfirmEmptyOrders(false);
                          }}
                        />
                        <span>
                          <strong>Complete Open Orders Replacement</strong> (remove PO/SO records absent from this upload; retained if sheet is absent)
                        </span>
                      </label>
                      {isReplaceOrders && isSheetDetected(rawImportResult.stats.detectedSheets, ORDERS_SHEET_ALIASES) && rawImportResult.stats.openOrdersCount === 0 && (
                        <div style={{ marginLeft: 24, padding: '6px 10px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 6, fontSize: 11 }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#92400e', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={confirmEmptyOrders}
                              onChange={(e) => setConfirmEmptyOrders(e.target.checked)}
                            />
                            <span><strong>Confirm Empty Replacement:</strong> Open Orders sheet is present with 0 valid records. Check to confirm clearing all existing open orders.</span>
                          </label>
                        </div>
                      )}

                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={isReplaceBoms}
                          onChange={(e) => {
                            setIsReplaceBoms(e.target.checked);
                            if (!e.target.checked) setConfirmEmptyBoms(false);
                          }}
                        />
                        <span>
                          <strong>Complete BOM Replacement</strong> (remove component links absent from this upload; retained if sheet is absent)
                        </span>
                      </label>
                      {isReplaceBoms && isSheetDetected(rawImportResult.stats.detectedSheets, BOM_SHEET_ALIASES) && rawImportResult.stats.bomsCount === 0 && (
                        <div style={{ marginLeft: 24, padding: '6px 10px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 6, fontSize: 11 }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#92400e', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={confirmEmptyBoms}
                              onChange={(e) => setConfirmEmptyBoms(e.target.checked)}
                            />
                            <span><strong>Confirm Empty Replacement:</strong> BOM sheet is present with 0 valid records. Check to confirm clearing all existing BOM links.</span>
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Warnings or Errors */}
            {rawImportResult.warnings.length > 0 && (
              <div className="validation-warning-callout">
                <AlertTriangle size={16} color="var(--warning)" style={{ flexShrink: 0, marginTop: 2 }} />
                <div>
                  <strong style={{ fontSize: 12.5, color: '#92400e' }}>Notices & Discontinued Flags:</strong>
                  <ul style={{ fontSize: 11.5, color: '#b45309', marginTop: 4, paddingLeft: 16 }}>
                    {rawImportResult.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {rawImportResult.errors.length === 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#047857', fontSize: 12.5, fontWeight: 600 }}>
                <CheckCircle2 size={16} color="var(--success)" />
                <span>Dataset integrity verified. Ready to compute model readiness and populate state.</span>
              </div>
            )}
          </div>
        )}

        {/* STEP 5: MERGE & INGEST SUMMARY */}
        {currentStep === 5 && resolvedDataset && (
          <div className="import-success-hero">
            <div className="success-icon-badge">
              <CheckCircle2 size={36} color="var(--success)" />
            </div>

            <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', marginTop: 10 }}>
              {ingestionMode === 'merge' && existingDataset ? 'INCREMENTAL DATA MERGED' : 'DATASET READY FOR LEARNING'}
            </h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 520, margin: '6px auto 0' }}>
              {fileName} has been ingested as <strong>Dataset v{resolvedDataset.dataVersion}</strong>.
            </p>

            {/* Deduplication & Growth Metrics Grid */}
            <div className="dataset-ready-kpi-row" style={{ marginTop: 16 }}>
              <div className="ready-kpi-cell">
                <span className="kpi-tag">Actual History</span>
                <span className="kpi-val num" style={{ color: 'var(--ai-primary)' }}>
                  {resolvedDataset.historySummary.totalMonths} Months
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                  {resolvedDataset.historySummary.earliestPeriod} to {resolvedDataset.historySummary.latestPeriod}
                </span>
              </div>

              {incStats ? (
                <>
                  <div className="ready-kpi-cell">
                    <span className="kpi-tag">New Observations</span>
                    <span className="kpi-val num" style={{ color: 'var(--success)' }}>+{incStats.newObservations}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Appended</span>
                  </div>
                  <div className="ready-kpi-cell">
                    <span className="kpi-tag">Updated Observations</span>
                    <span className="kpi-val num" style={{ color: '#d97706' }}>{incStats.updatedObservations}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Re-calibrated</span>
                  </div>
                  <div className="ready-kpi-cell">
                    <span className="kpi-tag">Duplicates Ignored</span>
                    <span className="kpi-val num" style={{ color: 'var(--text-secondary)' }}>{incStats.duplicatesIgnored}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Natural-key hit</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="ready-kpi-cell">
                    <span className="kpi-tag">Total Observations</span>
                    <span className="kpi-val num">{formatNumber(resolvedDataset.historySummary.totalObservations)}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Recorded</span>
                  </div>
                  <div className="ready-kpi-cell">
                    <span className="kpi-tag">Missing / Gaps</span>
                    <span className="kpi-val num" style={{ color: '#ef4444' }}>
                      {Object.keys(historySummary?.incrementalStats?.missingPeriodsMap || {}).length}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>SKUs with Gaps</span>
                  </div>
                </>
              )}
            </div>

            {incStats && Object.keys(incStats.missingPeriodsMap || {}).length > 0 && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 14px', fontSize: 12, marginTop: 16, textAlign: 'left' }}>
                <strong style={{ color: '#991b1b' }}>Missing Periods Detected:</strong>
                <div style={{ maxHeight: '80px', overflowY: 'auto', marginTop: 4, color: '#7f1d1d' }}>
                  {Object.entries(incStats.missingPeriodsMap).map(([item, periods]) => (
                    <div key={item}>
                      <strong>{item}</strong>: {periods.join(', ')}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {rawImportResult?.stats?.invalidObservations ? (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 14px', fontSize: 12, marginTop: 16, textAlign: 'left' }}>
                <strong style={{ color: '#92400e' }}>Data Quality Notice:</strong>
                <div style={{ marginTop: 4, color: '#b45309' }}>
                  Ignored <strong>{rawImportResult?.stats?.invalidObservations}</strong> observations due to non-numeric (invalid) quantities.
                </div>
              </div>
            ) : null}

            {incStats && incStats.affectedItems && incStats.affectedItems.length > 0 && (
              <div style={{ marginTop: 16, textAlign: 'left', fontSize: 11, color: 'var(--text-secondary)' }}>
                <strong>Affected SKUs: </strong> {incStats.affectedItems.length} items modified or verified.
              </div>
            )}

            {/* Model Readiness Promotion Notice */}
            <div style={{ background: '#f8fafc', border: '1px solid var(--border-medium)', borderRadius: 8, padding: '12px 16px', maxWidth: 640, margin: '16px auto 0', textAlign: 'left', fontSize: 12 }}>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Sparkles size={14} color="var(--ai-primary)" />
                <span>Forecasting Engine Adaptive Behavior:</span>
              </div>
              <p style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
                The forecasting engine will dynamically evaluate each item according to its available historical depth ({resolvedDataset.historySummary.totalMonths} months overall). Items will be assigned the highest eligible model tier in the capability hierarchy.
              </p>
            </div>

            <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center' }}>
              <button className="btn-primary" onClick={handleFinalImport} style={{ padding: '10px 32px' }}>
                <CheckCircle2 size={16} />
                <span>Confirm & Apply Update</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

