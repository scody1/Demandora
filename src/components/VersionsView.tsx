import React from 'react';
import { ForecastVersion } from '../types';
import { formatNumber, StatusBadge } from './UI';
import { Calendar, History, Eye, RotateCcw, ArrowRight } from 'lucide-react';

interface VersionsViewProps {
  versions: ForecastVersion[];
  onViewSnapshot: (version: ForecastVersion) => void;
  onRestoreVersionAsDraft?: (version: ForecastVersion) => void;
}

export function VersionsView({ versions, onViewSnapshot, onRestoreVersionAsDraft }: VersionsViewProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Workspace Header */}
      <div className="workspace-header-bar">
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Calendar size={18} color="var(--ai-primary)" />
            FORECAST VERSION TIMELINE & AUDIT TRAIL
          </h2>
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
            Complete historical snapshots recorded upon generation, planner adjustments, draft saves, and approvals
          </p>
        </div>
      </div>

      <div className="workspace-table-card" style={{ padding: 22 }}>
        {versions.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {versions.map((ver) => (
              <div
                key={ver.version}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: '#ffffff',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 12,
                  padding: '16px 20px',
                  boxShadow: 'var(--shadow-sm)',
                  transition: 'all 0.2s ease'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 10,
                      background: 'var(--ai-subtle)',
                      color: 'var(--ai-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 800,
                      fontSize: 16,
                      border: '1px solid var(--ai-border)'
                    }}
                  >
                    v{ver.version}
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <strong style={{ fontSize: 14, color: 'var(--text-primary)' }}>
                        Version {ver.version}
                      </strong>
                      <StatusBadge status={ver.status} />
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                      Recorded on <strong>{ver.date}</strong> by <strong>{ver.user}</strong>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
                      Horizon: {ver.parameters.horizon} Months ({ver.parameters.startMonth}) · {ver.adjustmentsCount} Planner Overrides
                      {ver.datasetVersion && (
                        <span> · Source: <strong>v{ver.datasetVersion}</strong> ({ver.datasetName || 'Excel Ingestion'})</span>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>
                      AI Demand Forecast
                    </div>
                    <div className="num" style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>
                      {formatNumber(ver.aiTotal)}
                    </div>
                  </div>

                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>
                      Net Requirement
                    </div>
                    <div className="num" style={{ fontSize: 15, fontWeight: 800, color: 'var(--danger)' }}>
                      {formatNumber(ver.netReqTotal)}
                    </div>
                  </div>

                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>
                      Confidence
                    </div>
                    <div className="num" style={{ fontSize: 15, fontWeight: 800, color: 'var(--ai-primary)' }}>
                      {ver.avgConfidencePct}%
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => onViewSnapshot(ver)}
                    style={{ fontSize: 12, padding: '6px 14px' }}
                  >
                    <Eye size={13} />
                    <span>View Snapshot</span>
                  </button>

                  {onRestoreVersionAsDraft && (
                    <button
                      type="button"
                      className="btn-ai"
                      onClick={() => onRestoreVersionAsDraft(ver)}
                      style={{ fontSize: 12, padding: '6px 14px' }}
                      title={`Restore version ${ver.version} into a new Draft workspace`}
                    >
                      <RotateCcw size={13} />
                      <span>Restore as New Draft</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: '48px 20px', textAlign: 'center' }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--ai-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: 'var(--ai-primary)' }}>
              <History size={24} />
            </div>
            <h4 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>No Prior Versions in Current Session</h4>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 500, margin: '8px auto 0' }}>
              Versions are recorded automatically whenever you generate a forecast, save drafts, or submit planning milestones for approval.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
