import React, { useState, useMemo } from 'react';
import {
  ForecastParameters,
  ForecastLine,
  ForecastVersion,
  ForecastStatus,
  UserRole,
  AlertItem,
  NormalizedDataset,
  ForecastResult,
  ComponentRequirementRow
} from '../types';
import { formatNumber, formatCompact, ConfidenceBadge, StatusBadge, getMonthLabels, Modal } from './UI';
import { ForecastGrid } from './ForecastGrid';
import { AnalyticsPanel } from './AnalyticsPanel';
import {
  Sparkles,
  TrendingUp,
  AlertTriangle,
  AlertCircle,
  Info,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  Layers,
  Calendar,
  Cpu,
  CheckCircle2,
  Search,
  Filter,
  ArrowRight,
  Clock,
  ArrowUpRight,
  FileSpreadsheet,
  Database
} from 'lucide-react';

interface MRPForecastProps {
  parameters: ForecastParameters;
  onUpdateParameters: (params: ForecastParameters) => void;
  forecastResult: ForecastResult;
  onUpdateLine: (itemCode: string, plannerAdj: number | null, remark: string) => void;
  onUpdateMoq?: (itemCode: string, moq: number) => void;
  selectedItemCode: string | null;
  onSelectItem: (item: ForecastLine) => void;
  userRole: UserRole;
  status: ForecastStatus;
  activeTab: string;
  onTabChange: (tab: string) => void;
  versions: ForecastVersion[];
  onRestoreVersion: (ver: ForecastVersion) => void;
  highlightedAlertItemCodes: string[];
  activeAlertTitle: string | null;
  onSelectAlert: (alert: AlertItem | null) => void;
  isParametersOpen: boolean;
  onToggleParameters: () => void;
  dataset: NormalizedDataset;
}

export function MRPForecast({
  parameters,
  onUpdateParameters,
  forecastResult,
  onUpdateLine,
  onUpdateMoq,
  selectedItemCode,
  onSelectItem,
  userRole,
  status,
  activeTab,
  onTabChange,
  versions,
  onRestoreVersion,
  highlightedAlertItemCodes,
  activeAlertTitle,
  onSelectAlert,
  isParametersOpen,
  onToggleParameters,
  dataset
}: MRPForecastProps) {
  const { lines, kpis, alerts } = forecastResult;

  const selectedItem = useMemo(() => {
    return lines.find(l => l.itemCode === selectedItemCode) || lines[0] || null;
  }, [lines, selectedItemCode]);

  // Aggregate BOM Component Requirements dynamically from normalized dataset
  const componentRequirements = useMemo<ComponentRequirementRow[]>(() => {
    const rows: ComponentRequirementRow[] = [];
    const monthLabels = getMonthLabels(parameters.startMonth, parameters.horizon);

    lines.forEach(line => {
      if (line.makeBuy === 'Make') {
        const itemBOMs = dataset.boms.filter(b => b.parentItemCode === line.itemCode);
        itemBOMs.forEach((bom, bIdx) => {
          const reqQty = Math.round(line.finalQty * bom.qtyPerUnit);
          const stock = bom.currentStock || 0;
          const openPo = bom.openPo || 0;
          const shortage = Math.max(reqQty - stock - openPo, 0);

          rows.push({
            id: `${line.itemCode}-${bom.componentCode}-${bIdx}`,
            parentItemCode: line.itemCode,
            parentDescription: line.description,
            componentCode: bom.componentCode,
            componentName: bom.componentName,
            qtyPerUnit: bom.qtyPerUnit,
            requiredQty: reqQty,
            stock,
            openPo,
            shortage,
            month: monthLabels[0] || 'Month 1',
            uom: bom.uom
          });
        });
      }
    });

    return rows;
  }, [lines, dataset.boms, parameters.startMonth, parameters.horizon]);


  const [bomSearch, setBomSearch] = useState('');
  const [bomShortageOnly, setBomShortageOnly] = useState(false);

  // Available groups & warehouses from dataset
  const availableGroups = useMemo(() => {
    const set = new Set<string>();
    dataset.items.forEach(it => set.add(it.itemGroup));
    return Array.from(set).sort();
  }, [dataset.items]);

  const availableWarehouses = useMemo(() => {
    const set = new Set<string>();
    dataset.inventory.forEach(inv => set.add(inv.warehouse));
    return Array.from(set).sort();
  }, [dataset.inventory]);

  const handleToggleGroup = (group: string) => {
    const exists = parameters.itemGroups.includes(group);
    const newGroups = exists 
      ? parameters.itemGroups.filter(g => g !== group)
      : [...parameters.itemGroups, group];
    onUpdateParameters({ ...parameters, itemGroups: newGroups });
  };

  const handleToggleWarehouse = (wh: string) => {
    const exists = parameters.warehouses.includes(wh);
    const newWhs = exists 
      ? parameters.warehouses.filter(w => w !== wh)
      : [...parameters.warehouses, wh];
    onUpdateParameters({ ...parameters, warehouses: newWhs });
  };

  return (
    <div className="workspace-scroll-container">
      {/* Active Section Content: Strictly 1:1 with active navigation tab */}
      {activeTab === 'Forecast' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Data-Length-Aware Model Readiness Bar */}
          <div style={{ background: '#f8fafc', border: '1px solid var(--border-medium)', borderRadius: 10, padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Database size={16} color="var(--ai-primary)" />
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                Dataset History: {kpis.availableHistoryMonths} Months ({kpis.historyDateSpan})
              </span>
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, background: 'var(--ai-subtle)', color: 'var(--ai-primary)', fontWeight: 700, border: '1px solid var(--ai-border)' }}>
                {kpis.modelReadinessTier}
              </span>
              {parameters.historyPeriod > kpis.availableHistoryMonths && (
                <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', fontWeight: 700 }}>
                  Requested {parameters.historyPeriod}M &gt; Available {kpis.availableHistoryMonths}M (Limited Telemetry)
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {kpis.modelReadinessDescription}
            </div>
          </div>

          {/* 1. Intelligence Hero Bento Strip */}
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
                <span className={`bento-tag ${kpis.avgConfidencePct !== null && kpis.avgConfidencePct >= 75 ? 'green' : kpis.avgConfidencePct !== null && kpis.avgConfidencePct >= 50 ? 'blue' : 'amber'}`}>
                  {kpis.avgConfidencePct !== null ? (kpis.avgConfidencePct >= 75 ? 'HIGH' : kpis.avgConfidencePct >= 50 ? 'MEDIUM' : 'LOW') : 'NOT EVALUATED'}
                </span>
              </div>
              <div className="bento-value-row">
                <span className="bento-val-large num" style={{ color: 'var(--ai-primary)' }}>
                  {kpis.avgConfidencePct !== null ? `${kpis.avgConfidencePct}` : '—'}
                </span>
              </div>
              <span className="bento-subtext">Derived from {kpis.availableHistoryMonths}M telemetry & model validation</span>
            </div>

            {/* Metric 4: Forecast WAPE */}
            <div className="bento-intel-card">
              <div className="bento-card-top">
                <span className="bento-label">Model Accuracy</span>
                <span className="bento-tag blue">{kpis.wapePct !== null ? 'Calculated' : 'Benchmark'}</span>
              </div>
              <div className="bento-value-row">
                <span className="bento-val-large num" style={{ color: kpis.wapePct !== null ? '#047857' : 'var(--text-tertiary)' }}>
                  {kpis.wapePct !== null ? `${kpis.wapePct}%` : 'N/A'}
                </span>
              </div>
              <span className="bento-subtext">
                {kpis.wapePct !== null ? 'Weighted error on historical actuals' : 'No prior benchmark sheet'}
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

          {/* 2. Scope Configuration Summary Bar */}
          <div className="scope-summary-bar">
            <div className="scope-chips">
              <span style={{ fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <SlidersHorizontal size={14} color="var(--ai-primary)" />
                Scope:
              </span>
              <span className="scope-chip-item">Start: <strong>{parameters.startMonth}</strong></span>
              <span className="scope-chip-item">Horizon: <strong>{parameters.horizon} Months</strong></span>
              <span className="scope-chip-item">
                History: <strong>{kpis.availableHistoryMonths}M Available</strong> (Config: {parameters.historyPeriod}M)
                {parameters.historyPeriod > kpis.availableHistoryMonths && (
                  <span style={{ marginLeft: 4, color: '#b45309', fontWeight: 700 }}>[Limited Telemetry]</span>
                )}
              </span>
              <span className="scope-chip-item">Warehouses: <strong>{parameters.warehouses.length} Active</strong></span>
              <span className="scope-chip-item">Categories: <strong>{parameters.itemGroups.length} Active</strong></span>
              <span className="scope-chip-item">Seasonality: <strong style={{ color: parameters.seasonality ? '#047857' : 'inherit' }}>{parameters.seasonality ? 'ON' : 'OFF'}</strong></span>
              <span className="scope-chip-item">Open Orders: <strong style={{ color: parameters.includeOpenSalesOrders ? '#047857' : 'inherit' }}>{parameters.includeOpenSalesOrders ? 'INCLUDED' : 'EXCLUDED'}</strong></span>
            </div>

            <button 
              type="button" 
              className="btn-ghost" 
              onClick={onToggleParameters}
              style={{ fontSize: 12, padding: '4px 12px' }}
            >
              <SlidersHorizontal size={13} />
              <span>Edit Configuration</span>
            </button>
          </div>

          {/* 3. Dynamic Anomaly & Planning Alerts Strip */}
          {alerts.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-tertiary)' }}>
                Detected Exceptions:
              </span>
              {alerts.map(alt => {
                const isActive = activeAlertTitle === alt.title;
                const isCrit = alt.severity === 'Critical';
                const isWarn = alt.severity === 'Warning';

                return (
                  <button
                    key={alt.id}
                    type="button"
                    className="btn-ghost"
                    onClick={() => onSelectAlert(isActive ? null : alt)}
                    style={{
                      fontSize: 11.5,
                      padding: '3px 10px',
                      borderRadius: 9999,
                      background: isActive ? 'var(--ai-subtle)' : isCrit ? 'var(--danger-subtle)' : isWarn ? 'var(--warning-subtle)' : '#ffffff',
                      borderColor: isActive ? 'var(--ai-border)' : isCrit ? 'var(--danger-border)' : isWarn ? 'var(--warning-border)' : 'var(--border-subtle)',
                      color: isActive ? 'var(--ai-primary)' : isCrit ? 'var(--danger)' : isWarn ? 'var(--warning)' : 'var(--text-secondary)',
                      fontWeight: isActive ? 700 : 500
                    }}
                  >
                    {isCrit && <AlertCircle size={12} />}
                    {isWarn && <AlertTriangle size={12} />}
                    {!isCrit && !isWarn && <Info size={12} />}
                    <span>{alt.title}</span>
                    <span className="nav-tab-counter">{alt.count}</span>
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

          {/* Forecast Grid & Item Detail Drawer */}
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

          <AnalyticsPanel
            item={selectedItem}
            startMonth={parameters.startMonth}
            horizon={parameters.horizon}
            onUpdateMoq={onUpdateMoq}
          />
        </div>
      )}

      {/* Demand Intelligence Tab */}
      {activeTab === 'Demand Intelligence' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="workspace-table-card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 700 }}>AI Demand Signals & Causal Telemetry</h3>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Automated pattern detection across {kpis.availableHistoryMonths}-month historical telemetry ({kpis.historyDateSpan})
                </p>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
              {lines.map(line => (
                <div 
                  key={line.itemCode}
                  onClick={() => {
                    onSelectItem(line);
                    onTabChange('Forecast');
                  }}
                  style={{
                    background: '#ffffff',
                    border: `1px solid ${selectedItemCode === line.itemCode ? 'var(--ai-primary)' : 'var(--border-subtle)'}`,
                    borderRadius: 12,
                    padding: 14,
                    cursor: 'pointer',
                    boxShadow: selectedItemCode === line.itemCode ? '0 0 0 2px var(--ai-glow)' : 'var(--shadow-sm)',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--ai-primary)' }}>{line.itemCode}</span>
                    <ConfidenceBadge confidence={line.confidence} percentage={line.confidencePct ?? undefined} />
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', marginTop: 4 }}>{line.description}</div>
                  <div style={{ fontSize: 12, color: 'var(--ai-primary)', fontWeight: 700, marginTop: 8 }}>
                    {line.demandSignal.signalHeadline}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>
                    {line.demandSignal.aiRecommendation}
                  </div>
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)' }}>
                    <span>Velocity: <strong style={{ color: line.demandSignal.velocityTrendPct >= 0 ? '#047857' : 'var(--danger)' }}>{line.demandSignal.velocityTrendPct >= 0 ? `+${line.demandSignal.velocityTrendPct}%` : `${line.demandSignal.velocityTrendPct}%`}</strong></span>
                    <span style={{ color: 'var(--ai-primary)', fontWeight: 600 }}>Inspect SKU →</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Accuracy Tab */}
      {activeTab === 'Accuracy' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="workspace-table-card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: 12, flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 700 }}>Model Accuracy & WAPE Benchmarks</h3>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Evaluated on historical actuals: <code>WAPE = Σ |Forecast - Actual| / Σ Actual</code>
                </p>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ background: kpis.wapePct !== null ? 'var(--ai-subtle)' : '#f8fafc', border: `1px solid ${kpis.wapePct !== null ? 'var(--ai-border)' : 'var(--border-subtle)'}`, padding: '8px 16px', borderRadius: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: kpis.wapePct !== null ? 'var(--ai-primary)' : 'var(--text-tertiary)', textTransform: 'uppercase' }}>Portfolio WAPE</div>
                  <div className="num" style={{ fontSize: 20, fontWeight: 800, color: kpis.wapePct !== null ? '#047857' : 'var(--text-tertiary)' }}>
                    {kpis.wapePct !== null ? `${kpis.wapePct}%` : 'Not Available'}
                  </div>
                </div>
              </div>
            </div>

            {dataset.accuracyRecords && dataset.accuracyRecords.length > 0 ? (
              <div className="modern-table-container" style={{ marginTop: 14 }}>
                <table className="modern-data-table">
                  <thead>
                    <tr>
                      <th>SKU Code</th>
                      <th>Product Description</th>
                      <th>Category</th>
                      <th style={{ textAlign: 'center' }}>Month</th>
                      <th style={{ textAlign: 'right' }}>Forecast Qty</th>
                      <th style={{ textAlign: 'right' }}>Actual Invoiced</th>
                      <th style={{ textAlign: 'right' }}>Variance</th>
                      <th style={{ textAlign: 'right' }}>WAPE %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dataset.accuracyRecords.map((rec, i) => (
                      <tr key={i}>
                        <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--ai-primary)' }}>{rec.itemCode}</td>
                        <td>{rec.description}</td>
                        <td>{rec.itemGroup}</td>
                        <td style={{ textAlign: 'center' }} className="num">{rec.month}</td>
                        <td style={{ textAlign: 'right' }} className="num">{formatNumber(rec.forecast)}</td>
                        <td style={{ textAlign: 'right' }} className="num">{formatNumber(rec.actual)}</td>
                        <td style={{ textAlign: 'right', color: rec.variance < 0 ? 'var(--danger)' : 'var(--success)' }} className="num">
                          {rec.variance > 0 ? `+${formatNumber(rec.variance)}` : formatNumber(rec.variance)}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }} className="num">{(rec.wape * 100).toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ padding: '36px 20px', textAlign: 'center' }}>
                <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--ai-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: 'var(--ai-primary)' }}>
                  <Info size={22} />
                </div>
                <h4 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>Historical Accuracy Benchmark Not Available</h4>
                <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', maxWidth: 540, margin: '8px auto 0', lineHeight: 1.6 }}>
                  The uploaded Excel workbook does not include a historical benchmark sheet (<code>Forecast Accuracy</code> or <code>Historical Actuals</code>). 
                  To enable automated WAPE calculation and model backtesting, upload a workbook containing prior forecast and invoiced actuals columns.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Components Tab (BOM Explosion) */}
      {activeTab === 'Components' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="workspace-table-card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: 12, flexWrap: 'wrap', gap: 10 }}>
              <div>
                <h3 style={{ fontSize: 15, fontWeight: 700 }}>BOM Component Explosion for In-House Make SKUs</h3>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Computed dynamically from current Final Quantities & raw material stock levels
                </p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="toolbar-search-wrapper" style={{ width: 200 }}>
                  <Search size={13} color="#64748b" />
                  <input 
                    type="text" 
                    placeholder="Filter components..." 
                    value={bomSearch}
                    onChange={(e) => setBomSearch(e.target.value)}
                  />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
                  <input 
                    type="checkbox" 
                    checked={bomShortageOnly}
                    onChange={(e) => setBomShortageOnly(e.target.checked)}
                  />
                  <span>Shortages Only</span>
                </label>
              </div>
            </div>

            {componentRequirements.length > 0 ? (
              <div className="modern-table-container" style={{ marginTop: 14 }}>
                <table className="modern-data-table">
                  <thead>
                    <tr>
                      <th>Parent SKU</th>
                      <th>Component Code</th>
                      <th>Component Description</th>
                      <th style={{ textAlign: 'center' }}>Per Unit</th>
                      <th style={{ textAlign: 'center' }}>UoM</th>
                      <th style={{ textAlign: 'right' }}>Total Required</th>
                      <th style={{ textAlign: 'right' }}>On-Hand Stock</th>
                      <th style={{ textAlign: 'right' }}>Open PO</th>
                      <th style={{ textAlign: 'right' }}>Net Shortage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {componentRequirements
                      .filter(r => {
                        if (bomShortageOnly && r.shortage <= 0) return false;
                        if (bomSearch.trim()) {
                          const q = bomSearch.toLowerCase();
                          return r.componentCode.toLowerCase().includes(q) || r.componentName.toLowerCase().includes(q) || r.parentItemCode.toLowerCase().includes(q);
                        }
                        return true;
                      })
                      .map(r => (
                        <tr key={r.id}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--ai-primary)' }}>{r.parentItemCode}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{r.componentCode}</td>
                          <td>{r.componentName}</td>
                          <td style={{ textAlign: 'center' }} className="num">{r.qtyPerUnit}</td>
                          <td style={{ textAlign: 'center' }} className="num">{r.uom}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700 }} className="num">{formatNumber(r.requiredQty)}</td>
                          <td style={{ textAlign: 'right' }} className="num">{formatNumber(r.stock)}</td>
                          <td style={{ textAlign: 'right' }} className="num">{formatNumber(r.openPo)}</td>
                          <td style={{ textAlign: 'right' }} className="num">
                            {r.shortage > 0 ? (
                              <span style={{ color: 'var(--danger)', fontWeight: 800, background: 'var(--danger-subtle)', padding: '2px 7px', borderRadius: 4 }}>
                                {formatNumber(r.shortage)} Short
                              </span>
                            ) : (
                              <span style={{ color: 'var(--success)', fontWeight: 600 }}>Covered</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ padding: '36px 20px', textAlign: 'center' }}>
                <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--ai-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: 'var(--ai-primary)' }}>
                  <Layers size={22} />
                </div>
                <h4 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>No BOM Components In Dataset</h4>
                <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', maxWidth: 500, margin: '8px auto 0' }}>
                  No in-house 'Make' parent items or Bill of Materials relationships were detected in the uploaded Excel workbook.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Versions Tab (Modern Timeline) */}
      {activeTab === 'Versions' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="workspace-table-card" style={{ padding: 20 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Forecast Iteration & Continuous Learning Timeline</h3>
            {versions.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {versions.map(v => (
                  <div 
                    key={v.version}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: '#ffffff',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 12,
                      padding: '14px 18px',
                      boxShadow: 'var(--shadow-sm)'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--ai-subtle)', color: 'var(--ai-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 14 }}>
                        v{v.version}
                      </div>
                      <div>
                        <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 13.5 }}>
                          Version {v.version} · {v.status}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
                          {v.date} by {v.user} · {v.parameters.horizon}M Horizon ({v.parameters.startMonth})
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>AI Demand Total</div>
                        <div className="num" style={{ fontWeight: 800, fontSize: 14 }}>{formatNumber(v.aiTotal)}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>Net Requirement</div>
                        <div className="num" style={{ fontWeight: 800, fontSize: 14, color: 'var(--danger)' }}>{formatNumber(v.netReqTotal)}</div>
                      </div>
                      <button 
                        type="button" 
                        className="btn-ghost" 
                        onClick={() => onRestoreVersion(v)}
                        style={{ fontSize: 12 }}
                      >
                        View Snapshot
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: '36px 20px', textAlign: 'center' }}>
                <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--ai-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: 'var(--ai-primary)' }}>
                  <Calendar size={22} />
                </div>
                <h4 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>No Prior Versions in Current Session</h4>
                <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', maxWidth: 500, margin: '8px auto 0' }}>
                  Generating forecasts, saving drafts, or submitting for approval will automatically record milestone snapshots here.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Scope Configuration Drawer / Modal */}
      <Modal
        isOpen={isParametersOpen}
        title="Forecast Scope & Algorithm Parameters"
        onClose={onToggleParameters}
        maxWidth="740px"
        footer={
          <button 
            type="button" 
            className="btn-ai" 
            onClick={onToggleParameters}
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
                onChange={(e) => onUpdateParameters({ ...parameters, startMonth: e.target.value })}
                style={{ width: '100%', marginTop: 4 }}
              />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Horizon ({parameters.horizon} Mo.)</label>
              <select 
                className="modern-select" 
                value={parameters.horizon}
                onChange={(e) => onUpdateParameters({ ...parameters, horizon: parseInt(e.target.value, 10) })}
                style={{ width: '100%', marginTop: 4 }}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => (
                  <option key={n} value={n}>{n} Months</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                History Window ({parameters.historyPeriod}M)
              </label>
              <select
                className="modern-select"
                value={parameters.historyPeriod}
                onChange={(e) => onUpdateParameters({ ...parameters, historyPeriod: parseInt(e.target.value, 10) })}
                style={{ width: '100%', marginTop: 4 }}
              >
                {[3, 6, 12, 18, 24, 36, 48].map(m => (
                  <option key={m} value={m}>{m} Months {m === 24 ? '(Default)' : ''}</option>
                ))}
              </select>
            </div>
          </div>

          {/* FSD Compatibility & Telemetry Availability Status */}
          <div style={{ 
            background: parameters.historyPeriod > kpis.availableHistoryMonths ? '#fffbeb' : '#f0fdf4', 
            border: `1px solid ${parameters.historyPeriod > kpis.availableHistoryMonths ? '#fde68a' : '#bbf7d0'}`, 
            borderRadius: 8, 
            padding: '10px 14px', 
            fontSize: 12, 
            color: parameters.historyPeriod > kpis.availableHistoryMonths ? '#92400e' : '#166534' 
          }}>
            <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Database size={14} />
              <span>Dynamic History Detection Status:</span>
            </div>
            <div style={{ marginTop: 4 }}>
              Requested history: <strong>{parameters.historyPeriod} months</strong> | Available history: <strong>{kpis.availableHistoryMonths} months</strong> ({kpis.historyDateSpan}).
            </div>
            {parameters.historyPeriod > kpis.availableHistoryMonths ? (
              <div style={{ marginTop: 4, fontWeight: 600 }}>
                Status: <strong>Limited historical data</strong>. The engine trains on all {kpis.availableHistoryMonths} available months without fabricating missing data.
              </div>
            ) : (
              <div style={{ marginTop: 4 }}>
                Status: <strong>Full telemetry available</strong>. History covers requested analysis window.
              </div>
            )}
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

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={parameters.seasonality}
                onChange={(e) => onUpdateParameters({ ...parameters, seasonality: e.target.checked })}
              />
              <span>Enable Mathematical Seasonality & Trend Detection</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={parameters.treatBulkProjectSeparately}
                onChange={(e) => onUpdateParameters({ ...parameters, treatBulkProjectSeparately: e.target.checked })}
              />
              <span>Treat Bulk & Project Orders Separately (Smooth Lumpy Demand)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={parameters.includeOpenSalesOrders}
                onChange={(e) => onUpdateParameters({ ...parameters, includeOpenSalesOrders: e.target.checked })}
              />
              <span>Include Open Sales Orders as Firm Demand</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={parameters.applyMoqOrderMultiple}
                onChange={(e) => onUpdateParameters({ ...parameters, applyMoqOrderMultiple: e.target.checked })}
              />
              <span>Apply Item MOQ & Order Multiples to Net Requirements</span>
            </label>
          </div>
        </div>
      </Modal>
    </div>
  );
}
