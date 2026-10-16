import React from 'react';
import { Upload, Download, Sparkles, Database, ArrowRight, FileSpreadsheet, ShieldCheck, Cpu, LineChart } from 'lucide-react';
import { downloadExcelTemplate } from '../services/excelService';

interface EmptyStateProps {
  onOpenImport: () => void;
}

export function EmptyState({ onOpenImport }: EmptyStateProps) {
  return (
    <div className="empty-ai-canvas">
      <div className="empty-ai-card">
        {/* Subtle Tag / Pill */}
        <div className="empty-ai-pill">
          <Sparkles size={13} color="var(--ai-primary)" />
          <span>AI FORECASTING</span>
        </div>

        {/* Crisp, Focused Heading */}
        <h2 className="empty-ai-title">No planning dataset loaded</h2>

        {/* Clear Subtitle */}
        <p className="empty-ai-description">
          Import your historical demand Excel file to generate item-level forecasts, demand patterns and planning requirements.
        </p>

        {/* Primary and Secondary Action Buttons */}
        <div className="empty-ai-actions">
          <button
            type="button"
            className="btn-ai empty-ai-primary-btn"
            onClick={onOpenImport}
          >
            <Upload size={15} />
            <span>Import Excel</span>
            <ArrowRight size={14} style={{ marginLeft: 2 }} />
          </button>

          <button
            type="button"
            className="btn-ghost empty-ai-secondary-btn"
            onClick={downloadExcelTemplate}
          >
            <Download size={14} />
            <span>Download Template</span>
          </button>

        </div>



        {/* Concise Footer Note */}
        <div className="empty-ai-footer-note">
          Excel-first architecture · Adaptive historical telemetry (4M, 11M, 24M, 36M+) · Natural-key deduplication
        </div>
      </div>
    </div>
  );
}
