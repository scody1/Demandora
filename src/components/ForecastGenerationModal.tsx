import React from 'react';
import { Sparkles, Check, Loader2, AlertTriangle, Terminal, X, StopCircle, RefreshCw } from 'lucide-react';
import { Modal } from './UI';

export const ACCURATE_FORECAST_STAGES = [
  'Validating Excel demand history',
  'Constructing chronological features',
  'Profiling SKU demand patterns',
  'Training eligible candidate models',
  'Running walk-forward backtesting',
  'Selecting the best-performing model',
  'Refitting selected models on available history',
  'Generating future demand forecasts',
  'Calculating prediction intervals and reliability',
  'Calculating MRP and procurement requirements',
  'Committing forecast results'
] as const;

export type ForecastStageName = typeof ACCURATE_FORECAST_STAGES[number];

// Retain legacy export for backwards compatibility
export const ML_FORECAST_STEPS = ACCURATE_FORECAST_STAGES;

export interface ForecastJobModalInfo {
  jobId?: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  currentStage: string;
  completedStages: string[];
  completedItems: number;
  totalItems: number;
  currentItemCode?: string | null;
  currentModel?: string | null;
  elapsedSeconds: number;
  progressPercentage?: number | null;
}

interface ForecastGenerationModalProps {
  isOpen: boolean;
  jobInfo?: ForecastJobModalInfo | null;
  stepIndex?: number;
  categoryScopeLabel?: string;
  error?: string | null;
  onClose: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
}

function formatElapsedTime(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(rounded / 60).toString().padStart(2, '0');
  const ss = (rounded % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

export function ForecastGenerationModal({
  isOpen,
  jobInfo,
  stepIndex = 0,
  categoryScopeLabel,
  error,
  onClose,
  onCancel,
  onRetry
}: ForecastGenerationModalProps) {
  if (!isOpen) return null;

  const totalItems = jobInfo?.totalItems ?? 0;
  const completedItems = jobInfo?.completedItems ?? 0;
  const elapsedText = formatElapsedTime(jobInfo?.elapsedSeconds ?? 0);
  const currentStageText = jobInfo?.currentStage || ACCURATE_FORECAST_STAGES[Math.min(stepIndex, ACCURATE_FORECAST_STAGES.length - 1)];
  const currentSkuText = jobInfo?.currentItemCode || (jobInfo?.status === 'QUEUED' ? 'Waiting in queue...' : '—');
  const currentModelText = jobInfo?.currentModel || (jobInfo?.status === 'RUNNING' ? 'Evaluating candidates...' : '—');

  // Compute measurable progress percentage
  const progressPct = typeof jobInfo?.progressPercentage === 'number'
    ? Math.min(100, Math.max(0, jobInfo.progressPercentage))
    : totalItems > 0
      ? Math.min(100, Math.max(0, Math.round((completedItems / totalItems) * 100)))
      : 0;

  return (
    <Modal
      isOpen={isOpen}
      title={error ? 'Forecasting Engine Unavailable' : 'PYTHON ML ENGINE — GENERATING FORECAST'}
      onClose={onClose}
      maxWidth="620px"
    >
      <div style={{ padding: '8px 4px 16px 4px' }}>
        {error ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 16 }}>
              <div
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 10,
                  background: '#fef2f2',
                  border: '1px solid #fecaca',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#dc2626',
                  flexShrink: 0
                }}
              >
                <AlertTriangle size={22} />
              </div>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: '#991b1b', margin: 0 }}>
                  PYTHON FORECASTING SERVICE OFFLINE OR ERROR
                </h3>
                <p style={{ fontSize: 12.5, color: '#7f1d1d', marginTop: 4, lineHeight: 1.4 }}>
                  {error}
                </p>
              </div>
            </div>

            <div
              style={{
                background: '#0f172a',
                color: '#f8fafc',
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 16,
                fontSize: 12,
                fontFamily: 'monospace'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#94a3b8', marginBottom: 6 }}>
                <Terminal size={14} />
                <span>Ensure the Python ML backend is active locally:</span>
              </div>
              <div style={{ color: '#38bdf8', userSelect: 'all', fontWeight: 600 }}>
                python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              {onRetry && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={onRetry}
                  style={{ fontSize: 12, padding: '7px 16px', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <RefreshCw size={14} />
                  Retry Forecast Generation
                </button>
              )}
              <button
                type="button"
                className="btn-secondary"
                onClick={onClose}
                style={{ fontSize: 12, padding: '7px 16px' }}
              >
                Close & Review Service Status
              </button>
            </div>
          </div>
        ) : (
          <div>
            {/* Header info */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  background: 'var(--ai-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--ai-primary)',
                  flexShrink: 0
                }}
              >
                <Sparkles size={20} className="pulse-icon" />
              </div>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
                  PYTHON ML ENGINE — GENERATING FORECAST
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: 'var(--ai-primary)',
                      background: 'var(--ai-subtle)',
                      padding: '2px 8px',
                      borderRadius: 4
                    }}
                  >
                    Forecasting {categoryScopeLabel || 'All Categories'}: {totalItems} SKUs
                  </span>
                </div>
              </div>
            </div>

            {/* Real Execution Telemetry Card */}
            <div
              style={{
                background: 'var(--bg-subtle, #f8fafc)',
                border: '1px solid var(--border-subtle, #e2e8f0)',
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 16
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                  gap: '10px 14px',
                  fontSize: 12
                }}
              >
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>
                    Current stage
                  </div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {currentStageText}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>
                    Current SKU
                  </div>
                  <div style={{ fontWeight: 700, color: 'var(--ai-primary)', marginTop: 2, fontFamily: 'monospace' }}>
                    {currentSkuText}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>
                    Current model
                  </div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {currentModelText}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>
                    Batch progress
                  </div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>
                    {totalItems > 0 ? `${completedItems} / ${totalItems} SKUs completed` : 'Preparing batch...'}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', fontWeight: 600 }}>
                    Elapsed time
                  </div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginTop: 2, fontFamily: 'monospace' }}>
                    {elapsedText}
                  </div>
                </div>
              </div>

              {/* Genuine Measurable Progress Bar */}
              {totalItems > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div
                    style={{
                      width: '100%',
                      height: 6,
                      borderRadius: 3,
                      background: 'var(--border-subtle, #e2e8f0)',
                      overflow: 'hidden'
                    }}
                  >
                    <div
                      style={{
                        width: `${progressPct}%`,
                        height: '100%',
                        background: 'var(--ai-primary, #0284c7)',
                        borderRadius: 3,
                        transition: 'width 0.3s ease'
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Stages Checklist */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, maxHeight: '280px', overflowY: 'auto' }}>
              {ACCURATE_FORECAST_STAGES.map((stageText, idx) => {
                const isDone = jobInfo
                  ? jobInfo.completedStages.includes(stageText)
                  : idx < stepIndex;
                const isCurrent = jobInfo
                  ? jobInfo.currentStage === stageText
                  : idx === stepIndex;

                return (
                  <div
                    key={stageText}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '6px 10px',
                      borderRadius: 6,
                      background: isCurrent ? 'var(--ai-subtle, #f0f9ff)' : '#ffffff',
                      border: `1px solid ${isCurrent ? 'var(--ai-border, #bae6fd)' : 'var(--border-subtle, #f1f5f9)'}`,
                      transition: 'all 0.2s ease'
                    }}
                  >
                    <div style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {isDone ? (
                        <Check size={15} color="var(--success, #16a34a)" />
                      ) : isCurrent ? (
                        <Loader2 size={15} color="var(--ai-primary, #0284c7)" className="spin-icon" />
                      ) : (
                        <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--text-tertiary, #94a3b8)' }} />
                      )}
                    </div>

                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: isCurrent ? 700 : isDone ? 500 : 400,
                        color: isCurrent
                          ? 'var(--ai-primary, #0284c7)'
                          : isDone
                            ? 'var(--text-primary, #0f172a)'
                            : 'var(--text-tertiary, #94a3b8)'
                      }}
                    >
                      {stageText}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Action Buttons: Cancel / Hide distinction */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 18,
                paddingTop: 12,
                borderTop: '1px solid var(--border-subtle, #f1f5f9)'
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                Closing this modal will not cancel the background forecasting engine.
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                {onCancel && (
                  <button
                    type="button"
                    onClick={onCancel}
                    style={{
                      fontSize: 11.5,
                      padding: '5px 12px',
                      borderRadius: 6,
                      border: '1px solid #fecaca',
                      background: '#fff',
                      color: '#b91c1c',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      fontWeight: 600
                    }}
                  >
                    <StopCircle size={13} />
                    Cancel Forecast
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={onClose}
                  style={{ fontSize: 11.5, padding: '5px 12px' }}
                >
                  Hide Modal
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
