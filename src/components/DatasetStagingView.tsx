import React from 'react';
import { Sparkles, Brain, Sliders, Database, ArrowRight, CheckCircle2, AlertTriangle, Layers, Calendar, BarChart3, RefreshCw } from 'lucide-react';
import { NormalizedDataset, ForecastParameters, SKUCategory, SegmentationResult } from '../types';
import { DemandSegmentationCards } from './DemandSegmentationCards';

interface DatasetStagingViewProps {
  dataset: NormalizedDataset;
  parameters: ForecastParameters;
  onOpenParameters: () => void;
  onTrainAndGenerate: () => void;
  onOpenImport: () => void;
  segmentation?: SegmentationResult | null;
  isSegmentationLoading?: boolean;
  segmentationError?: string | null;
  onRetrySegmentation?: () => void;
  selectedCategories?: SKUCategory[];
  onSelectCategories?: (categories: SKUCategory[]) => void;
}

export function DatasetStagingView({
  dataset,
  parameters,
  onOpenParameters,
  onTrainAndGenerate,
  onOpenImport,
  segmentation,
  isSegmentationLoading = false,
  segmentationError = null,
  onRetrySegmentation,
  selectedCategories,
  onSelectCategories
}: DatasetStagingViewProps) {
  const months = dataset.historySummary?.totalMonths || 0;
  const itemsCount = dataset.items.length;
  const observationsCount = dataset.salesHistory.length;

  const itemsWithHistory = dataset.historySummary?.itemsWithHistory || itemsCount;
  
  // Calculate items requiring attention
  const itemsRequiringAttention = dataset.items.filter(i => {
    return !dataset.historySummary?.itemHistoryMap[i.itemCode] || dataset.historySummary.itemHistoryMap[i.itemCode] < 12;
  }).length;
  
  const historyRange = dataset.historySummary?.earliestPeriod 
    ? `${dataset.historySummary.earliestPeriod} to ${dataset.historySummary.latestPeriod}`
    : '';

  // Determine ML model tier capability based on history length (Aligned with Phase 8 FSD)
  const getTierInfo = (m: number) => {
    if (m >= 24) {
      return {
        tier: 'Full Historical Forecasting (24M+)',
        desc: 'Full candidate suite: Multi-Year Seasonal Decomposition, Auto-ARIMA, Holt-Winters Multiplicative, Gradient Boosting & Ensemble Weighted Blending.',
        badgeColor: '#047857',
        badgeBg: '#ecfdf5'
      };
    }
    if (m >= 12) {
      return {
        tier: 'Normal Forecasting (12-23M)',
        desc: 'Sufficient history detected. Eligible for Annual Seasonality, Holt-Winters Additive, Auto-ARIMA, and Random Forest lag regression.',
        badgeColor: '#0369a1',
        badgeBg: '#f0f9ff'
      };
    }
    if (m >= 6) {
      return {
        tier: 'Insufficient History / Manual Handling (6-11M)',
        desc: 'History under 12 months. FSD requires minimum 12 months for AI forecasting. Requires manual planner handling.',
        badgeColor: '#b45309',
        badgeBg: '#fffbeb'
      };
    }
    return {
      tier: 'New Item / No AI Forecast (0-5M)',
      desc: 'New item with less than 6 months history. Manual or similar-item handling required per FSD.',
      badgeColor: '#b91c1c',
      badgeBg: '#fef2f2'
    };
  };

  const tierInfo = getTierInfo(months);

  return (
    <div style={{ maxWidth: 1100, margin: '24px auto', padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Top Banner / Hero */}
      <div className="dataset-staging-card" style={{ borderLeft: '4px solid var(--ai-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--ai-primary)', background: 'var(--ai-subtle)', padding: '3px 10px', borderRadius: 20, marginBottom: 8 }}>
              <Sparkles size={12} />
              <span>AI ENGINE · DATA READY</span>
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 6px 0', letterSpacing: '-0.2px' }}>
              Planning Dataset Active — Ready for Model Training
            </h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, maxWidth: 680, lineHeight: 1.5 }}>
              The Excel workbook <strong>{dataset.metadata.sourceName}</strong> (v{dataset.dataVersion}) has been parsed and validated.
              The forecasting engine has analyzed the available historical demand telemetry and calibrated its model tier.
            </p>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              type="button"
              className="btn-ghost"
              onClick={onOpenParameters}
              style={{ fontSize: 12, padding: '8px 14px' }}
            >
              <Sliders size={13} />
              <span>Horizon ({parameters.horizon}M) & Scope</span>
            </button>

            <button
              type="button"
              className="btn-ai"
              onClick={onTrainAndGenerate}
              disabled={isSegmentationLoading || !segmentation || Boolean(segmentationError)}
              title={isSegmentationLoading ? 'Calculating SKU segmentation...' : undefined}
              style={{
                fontSize: 13,
                padding: '9px 20px',
                fontWeight: 600,
                boxShadow: (isSegmentationLoading || !segmentation || Boolean(segmentationError))
                  ? 'none'
                  : '0 4px 14px rgba(79, 70, 229, 0.3)',
                opacity: (isSegmentationLoading || !segmentation || Boolean(segmentationError)) ? 0.6 : 1,
                cursor: (isSegmentationLoading || !segmentation || Boolean(segmentationError)) ? 'not-allowed' : 'pointer'
              }}
            >
              <Brain size={15} />
              <span>
                {isSegmentationLoading
                  ? 'Calculating SKU segmentation...'
                  : selectedCategories && selectedCategories.length === 1
                  ? `Generate ${selectedCategories[0].charAt(0) + selectedCategories[0].slice(1).toLowerCase()} Forecast`
                  : selectedCategories && selectedCategories.length < 3
                  ? `Generate ${selectedCategories.map(c => c.charAt(0) + c.slice(1).toLowerCase()).join(' & ')} Forecast`
                  : 'Train Models & Generate Forecast'}
              </span>
              <ArrowRight size={14} />
            </button>
          </div>
        </div>

        {/* Dynamic Telemetry Metrics Cards */}
        <div className="staging-metrics-grid" style={{ marginTop: 8 }}>
          <div className="staging-stat-cell">
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>
              Dataset
            </span>
            <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
              {itemsCount.toLocaleString()} items
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              Across {new Set(dataset.items.map(i => i.itemGroup)).size} item groups
            </span>
          </div>

          <div className="staging-stat-cell">
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>
              History
            </span>
            <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
              {months} months
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              {historyRange || 'Adaptive historical period'}
            </span>
          </div>

          <div className="staging-stat-cell">
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>
              Warehouses
            </span>
            <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
              {new Set(dataset.inventory.map(inv => inv.warehouse)).size}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              Inventory tracking active
            </span>
          </div>

          <div className="staging-stat-cell">
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>
              Valid observations
            </span>
            <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
              {observationsCount.toLocaleString()}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              From {itemsWithHistory.toLocaleString()} items with sales
            </span>
          </div>
          
          <div className="staging-stat-cell">
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>
              Items requiring attention
            </span>
            <span style={{ fontSize: 20, fontWeight: 700, color: itemsRequiringAttention > 0 ? '#b91c1c' : '#047857' }}>
              {itemsRequiringAttention}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              Due to insufficient history (&lt;12M)
            </span>
          </div>
        </div>

        {dataset.historySummary?.incrementalStats && (
          <div style={{ marginTop: 16, background: 'var(--bg-subtle)', padding: '12px 16px', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
            <h4 style={{ margin: '0 0 10px 0', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase' }}>Import Reconciliation (Incremental Merge)</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>New</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--success)' }}>+{dataset.historySummary.incrementalStats.newObservations}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Updated</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ai-primary)' }}>{dataset.historySummary.incrementalStats.updatedObservations}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Duplicates</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{dataset.historySummary.incrementalStats.duplicatesIgnored}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Conflicts</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: dataset.historySummary.incrementalStats.conflictingObservations > 0 ? 'var(--danger)' : 'inherit' }}>{dataset.historySummary.incrementalStats.conflictingObservations}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Invalid</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: dataset.historySummary.incrementalStats.invalidObservations > 0 ? 'var(--danger)' : 'inherit' }}>{dataset.historySummary.incrementalStats.invalidObservations}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Affected items</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{dataset.historySummary.incrementalStats.affectedItems.length}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Missing periods</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{Object.keys(dataset.historySummary.incrementalStats.missingPeriodsMap).length}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Demand-Based SKU Segmentation (Runner, Repeater, Stranger) */}
      <DemandSegmentationCards
        segmentation={segmentation}
        isLoading={isSegmentationLoading}
        error={segmentationError}
        onRetry={onRetrySegmentation}
        selectedCategories={selectedCategories || ['RUNNER', 'REPEATER', 'STRANGER']}
        onSelectCategories={onSelectCategories || (() => {})}
      />

      {/* Engine Capability & Progressive Pipeline Card */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        {/* ML Tier Assessment */}
        <div className="dataset-staging-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
              Calibrated Forecasting Capability
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, color: tierInfo.badgeColor, background: tierInfo.badgeBg, padding: '2px 8px', borderRadius: 12 }}>
              {tierInfo.tier}
            </span>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '8px 0 12px 0', lineHeight: 1.55 }}>
            {tierInfo.desc}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, color: 'var(--text-secondary)', background: '#f8fafc', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle2 size={13} color="#047857" />
              <span>Target Horizon: <strong>{parameters.horizon} Months</strong> starting <strong>{parameters.startMonth}</strong></span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle2 size={13} color="#047857" />
              <span>Inventory positions: <strong>{dataset.inventory.length}</strong> warehouse records</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle2 size={13} color="#047857" />
              <span>Open Sales Orders: <strong>{dataset.openOrders.length}</strong> active commitments</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle2 size={13} color={dataset.boms.length > 0 ? "#047857" : "#94a3b8"} />
              <span>Bill of Materials (BOM): <strong>{dataset.boms.length}</strong> component linkages {dataset.boms.length === 0 ? '(Components tab locked)' : '(Components enabled)'}</span>
            </div>
          </div>
        </div>

        {/* Workflow Progression Checklist */}
        <div className="dataset-staging-card">
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
            Product Workflow Progression
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#dcfce7', color: '#15803d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                ✓
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>1. Excel Workbook Ingested & Validated</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{dataset.metadata.sourceName} · {dataset.items.length} SKUs recognized</div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#eef2ff', color: 'var(--ai-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                2
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ai-primary)' }}>2. Data Ready — Model Training (Current)</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Click below to execute feature engineering and model training</div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, opacity: 0.7 }}>
              <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#f1f5f9', color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                3
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>3. Forecast & Demand Intelligence</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Unlocks interactive grid, demand patterns, seasonality and versioning</div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, opacity: 0.7 }}>
              <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#f1f5f9', color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                4
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>4. Accuracy & MRP Net Requirements</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Calculates WAPE accuracy when actuals exist, plus BOM component explosion</div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button
              type="button"
              className="btn-ghost"
              onClick={onOpenImport}
              style={{ fontSize: 11 }}
            >
              <RefreshCw size={12} />
              <span>Replace / Merge Another File</span>
            </button>

            <button
              type="button"
              className="btn-ai"
              onClick={onTrainAndGenerate}
              disabled={isSegmentationLoading || !segmentation || Boolean(segmentationError)}
              title={isSegmentationLoading ? 'Calculating SKU segmentation...' : undefined}
              style={{
                fontSize: 12,
                padding: '7px 16px',
                opacity: (isSegmentationLoading || !segmentation || Boolean(segmentationError)) ? 0.6 : 1,
                cursor: (isSegmentationLoading || !segmentation || Boolean(segmentationError)) ? 'not-allowed' : 'pointer'
              }}
            >
              <Sparkles size={13} />
              <span>{isSegmentationLoading ? 'Calculating Segmentation...' : 'Launch Training →'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
