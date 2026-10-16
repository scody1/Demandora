import React from 'react';
import {
  ForecastParameters,
  ForecastResult,
  ForecastLine,
  UserRole,
  ForecastStatus,
  AlertItem,
  SKUCategory,
  SegmentationResult
} from '../types';
import { formatCompact, formatNumber, ConfidenceBadge, StatusBadge } from './UI';
import { ForecastGrid } from './ForecastGrid';
import { AnalyticsPanel } from './AnalyticsPanel';
import { DemandSegmentationCards } from './DemandSegmentationCards';
import {
  Sparkles,
  SlidersHorizontal,
  ArrowUpRight,
  RotateCcw,
  Save,
  Send,
  Check,
  Undo2,
  Download,
  Database,
  Play,
  MoreVertical,
  ChevronDown
} from 'lucide-react';

interface ForecastWorkspaceProps {
  parameters: ForecastParameters;
  onUpdateParameters: (params: ForecastParameters) => void;
  forecastResult: ForecastResult;
  onUpdateLine: (itemCode: string, plannerAdj: number | null, remark: string) => void;
  onUpdateMoq?: (itemCode: string, moq: number) => void;
  selectedItemCode: string | null;
  onSelectItem: (item: ForecastLine) => void;
  userRole: UserRole;
  status: ForecastStatus;
  version: number;
  hasUnsavedChanges: boolean;
  isForecastStale?: boolean;
  highlightedAlertItemCodes: string[];
  activeAlertTitle: string | null;
  onSelectAlert: (alert: AlertItem | null) => void;
  onOpenParameters: () => void;
  // Workflow actions
  canGenerate: boolean;
  canSaveDraft: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canReturn: boolean;
  onGenerate: () => void;
  onSaveDraft: () => void;
  onSubmit: () => void;
  onApprove: () => void;
  onReturn: () => void;
  onExport: () => void;
  // Demand-Based Segmentation Props
  segmentation?: SegmentationResult | null;
  isSegmentationLoading?: boolean;
  segmentationError?: string | null;
  onRetrySegmentation?: () => void;
  selectedCategories?: SKUCategory[];
  onSelectCategories?: (categories: SKUCategory[]) => void;
  isExecuting?: boolean;
}

export function ForecastWorkspace({
  parameters,
  forecastResult,
  onUpdateLine,
  onUpdateMoq,
  selectedItemCode,
  onSelectItem,
  userRole,
  status,
  version,
  hasUnsavedChanges,
  isForecastStale = false,
  highlightedAlertItemCodes,
  activeAlertTitle,
  onSelectAlert,
  onOpenParameters,
  canGenerate,
  canSaveDraft,
  canSubmit,
  canApprove,
  canReturn,
  onGenerate,
  onSaveDraft,
  onSubmit,
  onApprove,
  onReturn,
  onExport,
  segmentation,
  isSegmentationLoading = false,
  segmentationError = null,
  onRetrySegmentation,
  selectedCategories,
  onSelectCategories,
  isExecuting = false
}: ForecastWorkspaceProps) {
  const { lines, kpis, alerts } = forecastResult;

  const selectedScopeLabel = selectedCategories && selectedCategories.length === 1
    ? (selectedCategories[0] === 'RUNNER' ? 'Runner' : selectedCategories[0] === 'REPEATER' ? 'Repeater' : 'Stranger')
    : (selectedCategories && selectedCategories.length < 3 ? selectedCategories.map(c => c.charAt(0) + c.slice(1).toLowerCase()).join(' & ') : '');

  const generateBtnLabel = selectedScopeLabel
    ? (lines.length > 0 ? `Regenerate ${selectedScopeLabel}` : `Generate ${selectedScopeLabel}`)
    : (lines.length > 0 ? 'Regenerate' : 'Generate');

  const selectedItem = lines.find(l => l.itemCode === selectedItemCode) || lines[0] || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Updated Excel Data Notification Banner */}
      {isForecastStale && (
        <div
          style={{
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: 8,
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Sparkles size={16} color="var(--ai-primary)" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#1e40af' }}>
              Updated Excel data imported. Regenerate the forecast to calculate using the latest data.
            </span>
          </div>
          {canGenerate && (
            <button
              type="button"
              className="btn-ai"
              onClick={onGenerate}
              disabled={isSegmentationLoading || !segmentation || Boolean(segmentationError)}
              title={isSegmentationLoading ? 'Calculating SKU segmentation...' : undefined}
              style={{
                fontSize: 12,
                padding: '5px 14px',
                flexShrink: 0,
                opacity: (isSegmentationLoading || !segmentation || Boolean(segmentationError)) ? 0.6 : 1,
                cursor: (isSegmentationLoading || !segmentation || Boolean(segmentationError)) ? 'not-allowed' : 'pointer'
              }}
            >
              <Sparkles size={13} />
              <span>Regenerate Forecast</span>
            </button>
          )}
        </div>
      )}

      {/* 1. Contextual Action Bar */}
      <div className="workspace-header-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>
                MRP DEMAND FORECAST
              </h2>
              <StatusBadge status={status} />
              <span className="badge-pill" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', fontSize: 11 }}>
                v{version}
              </span>
              {hasUnsavedChanges && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--planner-mod)', fontWeight: 600, background: 'var(--planner-mod-bg)', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--planner-mod-border)' }}>
                  ● Unsaved Planner Edits
                </span>
              )}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              Planning Horizon: <strong>{parameters.startMonth}</strong> (Next {parameters.horizon} Months) · {lines.length} Applicable Items
            </p>
          </div>
        </div>

        {/* Action Buttons Separated from Primary Navigation */}
        <div className="workspace-actions-group">
          {canGenerate && (
            <button
              type="button"
              className="btn-ai"
              onClick={onGenerate}
              disabled={isSegmentationLoading || !segmentation || Boolean(segmentationError)}
              title={isSegmentationLoading ? 'Calculating SKU segmentation...' : undefined}
              style={{
                opacity: (isSegmentationLoading || !segmentation || Boolean(segmentationError)) ? 0.6 : 1,
                cursor: (isSegmentationLoading || !segmentation || Boolean(segmentationError)) ? 'not-allowed' : 'pointer'
              }}
            >
              <Sparkles size={14} />
              <span>{isSegmentationLoading ? 'Calculating Segmentation...' : generateBtnLabel}</span>
            </button>
          )}

          {canSaveDraft && (
            <button
              type="button"
              className="btn-ghost"
              onClick={onSaveDraft}
            >
              <Save size={13} />
              <span>Save Draft</span>
            </button>
          )}

          {canSubmit && (
            <button
              type="button"
              className="btn-ghost"
              onClick={onSubmit}
            >
              <Send size={13} />
              <span>Submit for Approval</span>
            </button>
          )}

          {canApprove && (
            <button
              type="button"
              className="btn-ai"
              style={{ background: '#059669' }}
              onClick={onApprove}
            >
              <Check size={14} />
              <span>Approve Forecast</span>
            </button>
          )}

          {canReturn && (
            <button
              type="button"
              className="btn-ghost"
              style={{ color: 'var(--danger)', borderColor: 'var(--danger-border)' }}
              onClick={onReturn}
            >
              <Undo2 size={13} />
              <span>Return with Remark</span>
            </button>
          )}

          <button
            type="button"
            className="btn-ghost"
            onClick={onOpenParameters}
          >
            <SlidersHorizontal size={13} />
            <span>Scope & Parameters</span>
          </button>

          <button
            type="button"
            className="btn-ghost"
            onClick={onExport}
          >
            <Download size={13} />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* 2. Intelligence Hero Bento Strip */}
      <div className="intelligence-hero-strip">
        {/* Metric 1: AI Forecast Total */}
        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">AI Demand Forecast</span>
            <span className="bento-tag blue">{parameters.horizon}M Horizon</span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num">{formatCompact(kpis.aiForecastTotal)}</span>
            <span className={`bento-delta ${kpis.baselineGrowthPct >= 0 ? 'positive' : 'negative'}`}>
              <ArrowUpRight size={14} />
              {kpis.baselineGrowthPct >= 0 ? `+${kpis.baselineGrowthPct}%` : `${kpis.baselineGrowthPct}%`}
            </span>
          </div>
          <span className="bento-subtext">vs historical annual baseline demand</span>
        </div>

        {/* Metric 2: Net Requirement */}
        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">Net Requirement</span>
            <span className={`bento-tag ${kpis.shortagesCount > 0 ? 'red' : 'green'}`}>
              {kpis.shortagesCount > 0 ? `${kpis.shortagesCount} Shortages` : 'Covered'}
            </span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num" style={{ color: kpis.netRequirementTotal > 0 ? 'var(--danger)' : 'var(--success)' }}>
              {formatCompact(kpis.netRequirementTotal)}
            </span>
          </div>
          <span className="bento-subtext">After stock depletion & open PO supply</span>
        </div>

        {/* Metric 3: Forecast Reliability */}
        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">Forecast Reliability</span>
            <span className="bento-tag green">Empirical</span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num" style={{ color: 'var(--ai-primary)' }}>
              {kpis.avgConfidencePct !== null ? (kpis.avgConfidencePct >= 75 ? 'HIGH' : kpis.avgConfidencePct >= 50 ? 'MEDIUM' : 'LOW') : 'NOT EVALUATED'}
            </span>
          </div>
          <span className="bento-subtext">Derived from 24M variance & open orders</span>
        </div>

        {/* Metric 4: Forecast WAPE / Model Accuracy */}
        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">Model Accuracy</span>
            <span className={`bento-tag ${kpis.wapePct !== null ? 'green' : 'blue'}`}>
              {kpis.wapePct !== null ? 'WAPE Calculated' : 'No Benchmark'}
            </span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num" style={{ color: kpis.wapePct !== null ? '#047857' : 'var(--text-secondary)' }}>
              {kpis.wapePct !== null ? `${kpis.wapePct}%` : 'Not Available'}
            </span>
          </div>
          <span className="bento-subtext">
            {kpis.wapePct !== null ? 'Weighted error on actuals' : 'No historical forecasts in workbook'}
          </span>
        </div>

        {/* AI Demand Signal Card */}
        <div className="bento-intel-card ai-signal-card" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className="bento-card-top">
            <span className="bento-label" style={{ color: 'var(--ai-primary)' }}>Forecast Reliability</span>
            <span className={`bento-tag ${selectedItem?.confidence === 'High' ? 'green' : selectedItem?.confidence === 'Medium' ? 'blue' : 'amber'}`}>
              {selectedItem?.confidence?.toUpperCase() || 'NOT EVALUATED'}
            </span>
          </div>
          
          {selectedItem?.demandSignal.confidenceBlock?.metrics && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: 12 }}>
              <div style={{ background: 'rgba(79, 70, 229, 0.05)', padding: '6px', borderRadius: '4px' }}>
                <div style={{ color: 'var(--text-secondary)' }}>WAPE</div>
                <div style={{ fontWeight: 600 }}>{selectedItem.demandSignal.confidenceBlock.metrics.wape}%</div>
              </div>
              <div style={{ background: 'rgba(79, 70, 229, 0.05)', padding: '6px', borderRadius: '4px' }}>
                <div style={{ color: 'var(--text-secondary)' }}>Bias</div>
                <div style={{ fontWeight: 600 }}>{selectedItem.demandSignal.confidenceBlock.metrics.bias}%</div>
              </div>
              <div style={{ background: 'rgba(79, 70, 229, 0.05)', padding: '6px', borderRadius: '4px' }}>
                <div style={{ color: 'var(--text-secondary)' }}>Interval Width</div>
                <div style={{ fontWeight: 600 }}>{(selectedItem.demandSignal.confidenceBlock.metrics.intervalWidthRatio * 100).toFixed(0)}%</div>
              </div>
              <div style={{ background: 'rgba(79, 70, 229, 0.05)', padding: '6px', borderRadius: '4px' }}>
                <div style={{ color: 'var(--text-secondary)' }}>Valid Windows</div>
                <div style={{ fontWeight: 600 }}>{selectedItem.demandSignal.confidenceBlock.metrics.validationWindows}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 3. Scope Configuration Summary Bar */}
      <div className="scope-summary-bar">
        <div className="scope-chips">
          <span style={{ fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <SlidersHorizontal size={14} color="var(--ai-primary)" />
            Scope:
          </span>
          <span className="scope-chip-item">Start: <strong>{parameters.startMonth}</strong></span>
          <span className="scope-chip-item">Horizon: <strong>{parameters.horizon} Months</strong></span>
          <span className="scope-chip-item">History: <strong>{parameters.historyPeriod} Months</strong></span>
          <span className="scope-chip-item">Warehouses: <strong>{parameters.warehouses.length} Active</strong></span>
          <span className="scope-chip-item">Categories: <strong>{parameters.itemGroups.length} Active</strong></span>
          <span className="scope-chip-item">Seasonality: <strong style={{ color: parameters.seasonality ? '#047857' : 'inherit' }}>{parameters.seasonality ? 'ON' : 'OFF'}</strong></span>
          <span className="scope-chip-item">Open Orders: <strong style={{ color: parameters.includeOpenSalesOrders ? '#047857' : 'inherit' }}>{parameters.includeOpenSalesOrders ? 'INCLUDED' : 'EXCLUDED'}</strong></span>
        </div>

        <button
          type="button"
          className="btn-ghost"
          onClick={onOpenParameters}
          style={{ fontSize: 12, padding: '4px 12px' }}
        >
          <SlidersHorizontal size={13} />
          <span>Edit Configuration</span>
        </button>
      </div>

      {/* 4. Dynamic Anomaly & Planning Exceptions Strip */}
      {alerts.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-tertiary)' }}>
            Detected Exceptions:
          </span>
          {alerts.map(alt => {
            const isActive = activeAlertTitle === alt.title;
            const isCrit = alt.severity === 'Critical';

            return (
              <button
                key={alt.id}
                type="button"
                className="btn-ghost"
                onClick={() => onSelectAlert(isActive ? null : alt)}
                style={{
                  fontSize: 11.5,
                  padding: '3px 10px',
                  borderRadius: 6,
                  background: isActive ? 'var(--ai-subtle)' : isCrit ? 'var(--danger-subtle)' : '#ffffff',
                  borderColor: isActive ? 'var(--ai-primary)' : isCrit ? 'var(--danger-border)' : 'var(--border-subtle)',
                  color: isCrit ? 'var(--danger)' : 'var(--text-primary)',
                  fontWeight: isActive ? 700 : 500
                }}
              >
                <span>{alt.title}</span>
                {isActive && <span style={{ marginLeft: 4 }}>✕</span>}
              </button>
            );
          })}
          {activeAlertTitle && (
            <button
              type="button"
              onClick={() => onSelectAlert(null)}
              style={{ fontSize: 11, color: 'var(--ai-primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
            >
              Clear Filter ✕
            </button>
          )}
        </div>
      )}

      {/* 5. Demand-Based SKU Segmentation (Runner, Repeater, Stranger) */}
      <DemandSegmentationCards
        segmentation={segmentation}
        isLoading={isSegmentationLoading}
        error={segmentationError}
        onRetry={onRetrySegmentation}
        selectedCategories={selectedCategories || ['RUNNER', 'REPEATER', 'STRANGER']}
        onSelectCategories={onSelectCategories || (() => {})}
        isExecuting={isExecuting}
      />

      {/* 6. Forecast Grid (Primary Planner Workspace) */}
      <ForecastGrid
        lines={lines}
        startMonth={parameters.startMonth}
        horizon={parameters.horizon}
        selectedItemCode={selectedItemCode}
        onSelectItem={onSelectItem}
        onUpdateLine={onUpdateLine}
        userRole={userRole}
        status={status}
        highlightedItemCodes={highlightedAlertItemCodes}
        activeAlertTitle={activeAlertTitle}
        onClearAlertFilter={() => onSelectAlert(null)}
      />

      {/* 6. Item Intelligence Panel */}
      <AnalyticsPanel
        item={selectedItem}
        startMonth={parameters.startMonth}
        horizon={parameters.horizon}
        onUpdateMoq={onUpdateMoq}
      />
    </div>
  );
}
