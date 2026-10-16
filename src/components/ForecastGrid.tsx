import React, { useState, useMemo } from 'react';
import { ForecastLine, ConfidenceLevel, MakeBuy, PlanningMethod, UserRole, ForecastStatus } from '../types';
import { formatNumber, ConfidenceBadge, getMonthLabels } from './UI';
import { Search, ArrowUpDown, ArrowUp, ArrowDown, AlertCircle, X, Sparkles, Filter } from 'lucide-react';

interface ForecastGridProps {
  lines: ForecastLine[];
  startMonth: string;
  horizon: number;
  selectedItemCode: string | null;
  onSelectItem: (item: ForecastLine) => void;
  onUpdateLine: (itemCode: string, plannerAdj: number | null, remark: string) => void;
  userRole: UserRole;
  status: ForecastStatus;
  highlightedItemCodes: string[];
  activeAlertTitle: string | null;
  onClearAlertFilter: () => void;
}

type SortField = 
  | 'itemCode' 
  | 'historyAvailableMonths'
  | 'avgPerMonth' 
  | 'aiTotal' 
  | 'plannerAdj' 
  | 'finalQty' 
  | 'stock' 
  | 'openPo' 
  | 'rawNetReq'
  | 'moq'
  | 'plannedOrderQty'
  | 'netReq' 
  | 'confidencePct';

export function ForecastGrid({
  lines,
  startMonth,
  horizon,
  selectedItemCode,
  onSelectItem,
  onUpdateLine,
  userRole,
  status,
  highlightedItemCodes,
  activeAlertTitle,
  onClearAlertFilter
}: ForecastGridProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [confidenceFilter, setConfidenceFilter] = useState<'ALL' | ConfidenceLevel>('ALL');
  const [shortageFilter, setShortageFilter] = useState<'ALL' | 'SHORTAGE_ONLY'>('ALL');
  const [adjustedFilter, setAdjustedFilter] = useState<'ALL' | 'ADJUSTED_ONLY'>('ALL');
  const [makeBuyFilter, setMakeBuyFilter] = useState<'ALL' | MakeBuy>('ALL');
  const [planningMethodFilter, setPlanningMethodFilter] = useState<'ALL' | PlanningMethod>('ALL');
  const [itemGroupFilter, setItemGroupFilter] = useState<string>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | 'RUNNER' | 'REPEATER' | 'STRANGER' | 'UNCLASSIFIED'>('ALL');

  const [sortField, setSortField] = useState<SortField>('itemCode');
  const [sortAsc, setSortAsc] = useState(true);

  const isEditingLocked = 
    status === 'Submitted' || 
    status === 'Approved' || 
    
    (userRole !== 'PLANNER' && userRole !== 'ADMINISTRATOR');

  const monthLabels = useMemo(() => getMonthLabels(startMonth, horizon), [startMonth, horizon]);

  const uniqueGroups = useMemo(() => {
    const groups = new Set<string>();
    lines.forEach(l => groups.add(l.itemGroup));
    return Array.from(groups).sort();
  }, [lines]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const filteredAndSortedLines = useMemo(() => {
    return lines.filter(item => {
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        if (!item.itemCode.toLowerCase().includes(q) && !item.description.toLowerCase().includes(q)) {
          return false;
        }
      }

      if (confidenceFilter !== 'ALL' && item.confidence !== confidenceFilter) return false;
      if (shortageFilter === 'SHORTAGE_ONLY') {
        const hasShortage = (item.rawNetReq !== null && item.rawNetReq > 0) || (item.plannedOrderQty !== null && item.plannedOrderQty > 0) || (item.netReq !== null && item.netReq > 0);
        if (!hasShortage) return false;
      }
      if (adjustedFilter === 'ADJUSTED_ONLY' && item.plannerAdj === null) return false;
      if (makeBuyFilter !== 'ALL' && item.makeBuy !== makeBuyFilter) return false;
      if (planningMethodFilter !== 'ALL' && item.planningMethod !== planningMethodFilter) return false;
      if (itemGroupFilter !== 'ALL' && item.itemGroup !== itemGroupFilter) return false;
      if (categoryFilter !== 'ALL' && (item.category || 'STRANGER') !== categoryFilter) return false;

      if (highlightedItemCodes.length > 0 && !highlightedItemCodes.includes(item.itemCode)) {
        return false;
      }

      return true;
    }).sort((a, b) => {
      let valA: any = a[sortField];
      let valB: any = b[sortField];

      if (sortField === 'rawNetReq') {
        valA = a.rawNetReq === null ? -1 : a.rawNetReq;
        valB = b.rawNetReq === null ? -1 : b.rawNetReq;
      } else if (sortField === 'plannedOrderQty' || sortField === 'netReq') {
        valA = (a.plannedOrderQty ?? a.netReq) === null ? -1 : (a.plannedOrderQty ?? a.netReq);
        valB = (b.plannedOrderQty ?? b.netReq) === null ? -1 : (b.plannedOrderQty ?? b.netReq);
      } else if (sortField === 'moq') {
        valA = a.moq;
        valB = b.moq;
      } else if (sortField === 'plannerAdj') {
        valA = a.plannerAdj === null ? -1 : a.plannerAdj;
        valB = b.plannerAdj === null ? -1 : b.plannerAdj;
      }

      if (valA === valB) return 0;
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;

      if (typeof valA === 'string') {
        return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return sortAsc ? valA - valB : valB - valA;
    });
  }, [
    lines,
    searchTerm,
    confidenceFilter,
    shortageFilter,
    adjustedFilter,
    makeBuyFilter,
    planningMethodFilter,
    itemGroupFilter,
    highlightedItemCodes,
    sortField,
    sortAsc
  ]);

  const renderSortIndicator = (field: SortField) => {
    if (sortField !== field) {
      return <ArrowUpDown size={11} style={{ opacity: 0.3, marginLeft: 4 }} />;
    }
    return sortAsc 
      ? <ArrowUp size={11} style={{ color: 'var(--ai-primary)', marginLeft: 4 }} />
      : <ArrowDown size={11} style={{ color: 'var(--ai-primary)', marginLeft: 4 }} />;
  };

  return (
    <div className="workspace-table-card">
      {/* Modern Table Toolbar */}
      <div className="table-toolbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* Search Box */}
          <div className="toolbar-search-wrapper">
            <Search size={14} color="#64748b" />
            <input 
              type="text" 
              placeholder="Search SKU or description..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button 
                type="button" 
                onClick={() => setSearchTerm('')} 
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Group Filter */}
          <select 
            className="modern-select" 
            value={itemGroupFilter} 
            onChange={(e) => setItemGroupFilter(e.target.value)}
          >
            <option value="ALL">All Categories</option>
            {uniqueGroups.map(grp => (
              <option key={grp} value={grp}>{grp}</option>
            ))}
          </select>

          {/* Confidence Filter */}
          <select 
            className="modern-select" 
            value={confidenceFilter} 
            onChange={(e) => setConfidenceFilter(e.target.value as any)}
          >
            <option value="ALL">All Reliability</option>
            <option value="High">High Confidence (≥85%)</option>
            <option value="Medium">Medium (70–84%)</option>
            <option value="Low">Low (&lt;70%)</option>
          </select>

          {/* Shortage Filter */}
          <select 
            className="modern-select" 
            value={shortageFilter} 
            onChange={(e) => setShortageFilter(e.target.value as any)}
          >
            <option value="ALL">All Requirements</option>
            <option value="SHORTAGE_ONLY">Net Shortages Only</option>
          </select>

          {/* Adjusted Filter */}
          <select 
            className="modern-select" 
            value={adjustedFilter} 
            onChange={(e) => setAdjustedFilter(e.target.value as any)}
          >
            <option value="ALL">All Lines</option>
            <option value="ADJUSTED_ONLY">Planner Overrides Only</option>
          </select>

          {/* Demand Category Filter */}
          <select 
            className="modern-select" 
            value={categoryFilter} 
            onChange={(e) => setCategoryFilter(e.target.value as any)}
            title="Filter by Demand Category (Runner, Repeater, Stranger)"
          >
            <option value="ALL">All Categories</option>
            <option value="RUNNER">Runner Only</option>
            <option value="REPEATER">Repeater Only</option>
            <option value="STRANGER">Stranger Only</option>
          </select>

          {/* Active Alert Highlight Badge */}
          {activeAlertTitle && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, background: 'var(--ai-subtle)', border: '1px solid var(--ai-border)', color: 'var(--ai-primary)', padding: '3px 10px', borderRadius: 9999, fontWeight: 600 }}>
              <span>Filtered: {activeAlertTitle}</span>
              <button 
                type="button" 
                onClick={onClearAlertFilter} 
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ai-primary)', fontWeight: 'bold' }}
              >
                ✕
              </button>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            Showing <strong>{filteredAndSortedLines.length}</strong> of <strong>{lines.length}</strong> items
          </span>
          {isEditingLocked && (
            <span style={{ fontSize: 11, background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid var(--danger-border)', padding: '2px 8px', borderRadius: 6, fontWeight: 600 }}>
              {status === 'Submitted' ? 'Review Locked' : status === 'Approved' ? 'Approved Locked' : 'Read Only'}
            </span>
          )}
        </div>
      </div>

      {/* Modern Data Table */}
      <div className="modern-table-container">
        {(() => {
          const COL_WIDTHS = {
            num: 48,
            code: 152,
            desc: 260,
            uom: 60,
            history: 80,
            model: 192,
            avgPerMonth: 96,
            month: 104,
            aiTotal: 116,
            plannerAdj: 128,
            finalQty: 104,
            stock: 88,
            openPo: 88,
            rawNetReq: 148,
            moq: 84,
            plannedOrderQty: 156,
            confidence: 160,
            remark: 240,
          };

          const totalTableWidth =
            COL_WIDTHS.num +
            COL_WIDTHS.code +
            COL_WIDTHS.desc +
            COL_WIDTHS.uom +
            COL_WIDTHS.history +
            COL_WIDTHS.model +
            COL_WIDTHS.avgPerMonth +
            monthLabels.length * COL_WIDTHS.month +
            COL_WIDTHS.aiTotal +
            COL_WIDTHS.plannerAdj +
            COL_WIDTHS.finalQty +
            COL_WIDTHS.stock +
            COL_WIDTHS.openPo +
            COL_WIDTHS.rawNetReq +
            COL_WIDTHS.moq +
            COL_WIDTHS.plannedOrderQty +
            COL_WIDTHS.confidence +
            COL_WIDTHS.remark;

          return (
            <table 
              className="modern-data-table forecast-grid-table" 
              style={{ width: totalTableWidth, minWidth: totalTableWidth }}
            >
              <colgroup>
                <col style={{ width: COL_WIDTHS.num }} />
                <col style={{ width: COL_WIDTHS.code }} />
                <col style={{ width: COL_WIDTHS.desc }} />
                <col style={{ width: COL_WIDTHS.uom }} />
                <col style={{ width: COL_WIDTHS.history }} />
                <col style={{ width: COL_WIDTHS.model }} />
                <col style={{ width: COL_WIDTHS.avgPerMonth }} />
                {monthLabels.map((_, idx) => (
                  <col key={idx} style={{ width: COL_WIDTHS.month }} />
                ))}
                <col style={{ width: COL_WIDTHS.aiTotal }} />
                <col style={{ width: COL_WIDTHS.plannerAdj }} />
                <col style={{ width: COL_WIDTHS.finalQty }} />
                <col style={{ width: COL_WIDTHS.stock }} />
                <col style={{ width: COL_WIDTHS.openPo }} />
                <col style={{ width: COL_WIDTHS.rawNetReq }} />
                <col style={{ width: COL_WIDTHS.moq }} />
                <col style={{ width: COL_WIDTHS.plannedOrderQty }} />
                <col style={{ width: COL_WIDTHS.confidence }} />
                <col style={{ width: COL_WIDTHS.remark }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="col-sticky-num" style={{ textAlign: 'center' }}>#</th>
                  <th className="col-sticky-code sortable" onClick={() => handleSort('itemCode')}>
                    SKU / Code {renderSortIndicator('itemCode')}
                  </th>
                  <th className="col-sticky-desc">Description</th>
                  <th style={{ textAlign: 'center' }}>UoM</th>
                  <th className="sortable" style={{ textAlign: 'center' }} onClick={() => handleSort('historyAvailableMonths')}>
                    History {renderSortIndicator('historyAvailableMonths')}
                  </th>
                  <th style={{ textAlign: 'left' }}>
                    Model & Tier
                  </th>
                  <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('avgPerMonth')}>
                    Avg / Mo {renderSortIndicator('avgPerMonth')}
                  </th>

                  {/* Dynamic Month Columns */}
                  {monthLabels.map((lbl, idx) => (
                    <th key={idx} style={{ textAlign: 'right' }}>
                      {lbl}
                    </th>
                  ))}

                  <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('aiTotal')}>
                    AI Forecast {renderSortIndicator('aiTotal')}
                  </th>
                  <th className="sortable" style={{ textAlign: 'right', background: 'var(--planner-mod-bg)', color: 'var(--planner-mod)' }} onClick={() => handleSort('plannerAdj')}>
                    Planner Adj. {renderSortIndicator('plannerAdj')}
                  </th>
                  <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('finalQty')}>
                    Final Qty {renderSortIndicator('finalQty')}
                  </th>
                  <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('stock')}>
                    Stock {renderSortIndicator('stock')}
                  </th>
                  <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('openPo')}>
                    Open PO {renderSortIndicator('openPo')}
                  </th>
                  <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('rawNetReq')} title="Net Requirement Before Lot Sizing">
                    Net Req. (Pre-Lot) {renderSortIndicator('rawNetReq')}
                  </th>
                  <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('moq')}>
                    MOQ {renderSortIndicator('moq')}
                  </th>
                  <th className="sortable" style={{ textAlign: 'right' }} onClick={() => handleSort('plannedOrderQty')} title="Planned Order Qty After Lot Sizing">
                    Planned Order (Post-Lot) {renderSortIndicator('plannedOrderQty')}
                  </th>
                  <th className="sortable" style={{ textAlign: 'center' }} onClick={() => handleSort('confidencePct')}>
                    Forecast Reliability {renderSortIndicator('confidencePct')}
                  </th>
                  <th style={{ textAlign: 'left' }}>Adjustment Remark</th>
                </tr>
              </thead>
              <tbody>
                {filteredAndSortedLines.length === 0 ? (
                  <tr>
                    <td colSpan={17 + monthLabels.length} style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--text-tertiary)' }}>
                      No items match the current search or filter parameters.
                    </td>
                  </tr>
                ) : (
                  filteredAndSortedLines.map((line, index) => {
                    const isSelected = selectedItemCode === line.itemCode;
                    const isAlertItem = highlightedItemCodes.includes(line.itemCode);

                    const hasLargeAdj = 
                      line.plannerAdj !== null && 
                      line.aiTotal > 0 && 
                      (Math.abs(line.plannerAdj - line.aiTotal) / line.aiTotal) > 0.20;
                    
                    const isRemarkMissing = hasLargeAdj && (!line.remark || line.remark.trim() === '');

                    return (
                      <tr 
                        key={line.id} 
                        className={`${isSelected ? 'selected' : ''} ${isAlertItem ? 'alert-highlight' : ''}`}
                        onClick={() => onSelectItem(line)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td className="col-sticky-num num" style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 11 }}>
                          {index + 1}
                        </td>

                        {/* SKU Sticky */}
                        <td className="col-sticky-code">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden', whiteSpace: 'nowrap', width: '100%' }}>
                            <span className="cell-truncate" style={{ flex: '1 1 auto', minWidth: 0 }} title={line.itemCode}>{line.itemCode}</span>
                            {line.category && (
                              <span
                                style={{
                                  fontSize: 9,
                                  fontWeight: 800,
                                  padding: '1px 5px',
                                  borderRadius: 3,
                                  letterSpacing: '0.2px',
                                  flexShrink: 0,
                                  background:
                                    line.category === 'RUNNER'
                                      ? 'rgba(16, 185, 129, 0.15)'
                                      : line.category === 'REPEATER'
                                      ? 'rgba(59, 130, 246, 0.15)'
                                      : line.category === 'STRANGER'
                                      ? 'rgba(245, 158, 11, 0.15)'
                                      : '#f1f5f9',
                                  color:
                                    line.category === 'RUNNER'
                                      ? '#047857'
                                      : line.category === 'REPEATER'
                                      ? '#1d4ed8'
                                      : line.category === 'STRANGER'
                                      ? '#b45309'
                                      : '#64748b'
                                }}
                                title={line.classificationReason || `Demand Category: ${line.category}`}
                              >
                                {line.category}
                              </span>
                            )}
                            {line.isDiscontinued && (
                              <span style={{ fontSize: 9, color: '#e11d48', background: '#ffe4e6', padding: '1px 4px', borderRadius: 3, fontWeight: 700, flexShrink: 0 }}>
                                PHASE-OUT
                              </span>
                            )}
                            {line.isNewItem && (
                              <span style={{ fontSize: 9, color: 'var(--ai-primary)', background: 'var(--ai-subtle)', padding: '1px 4px', borderRadius: 3, fontWeight: 700, flexShrink: 0 }}>
                                NEW
                              </span>
                            )}
                            {line.momentumFlag && line.momentumFlag !== 'NEUTRAL' && (
                              <span
                                style={{
                                  fontSize: 9,
                                  fontWeight: 800,
                                  padding: '1px 5px',
                                  borderRadius: 3,
                                  letterSpacing: '0.2px',
                                  flexShrink: 0,
                                  background:
                                    line.momentumFlag === 'SURGE'
                                      ? 'rgba(16, 185, 129, 0.2)'
                                      : 'rgba(239, 68, 68, 0.15)',
                                  color:
                                    line.momentumFlag === 'SURGE'
                                      ? '#065f46'
                                      : '#b91c1c'
                                }}
                                title={`Momentum: ${line.momentumFlag}${line.yoyVelocityPct !== null && line.yoyVelocityPct !== undefined ? ` (${line.yoyVelocityPct > 0 ? '+' : ''}${line.yoyVelocityPct}% YoY)` : ''}`}
                              >
                                {line.momentumFlag === 'SURGE' ? '▲ SURGE' : '▼ NEGATIVE'}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Description Sticky */}
                        <td className="col-sticky-desc" title={line.description}>
                          <div className="cell-truncate">
                            {line.description}
                          </div>
                        </td>

                        <td style={{ textAlign: 'center', color: 'var(--text-secondary)' }} className="num">{line.uom}</td>

                        {/* History Depth Badge */}
                        <td style={{ textAlign: 'center' }}>
                          <span 
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              padding: '2px 7px',
                              borderRadius: 5,
                              display: 'inline-block',
                              background: line.historyAvailableMonths >= 24 ? '#f5f3ff' : line.historyAvailableMonths >= 12 ? '#eff6ff' : line.historyAvailableMonths >= 6 ? '#f0fdf4' : line.historyAvailableMonths >= 3 ? '#fffbeb' : '#fef2f2',
                              color: line.historyAvailableMonths >= 24 ? '#6b21a8' : line.historyAvailableMonths >= 12 ? '#1e40af' : line.historyAvailableMonths >= 6 ? '#166534' : line.historyAvailableMonths >= 3 ? '#92400e' : '#991b1b',
                              border: `1px solid ${line.historyAvailableMonths >= 24 ? '#ddd6fe' : line.historyAvailableMonths >= 12 ? '#bfdbfe' : line.historyAvailableMonths >= 6 ? '#bbf7d0' : line.historyAvailableMonths >= 3 ? '#fde68a' : '#fecaca'}`
                            }}
                            title={`${line.historyAvailableMonths} months available (${line.historyDateRange})`}
                          >
                            {line.historyAvailableMonths}M
                          </span>
                        </td>

                        {/* Learning Model & Tier */}
                        <td style={{ textAlign: 'left' }}>
                          <div className="cell-truncate" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)', lineHeight: '1.2' }} title={line.modelDecision?.selectedModel}>
                            {line.modelDecision?.selectedModel || 'AI Baseline'}
                          </div>
                          <div className="cell-truncate" style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2, lineHeight: '1.2' }} title={line.modelDecision?.modelTier}>
                            {line.modelDecision?.modelTier.split(':')[0]} {line.modelDecision?.backtestWape !== null ? `· ${line.modelDecision?.backtestWape}% WAPE` : ''}
                          </div>
                        </td>

                        <td style={{ textAlign: 'right' }} className="num">{formatNumber(line.avgPerMonth)}</td>

                        {/* Monthly Forecast Values */}
                        {line.monthlyForecast.map((mVal, mIdx) => {
                          const isColdOrSparse = line.modelDecision?.selectionStatus === 'COLD_START' || line.modelDecision?.selectionStatus === 'SPARSE_HISTORY';
                          const isInsufficient6to11 = line.historyAvailableMonths >= 6 && line.historyAvailableMonths < 12;

                          if (isInsufficient6to11 && line.aiTotal === 0 && mVal === 0) {
                            return (
                              <td key={mIdx} style={{ textAlign: 'right', verticalAlign: 'middle', color: 'var(--text-tertiary)' }} className="num">
                                —
                              </td>
                            );
                          }

                          let intervalContent = null;
                          if (line.confidenceBlock) {
                            if (line.confidenceBlock.status === 'NOT_EVALUATED' || isColdOrSparse) {
                              intervalContent = (
                                <div 
                                  style={{ 
                                    fontSize: '9.5px', 
                                    color: 'var(--text-tertiary)', 
                                    marginTop: 2, 
                                    whiteSpace: 'nowrap', 
                                    lineHeight: '1.2',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    maxWidth: '100%'
                                  }} 
                                  title="Prediction interval (Not evaluated)"
                                >
                                  Not evaluated
                                </div>
                              );
                            } else {
                              const lower = line.confidenceBlock.lowerBound?.[mIdx];
                              const upper = line.confidenceBlock.upperBound?.[mIdx];
                              if (lower != null && upper != null) {
                                intervalContent = (
                                  <div 
                                    style={{ 
                                      fontSize: '9.5px', 
                                      color: 'var(--text-secondary)', 
                                      marginTop: 2, 
                                      whiteSpace: 'nowrap', 
                                      lineHeight: '1.2',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      maxWidth: '100%'
                                    }} 
                                    title={`Prediction Interval: ${formatNumber(lower)} - ${formatNumber(upper)}`}
                                  >
                                    {formatNumber(lower)}–{formatNumber(upper)}
                                  </div>
                                );
                              } else {
                                intervalContent = (
                                  <div 
                                    style={{ 
                                      fontSize: '9.5px', 
                                      color: 'var(--text-tertiary)', 
                                      marginTop: 2, 
                                      whiteSpace: 'nowrap', 
                                      lineHeight: '1.2',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      maxWidth: '100%'
                                    }} 
                                    title="Prediction interval (Not evaluated)"
                                  >
                                    Not evaluated
                                  </div>
                                );
                              }
                            }
                          }

                          return (
                            <td key={mIdx} style={{ textAlign: 'right', verticalAlign: 'middle' }} className="num">
                              <div style={{ fontWeight: 600, fontSize: '12.5px', lineHeight: '1.2' }}>{formatNumber(mVal)}</div>
                              {intervalContent}
                            </td>
                          );
                        })}

                        {/* AI Total */}
                        <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-secondary)' }} className="num">
                          {line.historyAvailableMonths >= 6 && line.historyAvailableMonths < 12 && line.aiTotal === 0 ? (
                            <span 
                              style={{ 
                                fontSize: 11, 
                                fontStyle: 'italic', 
                                fontWeight: 'normal', 
                                color: 'var(--text-tertiary)',
                                display: 'block',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                              }}
                              title="Insufficient historical data (6–11 months) to generate AI forecast"
                            >
                              Insufficient history
                            </span>
                          ) : (
                            formatNumber(line.aiTotal)
                          )}
                        </td>

                        {/* Planner Adj (Editable) */}
                        <td 
                          style={{ textAlign: 'right' }} 
                          className={line.plannerAdj !== null ? 'modified' : ''}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {isEditingLocked ? (
                            <span className="num" style={{ fontWeight: line.plannerAdj !== null ? 700 : 'normal', color: line.plannerAdj !== null ? 'var(--planner-mod)' : 'inherit' }}>
                              {line.plannerAdj !== null ? formatNumber(line.plannerAdj) : '—'}
                            </span>
                          ) : (
                            <input
                              type="number"
                              className={`modern-edit-input num ${line.plannerAdj !== null ? 'modified' : ''}`}
                              placeholder="—"
                              value={line.plannerAdj !== null ? line.plannerAdj : ''}
                              onChange={(e) => {
                                const valStr = e.target.value;
                                const newAdj = valStr === '' ? null : Math.max(0, parseInt(valStr, 10) || 0);
                                onUpdateLine(line.itemCode, newAdj, line.remark);
                              }}
                            />
                          )}
                        </td>

                        {/* Final Qty */}
                        <td style={{ textAlign: 'right', fontWeight: 800, color: line.plannerAdj !== null ? 'var(--planner-mod)' : 'var(--ai-primary)' }} className="num">
                          {formatNumber(line.finalQty)}
                        </td>

                        {/* Stock */}
                        <td style={{ textAlign: 'right' }} className="num">
                          {line.stock !== null && line.stock !== undefined ? formatNumber(line.stock) : '—'}
                        </td>

                        {/* Open PO */}
                        <td style={{ textAlign: 'right' }} className="num">
                          {line.openPo !== null && line.openPo !== undefined ? formatNumber(line.openPo) : '—'}
                        </td>

                        {/* Net Requirement Before Lot Sizing */}
                        <td style={{ textAlign: 'right' }} className="num">
                          {line.planningMethod !== 'MRP' ? (
                            <span style={{ color: 'var(--text-tertiary)', fontSize: 11, fontStyle: 'italic' }}>
                              N/A
                            </span>
                          ) : line.rawNetReq === null ? (
                            <span 
                              className="status-pill-missing-supply" 
                              title="Not Evaluated — Missing Supply Data (Stock or Open PO missing)"
                            >
                              <span className="status-dot-missing" />
                              <span className="status-pill-text">Not Evaluated — Missing Supply Data</span>
                            </span>
                          ) : line.rawNetReq > 0 ? (
                            <span style={{ color: 'var(--danger)', fontWeight: 700 }}>
                              {formatNumber(line.rawNetReq)}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--success)', fontWeight: 600 }}>0</span>
                          )}
                        </td>

                        {/* MOQ */}
                        <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }} className="num">
                          {line.moq > 0 ? formatNumber(line.moq) : '—'}
                        </td>

                        {/* Planned Order Qty After Lot Sizing */}
                        <td style={{ textAlign: 'right' }} className="num">
                          {line.planningMethod !== 'MRP' ? (
                            <span style={{ color: 'var(--text-tertiary)', fontSize: 11, fontStyle: 'italic' }}>
                              N/A
                            </span>
                          ) : (line.plannedOrderQty ?? line.netReq) === null ? (
                            <span 
                              className="status-pill-missing-supply" 
                              title="Not Evaluated — Missing Supply Data (Stock or Open PO missing)"
                            >
                              <span className="status-dot-missing" />
                              <span className="status-pill-text">Not Evaluated — Missing Supply Data</span>
                            </span>
                          ) : (line.plannedOrderQty ?? line.netReq)! > 0 ? (
                            <span style={{ color: 'var(--danger)', fontWeight: 800, background: 'var(--danger-subtle)', padding: '2px 7px', borderRadius: 4 }}>
                              {formatNumber((line.plannedOrderQty ?? line.netReq)!)}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--success)', fontWeight: 600 }}>0</span>
                          )}
                        </td>

                        {/* Confidence % */}
                        <td style={{ textAlign: 'center' }}>
                          <ConfidenceBadge confidence={line.confidence} percentage={line.confidencePct ?? undefined} />
                        </td>

                        {/* Remark (Editable) */}
                        <td style={{ textAlign: 'left' }} onClick={(e) => e.stopPropagation()}>
                          {isEditingLocked ? (
                            <span className="cell-truncate" style={{ fontSize: 12, color: line.remark ? 'var(--text-primary)' : 'var(--text-tertiary)' }} title={line.remark}>
                              {line.remark || '—'}
                            </span>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: '100%' }}>
                              <input
                                type="text"
                                className={`remark-input-box ${isRemarkMissing ? 'error' : ''}`}
                                placeholder={hasLargeAdj ? 'Mandatory remark (>20% adj)' : 'Optional adjustment remark...'}
                                value={line.remark}
                                onChange={(e) => onUpdateLine(line.itemCode, line.plannerAdj, e.target.value)}
                                title={isRemarkMissing ? 'Adjustment is >20% from AI forecast. A remark is required.' : undefined}
                              />
                              {isRemarkMissing && (
                                <div 
                                  style={{ 
                                    display: 'flex', 
                                    alignItems: 'center', 
                                    gap: 4, 
                                    color: 'var(--danger)', 
                                    fontSize: 10, 
                                    marginTop: 2, 
                                    fontWeight: 600,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                  }}
                                  title="Please enter a remark for this adjustment (>20% change)."
                                >
                                  <AlertCircle size={10} style={{ flexShrink: 0 }} />
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>Remark required (&gt;20% adj)</span>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          );
        })()}
      </div>
    </div>
  );
}
