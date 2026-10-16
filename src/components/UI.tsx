import React from 'react';
import { ForecastStatus, ConfidenceLevel } from '../types';
import { X, CheckCircle2, AlertCircle, Info, Sparkles } from 'lucide-react';

export function formatNumber(val: number | null | undefined): string {
  if (val === null || val === undefined) return '—';
  return val.toLocaleString('en-IN');
}

export function formatCompact(val: number): string {
  if (val >= 1_000_000) {
    return (val / 1_000_000).toFixed(2) + 'M';
  }
  if (val >= 1_000) {
    return (val / 1_000).toFixed(1) + 'K';
  }
  return val.toLocaleString('en-IN');
}

export function getMonthLabels(startMonthStr: string, horizon: number): string[] {
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [yearStr, monthStr] = (startMonthStr || '2026-11').split('-');
  let year = parseInt(yearStr, 10);
  let month = parseInt(monthStr, 10) - 1; // 0-indexed

  if (isNaN(year) || isNaN(month)) {
    year = 2026;
    month = 10;
  }

  const labels: string[] = [];
  for (let i = 0; i < horizon; i++) {
    const curYear = year + Math.floor((month + i) / 12);
    const curMonth = (month + i) % 12;
    const shortYear = (curYear % 100).toString().padStart(2, '0');
    labels.push(`${monthNames[curMonth]}-${shortYear}`);
  }
  return labels;
}

export function StatusBadge({ status }: { status: ForecastStatus }) {
  const config: Record<ForecastStatus, { color: string; bg: string; border: string }> = {
    'Draft': { color: '#475569', bg: '#f1f5f9', border: '#cbd5e1' },
    'Generated': { color: '#4f46e5', bg: '#eef2ff', border: '#c7d2fe' },
    'Submitted': { color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
    'Approved': { color: '#047857', bg: '#ecfdf5', border: '#a7f3d0' },
    'Returned': { color: '#e11d48', bg: '#fff1f2', border: '#fecdd3' }
  };

  const style = config[status] || config['Draft'];

  return (
    <span 
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11.5,
        fontWeight: 600,
        color: style.color,
        background: style.bg,
        border: `1px solid ${style.border}`,
        padding: '3px 8px',
        borderRadius: 9999
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: style.color }} />
      {status}
    </span>
  );
}

export function ConfidenceBadge({ 
  confidence, 
  percentage 
}: { 
  confidence: ConfidenceLevel; 
  percentage?: number | null; 
}) {
  if (confidence === 'Not evaluated' || !confidence) {
    return (
      <span className="confidence-indicator none" style={{ color: '#94a3b8' }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', marginRight: 5 }} />
        Not evaluated
      </span>
    );
  }

  const isHigh = confidence === 'High';
  const isMedium = confidence === 'Medium';
  const themeClass = isHigh ? 'high' : isMedium ? 'medium' : 'low';
  
  const displayVal = percentage !== null && percentage !== undefined 
    ? `${confidence} (${percentage.toFixed(0)})` 
    : confidence;

  return (
    <span className={`confidence-indicator ${themeClass}`}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', marginRight: 5 }} />
      <span>{displayVal}</span>
    </span>
  );
}

interface ModalProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string;
}

export function Modal({ isOpen, title, onClose, children, footer, maxWidth = '620px' }: ModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div 
        className="modal-box" 
        style={{ maxWidth }} 
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-top">
          <h3>{title}</h3>
          <button 
            type="button" 
            className="btn-ghost" 
            style={{ padding: 4, borderRadius: 6 }} 
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="modal-content-body">
          {children}
        </div>
        {footer && (
          <div className="modal-bottom-actions">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

export function ToastContainer({ 
  toasts, 
  onDismiss 
}: { 
  toasts: ToastMessage[]; 
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast-pill ${toast.type}`}>
          {toast.type === 'success' && <CheckCircle2 size={16} color="#10b981" />}
          {toast.type === 'error' && <AlertCircle size={16} color="#f43f5e" />}
          {toast.type === 'info' && <Sparkles size={16} color="#818cf8" />}
          <span style={{ flex: 1 }}>{toast.message}</span>
          <button 
            type="button" 
            onClick={() => onDismiss(toast.id)} 
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 2 }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
