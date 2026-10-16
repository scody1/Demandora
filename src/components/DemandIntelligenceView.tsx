import React, { useState, useMemo } from 'react';
import { ForecastLine, NormalizedDataset, ForecastParameters } from '../types';
import { formatNumber, formatCompact, ConfidenceBadge, getMonthLabels } from './UI';
import { Sparkles, TrendingUp, AlertTriangle, Calendar, Layers, Activity, Search, Filter, ArrowUpRight, ArrowDownRight, Compass } from 'lucide-react';

interface DemandIntelligenceViewProps {
  lines: ForecastLine[];
  dataset: NormalizedDataset;
  parameters: ForecastParameters;
  selectedItemCode: string | null;
  onSelectItem: (item: ForecastLine) => void;
}

export function DemandIntelligenceView({
  lines,
  dataset,
  parameters,
  selectedItemCode,
  onSelectItem
}: DemandIntelligenceViewProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [signalFilter, setSignalFilter] = useState<'ALL' | string>('ALL');

  const selectedItem = useMemo(() => {
    return lines.find(l => l.itemCode === selectedItemCode) || lines[0] || null;
  }, [lines, selectedItemCode]);

  // Group portfolio items by velocity trajectory
  const velocityBreakdown = useMemo(() => {
    const growth = lines.filter(l => l.demandSignal.velocityTrendPct > 5).length;
    const declining = lines.filter(l => l.demandSignal.velocityTrendPct < -5).length;
    const stable = lines.length - growth - declining;
    return { growth, declining, stable };
  }, [lines]);



  const filteredLines = useMemo(() => {
    return lines.filter(l => {
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        if (!l.itemCode.toLowerCase().includes(q) && !l.description.toLowerCase().includes(q)) {
          return false;
        }
      }
      if (signalFilter !== 'ALL' && l.demandSignal.signalTone !== signalFilter) {
        return false;
      }
      return true;
    });
  }, [lines, searchTerm, signalFilter]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Workspace Header Sub-Bar */}
      <div className="workspace-header-bar">
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={18} color="var(--ai-primary)" />
            DEMAND INTELLIGENCE & CAUSAL TELEMETRY
          </h2>
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
            Empirical demand patterns, velocity trajectories, and festive seasonality derived from {dataset.metadata.sourceName}
          </p>
        </div>
      </div>

      {/* Top Intelligence Bento Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">Velocity Growth SKUs</span>
            <span className="bento-tag green">Expansion</span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num" style={{ color: 'var(--success)' }}>
              {velocityBreakdown.growth}
            </span>
            <span className="bento-delta positive">
              <ArrowUpRight size={14} />
              {((velocityBreakdown.growth / Math.max(lines.length, 1)) * 100).toFixed(0)}%
            </span>
          </div>
          <span className="bento-subtext">&gt;5% annualized positive demand momentum</span>
        </div>

        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">Declining Demand SKUs</span>
            <span className="bento-tag red">Contraction</span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num" style={{ color: 'var(--danger)' }}>
              {velocityBreakdown.declining}
            </span>
            <span className="bento-delta negative">
              <ArrowDownRight size={14} />
              {((velocityBreakdown.declining / Math.max(lines.length, 1)) * 100).toFixed(0)}%
            </span>
          </div>
          <span className="bento-subtext">Review buffer stock liquidation</span>
        </div>

        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">Stable / Core Demand</span>
            <span className="bento-tag blue">Predictable</span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num" style={{ color: 'var(--ai-primary)' }}>
              {velocityBreakdown.stable}
            </span>
            <span className="bento-delta" style={{ color: 'var(--text-secondary)' }}>
              {((velocityBreakdown.stable / Math.max(lines.length, 1)) * 100).toFixed(0)}%
            </span>
          </div>
          <span className="bento-subtext">Within ±5% historical velocity band</span>
        </div>

        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">Procurement Guardrails</span>
            <span className="bento-tag purple">Active Policies</span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num" style={{ color: '#8b5cf6' }}>
              {lines.filter(l => (l.heuristicAdvisories && l.heuristicAdvisories.length > 0) || l.momentumFlag === 'SURGE' || l.momentumFlag === 'NEGATIVE').length}
            </span>
            <span className="bento-delta" style={{ color: '#8b5cf6' }}>
              Active
            </span>
          </div>
          <span className="bento-subtext">Working capital & service-level guardrails</span>
        </div>
      </div>



      {/* Item-level Demand Intelligence Grid */}
      <div className="workspace-table-card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text-primary)' }}>
              SKU Demand Signals & Driver Telemetry
            </h3>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Calculated dynamically from imported sales velocity and open order book
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="toolbar-search-wrapper" style={{ width: 220 }}>
              <Search size={13} color="#64748b" />
              <input
                type="text"
                placeholder="Search SKU..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <select
              className="modern-select"
              value={signalFilter}
              onChange={(e) => setSignalFilter(e.target.value)}
              style={{ fontSize: 12 }}
            >
              <option value="ALL">All Signal Trajectories</option>
              <option value="strong-growth">Strong Growth</option>
              <option value="moderate-growth">Moderate Growth</option>
              <option value="stable">Stable Demand</option>
              <option value="declining">Declining Demand</option>
            </select>
          </div>
        </div>

        {/* Signals Table */}
        <div className="modern-table-container">
          <table className="modern-data-table">
            <thead>
              <tr>
                <th>SKU Code</th>
                <th>Description</th>
                <th>Pattern</th>
                <th>Trend / Seasonality</th>
                <th>Data Quality</th>
                <th>Recommended Model</th>
                <th style={{ textAlign: 'right' }}>Backtest WAPE</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredLines.map(line => {
                const isSelected = selectedItemCode === line.itemCode;
                const isPos = line.demandSignal.velocityTrendPct > 0;
                const wape = line.modelDecision.backtestWape;
                const profile = line.demandSignal.demandProfile;

                return (
                  <tr
                    key={line.itemCode}
                    onClick={() => onSelectItem(line)}
                    style={{
                      cursor: 'pointer',
                      background: isSelected ? 'var(--ai-subtle)' : 'transparent'
                    }}
                  >
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--ai-primary)' }}>
                      {line.itemCode}
                    </td>
                    <td>{line.description}</td>
                    <td>
                      {profile ? (
                        <div>
                          <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{profile.demand_pattern}</span>
                          <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-secondary)' }}>
                            {profile.forecast_eligibility === 'insufficient_history' ? 'Insufficient History' : 'Eligible'}
                          </span>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)' }}>N/A</span>
                      )}
                    </td>
                    <td>
                      {profile ? (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <span className="badge-pill blue" style={{ fontSize: 10, padding: '2px 6px' }}>
                            {profile.trend_direction} trend
                          </span>
                          {profile.seasonality_detected && (
                            <span className="badge-pill" style={{ fontSize: 10, padding: '2px 6px', background: '#e0e7ff', color: '#4338ca' }}>
                              Seasonal ({profile.seasonality_period}m)
                            </span>
                          )}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {profile ? (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {profile.data_quality_flags.includes('INTERMITTENT_DEMAND') && (
                            <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fef3c7', color: '#b45309' }}>Intermittent</span>
                          )}
                          {profile.data_quality_flags.includes('LUMPY_DEMAND') && (
                            <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fef3c7', color: '#b45309' }}>Lumpy</span>
                          )}
                          {profile.outlier_count > 0 && (
                            <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fee2e2', color: '#b91c1c' }}>{profile.outlier_count} Outliers</span>
                          )}
                          {profile.missing_periods > 0 && (
                            <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#f1f5f9', color: '#64748b' }}>{profile.missing_periods} Missing</span>
                          )}
                          {profile.data_quality_flags.length === 0 && profile.outlier_count === 0 && profile.missing_periods === 0 && (
                            <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#ecfdf5', color: '#047857' }}>Clean</span>
                          )}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                        {line.modelDecision.selectedModel}
                      </span>
                      <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-secondary)' }}>
                        Family: {profile?.recommended_model_family || 'N/A'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }} className="num">
                      {wape !== null ? (
                        <span style={{ color: wape < 15 ? 'var(--success)' : 'inherit' }}>
                          {wape}%
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>N/A</span>
                      )}
                    </td>
                    <td>
                       <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                         {line.modelDecision.selectionStatus === 'INSUFFICIENT_HISTORY' ? 'Not Evaluated' : 'Evaluated'}
                       </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
