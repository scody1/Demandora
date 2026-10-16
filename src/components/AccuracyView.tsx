import React, { useState } from 'react';
import { NormalizedDataset, ForecastResult } from '../types';
import { formatNumber, ConfidenceBadge } from './UI';
import { CheckCircle2, AlertCircle, TrendingUp, Info, HelpCircle } from 'lucide-react';

interface AccuracyViewProps {
  dataset: NormalizedDataset;
  forecastResult: ForecastResult;
}

export function AccuracyView({ dataset, forecastResult }: AccuracyViewProps) {
  const { kpis } = forecastResult;
  const accuracyRecords = dataset.accuracyRecords || [];
  const hasAccuracyData = accuracyRecords.length > 0;

  const totalActual = accuracyRecords.reduce((a, b) => a + b.actual, 0);
  const totalForecast = accuracyRecords.reduce((a, b) => a + b.forecast, 0);
  const totalAbsError = accuracyRecords.reduce((a, b) => a + Math.abs(b.forecast - b.actual), 0);
  const calcWape = totalActual > 0 ? ((totalAbsError / totalActual) * 100).toFixed(1) : '0.0';
  const calcBias = totalActual > 0 ? (((totalForecast - totalActual) / totalActual) * 100).toFixed(1) : '0.0';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Workspace Sub-Header */}
      <div className="workspace-header-bar">
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle2 size={18} color="#047857" />
            MODEL ACCURACY & BENCHMARK VALIDATION
          </h2>
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
            Evaluation of prior forecast predictions against actual sales invoices using Weighted Absolute Percentage Error (WAPE)
          </p>
        </div>
      </div>

      {hasAccuracyData ? (
        <>
          {/* Key Accuracy Metrics Strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            <div className="bento-intel-card">
              <div className="bento-card-top">
                <span className="bento-label">Portfolio WAPE</span>
                <span className="bento-tag green">Empirical</span>
              </div>
              <div className="bento-value-row">
                <span className="bento-val-large num" style={{ color: '#047857' }}>
                  {calcWape}%
                </span>
                <span className="bento-delta positive">Verified</span>
              </div>
              <span className="bento-subtext">Weighted error on historical actuals</span>
            </div>

            <div className="bento-intel-card">
              <div className="bento-card-top">
                <span className="bento-label">Forecast Bias</span>
                <span className="bento-tag blue">Empirical</span>
              </div>
              <div className="bento-value-row">
                <span className="bento-val-large num" style={{ color: 'var(--ai-primary)' }}>
                  {parseFloat(calcBias) > 0 ? `+${calcBias}%` : `${calcBias}%`}
                </span>
              </div>
              <span className="bento-subtext">Overall portfolio directional bias</span>
            </div>

            <div className="bento-intel-card">
              <div className="bento-card-top">
                <span className="bento-label">Validated Records</span>
                <span className="bento-tag blue">Empirical</span>
              </div>
              <div className="bento-value-row">
                <span className="bento-val-large num" style={{ color: 'var(--text-primary)' }}>
                  {accuracyRecords.length}
                </span>
              </div>
              <span className="bento-subtext">Historical comparison pairs verified</span>
            </div>
          </div>

          {/* Detailed Item Accuracy Table */}
          <div className="workspace-table-card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                  Historical Forecast vs Actual Invoiced Performance
                </h3>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Formula: <code>WAPE = Σ |Forecast - Actual| / Σ Actual</code>
                </p>
              </div>
            </div>

            <div className="modern-table-container">
              <table className="modern-data-table">
                <thead>
                  <tr>
                    <th>SKU Code</th>
                    <th>Product Description</th>
                    <th>Category</th>
                    <th style={{ textAlign: 'center' }}>Month</th>
                    <th style={{ textAlign: 'right' }}>Prior Forecast</th>
                    <th style={{ textAlign: 'right' }}>Actual Invoiced</th>
                    <th style={{ textAlign: 'right' }}>Variance</th>
                    <th style={{ textAlign: 'right' }}>SKU Error %</th>
                  </tr>
                </thead>
                <tbody>
                  {accuracyRecords.map((rec, i) => (
                    <tr key={i}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--ai-primary)' }}>
                        {rec.itemCode}
                      </td>
                      <td>{rec.description}</td>
                      <td>{rec.itemGroup}</td>
                      <td style={{ textAlign: 'center' }} className="num">{rec.month}</td>
                      <td style={{ textAlign: 'right' }} className="num">{formatNumber(rec.forecast)}</td>
                      <td style={{ textAlign: 'right' }} className="num">{formatNumber(rec.actual)}</td>
                      <td style={{ textAlign: 'right', color: rec.variance < 0 ? 'var(--danger)' : 'var(--success)' }} className="num">
                        {rec.variance > 0 ? `+${formatNumber(rec.variance)}` : formatNumber(rec.variance)}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }} className="num">
                        {(rec.wape * 100).toFixed(2)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        /* Transparent Unavailable State if no accuracy data in Excel */
        <div className="workspace-table-card" style={{ padding: '48px 24px', textAlign: 'center' }}>
          <div style={{ width: 54, height: 54, borderRadius: '50%', background: 'var(--bg-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', color: 'var(--text-tertiary)' }}>
            <AlertCircle size={28} />
          </div>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
            WAPE & Accuracy Benchmark Not Available
          </h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 520, margin: '8px auto 0', lineHeight: 1.6 }}>
            The uploaded workbook (<strong>{dataset.metadata.sourceName}</strong>) does not contain a historical forecast vs actual benchmarks sheet (<code>Accuracy_Benchmarks</code>).
          </p>
          <div style={{ marginTop: 20, display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--bg-subtle)', padding: '10px 18px', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
            <Info size={14} color="var(--ai-primary)" />
            <span>To track WAPE, include prior forecast values in your Excel file or approve forecast iterations over time.</span>
          </div>
        </div>
      )}
    </div>
  );
}
