import React, { useState, useEffect, useRef } from 'react';
import { ForecastLine, ExplanationPayload, ExplanationResponse } from '../types';
import { fetchForecastExplanation } from '../services/forecastClient';
import { formatNumber, formatCompact, ConfidenceBadge, getMonthLabels } from './UI';
import { Sparkles, CheckCircle2, Cpu, HelpCircle, AlertCircle, Database, Layers, ArrowRight, Info, ChevronDown, ChevronRight, Check } from 'lucide-react';

interface AnalyticsPanelProps {
  item: ForecastLine | null;
  startMonth: string;
  horizon: number;
  onUpdateMoq?: (itemCode: string, moq: number) => void;
}

export function AnalyticsPanel({ item, startMonth, horizon, onUpdateMoq }: AnalyticsPanelProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [explanation, setExplanation] = useState<ExplanationResponse | null>(null);
  const [isLoadingExplanation, setIsLoadingExplanation] = useState(false);
  const [showValidationDetails, setShowValidationDetails] = useState(false);
  const [moqInput, setMoqInput] = useState<string>('500');
  const [moqError, setMoqError] = useState<string | null>(null);
  const [justUpdated, setJustUpdated] = useState(false);
  const updatedTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (updatedTimeoutRef.current) {
        clearTimeout(updatedTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (item) {
      setMoqInput((item.moq !== undefined && item.moq > 0) ? item.moq.toString() : '500');
      setMoqError(null);
    }
  }, [item?.itemCode, item?.moq]);

  const handleMoqInputChange = (valStr: string) => {
    setMoqInput(valStr);
    const trimmed = valStr.trim();
    if (trimmed === '') {
      setMoqError('MOQ must be greater than 0.');
      return;
    }
    const parsed = Number(trimmed);
    if (isNaN(parsed) || parsed <= 0 || !Number.isFinite(parsed)) {
      setMoqError('MOQ must be greater than 0.');
      return;
    }
    setMoqError(null);
  };

  const handleCommitMoq = () => {
    const trimmed = moqInput.trim();
    if (trimmed === '') {
      setMoqError('MOQ must be greater than 0.');
      return;
    }
    const parsed = Math.round(Number(trimmed));
    if (isNaN(parsed) || parsed <= 0 || !Number.isFinite(parsed)) {
      setMoqError('MOQ must be greater than 0.');
      return;
    }
    setMoqError(null);
    if (item && onUpdateMoq) {
      onUpdateMoq(item.itemCode, parsed);
      setJustUpdated(true);
      if (updatedTimeoutRef.current) clearTimeout(updatedTimeoutRef.current);
      updatedTimeoutRef.current = window.setTimeout(() => {
        setJustUpdated(false);
      }, 2000);
    }
  };

  const handleResetMoq = () => {
    setMoqInput('500');
    setMoqError(null);
    if (item && onUpdateMoq) {
      onUpdateMoq(item.itemCode, 500);
      setJustUpdated(true);
      if (updatedTimeoutRef.current) clearTimeout(updatedTimeoutRef.current);
      updatedTimeoutRef.current = window.setTimeout(() => {
        setJustUpdated(false);
      }, 2000);
    }
  };

  useEffect(() => {
    setShowValidationDetails(false);
  }, [item?.itemCode]);

  useEffect(() => {
    if (!item) return;
    setExplanation(null);
    setIsLoadingExplanation(true);

    const pattern = item.demandSignal.demandProfile?.demand_pattern || 'unknown';
    
    // Safely calculate prediction interval bounds
    let interval = null;
    if (item.confidenceBlock?.status === 'EVALUATED') {
       const lowers = item.confidenceBlock.lowerBound.filter(x => x !== null) as number[];
       const uppers = item.confidenceBlock.upperBound.filter(x => x !== null) as number[];
       if (lowers.length > 0 && uppers.length > 0) {
         interval = {
           lower: Math.min(...lowers),
           upper: Math.max(...uppers)
         };
       }
    }

    const payload: ExplanationPayload = {
      itemCode: item.itemCode,
      description: item.description,
      pattern: item.demandSignal.demandProfile?.demand_pattern || 'unknown',
      historyLength: item.historyAvailableMonths || (item.historyValues?.length || 0),
      historicalAvg: item.avgPerMonth,
      recentDemand: item.historyValues ? item.historyValues.slice(-3) : [],
      fullForecast: item.monthlyForecast || [],
      forecastTotal: item.aiTotal,
      confidencePct: item.confidencePct,
      predictionInterval: interval,
      intervalMethod: item.confidenceBlock?.method || null,
      wape: item.modelDecision?.backtestWape || null,
      mae: item.modelDecision?.mae || null,
      rmse: item.modelDecision?.rmse || null,
      bias: item.modelDecision?.bias || null,
      validationWindowCount: item.modelDecision?.windows?.length || null,
      selectedModel: item.modelDecision?.selectedModel || 'Unknown',
      modelType: item.modelDecision?.alternatives?.find(a => a.modelName === item.modelDecision?.selectedModel)?.modelType || 'Statistical',
      trendDirection: item.demandSignal.demandProfile?.trend_direction || null,
      trendStrength: item.demandSignal.demandProfile?.trend_strength || null,
      seasonalityDetected: item.demandSignal.demandProfile?.seasonality_detected || null,
      seasonalityPeriod: item.demandSignal.demandProfile?.seasonality_period || null,
      seasonalityStrength: item.demandSignal.demandProfile?.seasonality_strength || null,
      outlierCount: item.demandSignal.demandProfile?.outlier_count || null,
      missingPeriods: item.demandSignal.demandProfile?.missing_periods || null,
      zeroDemandRatio: item.demandSignal.demandProfile?.zero_demand_ratio || null,
      forecastEligibility: item.demandSignal.demandProfile?.forecast_eligibility || null,
      recommendedModelFamily: item.demandSignal.demandProfile?.recommended_model_family || null,
      dataQualityFlags: item.demandSignal.demandProfile?.data_quality_flags || [],
      stock: item.stock,
      openPo: item.openPo,
      netReq: item.netReq,
      plannerAdj: item.plannerAdj,
      finalQuantity: item.finalQty,
      alerts: []
    };

    let isMounted = true;
    fetchForecastExplanation(payload).then(res => {
      if (isMounted) {
        setExplanation(res);
        setIsLoadingExplanation(false);
      }
    });

    return () => { isMounted = false; };
  }, [item]);

  if (!item) {
    return (
      <div className="item-intelligence-card" style={{ textAlign: 'center', padding: '36px 20px', color: 'var(--text-tertiary)' }}>
        <Sparkles size={28} style={{ margin: '0 auto 8px auto', opacity: 0.5, color: 'var(--ai-primary)' }} />
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>Select an Item for AI Telemetry</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>Click any row in the forecast workspace to inspect historical demand patterns, confidence intervals, model selection reasoning, and capability hierarchy.</div>
      </div>
    );
  }

  const forecastLabels = getMonthLabels(startMonth, horizon);

  // Dynamic history series based on actual available data
  const actualHistoryValues = item.historyValues || [];
  const actualPeriods = item.historyPeriods || [];

  const historySeries = actualHistoryValues.map((qty, idx) => ({
    label: actualPeriods[idx] || `M-${actualHistoryValues.length - idx}`,
    qty,
    type: 'actual' as const,
    upper: qty,
    lower: qty
  }));

  // Forecast series with confidence interval band
  const forecastSeries = item.monthlyForecast.map((qty, idx) => {
    let lower = qty;
    let upper = qty;
    
    if (item.confidenceBlock?.status === 'EVALUATED') {
      lower = item.confidenceBlock.lowerBound[idx] !== null ? item.confidenceBlock.lowerBound[idx]! : qty;
      upper = item.confidenceBlock.upperBound[idx] !== null ? item.confidenceBlock.upperBound[idx]! : qty;
    }

    return {
      label: forecastLabels[idx] || `F+${idx + 1}`,
      qty,
      type: 'forecast' as const,
      upper,
      lower
    };
  });

  const allPoints = [...historySeries, ...forecastSeries];
  const maxVal = Math.max(...allPoints.map(p => p.upper), 1);

  // SVG dimensions
  const svgWidth = 920;
  const svgHeight = 190;
  const padLeft = 46;
  const padRight = 24;
  const padTop = 24;
  const padBottom = 28;
  const innerW = svgWidth - padLeft - padRight;
  const innerH = svgHeight - padTop - padBottom;

  const totalPoints = Math.max(allPoints.length, 2);
  const getX = (idx: number) => padLeft + (idx / (totalPoints - 1)) * innerW;
  const getY = (val: number) => padTop + innerH - (val / maxVal) * innerH;

  // Build Actuals Path
  const actualCoords = historySeries.map((d, i) => `${getX(i)},${getY(d.qty)}`);
  const actualPath = actualCoords.length > 0 ? `M ${actualCoords.join(' L ')}` : '';

  // Actuals Area Fill
  const actualArea = actualCoords.length > 0
    ? `${actualPath} L ${getX(historySeries.length - 1)},${padTop + innerH} L ${getX(0)},${padTop + innerH} Z`
    : '';

  // Build Forecast Line Path
  const forecastStartIdx = Math.max(0, historySeries.length - 1);
  const forecastCoords = historySeries.length > 0
    ? [
        `${getX(forecastStartIdx)},${getY(historySeries[forecastStartIdx]?.qty || 0)}`,
        ...forecastSeries.map((d, i) => `${getX(forecastStartIdx + 1 + i)},${getY(d.qty)}`)
      ]
    : forecastSeries.map((d, i) => `${getX(i)},${getY(d.qty)}`);

  const forecastPath = forecastCoords.length > 0 ? `M ${forecastCoords.join(' L ')}` : '';

  // Build Confidence Band (Upper + Lower Envelope)
  const upperCoords = historySeries.length > 0
    ? [
        `${getX(forecastStartIdx)},${getY(historySeries[forecastStartIdx]?.qty || 0)}`,
        ...forecastSeries.map((d, i) => `${getX(forecastStartIdx + 1 + i)},${getY(d.upper)}`)
      ]
    : forecastSeries.map((d, i) => `${getX(i)},${getY(d.upper)}`);

  const lowerCoords = historySeries.length > 0
    ? [
        ...forecastSeries.map((d, i) => `${getX(forecastStartIdx + 1 + i)},${getY(d.lower)}`).reverse(),
        `${getX(forecastStartIdx)},${getY(historySeries[forecastStartIdx]?.qty || 0)}`
      ]
    : forecastSeries.map((d, i) => `${getX(i)},${getY(d.lower)}`).reverse();

  const confidenceBandPath = (upperCoords.length > 0 && lowerCoords.length > 0)
    ? `M ${upperCoords.join(' L ')} L ${lowerCoords.join(' L ')} Z`
    : '';

  const separatorX = getX(forecastStartIdx);

  // Model decision info
  const md = item.modelDecision || {
    historyMonthsAvailable: item.historyAvailableMonths || actualHistoryValues.length,
    historyDateRange: item.historyDateRange || 'N/A',
    selectedModel: 'Standard AI Baseline',
    modelTier: 'Tier 5: Full Candidate (24M+)',
    modelLimitation: 'Adequate historical telemetry available.',
    featuresUsed: ['lag_1', 'rolling_mean_3'],
    backtestWape: null,
    backtestMethod: 'Walk-forward validation',
    alternatives: [],
    trainingObservationsCount: actualHistoryValues.length
  };

  const getTierColor = (tier: string) => {
    if (tier.includes('Tier 1')) return { bg: '#fef2f2', text: '#991b1b', border: '#fecaca' };
    if (tier.includes('Tier 2')) return { bg: '#fffbeb', text: '#92400e', border: '#fde68a' };
    if (tier.includes('Tier 3')) return { bg: '#f0fdf4', text: '#166534', border: '#bbf7d0' };
    if (tier.includes('Tier 4')) return { bg: '#eff6ff', text: '#1e40af', border: '#bfdbfe' };
    return { bg: '#faf5ff', text: '#6b21a8', border: '#e9d5ff' };
  };

  const tierColors = getTierColor(md.modelTier);

  return (
    <div className="item-intelligence-card">
      {/* Header */}
      <div className="intel-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="intel-sku-tag">{item.itemCode}</span>
          <span style={{ color: 'var(--border-medium)' }}>/</span>
          <span className="intel-desc">{item.description}</span>
          <span style={{ fontSize: 11, background: 'var(--bg-subtle)', padding: '2px 8px', borderRadius: 6, fontWeight: 600, color: 'var(--text-secondary)' }}>
            {item.itemGroup}
          </span>
          <span 
            style={{ 
              fontSize: 11, 
              background: tierColors.bg, 
              color: tierColors.text, 
              border: `1px solid ${tierColors.border}`, 
              padding: '2px 8px', 
              borderRadius: 6, 
              fontWeight: 700 
            }}
          >
            {md.modelTier.split(':')[0]}: {item.historyAvailableMonths}M History
          </span>
          <ConfidenceBadge confidence={item.confidence} percentage={item.confidencePct ?? undefined} />
          {item.isModified && (
            <span style={{ fontSize: 11, background: 'var(--planner-mod-bg)', color: 'var(--planner-mod)', border: '1px solid var(--planner-mod-border)', padding: '2px 8px', borderRadius: 6, fontWeight: 700 }}>
              Planner Override: {formatNumber(item.plannerAdj)}
            </span>
          )}
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Lead Time: <strong>{item.leadTimeDays ? `${item.leadTimeDays}d` : '—'}</strong> | MOQ: <strong>{item.moq > 0 ? formatNumber(item.moq) : '—'}</strong> {item.uom} | Order Multiple: <strong>{item.orderMultiple > 1 ? formatNumber(item.orderMultiple) : '—'}</strong>
        </div>
      </div>

      {/* Specification Nodes Cluster */}
      <div className="intel-specs-cluster">
        <div className="spec-node">
          <span className="spec-node-label">Available History</span>
          <span className="spec-node-value num" style={{ color: item.historyAvailableMonths < 6 ? 'var(--warning)' : 'var(--text-primary)' }}>
            {item.historyAvailableMonths} Months
          </span>
        </div>
        <div className="spec-node">
          <span className="spec-node-label">Monthly Velocity</span>
          <span className="spec-node-value num">{formatNumber(item.avgPerMonth)} {item.uom}</span>
        </div>
        <div className="spec-node">
          <span className="spec-node-label">AI Baseline ({horizon}M)</span>
          <span className="spec-node-value num" style={{ color: 'var(--ai-primary)' }}>
            {item.historyAvailableMonths >= 6 && item.historyAvailableMonths < 12 && item.aiTotal === 0 ? (
              <span style={{ fontSize: 11, fontStyle: 'italic', fontWeight: 'normal' }}>Insufficient history</span>
            ) : (
              formatNumber(item.aiTotal)
            )}
          </span>
        </div>
        <div className="spec-node">
          <span className="spec-node-label">Planner Adjustment</span>
          <span className="spec-node-value num" style={{ color: item.plannerAdj !== null ? 'var(--planner-mod)' : 'inherit' }}>
            {item.plannerAdj !== null ? formatNumber(item.plannerAdj) : '—'}
          </span>
          {item.remark && (
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4, fontStyle: 'italic', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.remark}>
              "{item.remark}"
            </div>
          )}
        </div>
        <div className="spec-node">
          <span className="spec-node-label">Final Planning Qty</span>
          <span className="spec-node-value num" style={{ color: 'var(--text-primary)', fontWeight: 800 }}>
            {formatNumber(item.finalQty)}
          </span>
        </div>
        <div className="spec-node">
          <span className="spec-node-label">On-Hand Stock</span>
          <span className="spec-node-value num">{item.stock !== null && item.stock !== undefined ? formatNumber(item.stock) : '—'}</span>
        </div>
        <div className="spec-node">
          <span className="spec-node-label">Open PO Supply</span>
          <span className="spec-node-value num">{item.openPo !== null && item.openPo !== undefined ? formatNumber(item.openPo) : '—'}</span>
        </div>
        <div className="spec-node">
          <span className="spec-node-label">Net Req Before Lot Sizing</span>
          <span className="spec-node-value num" style={{ color: (item.rawNetReq ?? Math.max(0, item.finalQty - (item.stock ?? 0) - (item.openPo ?? 0))) > 0 ? 'var(--danger)' : 'var(--success)' }}>
            {item.planningMethod !== 'MRP' ? 'N/A' : formatNumber(item.rawNetReq ?? Math.max(0, item.finalQty - (item.stock ?? 0) - (item.openPo ?? 0)))}
          </span>
        </div>
        <div className="spec-node">
          <span className="spec-node-label">Planned Order Qty After Lot Sizing</span>
          <span className="spec-node-value num" style={{ color: (item.plannedOrderQty ?? item.netReq ?? 0) > 0 ? 'var(--danger)' : 'var(--success)', fontWeight: 800 }}>
            {item.planningMethod !== 'MRP' ? 'Not planned' : formatNumber(item.plannedOrderQty ?? item.netReq ?? 0)}
          </span>
        </div>
      </div>

      {/* Demand Trend & AI Confidence Chart */}
      <div style={{ marginTop: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-primary)' }}>
              Demand Telemetry: {item.historyAvailableMonths}M History ({item.historyDateRange}) → {horizon}M Horizon
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 2, background: '#3b82f6', borderRadius: 1 }} />
                <span>Actual Demand ({item.historyAvailableMonths}M)</span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 2, background: 'var(--ai-primary)', borderRadius: 1 }} />
                <span>AI Projection ({horizon}M)</span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 10, height: 8, background: 'rgba(79, 70, 229, 0.15)', borderRadius: 2 }} />
                <span>Prediction Interval ({item.confidenceBlock?.intervalLevel ? `${item.confidenceBlock.intervalLevel * 100}%` : 'N/A'})</span>
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11.5 }}>
            <span>YoY Velocity: <strong style={{ color: item.demandSignal.velocityTrendPct >= 0 ? 'var(--success)' : 'var(--danger)' }}>{item.demandSignal.velocityTrendPct >= 0 ? `+${item.demandSignal.velocityTrendPct}%` : `${item.demandSignal.velocityTrendPct}%`}</strong></span>
            <span>Seasonality Factor: <strong>{item.demandSignal.seasonalityFactor}x</strong></span>
          </div>
        </div>

        {/* SVG Chart */}
        <div style={{ background: '#ffffff', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '12px 14px', overflowX: 'auto' }}>
          <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} style={{ width: '100%', height: 'auto', display: 'block', minWidth: 680 }}>
            <defs>
              <linearGradient id="actualGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.18" />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Grid Lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => {
              const y = padTop + innerH * (1 - ratio);
              return (
                <g key={i}>
                  <line x1={padLeft} y1={y} x2={svgWidth - padRight} y2={y} stroke="#f1f5f9" strokeDasharray={ratio === 0 ? 'none' : '3 3'} />
                  <text x={padLeft - 6} y={y + 3} textAnchor="end" fontSize="9" fill="#94a3b8" fontFamily="monospace">
                    {formatCompact(Math.round(maxVal * ratio))}
                  </text>
                </g>
              );
            })}

            {/* Prediction Interval (Shaded Area) */}
            {confidenceBandPath && item.confidenceBlock?.status === 'EVALUATED' && <path d={confidenceBandPath} fill="rgba(79, 70, 229, 0.12)" />}

            {/* Actuals Area & Line */}
            {actualArea && <path d={actualArea} fill="url(#actualGrad)" />}
            {actualPath && <path d={actualPath} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" />}

            {/* Forecast Line */}
            {forecastPath && <path d={forecastPath} fill="none" stroke="var(--ai-primary)" strokeWidth="2.5" strokeDasharray="5 3" />}

            {/* Separator Line between Actuals and Forecast */}
            {historySeries.length > 0 && (
              <g>
                <line x1={separatorX} y1={padTop - 6} x2={separatorX} y2={svgHeight - padBottom} stroke="#d97706" strokeWidth="1.5" strokeDasharray="3 3" />
                <text x={separatorX + 6} y={padTop + 6} fontSize="9" fontWeight="700" fill="#d97706">
                  FORECAST HORIZON →
                </text>
              </g>
            )}

            {/* Points & Interactive Nodes */}
            {allPoints.map((p, idx) => {
              const x = getX(idx);
              const y = getY(p.qty);
              const isHovered = hoveredIdx === idx;
              const isForecast = p.type === 'forecast';

              return (
                <g key={idx} onMouseEnter={() => setHoveredIdx(idx)} onMouseLeave={() => setHoveredIdx(null)} style={{ cursor: 'pointer' }}>
                  <circle
                    cx={x}
                    cy={y}
                    r={isHovered ? 5 : isForecast ? 3.5 : 2.5}
                    fill={isForecast ? 'var(--ai-primary)' : '#3b82f6'}
                    stroke="#ffffff"
                    strokeWidth="1.5"
                  />
                  {(idx % 2 === 0 || isForecast || isHovered) && (
                    <text x={x} y={svgHeight - 10} textAnchor="middle" fontSize="8" fill={isForecast ? 'var(--ai-primary)' : '#64748b'} fontWeight={isForecast ? '700' : '500'}>
                      {p.label}
                    </text>
                  )}

                  {/* Tooltip */}
                  {isHovered && (
                    <g>
                      <rect x={Math.min(Math.max(x - 50, 10), svgWidth - 120)} y={Math.max(y - 32, 6)} width="105" height="24" rx="4" fill="#0f172a" />
                      <text x={Math.min(Math.max(x - 50, 10), svgWidth - 120) + 52} y={Math.max(y - 32, 6) + 16} textAnchor="middle" fill="#ffffff" fontSize="10" fontFamily="monospace" fontWeight="600">
                        {p.label}: {formatNumber(p.qty)}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* ========================================================= */}
      {/* SECTION 15: MODEL SELECTION & WALK-FORWARD BACKTEST CARD   */}
      {/* ========================================================= */}
      <div style={{ background: '#f8fafc', border: '1px solid var(--border-medium)', borderRadius: 10, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Cpu size={16} color="var(--ai-primary)" />
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Walk-Forward Backtesting & Data-Driven Model Selection
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span 
              style={{ 
                fontSize: 11, 
                padding: '3px 8px', 
                borderRadius: 6, 
                fontWeight: 700,
                background: md.selectionStatus === 'SELECTED' ? '#dcfce7' : md.selectionStatus === 'COLD_START' ? '#ede9fe' : md.selectionStatus === 'SPARSE_HISTORY' ? '#fef3c7' : '#fee2e2',
                color: md.selectionStatus === 'SELECTED' ? '#15803d' : md.selectionStatus === 'COLD_START' ? '#6d28d9' : md.selectionStatus === 'SPARSE_HISTORY' ? '#b45309' : '#991b1b',
                border: `1px solid ${md.selectionStatus === 'SELECTED' ? '#bbf7d0' : md.selectionStatus === 'COLD_START' ? '#ddd6fe' : md.selectionStatus === 'SPARSE_HISTORY' ? '#fde68a' : '#fecaca'}`
              }}
            >
              Status: {md.selectionStatus || (md.historyMonthsAvailable === 0 ? 'COLD_START' : md.historyMonthsAvailable < 6 ? 'SPARSE_HISTORY' : md.historyMonthsAvailable < 12 ? 'INSUFFICIENT_HISTORY' : 'SELECTED')}
            </span>
            <span 
              style={{ 
                fontSize: 11.5, 
                padding: '3px 10px', 
                borderRadius: 6, 
                fontWeight: 700, 
                background: tierColors.bg, 
                color: tierColors.text, 
                border: `1px solid ${tierColors.border}` 
              }}
            >
              {md.modelTier}
            </span>
          </div>
        </div>

        {/* Selection Rationale Banner */}
        {md.selectionReason && (
          <div style={{ background: 'var(--ai-subtle)', border: '1px solid var(--ai-border)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Sparkles size={16} color="var(--ai-primary)" style={{ flexShrink: 0 }} />
            <div>
              <strong>Selection Determination:</strong> {md.selectionReason}
            </div>
          </div>
        )}

        {/* Primary Model Decision Summary Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <div style={{ background: '#ffffff', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>Selected Winner Model</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ai-primary)', marginTop: 3 }}>{md.selectedModel}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>Lowest Aggregated Error</div>
          </div>

          <div style={{ background: '#ffffff', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>Backtest WAPE</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: md.backtestWape !== null && md.backtestWape < 15 ? 'var(--success)' : 'var(--text-primary)', marginTop: 3 }}>
              {md.backtestWape !== null ? `${md.backtestWape}%` : 'Not Available (N < 3)'}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {md.validationWindows ? `${md.validationWindows} validation windows` : 'Insufficient history'}
            </div>
          </div>

          <div style={{ background: '#ffffff', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>MAE / RMSE</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginTop: 3 }}>
              {md.mae !== null && md.mae !== undefined ? `${md.mae} / ${md.rmse}` : '—'}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>Mean / Root Mean Square Error</div>
          </div>

          <div style={{ background: '#ffffff', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>Forecast Bias</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: md.bias !== null && md.bias !== undefined && Math.abs(md.bias) > 10 ? 'var(--danger)' : 'var(--ai-primary)', marginTop: 3 }}>
              {md.bias !== null && md.bias !== undefined ? `${md.bias > 0 ? '+' : ''}${md.bias}%` : '—'}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {md.bias !== null && md.bias !== undefined ? (md.bias > 0 ? 'Over-forecasting' : md.bias < 0 ? 'Under-forecasting' : 'Neutral') : 'No bias calculation'}
            </div>
          </div>
        </div>

        {/* Model Limitation / Telemetry Warning */}
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#92400e', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong>Historical Horizon Note:</strong> {md.modelLimitation}
          </div>
        </div>

        {/* Evaluated Model Comparison Table */}
        {md.alternatives && md.alternatives.length > 0 && (
          <div style={{ background: '#ffffff', border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', background: '#f8fafc', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Candidate Models Walk-Forward Comparison
              </span>
              <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                Sorted by lowest WAPE with MAE/RMSE tie-breaking
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5, textAlign: 'left' }}>
                <thead>
                  <tr style={{ background: '#ffffff', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: '8px 12px' }}>Model Candidate</th>
                    <th style={{ padding: '8px 10px' }}>Eligibility</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>WAPE</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>MAE</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>RMSE</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>Bias</th>
                    <th style={{ padding: '8px 10px', textAlign: 'center' }}>Windows</th>
                    <th style={{ padding: '8px 12px' }}>Evaluation Rationale</th>
                  </tr>
                </thead>
                <tbody>
                  {md.alternatives.map((alt, i) => {
                    const isWinner = alt.modelName === md.selectedModel;
                    return (
                      <tr 
                        key={i} 
                        style={{ 
                          borderBottom: '1px solid var(--border-subtle)',
                          background: isWinner ? 'rgba(79, 70, 229, 0.04)' : 'transparent'
                        }}
                      >
                        <td style={{ padding: '8px 12px', fontWeight: isWinner ? 800 : 600, color: isWinner ? 'var(--ai-primary)' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          {alt.modelName}
                          {isWinner && (
                            <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'var(--ai-primary)', color: '#ffffff' }}>
                              SELECTED
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ 
                            fontSize: 10, 
                            fontWeight: 700, 
                            padding: '2px 6px', 
                            borderRadius: 4,
                            background: alt.eligibility === 'Eligible' ? '#dcfce7' : alt.eligibility === 'Insufficient Data' ? '#fee2e2' : '#fef3c7',
                            color: alt.eligibility === 'Eligible' ? '#15803d' : alt.eligibility === 'Insufficient Data' ? '#b91c1c' : '#b45309'
                          }}>
                            {alt.eligibility}
                          </span>
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: isWinner ? 800 : 500, color: alt.backtestWape !== null ? 'inherit' : 'var(--text-tertiary)' }}>
                          {alt.backtestWape !== null && alt.backtestWape !== undefined ? `${alt.backtestWape}%` : '—'}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace' }}>
                          {alt.mae !== null && alt.mae !== undefined ? alt.mae : '—'}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace' }}>
                          {alt.rmse !== null && alt.rmse !== undefined ? alt.rmse : '—'}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace' }}>
                          {alt.bias !== null && alt.bias !== undefined ? `${alt.bias > 0 ? '+' : ''}${alt.bias}%` : '—'}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'center', fontFamily: 'monospace' }}>
                          {alt.validationWindows || 0}
                        </td>
                        <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: 11 }}>
                          {alt.notes}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Individual Validation Windows Accordion/List (Collapsible Diagnostic Details) */}
        {md.windows && md.windows.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setShowValidationDetails(prev => !prev)}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--border-medium)',
                  background: showValidationDetails ? 'var(--bg-subtle)' : '#ffffff',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
              >
                {showValidationDetails ? (
                  <>
                    <ChevronDown size={14} color="var(--ai-primary)" />
                    <span>Hide Validation Details</span>
                  </>
                ) : (
                  <>
                    <ChevronRight size={14} color="var(--ai-primary)" />
                    <span>View Validation Details ({md.windows.length} Sequential Folds)</span>
                  </>
                )}
              </button>
            </div>

            {showValidationDetails && (
              <div style={{ background: '#ffffff', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10 }}>
                  CHRONOLOGICAL VALIDATION ORIGIN WINDOWS FOR WINNER MODEL ({md.windows.length} SEQUENTIAL FOLDS)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                  {md.windows.map((win, idx) => (
                    <div key={idx} style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '8px 10px', fontSize: 11 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, color: 'var(--text-primary)', borderBottom: '1px solid rgba(0,0,0,0.05)', paddingBottom: 3 }}>
                        <span>Origin: {win.origin}</span>
                        <span style={{ color: 'var(--ai-primary)' }}>Val: {win.targetPeriod}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Act: <strong>{win.actual[0]}</strong></span>
                        <span style={{ color: 'var(--text-secondary)' }}>Fcst: <strong>{win.forecast[0]}</strong></span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, fontSize: 10.5 }}>
                        <span style={{ color: 'var(--text-secondary)' }}>WAPE: <strong>{win.wape}%</strong></span>
                        <span style={{ color: win.bias > 0 ? '#047857' : win.bias < 0 ? '#b91c1c' : '#64748b', fontWeight: 600 }}>
                          Bias: {win.bias > 0 ? '+' : ''}{win.bias}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* MRP CALCULATION BREAKDOWN & EXPLANATION CARD */}
      <div style={{ background: '#ffffff', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Layers size={15} color="var(--ai-primary)" />
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              MRP Calculation & Procurement Lot-Sizing
            </span>
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: item.planningMethod === 'MRP' ? '#dbeafe' : '#f1f5f9', color: item.planningMethod === 'MRP' ? '#1d4ed8' : '#64748b' }}>
            Planning Method: {item.planningMethod}
          </span>
        </div>

        {item.planningMethod === 'MRP' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              {/* Demand Side */}
              <div style={{ background: '#f8fafc', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 6 }}>1. Demand</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>AI Forecast Total</span>
                  <span className="num" style={{ fontWeight: 600 }}>{formatNumber(item.aiTotal)} {item.uom}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Planner Adjustment</span>
                  <span className="num" style={{ fontWeight: 600, color: item.plannerAdj !== null ? 'var(--planner-mod)' : 'inherit' }}>
                    {item.plannerAdj !== null ? `${formatNumber(item.plannerAdj)} ${item.uom}` : '—'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, borderTop: '1px solid var(--border-subtle)', marginTop: 4, paddingTop: 4, color: 'var(--text-primary)' }}>
                  <span>Final Forecast Qty</span>
                  <span className="num">{formatNumber(item.finalQty)} {item.uom}</span>
                </div>
              </div>

              {/* Supply & Shortage */}
              <div style={{ background: '#f8fafc', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 6 }}>2. Supply & Shortage</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>On-Hand Stock</span>
                  <span className="num" style={{ fontWeight: 600 }}>{item.stock !== null && item.stock !== undefined ? `${formatNumber(item.stock)} ${item.uom}` : '—'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Open PO Supply</span>
                  <span className="num" style={{ fontWeight: 600 }}>{item.openPo !== null && item.openPo !== undefined ? `${formatNumber(item.openPo)} ${item.uom}` : '—'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, borderTop: '1px solid var(--border-subtle)', marginTop: 4, paddingTop: 4, color: item.rawNetReq === null ? 'var(--text-tertiary)' : item.rawNetReq > 0 ? 'var(--danger)' : 'var(--success)' }}>
                  <span>Net Requirement Before Lot Sizing</span>
                  <span className="num">{item.rawNetReq !== null ? `${formatNumber(item.rawNetReq)} ${item.uom}` : 'Not Evaluated — Missing Supply Data'}</span>
                </div>
              </div>

              {/* Lot-Sizing & Recommendation */}
              <div style={{ background: '#f8fafc', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 6 }}>3. Procurement Rules</div>
                
                {/* Supplier MOQ with explicit Update button and Reset action */}
                <div style={{ padding: '3px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Supplier MOQ</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', background: '#ffffff', border: `1px solid ${moqError ? 'var(--danger)' : 'var(--border-medium)'}`, borderRadius: 4, padding: '2px 6px' }}>
                        <input
                          type="number"
                          min="1"
                          style={{
                            width: 65,
                            border: 'none',
                            outline: 'none',
                            fontSize: 12,
                            fontWeight: 700,
                            textAlign: 'right',
                            background: 'transparent',
                            color: 'var(--text-primary)'
                          }}
                          className="num"
                          value={moqInput}
                          onChange={(e) => handleMoqInputChange(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleCommitMoq();
                            }
                          }}
                        />
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 4 }}>{item.uom || 'PCS'}</span>
                      </div>

                      <button
                        type="button"
                        onClick={handleCommitMoq}
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: '#ffffff',
                          background: justUpdated ? '#10b981' : 'var(--ai-primary)',
                          border: 'none',
                          borderRadius: 4,
                          padding: '3px 10px',
                          cursor: 'pointer',
                          transition: 'all 0.2s ease',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4
                        }}
                        title="Commit and recalculate procurement with this MOQ"
                      >
                        {justUpdated ? (
                          <>
                            <Check size={12} strokeWidth={3} />
                            <span>Updated</span>
                          </>
                        ) : (
                          'Update'
                        )}
                      </button>

                      {((item.moq !== 500) || (moqInput !== '500')) && (
                        <button
                          type="button"
                          onClick={handleResetMoq}
                          style={{
                            fontSize: 10.5,
                            fontWeight: 600,
                            color: 'var(--text-secondary)',
                            background: 'var(--bg-subtle)',
                            border: '1px solid var(--border-medium)',
                            borderRadius: 4,
                            padding: '3px 6px',
                            cursor: 'pointer'
                          }}
                          title="Reset MOQ to default 500 PCS and commit"
                        >
                          Reset to Default
                        </button>
                      )}
                    </div>
                  </div>
                  {moqError && (
                    <div style={{ fontSize: 10.5, color: 'var(--danger)', fontWeight: 600, textAlign: 'right', marginTop: 3 }}>
                      {moqError}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Order Multiple</span>
                  <span className="num" style={{ fontWeight: 600 }}>{item.orderMultiple > 1 ? `${formatNumber(item.orderMultiple)} ${item.uom}` : '—'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 800, borderTop: '1px solid var(--border-subtle)', marginTop: 4, paddingTop: 4, color: (item.plannedOrderQty ?? item.netReq) === null ? 'var(--text-tertiary)' : (item.plannedOrderQty ?? item.netReq)! > 0 ? 'var(--danger)' : 'var(--success)' }}>
                  <span>Planned Order Qty</span>
                  <span className="num">{(item.plannedOrderQty ?? item.netReq) !== null ? `${formatNumber((item.plannedOrderQty ?? item.netReq)!)} ${item.uom}` : 'Not Evaluated — Missing Supply Data'}</span>
                </div>
                {(item.plannedOrderQty ?? item.netReq) === null && (
                  <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.35, fontStyle: 'italic' }}>
                    * MOQ of {formatNumber(item.moq || 500)} {item.uom || 'PCS'} saved. Net requirement will be lot-sized once stock / open PO data is provided.
                  </div>
                )}
              </div>
            </div>

            {/* Explanation box */}
            <div style={{ background: '#f1f5f9', border: '1px solid var(--border-medium)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Info size={14} color="var(--ai-primary)" style={{ flexShrink: 0 }} />
              <div>
                <strong>MRP Rule Explanation: </strong>
                {(() => {
                  if (item.isDiscontinued) {
                    return `This SKU is marked as Discontinued / Phase-out. Procurement quantities are locked to 0 to prevent dead inventory creation. Planner adjustments cannot override this procurement lock.`;
                  }

                  if (item.rawNetReq === null || (item.plannedOrderQty ?? item.netReq) === null) {
                    return `Supply telemetry unavailable (On-Hand Stock or Open PO missing). Net requirement and planned order quantity cannot be evaluated without complete inventory telemetry.`;
                  }

                  const rawNet = item.rawNetReq;
                  const planned = (item.plannedOrderQty ?? item.netReq)!;
                  const uom = item.uom || 'PCS';
                  const moq = item.moq || 0;
                  const orderMultiple = item.orderMultiple || 1;

                  if (rawNet <= 0) {
                    const stockStr = item.stock !== null ? `on-hand stock (${formatNumber(item.stock)} ${uom})` : null;
                    const poStr = item.openPo !== null ? `open PO pipeline (${formatNumber(item.openPo)} ${uom})` : null;
                    const supplyCoverage = [stockStr, poStr].filter(Boolean).join(' and ');
                    return supplyCoverage
                      ? `Projected demand (${formatNumber(item.finalQty)} ${uom}) is fully covered by ${supplyCoverage}. Net requirement before lot sizing is 0 ${uom}; no purchase order is needed.`
                      : `Net requirement before lot sizing is 0 ${uom}; no purchase order is needed.`;
                  }

                  const moqApplied = moq > 0 && rawNet < moq;
                  const orderMultipleApplied = orderMultiple > 1 && planned > (moqApplied ? moq : rawNet);

                  if (moqApplied && orderMultipleApplied) {
                    return `Requirement is ${formatNumber(rawNet)} ${uom}. Supplier MOQ is ${formatNumber(moq)} ${uom} and order multiple is ${formatNumber(orderMultiple)} ${uom}, so the planned purchase quantity is raised to ${formatNumber(planned)} ${uom}.`;
                  }

                  if (moqApplied) {
                    return `Requirement is ${formatNumber(rawNet)} ${uom}. Supplier MOQ is ${formatNumber(moq)} ${uom}, so the planned purchase quantity is raised to ${formatNumber(planned)} ${uom}.`;
                  }

                  if (orderMultipleApplied) {
                    return `Requirement is ${formatNumber(rawNet)} ${uom}. Order multiple is ${formatNumber(orderMultiple)} ${uom}, so the planned purchase quantity is rounded to ${formatNumber(planned)} ${uom}.`;
                  }

                  return `Net requirement is ${formatNumber(rawNet)} ${uom}; no additional MOQ adjustment is required.`;
                })()}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '6px 0' }}>
            This item is configured with <code>Planning Method: None</code>. Net requirements and procurement lot-sizing calculations are suppressed.
          </div>
        )}
      </div>

      {/* WHY THIS FORECAST? AI Causal Drivers & Reasoning */}
      <div style={{ background: '#f8fafc', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={15} color="var(--ai-primary)" />
            <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Why This Forecast? (AI Reasoning & Telemetry)
            </span>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--ai-primary)', fontWeight: 700 }}>
            {item.demandSignal.signalHeadline}
          </span>
        </div>

        {/* Drivers List */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
          {item.demandSignal.drivers.map((drv, i) => (
            <div key={i} style={{ background: '#ffffff', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '6px 10px', fontSize: 12 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{drv.label}</span>
                <span style={{ 
                  fontSize: 10, 
                  fontWeight: 700, 
                  color: drv.impact === 'positive' ? '#047857' : drv.impact === 'negative' ? '#e11d48' : '#64748b' 
                }}>
                  {drv.impact.toUpperCase()}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{drv.detail}</div>
            </div>
          ))}
        </div>

        {/* Strategic Recommendation */}
        <div style={{ fontSize: 11.5, color: 'var(--text-primary)', background: 'var(--ai-subtle)', border: '1px solid var(--ai-border)', padding: '8px 12px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <CheckCircle2 size={14} color="var(--ai-primary)" style={{ flexShrink: 0 }} />
          <span><strong>Heuristic Recommendation:</strong> {item.demandSignal.aiRecommendation}</span>
        </div>
      </div>

      {/* LLM EXPLANATION LAYER */}
      <div style={{ background: '#ffffff', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8 }}>
          <Sparkles size={16} color="#8b5cf6" />
          <span style={{ fontSize: 13, fontWeight: 800, color: '#4c1d95', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            AI Explanation
          </span>
        </div>
        
        {isLoadingExplanation ? (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '10px 0', fontStyle: 'italic' }}>
            Generating explanation...
          </div>
        ) : explanation ? (
          explanation.unavailable ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {explanation.reason || "AI explanations are unavailable. Your numerical forecast is still fully operational."}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12, color: 'var(--text-primary)' }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                {explanation.summary}
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border-subtle)' }}>
                  <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text-secondary)' }}>Drivers</div>
                  <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--text-primary)' }}>
                    {explanation.drivers?.map((drv, i) => (
                      <li key={i} style={{ marginBottom: 2 }}>{drv}</li>
                    ))}
                  </ul>
                </div>
                
                <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border-subtle)' }}>
                  <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text-secondary)' }}>Risk Assessment</div>
                  <div>{explanation.risk}</div>
                </div>
              </div>
              
              <div style={{ background: '#fffbeb', border: '1px solid #fef3c7', padding: '8px 12px', borderRadius: 6 }}>
                <div style={{ fontWeight: 700, marginBottom: 4, color: '#92400e' }}>Planner Attention</div>
                <div style={{ color: '#b45309' }}>{explanation.plannerAttention}</div>
              </div>
              
              <div style={{ background: 'var(--ai-subtle)', border: '1px solid var(--ai-border)', padding: '8px 12px', borderRadius: 6 }}>
                <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--ai-primary)' }}>Recommendation</div>
                <div>{explanation.recommendation}</div>
              </div>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
