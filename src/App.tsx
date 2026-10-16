import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  ForecastParameters,
  ForecastLine,
  ForecastStatus,
  UserRole,
  AlertItem,
  AdjustmentLog,
  ForecastVersion,
  NormalizedDataset,
  ForecastResult,
  MRPRecommendation,
  SKUCategory,
  SegmentationResult
} from './types';
import { createDefaultParameters } from './data';
import {
  parseExcelWorkbook,
  downloadExcelTemplate
} from './services/excelService';
import {
  prepareItemHistories,
  processPythonForecastResults,
  recalculateBusinessMetrics,
  recalculateMRPAndSupply,
  diffForecastParameters,
  resolveForecastWorkflowDecision
} from './services/forecastingEngine';
import {
  getOrCalculateSegmentation,
  invalidateSegmentationCache
} from './services/segmentationService';
import {
  checkPythonServiceHealth,
  fetchBatchForecastFromPython,
  createForecastJob,
  getForecastJobStatus,
  cancelForecastJob,
  PythonBatchResponse
} from './services/forecastClient';
import { Permissions } from './services/permissions';
import { exportForecastToExcel } from './services/excelService';
import { PersistenceService, STORAGE_KEY } from './services/persistenceService';
import { VersionService } from './services/versionService';
import { EmptyState } from './components/EmptyState';
import { DatasetStagingView } from './components/DatasetStagingView';
import { ExcelImportModal } from './components/ExcelImportModal';
import { ForecastGenerationModal, ForecastJobModalInfo } from './components/ForecastGenerationModal';
import { ForecastWorkspace } from './components/ForecastWorkspace';
import { DemandIntelligenceView } from './components/DemandIntelligenceView';
import { AccuracyView } from './components/AccuracyView';
import { ComponentsView } from './components/ComponentsView';
import { VersionsView } from './components/VersionsView';
import { Modal, ToastContainer, ToastMessage, formatNumber, getMonthLabels } from './components/UI';
import {
  Sparkles,
  Layers,
  Calendar,
  CheckCircle2,
  Cpu,
  Settings,
  RotateCcw,
  Upload,
  Download,
  Database,
  ArrowRight,
  SlidersHorizontal,
  Undo2,
  Play,
  FileSpreadsheet,
  Lock
} from 'lucide-react';

export function App() {
  // 1. Ingested Dataset State (Derived from Excel, null on fresh start)
  const [dataset, setDataset] = useState<NormalizedDataset | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.dataset) return parsed.dataset;
      }
    } catch (e) {
      console.warn('Could not restore dataset from localStorage:', e);
    }
    return null;
  });

  // Track if forecast models have been trained and generated for the current dataset
  const [isForecastGenerated, setIsForecastGenerated] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.dataset) {
          return parsed.isForecastGenerated !== undefined ? parsed.isForecastGenerated : true;
        }
      }
    } catch (e) {
      console.warn('Could not restore isForecastGenerated:', e);
    }
    return false;
  });

  // 2. Forecast State
  const [parameters, setParameters] = useState<ForecastParameters>(() => {
    const s = PersistenceService.loadAppState();
    return s?.parameters ?? createDefaultParameters(s?.dataset ?? null);
  });
  const [existingLines, setExistingLines] = useState<ForecastLine[]>(() => {
    const s = PersistenceService.loadAppState();
    return s?.existingLines ?? [];
  });
  const [version, setVersion] = useState<number>(() => {
    const s = PersistenceService.loadAppState();
    return s?.version ?? 1;
  });
  const [status, setStatus] = useState<ForecastStatus>(() => {
    const s = PersistenceService.loadAppState();
    return s?.status ?? 'Generated';
  });
  const [selectedItemCode, setSelectedItemCode] = useState<string | null>(null);
  const [versions, setVersions] = useState<ForecastVersion[]>(() => {
    const s = PersistenceService.loadAppState();
    return Array.isArray(s?.versions) ? s.versions : [];
  });
  const [adjustmentLogs, setAdjustmentLogs] = useState<AdjustmentLog[]>(() => {
    const s = PersistenceService.loadAppState();
    return Array.isArray(s?.adjustmentLogs) ? s.adjustmentLogs : [];
  });
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isForecastStale, setIsForecastStale] = useState(false);

  // Demand-Based SKU Segmentation State (Runner, Repeater, Stranger)
  const [selectedCategories, setSelectedCategories] = useState<SKUCategory[]>(['RUNNER', 'REPEATER', 'STRANGER']);
  const [segmentationResult, setSegmentationResult] = useState<SegmentationResult | null>(null);
  const [isSegmentationLoading, setIsSegmentationLoading] = useState(false);
  const [segmentationError, setSegmentationError] = useState<string | null>(null);

  const calculateSegmentation = useCallback(async () => {
    if (!dataset) {
      setSegmentationResult(null);
      setIsSegmentationLoading(false);
      setSegmentationError(null);
      return;
    }
    setIsSegmentationLoading(true);
    setSegmentationError(null);
    try {
      const res = await getOrCalculateSegmentation(dataset, parameters);
      setSegmentationResult(res);
      setIsSegmentationLoading(false);
    } catch (err: any) {
      console.error('Segmentation calculation error:', err);
      setSegmentationError(err?.message || 'Failed to calculate SKU segmentation. Please retry.');
      setSegmentationResult(null);
      setIsSegmentationLoading(false);
    }
  }, [dataset, parameters.historyPeriod, parameters.itemGroups, dataset?.dataVersion]);

  // Recalculate SKU classification whenever dataset, parameters, or data version changes
  useEffect(() => {
    calculateSegmentation();
  }, [calculateSegmentation]);

  const handleRetrySegmentation = useCallback(() => {
    invalidateSegmentationCache();
    calculateSegmentation();
  }, [calculateSegmentation]);

  // Active Workspace Navigation: STRICTLY 5 WORKSPACES
  const [activeTab, setActiveTab] = useState<'Forecast' | 'Demand Intelligence' | 'Accuracy' | 'Components' | 'Versions'>('Forecast');

  // Role System
  const [currentUser, setCurrentUser] = useState('R. Sharma (Senior Demand Planner)');
  const [currentRole, setCurrentRole] = useState<UserRole>('PLANNER');

  // Active Alert Filter state
  const [highlightedAlertItemCodes, setHighlightedAlertItemCodes] = useState<string[]>([]);
  const [activeAlertTitle, setActiveAlertTitle] = useState<string | null>(null);

  // Modals & Drawers state
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [executionState, setExecutionState] = useState<'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED'>('IDLE');
  const [generationStep, setGenerationStep] = useState(0);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const isExecutingRef = useRef(false);
  const [activeJobInfo, setActiveJobInfo] = useState<ForecastJobModalInfo | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const isCancelledRef = useRef<boolean>(false);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [isParametersOpen, setIsParametersOpen] = useState(false);
  const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
  const [returnRemark, setReturnRemark] = useState('');
  const [versionSnapshotModal, setVersionSnapshotModal] = useState<ForecastVersion | null>(null);

  // Background Python ML Service health polling
  useEffect(() => {
    let isMounted = true;
    const verifyHealth = async () => {
      const res = await checkPythonServiceHealth();
      if (isMounted) {
        setBackendOnline(res.online);
      }
    };
    verifyHealth();
    const interval = setInterval(verifyHealth, 6000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Warn before closing if there are unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = ''; // Standard way to trigger browser dialog
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  // Log execution state changes
  useEffect(() => {
    console.log(`FORECAST_EXECUTION_STATE: ${executionState}`);
  }, [executionState]);

  // Toasts
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = (type: 'success' | 'error' | 'info', message: string) => {
    const id = Date.now().toString() + Math.random().toString().slice(2, 6);
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
  };

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Authoritative Forecast Results State (Populated exclusively by Python ML service)
  const [forecastResult, setForecastResult] = useState<ForecastResult>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.forecastResult && parsed.forecastResult.lines?.length > 0) {
          return parsed.forecastResult;
        }
      }
    } catch (e) {
      console.warn('Could not restore cached forecastResult:', e);
    }
    return {
      lines: [],
      kpis: {
        totalItems: 0,
        aiForecastTotal: 0,
        finalQtyTotal: 0,
        netRequirementTotal: 0,
        avgConfidencePct: 0,
        baselineGrowthPct: 0,
        adjustmentsCount: 0,
        lowConfidenceCount: 0,
        shortagesCount: 0,
        wapePct: null,
        wapeStatus: 'Not Available',
        availableHistoryMonths: 0,
        historyDateSpan: 'N/A',
        modelReadinessTier: 'New Item / No AI Forecast (0-5M)',
        modelReadinessDescription: 'No forecast generated'
      },
      alerts: []
    };
  });

  // Synchronize initial version history when forecast is computed
  useEffect(() => {
    if (dataset && versions.length === 0 && forecastResult.lines.length > 0) {
      const initialVer: ForecastVersion = {
        version: 1,
        date: new Date().toISOString().slice(0, 19).replace('T', ' '),
        user: currentUser,
        parameters: { ...parameters },
        status: 'Generated',
        adjustmentsCount: 0,
        aiTotal: forecastResult.kpis.aiForecastTotal,
        finalQty: forecastResult.kpis.finalQtyTotal,
        netReqTotal: forecastResult.kpis.netRequirementTotal,
        avgConfidencePct: forecastResult.kpis.avgConfidencePct,
        linesSnapshot: [...forecastResult.lines]
      };
      setVersions([initialVer]);
    }
  }, [dataset, forecastResult.lines.length]);

  // Set default selected item
  useEffect(() => {
    if (dataset && dataset.items.length > 0 && !selectedItemCode) {
      setSelectedItemCode(dataset.items[0].itemCode);
    }
  }, [dataset, selectedItemCode]);

  // Save state to localStorage
  const saveToStorage = (
    customDataset?: NormalizedDataset | null,
    updatedLines?: ForecastLine[],
    updatedStatus?: ForecastStatus,
    updatedVersion?: number,
    updatedForecastGenerated?: boolean,
    updatedResult?: ForecastResult,
    updatedVersions?: ForecastVersion[],
    updatedAdjustmentLogs?: AdjustmentLog[]
  ): boolean => {
    const activeData = customDataset !== undefined ? customDataset : dataset;
    if (!activeData) {
      PersistenceService.clearAppState();
      return true;
    }
    return PersistenceService.saveAppState({
      dataset: activeData,
      parameters,
      isForecastGenerated: updatedForecastGenerated !== undefined ? updatedForecastGenerated : isForecastGenerated,
      forecastResult: updatedResult ?? forecastResult,
      existingLines: updatedLines ?? forecastResult.lines,
      status: updatedStatus ?? status,
      version: updatedVersion ?? version,
      versions: updatedVersions ?? versions,
      adjustmentLogs: updatedAdjustmentLogs ?? adjustmentLogs
    });
  };

  // Real Dynamic AI Engine Status (Driven by actual application state & Python backend)
  const engineStatus = useMemo(() => {
    if (backendOnline === false) {
      return {
        label: 'AI ENGINE · OFFLINE / NEEDS ATTENTION',
        className: 'offline',
        status: 'OFFLINE' as const
      };
    }
    if (!dataset) {
      return {
        label: 'AI ENGINE · WAITING FOR DATA',
        className: 'waiting',
        status: 'NO_DATA' as const
      };
    }
    if (executionState === 'RUNNING') {
      return {
        label: 'AI ENGINE · TRAINING',
        className: 'training',
        status: 'TRAINING' as const
      };
    }
    if (!isForecastGenerated || forecastResult.lines.length === 0) {
      return {
        label: 'AI ENGINE · DATA READY',
        className: 'data-ready',
        status: 'DATA_READY' as const
      };
    }
    return {
      label: 'AI ENGINE · READY',
      className: 'ready',
      status: 'FORECAST_READY' as const
    };
  }, [backendOnline, dataset, executionState, isForecastGenerated, forecastResult.lines.length]);

  // Real Module Readiness & Progressive Unlocking
  const moduleReadiness = useMemo(() => {
    const isForecastActive = !!dataset && isForecastGenerated;

    return {
      forecast: {
        isAvailable: true,
        reason: ''
      },
      demandIntelligence: {
        isAvailable: isForecastActive,
        reason: !dataset
          ? 'Import planning data to unlock Demand Intelligence.'
          : 'Train models and generate a forecast first to unlock Demand Intelligence.'
      },
      accuracy: {
        isAvailable: isForecastActive && !!dataset?.accuracyRecords && dataset.accuracyRecords.length > 0,
        reason: 'Accuracy becomes available after actual demand is available for a generated forecast.'
      },
      components: {
        isAvailable: isForecastActive && !!dataset?.boms && dataset.boms.length > 0 && forecastResult.lines.some(l => l.makeBuy === 'Make'),
        reason: !dataset
          ? 'Import planning data to unlock Components.'
          : !dataset.boms || dataset.boms.length === 0
          ? 'Components requires BOM bill-of-materials in the active dataset.'
          : 'Components requires manufactured (Make) items in the demand plan.'
      },
      versions: {
        isAvailable: versions.length > 0,
        reason: 'Generate a forecast first to view version history.'
      }
    };
  }, [dataset, isForecastGenerated, forecastResult.lines, versions.length]);

  // Navigation tab click handler that prevents navigating to locked modules
  const handleNavTabClick = (tabKey: typeof activeTab) => {
    let check = moduleReadiness.forecast;
    if (tabKey === 'Demand Intelligence') check = moduleReadiness.demandIntelligence;
    else if (tabKey === 'Accuracy') check = moduleReadiness.accuracy;
    else if (tabKey === 'Components') check = moduleReadiness.components;
    else if (tabKey === 'Versions') check = moduleReadiness.versions;

    if (!check.isAvailable) {
      addToast('info', check.reason);
      return;
    }

    setActiveTab(tabKey);
  };

  // Ensure locked modules never become the apparent active page
  useEffect(() => {
    if (activeTab === 'Demand Intelligence' && !moduleReadiness.demandIntelligence.isAvailable) {
      setActiveTab('Forecast');
    } else if (activeTab === 'Accuracy' && !moduleReadiness.accuracy.isAvailable) {
      setActiveTab('Forecast');
    } else if (activeTab === 'Components' && !moduleReadiness.components.isAvailable) {
      setActiveTab('Forecast');
    } else if (activeTab === 'Versions' && !moduleReadiness.versions.isAvailable) {
      setActiveTab('Forecast');
    }
  }, [activeTab, moduleReadiness]);

  // Line modification handler (Planner adjustment)
  const handleUpdateLine = (itemCode: string, plannerAdj: number | null, remark: string) => {
    const line = forecastResult.lines.find(l => l.itemCode === itemCode);
    if (!line) return;

    let targetVersion = version;
    let targetStatus = status;

    // Phase 9: Version Immutability
    // If planner edits an Approved or Submitted version, we fork it into a new Draft
    if (status === 'Approved' || status === 'Submitted') {
      targetVersion = version + 1;
      targetStatus = 'Draft';
      setVersion(targetVersion);
      setStatus(targetStatus);
      addToast('info', `Version ${version} was ${status}. Created new Draft v${targetVersion} for your edits.`);
    }

    let nextLogs = adjustmentLogs;
    if (line.plannerAdj !== plannerAdj) {
      const logEntry: AdjustmentLog = {
        id: Date.now().toString(),
        itemCode: line.itemCode,
        description: line.description,
        oldValue: line.plannerAdj !== null ? line.plannerAdj : line.aiTotal,
        newValue: plannerAdj !== null ? plannerAdj : line.aiTotal,
        user: currentUser,
        date: new Date().toISOString().slice(0, 19).replace('T', ' '),
        remark: remark || line.remark
      };
      nextLogs = [logEntry, ...adjustmentLogs];
      setAdjustmentLogs(nextLogs);
    }

    const updated: ForecastLine = {
      ...line,
      plannerAdj,
      remark,
      isModified: plannerAdj !== null
    };

    const nextLines = forecastResult.lines.map(l => l.itemCode === itemCode ? updated : l);
    const recomputed = recalculateBusinessMetrics(nextLines, dataset, parameters);
    setForecastResult(recomputed);
    setExistingLines(recomputed.lines);
    setHasUnsavedChanges(true);

    saveToStorage(
      dataset,
      recomputed.lines,
      targetStatus,
      targetVersion,
      isForecastGenerated,
      recomputed,
      versions,
      nextLogs
    );
  };

  // Planner MOQ modification handler
  const handleUpdateMoq = (itemCode: string, newMoq: number) => {
    const line = forecastResult.lines.find(l => l.itemCode === itemCode);
    if (!line) return;

    if (typeof newMoq !== 'number' || isNaN(newMoq) || newMoq <= 0) {
      addToast('error', 'MOQ must be greater than 0.');
      return;
    }

    let targetVersion = version;
    let targetStatus = status;

    if (status === 'Approved' || status === 'Submitted') {
      targetVersion = version + 1;
      targetStatus = 'Draft';
      setVersion(targetVersion);
      setStatus(targetStatus);
      addToast('info', `Version ${version} was ${status}. Created new Draft v${targetVersion} for your edits.`);
    }

    const updated: ForecastLine = {
      ...line,
      moq: newMoq
    };

    const nextLines = forecastResult.lines.map(l => l.itemCode === itemCode ? updated : l);
    const recomputed = recalculateBusinessMetrics(nextLines, dataset, parameters);
    setForecastResult(recomputed);
    setExistingLines(recomputed.lines);
    setHasUnsavedChanges(true);

    saveToStorage(
      dataset,
      recomputed.lines,
      targetStatus,
      targetVersion,
      isForecastGenerated,
      recomputed,
      versions,
      adjustmentLogs
    );

    addToast('success', `Supplier MOQ for ${itemCode} updated to ${formatNumber(newMoq)} ${line.uom || 'PCS'}.`);
  };

  // Dataset Ingestion Handler
  const handleDatasetImported = (newDataset: NormalizedDataset) => {
    const isIncremental = newDataset.dataVersion > 1 && !!newDataset.historySummary.incrementalStats;
    const hadPreviousForecast = (isForecastGenerated || versions.length > 0) && forecastResult.lines.length > 0;

    setDataset(newDataset);
    const newParams = isIncremental
      ? { ...parameters, startMonth: createDefaultParameters(newDataset).startMonth }
      : createDefaultParameters(newDataset);
    setParameters(newParams);

    // If incremental merge, preserve existing planner adjustments for existing items
    const retainedLines = isIncremental 
      ? existingLines.filter(l => newDataset.items.some(it => it.itemCode === l.itemCode))
      : [];

    // Invalidate stale SKU classifications on new or updated Excel import
    invalidateSegmentationCache();
    getOrCalculateSegmentation(newDataset, newParams).then(res => {
      setSegmentationResult(res);
    });

    setExistingLines(retainedLines);
    
    const stats = newDataset.historySummary.incrementalStats;
    const hasDataChanges = isIncremental && (
      (stats?.newObservations || 0) > 0 ||
      (stats?.updatedObservations || 0) > 0 ||
      (stats?.affectedItems && stats.affectedItems.length > 0)
    );

    if (hadPreviousForecast) {
      if (hasDataChanges) {
        // Retain existing version history, flag forecast as needing regeneration from updated dataset
        setIsForecastStale(true);
        setStatus('Draft');
        setExecutionState('IDLE');
        setGenerationError(null);
        const forecastTargetsCount = stats?.forecastAffectedItems?.length ?? stats?.affectedItems?.length ?? 0;
        const mrpTargetsCount = stats?.mrpAffectedItems?.length ?? 0;
        const changeDesc = forecastTargetsCount > 0
          ? `${forecastTargetsCount} forecasting target(s)${mrpTargetsCount > 0 ? ` and ${mrpTargetsCount} MRP/supply target(s)` : ''}`
          : `${mrpTargetsCount} MRP/supply target(s)`;
        addToast(
          'info',
          `Updated Excel data imported (v${newDataset.dataVersion}). ${changeDesc} identified.`
        );
      } else {
        // Identical upload with zero changes: preserve existing forecast, versions, and status
        setIsForecastStale(false);
        setExecutionState('IDLE');
        setGenerationError(null);
        addToast(
          'info',
          `Excel workbook imported with zero data changes (v${newDataset.dataVersion}). Existing forecast and version remain current.`
        );
      }
    } else if (!isIncremental) {
      setExecutionState('IDLE');
      setGenerationError(null);
      setVersions([]);
      setAdjustmentLogs([]);
      setVersion(1);
      setIsForecastGenerated(false);
      setIsForecastStale(false);
      setForecastResult({
        lines: [],
        kpis: {
          totalItems: newDataset.items.length,
          aiForecastTotal: 0,
          finalQtyTotal: 0,
          netRequirementTotal: 0,
          avgConfidencePct: 0,
          baselineGrowthPct: 0,
          adjustmentsCount: 0,
          lowConfidenceCount: 0,
          shortagesCount: 0,
          wapePct: null,
          wapeStatus: 'Not Available',
          availableHistoryMonths: newDataset.historySummary?.totalMonths || 0,
          historyDateSpan: `${newDataset.historySummary.earliestPeriod} to ${newDataset.historySummary.latestPeriod}`,
          modelReadinessTier: 'Full Historical Forecasting (24M+)',
          modelReadinessDescription: 'Data ready for Python ML training.'
        },
        alerts: []
      });
      setStatus('Draft');
      addToast(
        'success',
        `Dataset v${newDataset.dataVersion} ingested: ${newDataset.historySummary.totalMonths} months of history (${newDataset.historySummary.earliestPeriod} to ${newDataset.historySummary.latestPeriod}). Data ready for ML training.`
      );
    } else {
      setVersion(prev => prev + 1);
      if (hasDataChanges) {
        setIsForecastStale(true);
        setStatus('Draft');
        addToast('info', 'Historical data changed. Please re-run the forecast generation to update models and features.');
      }
    }

    setHasUnsavedChanges(false);
    setSelectedItemCode(newDataset.items[0]?.itemCode || null);
    setActiveTab('Forecast');

    saveToStorage(
      newDataset,
      retainedLines,
      'Draft',
      version,
      isForecastGenerated,
      undefined,
      versions,
      adjustmentLogs
    );
  };

  const handleResetToEmptyState = () => {
    if (hasUnsavedChanges && !window.confirm('You have unsaved planner adjustments. Are you sure you want to reset the workspace?')) {
      return;
    }
    localStorage.removeItem(STORAGE_KEY);
    setExecutionState('IDLE');
    setGenerationError(null);
    isExecutingRef.current = false;
    setDataset(null);
    setIsForecastGenerated(false);
    setForecastResult({
      lines: [],
      kpis: {
        totalItems: 0,
        aiForecastTotal: 0,
        finalQtyTotal: 0,
        netRequirementTotal: 0,
        avgConfidencePct: 0,
        baselineGrowthPct: 0,
        adjustmentsCount: 0,
        lowConfidenceCount: 0,
        shortagesCount: 0,
        wapePct: null,
        wapeStatus: 'Not Available',
        availableHistoryMonths: 0,
        historyDateSpan: 'N/A',
        modelReadinessTier: 'New Item / No AI Forecast (0-5M)',
        modelReadinessDescription: 'No dataset loaded'
      },
      alerts: []
    });
    setExistingLines([]);
    setVersions([]);
    setAdjustmentLogs([]);
    setHasUnsavedChanges(false);
    setSelectedItemCode(null);
    setActiveTab('Forecast');
    addToast('info', 'Workspace reset to clean initial state.');
  };

  // Workflow Handlers: Authoritative Python ML Forecast Execution via Background Job
  const handleCancelForecast = async () => {
    isCancelledRef.current = true;
    const jobId = activeJobIdRef.current;
    if (jobId) {
      try {
        await cancelForecastJob(jobId);
      } catch (e) {
        console.warn('Failed to send cancel request to backend:', e);
      }
    }
    setExecutionState('IDLE');
    isExecutingRef.current = false;
    addToast('info', 'Forecast generation cancelled.');
  };

  const handleGenerateForecast = async (force: boolean = false) => {
    if (isExecutingRef.current || executionState === 'RUNNING') {
      return;
    }
    if (!Permissions.canGenerate(currentRole)) {
      addToast('error', 'Only Planners or Administrators can generate or modify forecasts.');
      return;
    }
    if (!dataset || dataset.items.length === 0) {
      addToast('error', 'Please import an Excel dataset first.');
      return;
    }
    if (isSegmentationLoading || !segmentationResult) {
      addToast('info', 'Please wait until SKU segmentation calculation has completed.');
      return;
    }
    if (hasUnsavedChanges && !window.confirm('Regenerating the forecast will replace the current forecast. Unsaved planner adjustments may be lost. Continue?')) {
      return;
    }

    isExecutingRef.current = true;
    isCancelledRef.current = false;
    console.log('FORECAST_EXECUTION_START');
    setGenerationError(null);
    setGenerationStep(0);
    setExecutionState('RUNNING');

    // Stage 1: Validating Excel demand history
    setActiveJobInfo({
      status: 'RUNNING',
      currentStage: 'Validating Excel demand history',
      completedStages: [],
      completedItems: 0,
      totalItems: dataset.items.length,
      currentItemCode: null,
      currentModel: null,
      elapsedSeconds: 0,
      progressPercentage: 0
    });

    try {
      // Step 1: Pre-flight verify local Python ML service
      const health = await checkPythonServiceHealth();
      if (!health.online) {
        setBackendOnline(false);
        setGenerationError(
          'The Python FastAPI forecasting engine on http://127.0.0.1:8000 is not responding. Numerical ML forecasts require the genuine Python runtime.'
        );
        setExecutionState('FAILED');
        isExecutingRef.current = false;
        addToast('error', 'Forecasting engine unavailable. Please start the Python service.');
        return;
      }
      setBackendOnline(true);

      // Stage 2: Constructing chronological features
      setGenerationStep(1);

      const categoryScopeLabel = selectedCategories.length === 3
        ? 'All Categories'
        : selectedCategories.length === 1
          ? (selectedCategories[0] === 'RUNNER' ? 'Runner' : selectedCategories[0] === 'REPEATER' ? 'Repeater' : 'Stranger')
          : selectedCategories.map(c => c.charAt(0) + c.slice(1).toLowerCase()).join(' & ');

      // Evaluate authoritative production workflow decision
      const workflowDecision = resolveForecastWorkflowDecision(
        dataset,
        parameters,
        forecastResult.parameters,
        forecastResult.lines,
        selectedCategories,
        segmentationResult
      );

      // 1. Handle NO_OP first
      if (workflowDecision.action === 'NO_OP') {
        setExecutionState('IDLE');
        isExecutingRef.current = false;
        setIsForecastStale(false);
        addToast(
          'info',
          'No affected SKUs detected in incremental update. Existing forecast results remain current.'
        );
        return;
      }

      // 2. Handle MRP_ONLY second (with version snapshot creation and persistence)
      if (workflowDecision.action === 'MRP_ONLY') {
        const recomputed = workflowDecision.recalculatedResult || recalculateMRPAndSupply(forecastResult.lines, dataset, parameters);
        setForecastResult(recomputed);
        setExistingLines([]);
        setIsForecastStale(false);
        setIsForecastGenerated(true);
        setStatus('Generated');

        const nextVer = versions.length > 0 ? Math.max(...versions.map(v => v.version)) + 1 : (version > 1 ? version : 1);
        setVersion(nextVer);

        const newSnapshot: ForecastVersion = {
          version: nextVer,
          date: new Date().toISOString().slice(0, 19).replace('T', ' '),
          user: currentUser,
          parameters: { ...parameters },
          status: 'Generated',
          adjustmentsCount: recomputed.lines.filter(l => l.plannerAdj !== null).length,
          aiTotal: recomputed.kpis.aiForecastTotal,
          finalQty: recomputed.kpis.finalQtyTotal,
          netReqTotal: recomputed.kpis.netRequirementTotal,
          avgConfidencePct: recomputed.kpis.avgConfidencePct,
          linesSnapshot: [...recomputed.lines],
          datasetVersion: dataset.dataVersion,
          datasetName: dataset.metadata.sourceName
        };
        const nextVersions = [newSnapshot, ...versions.filter(v => v.version !== nextVer)];
        setVersions(nextVersions);

        const saveSuccess = saveToStorage(
          dataset,
          recomputed.lines,
          'Generated',
          nextVer,
          true,
          recomputed,
          nextVersions,
          adjustmentLogs
        );

        setExecutionState('IDLE');
        isExecutingRef.current = false;
        const count = workflowDecision.mrpAffectedItemCodes.length || workflowDecision.bomAffectedItemCodes.length;

        if (saveSuccess) {
          setHasUnsavedChanges(false);
          addToast(
            'success',
            `MRP and supply requirements recalculated and saved as Version v${nextVer} for ${count} SKU(s) without retraining ML models.`
          );
        } else {
          setHasUnsavedChanges(true);
          addToast('error', 'Warning: Could not persist MRP update to local storage. Changes remain unsaved in memory.');
        }
        return;
      }

      // 3. Category eligibility checked before dispatching Python ML forecast job
      if (workflowDecision.categoryEligibleItems.length === 0) {
        setExecutionState('IDLE');
        isExecutingRef.current = false;
        addToast('info', `No eligible SKUs found for selected category scope: ${categoryScopeLabel}`);
        return;
      }

      const itemsPayload = workflowDecision.targetItems;

      setActiveJobInfo(prev => ({
        ...prev!,
        totalItems: itemsPayload.length,
        completedItems: 0,
        currentStage: 'Constructing chronological features',
        completedStages: ['Validating Excel demand history']
      }));

      // Create background job on Python backend with pre-filtered items, allowed categories, and full candidate pool for peer discovery
      const { jobId } = await createForecastJob(
        itemsPayload,
        parameters.horizon,
        parameters.startMonth,
        selectedCategories,
        workflowDecision.candidatePool,
        force
      );
      activeJobIdRef.current = jobId;

      setActiveJobInfo(prev => ({
        ...prev!,
        jobId,
        status: 'QUEUED',
        totalItems: itemsPayload.length,
        currentStage: 'Constructing chronological features',
        completedStages: ['Validating Excel demand history']
      }));

      // Poll job status every 800ms
      let consecutivePollErrors = 0;
      const pollInterval = 800;
      let pythonResponse: PythonBatchResponse | null = null;

      while (isExecutingRef.current && !isCancelledRef.current) {
        await new Promise(r => setTimeout(r, pollInterval));
        if (isCancelledRef.current) break;

        try {
          const jobStatus = await getForecastJobStatus(jobId);
          consecutivePollErrors = 0;

          setActiveJobInfo(prev => ({
            ...prev,
            jobId: jobStatus.jobId,
            status: jobStatus.status,
            currentStage: jobStatus.currentStage,
            completedStages: jobStatus.completedStages,
            completedItems: jobStatus.completedItems,
            totalItems: jobStatus.totalItems,
            currentItemCode: jobStatus.currentItemCode,
            currentModel: jobStatus.currentModel,
            elapsedSeconds: jobStatus.elapsedSeconds,
            progressPercentage: jobStatus.progressPercentage
          }));

          if (jobStatus.status === 'COMPLETED') {
            pythonResponse = jobStatus.result;
            console.log('FORECAST_API_RESOLVED');
            break;
          } else if (jobStatus.status === 'FAILED') {
            throw new Error(jobStatus.error || 'Python ML forecasting job failed.');
          } else if (jobStatus.status === 'CANCELLED') {
            throw new Error('Forecast generation was cancelled.');
          }
        } catch (pollErr: any) {
          if (pollErr.message === 'Forecast generation was cancelled.' || pollErr.message?.includes('Python ML forecasting job failed')) {
            throw pollErr;
          }
          consecutivePollErrors++;
          console.warn(`Forecast polling warning (attempt ${consecutivePollErrors}/5):`, pollErr);
          if (consecutivePollErrors >= 5) {
            throw new Error(`Lost connection to Python forecasting service after ${consecutivePollErrors} polling attempts.`);
          }
        }
      }

      if (isCancelledRef.current || !isExecutingRef.current) {
        setExecutionState('IDLE');
        isExecutingRef.current = false;
        if (isCancelledRef.current) {
          addToast('info', 'Forecast generation cancelled.');
        }
        return;
      }

      if (!pythonResponse || !pythonResponse.results) {
        throw new Error('Python ML service returned an empty or invalid response.');
      }

      // Stage 10: Calculating MRP and procurement requirements
      setGenerationStep(4);
      setActiveJobInfo(prev => ({
        ...prev!,
        currentStage: 'Calculating MRP and procurement requirements',
        completedStages: [
          ...prev!.completedStages.filter(s => s !== 'Calculating MRP and procurement requirements'),
          'Calculating prediction intervals and reliability'
        ]
      }));

      const previousBaseline = (workflowDecision.isIncrementalUpdate && forecastResult.lines.length > 0)
        ? forecastResult.lines
        : existingLines;

      const computedResult = processPythonForecastResults(
        pythonResponse,
        dataset,
        parameters,
        previousBaseline
      );

      // Stage 11: Committing forecast results
      setGenerationStep(5);
      setActiveJobInfo(prev => ({
        ...prev!,
        currentStage: 'Committing forecast results',
        completedStages: [
          ...prev!.completedStages,
          'Calculating MRP and procurement requirements'
        ]
      }));

      // Atomically commit forecast results and update state
      setForecastResult(computedResult);
      console.log('FORECAST_RESULT_COMMITTED');
      setExistingLines([]);
      setHasUnsavedChanges(false);
      setIsForecastStale(false);
      setIsForecastGenerated(true);
      setStatus('Generated');

      const nextVer = versions.length > 0 ? Math.max(...versions.map(v => v.version)) + 1 : (version > 1 ? version : 1);
      setVersion(nextVer);

      const newSnapshot: ForecastVersion = {
        version: nextVer,
        date: new Date().toISOString().slice(0, 19).replace('T', ' '),
        user: currentUser,
        parameters: { ...parameters },
        status: 'Generated',
        adjustmentsCount: 0,
        aiTotal: computedResult.kpis.aiForecastTotal,
        finalQty: computedResult.kpis.finalQtyTotal,
        netReqTotal: computedResult.kpis.netRequirementTotal,
        avgConfidencePct: computedResult.kpis.avgConfidencePct,
        linesSnapshot: [...computedResult.lines],
        datasetVersion: dataset.dataVersion,
        datasetName: dataset.metadata.sourceName
      };
      const nextVersions = [newSnapshot, ...versions.filter(v => v.version !== nextVer)];
      setVersions(nextVersions);

      saveToStorage(dataset, computedResult.lines, 'Generated', nextVer, true, computedResult, nextVersions, adjustmentLogs);

      setActiveJobInfo(prev => ({
        ...prev!,
        status: 'COMPLETED',
        completedStages: [
          ...prev!.completedStages,
          'Committing forecast results'
        ]
      }));

      setExecutionState('COMPLETED');
      isExecutingRef.current = false;
      console.log('FORECAST_MODAL_CLOSED');

      const targetCount = itemsPayload.length;
      const totalCount = computedResult.lines.length;
      const summaryMsg = workflowDecision.isIncrementalUpdate && targetCount < totalCount
        ? `Differential forecast updated for ${targetCount} modified item(s) (${totalCount} total portfolio items) using ${pythonResponse.engine} (Version v${nextVer}).`
        : `Authoritative Python ML forecast generated for ${computedResult.lines.length} items using ${pythonResponse.engine} (Version v${nextVer}).`;

      addToast('success', summaryMsg);
    } catch (err: any) {
      console.error('Forecast generation error:', err);
      if (err.message === 'Forecast generation was cancelled.' || isCancelledRef.current) {
        setExecutionState('IDLE');
        addToast('info', 'Forecast generation cancelled.');
      } else {
        setGenerationError(err?.message || 'Failed to generate forecast from Python ML engine.');
        setExecutionState('FAILED');
        addToast('error', 'Error during Python forecasting engine execution.');
      }
      isExecutingRef.current = false;
    }
  };

  const handleSaveDraft = () => {
    if (!Permissions.canSaveDraft(currentRole, status)) {
      addToast('error', 'Only Planners can save drafts in this state.');
      return;
    }
    setStatus('Draft');
    setHasUnsavedChanges(false);
    const { newVersion, newSnapshot } = VersionService.forkVersionIfNeeded(
      status, version, currentUser, parameters, forecastResult, 'Draft'
    );
    const updatedVersions = [newSnapshot, ...versions.filter(v => v.version !== newVersion)];
    setVersion(newVersion);
    setVersions(updatedVersions);
    saveToStorage(dataset, forecastResult.lines, 'Draft', newVersion, isForecastGenerated, forecastResult, updatedVersions, adjustmentLogs);
    addToast('success', `Draft v${version} saved successfully.`);
  };

  const handleSubmitForApproval = () => {
    if (!Permissions.canSubmit(currentRole, status)) {
      addToast('error', 'Only Demand Planners can submit forecasts for approval in this state.');
      return;
    }

    // >20% Remark Validation Check
    const unremarkedLarge = forecastResult.lines.filter(
      l => l.plannerAdj !== null &&
      l.aiTotal > 0 &&
      (Math.abs(l.plannerAdj - l.aiTotal) / l.aiTotal) > 0.20 &&
      (!l.remark || l.remark.trim() === '')
    );

    if (unremarkedLarge.length > 0) {
      addToast(
        'error',
        `Validation blocked: ${unremarkedLarge.length} item(s) have planner adjustments >20% without required audit justification remarks.`
      );
      setHighlightedAlertItemCodes(unremarkedLarge.map(l => l.itemCode));
      setActiveAlertTitle('Missing Required Remarks (>20%)');
      return;
    }

    setStatus('Submitted');
    setHasUnsavedChanges(false);

    const submittedSnapshot: ForecastVersion = {
      version,
      date: new Date().toISOString().slice(0, 19).replace('T', ' '),
      user: currentUser,
      parameters: { ...parameters },
      status: 'Submitted',
      adjustmentsCount: forecastResult.lines.filter(l => l.plannerAdj !== null).length,
      aiTotal: forecastResult.kpis.aiForecastTotal,
      finalQty: forecastResult.kpis.finalQtyTotal,
      netReqTotal: forecastResult.kpis.netRequirementTotal,
      avgConfidencePct: forecastResult.kpis.avgConfidencePct,
      linesSnapshot: [...forecastResult.lines]
    };
    const updatedVersions = [submittedSnapshot, ...versions.filter(v => v.version !== version)];
    setVersions(updatedVersions);
    saveToStorage(dataset, forecastResult.lines, 'Submitted', version, isForecastGenerated, forecastResult, updatedVersions, adjustmentLogs);
    addToast('success', `Forecast v${version} locked and submitted to Supply Chain Management for review.`);
  };

  const handleApprove = () => {
    if (!Permissions.canApprove(currentRole, status)) {
      addToast('error', 'Approval is restricted to Management Approvers in this state.');
      return;
    }
    setStatus('Approved');
    setHasUnsavedChanges(false);

    const approvedSnapshot: ForecastVersion = {
      version,
      date: new Date().toISOString().slice(0, 19).replace('T', ' '),
      user: currentUser,
      parameters: { ...parameters },
      status: 'Approved',
      adjustmentsCount: forecastResult.lines.filter(l => l.plannerAdj !== null).length,
      aiTotal: forecastResult.kpis.aiForecastTotal,
      finalQty: forecastResult.kpis.finalQtyTotal,
      netReqTotal: forecastResult.kpis.netRequirementTotal,
      avgConfidencePct: forecastResult.kpis.avgConfidencePct,
      linesSnapshot: [...forecastResult.lines]
    };
    const updatedVersions = [approvedSnapshot, ...versions.filter(v => v.version !== version)];
    setVersions(updatedVersions);
    saveToStorage(dataset, forecastResult.lines, 'Approved', version, isForecastGenerated, forecastResult, updatedVersions, adjustmentLogs);
    addToast('success', `Forecast v${version} approved by VP Supply Chain.`);
  };

  const handleReturnConfirm = () => {
    if (!Permissions.canReturn(currentRole, status)) {
      addToast('error', 'Only Approvers can return forecasts.');
      return;
    }
    if (!returnRemark.trim()) {
      addToast('error', 'Please provide a justification remark before returning.');
      return;
    }
    setStatus('Returned');
    setIsReturnModalOpen(false);
    setReturnRemark('');
    saveToStorage(dataset, forecastResult.lines, 'Returned', version, isForecastGenerated, forecastResult, versions, adjustmentLogs);
    addToast('info', 'Forecast returned to planner for revision.');
  };

  const handleRestoreVersionAsDraft = (snapshot: ForecastVersion) => {
    if (!dataset) {
      addToast('error', 'Cannot restore version: no dataset loaded.');
      return;
    }
    const nextVer = Math.max(version, ...versions.map(v => v.version)) + 1;
    const restoredLines = snapshot.linesSnapshot.map(l => ({ ...l }));
    const recomputed = recalculateBusinessMetrics(restoredLines, dataset, snapshot.parameters);

    const restorationLog: AdjustmentLog = {
      id: Date.now().toString(),
      itemCode: 'RESTORE_DRAFT',
      description: `Restored Version ${snapshot.version} (${snapshot.status}) as new Draft v${nextVer}`,
      oldValue: snapshot.version,
      newValue: nextVer,
      user: currentUser,
      date: new Date().toISOString().slice(0, 19).replace('T', ' '),
      remark: `Restored from historical snapshot v${snapshot.version} (${snapshot.date})`
    };
    const nextLogs = [restorationLog, ...adjustmentLogs];

    setParameters({ ...snapshot.parameters });
    setVersion(nextVer);
    setStatus('Draft');
    setForecastResult(recomputed);
    setExistingLines(recomputed.lines);
    setAdjustmentLogs(nextLogs);
    setHasUnsavedChanges(true);

    saveToStorage(
      dataset,
      recomputed.lines,
      'Draft',
      nextVer,
      true,
      recomputed,
      versions,
      nextLogs
    );

    setVersionSnapshotModal(null);
    setActiveTab('Forecast');
    addToast(
      'success',
      `Restored historical Version ${snapshot.version} into new Draft v${nextVer}. Planner adjustments and parameters restored.`
    );
  };

  // Excel Export
  const handleExport = () => {
    const monthLabels = getMonthLabels(parameters.startMonth, parameters.horizon);
    exportForecastToExcel(forecastResult.lines, parameters, status, version, monthLabels);
    addToast('success', `Exported ${forecastResult.lines.length} items to Excel.`);
  };

  // Scope Parameter toggles
  const availableGroups = useMemo(() => {
    if (!dataset) return [];
    return Array.from(new Set(dataset.items.map(it => it.itemGroup))).sort();
  }, [dataset]);

  const availableWarehouses = useMemo(() => {
    if (!dataset) return [];
    return Array.from(new Set(dataset.inventory.map(inv => inv.warehouse))).sort();
  }, [dataset]);

  const handleToggleGroup = (group: string) => {
    const exists = parameters.itemGroups.includes(group);
    const newGroups = exists
      ? parameters.itemGroups.filter(g => g !== group)
      : [...parameters.itemGroups, group];
    setParameters({ ...parameters, itemGroups: newGroups });
  };

  const handleToggleWarehouse = (wh: string) => {
    const exists = parameters.warehouses.includes(wh);
    const newWhs = exists
      ? parameters.warehouses.filter(w => w !== wh)
      : [...parameters.warehouses, wh];
    setParameters({ ...parameters, warehouses: newWhs });
  };

  // Role permissions & segmentation readiness
  const isSegmentationReady = !isSegmentationLoading && segmentationResult !== null && !segmentationError;
  const canGenerate = Permissions.canGenerate(currentRole) && isSegmentationReady;
  const canSaveDraft = Permissions.canSaveDraft(currentRole, status);
  const canSubmit = Permissions.canSubmit(currentRole, status);
  const canApprove = Permissions.canApprove(currentRole, status);
  const canReturn = Permissions.canReturn(currentRole, status);

  return (
    <div className="command-shell">
      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />

      {/* 1. Master Application Header */}
      <header className="command-header">
        <div className="brand-section">
          <div className="brand-mark">
            <div className="logo-icon">
              <Sparkles size={18} />
            </div>
            <div className="brand-name">
              <span>DEMANDORA</span>
              <span className="brand-badge">SUPPLY INTELLIGENCE</span>
            </div>
          </div>

          <div className="workspace-divider" />

          {/* Real Dynamic AI Status Badge */}
          <div className={`ai-status-pill ${engineStatus.className}`}>
            <span className="pulse-dot" />
            <span>{engineStatus.label}</span>
          </div>

          {/* Dataset Status Indicator (Only shown when dataset is loaded) */}
          {dataset && (
            <div className="dataset-indicator-badge">
              <FileSpreadsheet size={13} color="var(--ai-primary)" />
              <span className="dataset-name">{dataset.metadata.sourceName}</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'var(--ai-subtle)', color: 'var(--ai-primary)', border: '1px solid var(--ai-border)' }}>
                v{dataset.dataVersion}
              </span>
              <span className="dataset-meta">
                · {dataset.historySummary?.totalMonths || 0} months of history ({dataset.items.length.toLocaleString()} SKUs)
              </span>
            </div>
          )}
        </div>

        {/* Right Tools — Clean, uncluttered, exactly one primary Import action */}
        <div className="header-right-tools">
          <button
            type="button"
            className="btn-ai"
            onClick={() => {
              if (hasUnsavedChanges && !window.confirm('You have unsaved planner adjustments. Importing a new dataset will lose them. Continue?')) {
                return;
              }
              setIsImportModalOpen(true);
            }}
            style={{ fontSize: 12, padding: '6px 14px' }}
          >
            <Upload size={14} />
            <span>Import Excel</span>
          </button>

          <button
            type="button"
            className="btn-ghost"
            onClick={downloadExcelTemplate}
            title="Download Excel Planning Template"
          >
            <Download size={14} />
            <span>Template</span>
          </button>

          {/* Role Switcher */}
          <div className="role-chip">
            <label>Role:</label>
            <select
              value={currentRole}
              onChange={(e) => {
                const r = e.target.value as UserRole;
                setCurrentRole(r);
                if (r === 'APPROVER') setCurrentUser('M. Verma (VP Supply Chain)');
                else if (r === 'PURCHASE_MANAGER') setCurrentUser('K. Singhania (Head of Procurement)');
                else if (r === 'ADMINISTRATOR') setCurrentUser('Admin (System Superuser)');
                else setCurrentUser('R. Sharma (Senior Demand Planner)');
                addToast('info', `Switched role to ${r}`);
              }}
            >
              <option value="PLANNER">PLANNER</option>
              <option value="PURCHASE_MANAGER">PURCHASE MANAGER</option>
              <option value="APPROVER">APPROVER / MANAGEMENT</option>
              <option value="ADMINISTRATOR">ADMINISTRATOR</option>
            </select>
          </div>

          {/* Reset Workspace */}
          <button
            type="button"
            className="btn-ghost"
            onClick={handleResetToEmptyState}
            title="Reset Workspace to Clean State"
          >
            <RotateCcw size={14} />
          </button>
        </div>
      </header>

      {/* 2. Primary Navigation Bar — STRICT PROGRESSIVE READINESS & LOCKING */}
      <nav className="command-nav-bar">
        <div className="nav-tabs-group">
          <button
            type="button"
            className={`nav-tab-item ${activeTab === 'Forecast' ? 'active' : ''}`}
            onClick={() => handleNavTabClick('Forecast')}
          >
            <Layers size={14} />
            <span>Forecast</span>
            {dataset && isForecastGenerated && (
              <span className="nav-tab-counter">{forecastResult.lines.length}</span>
            )}
          </button>

          <button
            type="button"
            className={`nav-tab-item ${activeTab === 'Demand Intelligence' ? 'active' : ''} ${!moduleReadiness.demandIntelligence.isAvailable ? 'locked' : ''}`}
            onClick={() => handleNavTabClick('Demand Intelligence')}
            title={!moduleReadiness.demandIntelligence.isAvailable ? moduleReadiness.demandIntelligence.reason : 'Demand Patterns, Trends & Model Analytics'}
          >
            {!moduleReadiness.demandIntelligence.isAvailable ? <Lock size={13} className="lock-icon" /> : <Sparkles size={14} />}
            <span>Demand Intelligence</span>
            {!moduleReadiness.demandIntelligence.isAvailable && <span className="locked-badge">Locked</span>}
          </button>

          <button
            type="button"
            className={`nav-tab-item ${activeTab === 'Accuracy' ? 'active' : ''} ${!moduleReadiness.accuracy.isAvailable ? 'locked' : ''}`}
            onClick={() => handleNavTabClick('Accuracy')}
            title={!moduleReadiness.accuracy.isAvailable ? moduleReadiness.accuracy.reason : 'Forecast vs Actual Accuracy & WAPE'}
          >
            {!moduleReadiness.accuracy.isAvailable ? <Lock size={13} className="lock-icon" /> : <CheckCircle2 size={14} />}
            <span>Accuracy</span>
            {!moduleReadiness.accuracy.isAvailable ? (
              <span className="locked-badge">Locked</span>
            ) : (
              forecastResult.kpis.wapePct !== null && (
                <span className="nav-tab-counter">{forecastResult.kpis.wapePct}% WAPE</span>
              )
            )}
          </button>

          <button
            type="button"
            className={`nav-tab-item ${activeTab === 'Components' ? 'active' : ''} ${!moduleReadiness.components.isAvailable ? 'locked' : ''}`}
            onClick={() => handleNavTabClick('Components')}
            title={!moduleReadiness.components.isAvailable ? moduleReadiness.components.reason : 'Bill of Materials & Component Explosion'}
          >
            {!moduleReadiness.components.isAvailable ? <Lock size={13} className="lock-icon" /> : <Cpu size={14} />}
            <span>Components</span>
            {!moduleReadiness.components.isAvailable ? (
              <span className="locked-badge">Locked</span>
            ) : (
              dataset && <span className="nav-tab-counter">{dataset.boms.length}</span>
            )}
          </button>

          <button
            type="button"
            className={`nav-tab-item ${activeTab === 'Versions' ? 'active' : ''} ${!moduleReadiness.versions.isAvailable ? 'locked' : ''}`}
            onClick={() => handleNavTabClick('Versions')}
            title={!moduleReadiness.versions.isAvailable ? moduleReadiness.versions.reason : 'Forecast Version Comparison'}
          >
            {!moduleReadiness.versions.isAvailable ? <Lock size={13} className="lock-icon" /> : <Calendar size={14} />}
            <span>Versions</span>
            {!moduleReadiness.versions.isAvailable ? (
              <span className="locked-badge">Locked</span>
            ) : (
              versions.length > 0 && <span className="nav-tab-counter">v{versions.length}</span>
            )}
          </button>
        </div>
      </nav>

      {/* 3. Main Body Scroll Area — PROGRESSIVE PRODUCT FLOW */}
      <main className="workspace-scroll-container">
        {!dataset ? (
          <EmptyState
            onOpenImport={() => setIsImportModalOpen(true)}
          />
        ) : !isForecastGenerated ? (
          <DatasetStagingView
            dataset={dataset}
            parameters={parameters}
            onOpenParameters={() => setIsParametersOpen(true)}
            onTrainAndGenerate={handleGenerateForecast}
            onOpenImport={() => {
              if (hasUnsavedChanges && !window.confirm('You have unsaved planner adjustments. Importing a new dataset will lose them. Continue?')) {
                return;
              }
              setIsImportModalOpen(true);
            }}
            segmentation={segmentationResult}
            isSegmentationLoading={isSegmentationLoading}
            segmentationError={segmentationError}
            onRetrySegmentation={handleRetrySegmentation}
            selectedCategories={selectedCategories}
            onSelectCategories={setSelectedCategories}
          />
        ) : (
          <>
            {/* WORKSPACE 1: FORECAST */}
            {activeTab === 'Forecast' && (
              <ForecastWorkspace
                parameters={parameters}
                onUpdateParameters={setParameters}
                forecastResult={forecastResult}
                onUpdateLine={handleUpdateLine}
                onUpdateMoq={handleUpdateMoq}
                selectedItemCode={selectedItemCode}
                onSelectItem={(item) => setSelectedItemCode(item.itemCode)}
                userRole={currentRole}
                status={status}
                version={version}
                hasUnsavedChanges={hasUnsavedChanges}
                isForecastStale={isForecastStale}
                highlightedAlertItemCodes={highlightedAlertItemCodes}
                activeAlertTitle={activeAlertTitle}
                onSelectAlert={(alt) => {
                  if (!alt) {
                    setActiveAlertTitle(null);
                    setHighlightedAlertItemCodes([]);
                  } else {
                    setActiveAlertTitle(alt.title);
                    setHighlightedAlertItemCodes(alt.itemCodes);
                  }
                }}
                onOpenParameters={() => setIsParametersOpen(true)}
                canGenerate={canGenerate}
                canSaveDraft={canSaveDraft}
                canSubmit={canSubmit}
                canApprove={canApprove}
                canReturn={canReturn}
                onGenerate={handleGenerateForecast}
                onSaveDraft={handleSaveDraft}
                onSubmit={handleSubmitForApproval}
                onApprove={handleApprove}
                onReturn={() => setIsReturnModalOpen(true)}
                onExport={handleExport}
                segmentation={segmentationResult}
                isSegmentationLoading={isSegmentationLoading}
                segmentationError={segmentationError}
                onRetrySegmentation={handleRetrySegmentation}
                selectedCategories={selectedCategories}
                onSelectCategories={setSelectedCategories}
                isExecuting={executionState === 'RUNNING'}
              />
            )}

            {/* WORKSPACE 2: DEMAND INTELLIGENCE */}
            {activeTab === 'Demand Intelligence' && (
              <DemandIntelligenceView
                lines={forecastResult.lines}
                dataset={dataset}
                parameters={parameters}
                selectedItemCode={selectedItemCode}
                onSelectItem={(item) => setSelectedItemCode(item.itemCode)}
              />
            )}

            {/* WORKSPACE 3: ACCURACY */}
            {activeTab === 'Accuracy' && (
              <AccuracyView
                dataset={dataset}
                forecastResult={forecastResult}
              />
            )}

            {/* WORKSPACE 4: COMPONENTS (BOM EXPLOSION) */}
            {activeTab === 'Components' && (
              <ComponentsView
                lines={forecastResult.lines}
                dataset={dataset}
                parameters={parameters}
              />
            )}

            {/* WORKSPACE 5: VERSIONS TIMELINE */}
            {activeTab === 'Versions' && (
              <VersionsView
                versions={versions}
                onViewSnapshot={(v) => setVersionSnapshotModal(v)}
                onRestoreVersionAsDraft={handleRestoreVersionAsDraft}
              />
            )}
          </>
        )}
      </main>

      {/* 4. MODALS & DRAWERS */}

      {/* A. 5-Step Excel Ingestion Modal */}
      <ExcelImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onDatasetImported={handleDatasetImported}
        existingDataset={dataset}
      />

      {/* B. Authoritative Python ML Forecast Generation Modal */}
      <ForecastGenerationModal
        isOpen={executionState === 'RUNNING' || (executionState === 'FAILED' && !!generationError)}
        jobInfo={activeJobInfo}
        stepIndex={generationStep}
        categoryScopeLabel={
          selectedCategories.length === 3
            ? 'All Categories'
            : selectedCategories.length === 1
              ? (selectedCategories[0] === 'RUNNER' ? 'Runner' : selectedCategories[0] === 'REPEATER' ? 'Repeater' : 'Stranger')
              : selectedCategories.map(c => c.charAt(0) + c.slice(1).toLowerCase()).join(' & ')
        }
        error={generationError}
        onClose={() => {
          if (executionState === 'RUNNING') {
            handleCancelForecast();
          } else {
            setExecutionState('IDLE');
            setGenerationError(null);
            isExecutingRef.current = false;
          }
        }}
        onCancel={handleCancelForecast}
        onRetry={() => {
          setGenerationError(null);
          setExecutionState('IDLE');
          isExecutingRef.current = false;
          setTimeout(() => {
            handleGenerateForecast(true);
          }, 50);
        }}
      />

      {/* C. Scope & Algorithm Parameters Drawer */}
      <Modal
        isOpen={isParametersOpen}
        title="Forecast Scope & Algorithm Parameters"
        onClose={() => setIsParametersOpen(false)}
        maxWidth="740px"
        footer={
          <button
            type="button"
            className="btn-ai"
            onClick={() => setIsParametersOpen(false)}
          >
            Apply & Close
          </button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Forecast Code</label>
              <input
                type="text"
                className="modern-select num"
                readOnly
                value={parameters.forecastCode}
                style={{ width: '100%', marginTop: 4, background: '#f8fafc' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Start Month (YYYY-MM)</label>
              <input
                type="month"
                className="modern-select"
                value={parameters.startMonth}
                onChange={(e) => setParameters({ ...parameters, startMonth: e.target.value })}
                style={{ width: '100%', marginTop: 4 }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Horizon ({parameters.horizon} Mo.)</label>
              <select
                className="modern-select"
                value={parameters.horizon}
                onChange={(e) => setParameters({ ...parameters, horizon: parseInt(e.target.value, 10) })}
                style={{ width: '100%', marginTop: 4 }}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => (
                  <option key={n} value={n}>{n} Months</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
              Categories Filter ({parameters.itemGroups.length} selected)
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {availableGroups.map(grp => {
                const sel = parameters.itemGroups.includes(grp);
                return (
                  <span
                    key={grp}
                    onClick={() => handleToggleGroup(grp)}
                    style={{
                      fontSize: 11.5,
                      padding: '3px 10px',
                      borderRadius: 6,
                      cursor: 'pointer',
                      border: `1px solid ${sel ? 'var(--ai-border)' : 'var(--border-subtle)'}`,
                      background: sel ? 'var(--ai-subtle)' : '#ffffff',
                      color: sel ? 'var(--ai-primary)' : 'var(--text-secondary)',
                      fontWeight: sel ? 700 : 500
                    }}
                  >
                    {grp} {sel ? '✓' : '+'}
                  </span>
                );
              })}
            </div>
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
              Warehouses Filter ({parameters.warehouses.length} active)
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {availableWarehouses.map(wh => {
                const sel = parameters.warehouses.includes(wh);
                return (
                  <span
                    key={wh}
                    onClick={() => handleToggleWarehouse(wh)}
                    style={{
                      fontSize: 11.5,
                      padding: '3px 10px',
                      borderRadius: 6,
                      cursor: 'pointer',
                      border: `1px solid ${sel ? 'var(--ai-border)' : 'var(--border-subtle)'}`,
                      background: sel ? 'var(--ai-subtle)' : '#ffffff',
                      color: sel ? 'var(--ai-primary)' : 'var(--text-secondary)',
                      fontWeight: sel ? 700 : 500
                    }}
                  >
                    {wh} {sel ? '✓' : '+'}
                  </span>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={parameters.seasonality}
                onChange={(e) => setParameters({ ...parameters, seasonality: e.target.checked })}
              />
              <span>Enable Mathematical Seasonality & Trend Detection</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={parameters.includeOpenSalesOrders}
                onChange={(e) => setParameters({ ...parameters, includeOpenSalesOrders: e.target.checked })}
              />
              <span>Incorporate Confirmed Open Sales Orders into Demand Floor</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={parameters.applyMoqOrderMultiple}
                onChange={(e) => setParameters({ ...parameters, applyMoqOrderMultiple: e.target.checked })}
              />
              <span>Round Net Requirements up to Supplier MOQ & Order Multiples</span>
            </label>
          </div>
        </div>
      </Modal>

      {/* D. Return with Remark Modal */}
      <Modal
        isOpen={isReturnModalOpen}
        title="Return Forecast to Planner"
        onClose={() => setIsReturnModalOpen(false)}
        maxWidth="500px"
        footer={
          <>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setIsReturnModalOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-ai"
              style={{ background: 'var(--danger)' }}
              onClick={handleReturnConfirm}
            >
              Return with Remark
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Provide an audit remark for the planner explaining why this forecast iteration requires revision.
          </p>
          <textarea
            rows={4}
            className="modern-select"
            style={{ width: '100%', resize: 'vertical' }}
            placeholder="e.g. Please re-check bulk project allocations for LED Battens in North Depot..."
            value={returnRemark}
            onChange={(e) => setReturnRemark(e.target.value)}
          />
        </div>
      </Modal>

      {/* E. Version Snapshot Modal */}
      {versionSnapshotModal && (
        <Modal
          isOpen={true}
          title={`Snapshot: Version ${versionSnapshotModal.version} (${versionSnapshotModal.status})`}
          onClose={() => setVersionSnapshotModal(null)}
          maxWidth="700px"
          footer={
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, width: '100%' }}>
              <button
                type="button"
                className="btn-ai"
                onClick={() => handleRestoreVersionAsDraft(versionSnapshotModal)}
                style={{ fontSize: 12, padding: '6px 14px' }}
              >
                <RotateCcw size={13} />
                <span>Restore as New Draft</span>
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setVersionSnapshotModal(null)}
                style={{ fontSize: 12, padding: '6px 14px' }}
              >
                Close
              </button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              <div style={{ background: 'var(--bg-subtle)', padding: 10, borderRadius: 8 }}>
                <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Timestamp</div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>{versionSnapshotModal.date}</div>
              </div>
              <div style={{ background: 'var(--bg-subtle)', padding: 10, borderRadius: 8 }}>
                <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Planner / User</div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>{versionSnapshotModal.user}</div>
              </div>
              <div style={{ background: 'var(--bg-subtle)', padding: 10, borderRadius: 8 }}>
                <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>AI Total Demand</div>
                <div className="num" style={{ fontSize: 13, fontWeight: 800 }}>{formatNumber(versionSnapshotModal.aiTotal)}</div>
              </div>
              <div style={{ background: 'var(--bg-subtle)', padding: 10, borderRadius: 8 }}>
                <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>Net Requirement</div>
                <div className="num" style={{ fontSize: 13, fontWeight: 800, color: 'var(--danger)' }}>{formatNumber(versionSnapshotModal.netReqTotal)}</div>
              </div>
            </div>

            <div style={{ maxHeight: 320, overflowY: 'auto' }} className="modern-table-container">
              <table className="modern-data-table">
                <thead>
                  <tr>
                    <th>SKU Code</th>
                    <th>Product Description</th>
                    <th style={{ textAlign: 'right' }}>AI Total</th>
                    <th style={{ textAlign: 'right' }}>Planner Adj</th>
                    <th style={{ textAlign: 'right' }}>Final Qty</th>
                    <th style={{ textAlign: 'right' }}>Stock</th>
                    <th style={{ textAlign: 'right' }}>Open PO</th>
                    <th style={{ textAlign: 'right' }} title="Net Requirement Before Lot Sizing">Net Req (Pre-Lot)</th>
                    <th style={{ textAlign: 'right' }}>MOQ</th>
                    <th style={{ textAlign: 'right' }} title="Planned Order Qty After Lot Sizing">Planned Order (Post-Lot)</th>
                  </tr>
                </thead>
                <tbody>
                  {versionSnapshotModal.linesSnapshot.slice(0, 15).map(l => (
                    <tr key={l.itemCode}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--ai-primary)' }}>{l.itemCode}</td>
                      <td>{l.description}</td>
                      <td style={{ textAlign: 'right' }} className="num">{formatNumber(l.aiTotal)}</td>
                      <td style={{ textAlign: 'right' }} className="num">{l.plannerAdj !== null ? formatNumber(l.plannerAdj) : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }} className="num">{formatNumber(l.finalQty)}</td>
                      <td style={{ textAlign: 'right' }} className="num">{l.stock !== null && l.stock !== undefined ? formatNumber(l.stock) : '—'}</td>
                      <td style={{ textAlign: 'right' }} className="num">{l.openPo !== null && l.openPo !== undefined ? formatNumber(l.openPo) : '—'}</td>
                      <td style={{ textAlign: 'right' }} className="num">
                        {l.planningMethod !== 'MRP' ? '—' : l.rawNetReq !== null ? formatNumber(l.rawNetReq) : formatNumber(Math.max(0, l.finalQty - (l.stock ?? 0) - (l.openPo ?? 0)))}
                      </td>
                      <td style={{ textAlign: 'right' }} className="num">{l.moq > 0 ? formatNumber(l.moq) : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--danger)', fontWeight: 700 }} className="num">
                        {l.planningMethod !== 'MRP' ? '—' : (l.plannedOrderQty ?? l.netReq) !== null ? formatNumber((l.plannedOrderQty ?? l.netReq)!) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
