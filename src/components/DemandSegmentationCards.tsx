import React, { useState } from 'react';
import {
  SKUCategory,
  SegmentationResult,
  CategorySummary,
  IllustrativeSKUExplanation
} from '../types';
import {
  Layers,
  ChevronDown,
  ChevronUp,
  Check,
  CheckCircle2,
  Info,
  TrendingUp,
  Activity,
  AlertCircle,
  AlertTriangle,
  HelpCircle,
  Zap,
  RotateCw,
  Loader2,
  RefreshCw
} from 'lucide-react';

interface DemandSegmentationCardsProps {
  segmentation?: SegmentationResult | null;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  selectedCategories: SKUCategory[];
  onSelectCategories: (categories: SKUCategory[]) => void;
  isExecuting?: boolean;
}

export function DemandSegmentationCards({
  segmentation,
  isLoading = false,
  error = null,
  onRetry,
  selectedCategories,
  onSelectCategories,
  isExecuting = false
}: DemandSegmentationCardsProps) {
  // Track expanded accordion per category independently
  const [expandedCategories, setExpandedCategories] = useState<Record<SKUCategory, boolean>>({
    RUNNER: false,
    REPEATER: false,
    STRANGER: false,
    UNCLASSIFIED: false
  });

  if (isLoading) {
    return (
      <div
        className="segmentation-section"
        style={{
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: 12,
          padding: '16px 20px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          display: 'flex',
          alignItems: 'center',
          gap: 12
        }}
      >
        <Loader2 size={18} className="spin" color="var(--ai-primary)" />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
            Calculating SKU segmentation...
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Evaluating empirical demand frequency, inter-demand interval (ADI), and variability (CV²) across items.
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="segmentation-section"
        style={{
          background: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: 12,
          padding: '16px 20px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AlertTriangle size={18} color="#dc2626" />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#991b1b' }}>
              Segmentation Calculation Failed
            </div>
            <div style={{ fontSize: 11, color: '#b91c1c' }}>
              {error}
            </div>
          </div>
        </div>
        {onRetry && (
          <button
            type="button"
            className="btn-ghost"
            onClick={onRetry}
            style={{
              fontSize: 11.5,
              padding: '5px 12px',
              background: '#ffffff',
              border: '1px solid #fca5a5',
              color: '#b91c1c',
              borderRadius: 6,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5
            }}
          >
            <RefreshCw size={12} />
            <span>Retry Segmentation</span>
          </button>
        )}
      </div>
    );
  }

  if (!segmentation) {
    return null;
  }

  const toggleAccordion = (cat: SKUCategory, e: React.MouseEvent) => {
    e.stopPropagation(); // Never trigger selection or forecast
    setExpandedCategories(prev => ({
      ...prev,
      [cat]: !prev[cat]
    }));
  };

  const toggleCategorySelection = (cat: SKUCategory) => {
    if (isExecuting) return;
    if (selectedCategories.includes(cat)) {
      // Don't deselect the last category (at least one must be selected)
      if (selectedCategories.length === 1) return;
      onSelectCategories(selectedCategories.filter(c => c !== cat));
    } else {
      onSelectCategories([...selectedCategories, cat]);
    }
  };

  const selectSingleCategory = (cat: SKUCategory, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isExecuting) return;
    onSelectCategories([cat]);
  };

  const selectAllCategories = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isExecuting) return;
    onSelectCategories(['RUNNER', 'REPEATER', 'STRANGER']);
  };

  const allEligibleSelected =
    selectedCategories.includes('RUNNER') &&
    selectedCategories.includes('REPEATER') &&
    selectedCategories.includes('STRANGER');

  // Calculate selected SKU count
  const selectedSkuCount = selectedCategories.reduce((sum, cat) => {
    return sum + (segmentation.summary[cat]?.count || 0);
  }, 0);

  const getScopeLabel = () => {
    if (allEligibleSelected) return 'All Categories';
    if (selectedCategories.length === 1) {
      if (selectedCategories[0] === 'RUNNER') return 'Runner Only';
      if (selectedCategories[0] === 'REPEATER') return 'Repeater Only';
      if (selectedCategories[0] === 'STRANGER') return 'Stranger Only';
    }
    return selectedCategories.map(c => c.charAt(0) + c.slice(1).toLowerCase()).join(' & ');
  };

  const categories: Array<{
    key: SKUCategory;
    title: string;
    theme: {
      primary: string;
      bg: string;
      border: string;
      activeBg: string;
      activeBorder: string;
      badgeBg: string;
      badgeText: string;
    };
    icon: React.ReactNode;
  }> = [
    {
      key: 'RUNNER',
      title: 'RUNNER',
      theme: {
        primary: '#059669',
        bg: '#ffffff',
        border: '#e2e8f0',
        activeBg: '#ecfdf5',
        activeBorder: '#10b981',
        badgeBg: 'rgba(16, 185, 129, 0.12)',
        badgeText: '#047857'
      },
      icon: <Zap size={18} color="#059669" />
    },
    {
      key: 'REPEATER',
      title: 'REPEATER',
      theme: {
        primary: '#2563eb',
        bg: '#ffffff',
        border: '#e2e8f0',
        activeBg: '#eff6ff',
        activeBorder: '#3b82f6',
        badgeBg: 'rgba(59, 130, 246, 0.12)',
        badgeText: '#1d4ed8'
      },
      icon: <Activity size={18} color="#2563eb" />
    },
    {
      key: 'STRANGER',
      title: 'STRANGER',
      theme: {
        primary: '#d97706',
        bg: '#ffffff',
        border: '#e2e8f0',
        activeBg: '#fffbeb',
        activeBorder: '#f59e0b',
        badgeBg: 'rgba(245, 158, 11, 0.12)',
        badgeText: '#b45309'
      },
      icon: <HelpCircle size={18} color="#d97706" />
    }
  ];

  return (
    <div
      className="segmentation-section"
      style={{
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: 12,
        padding: '16px 20px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14
      }}
    >
      {/* 1. Header Bar: Title, Rules Version, & Scope Quick Switches */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          borderBottom: '1px solid #f1f5f9',
          paddingBottom: 12
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff'
            }}
          >
            <Layers size={18} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: 0, letterSpacing: '0.3px' }}>
                DEMAND-BASED SKU SEGMENTATION
              </h3>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  background: '#f1f5f9',
                  color: '#475569',
                  padding: '2px 8px',
                  borderRadius: 12,
                  fontFamily: 'var(--font-mono)'
                }}
              >
                {segmentation.ruleVersion || 'v1.0.0-SBC'}
              </span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '2px 0 0 0' }}>
              Classifies SKUs by empirical historical demand behaviour to enable selective category forecasting.
            </p>
          </div>
        </div>

        {/* Quick Scope Selectors */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 600 }}>
            Scope:
          </span>
          <button
            type="button"
            className="btn-ghost"
            onClick={selectAllCategories}
            style={{
              fontSize: 11.5,
              padding: '4px 10px',
              borderRadius: 6,
              background: allEligibleSelected ? 'var(--ai-subtle)' : '#ffffff',
              borderColor: allEligibleSelected ? 'var(--ai-primary)' : 'var(--border-subtle)',
              color: allEligibleSelected ? 'var(--ai-primary)' : 'var(--text-secondary)',
              fontWeight: allEligibleSelected ? 700 : 500
            }}
          >
            All Categories
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={(e) => selectSingleCategory('RUNNER', e)}
            style={{
              fontSize: 11.5,
              padding: '4px 10px',
              borderRadius: 6,
              background: selectedCategories.length === 1 && selectedCategories[0] === 'RUNNER' ? 'rgba(16, 185, 129, 0.12)' : '#ffffff',
              borderColor: selectedCategories.length === 1 && selectedCategories[0] === 'RUNNER' ? '#10b981' : 'var(--border-subtle)',
              color: selectedCategories.length === 1 && selectedCategories[0] === 'RUNNER' ? '#047857' : 'var(--text-secondary)',
              fontWeight: selectedCategories.length === 1 && selectedCategories[0] === 'RUNNER' ? 700 : 500
            }}
          >
            Runner Only
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={(e) => selectSingleCategory('REPEATER', e)}
            style={{
              fontSize: 11.5,
              padding: '4px 10px',
              borderRadius: 6,
              background: selectedCategories.length === 1 && selectedCategories[0] === 'REPEATER' ? 'rgba(59, 130, 246, 0.12)' : '#ffffff',
              borderColor: selectedCategories.length === 1 && selectedCategories[0] === 'REPEATER' ? '#3b82f6' : 'var(--border-subtle)',
              color: selectedCategories.length === 1 && selectedCategories[0] === 'REPEATER' ? '#1d4ed8' : 'var(--text-secondary)',
              fontWeight: selectedCategories.length === 1 && selectedCategories[0] === 'REPEATER' ? 700 : 500
            }}
          >
            Repeater Only
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={(e) => selectSingleCategory('STRANGER', e)}
            style={{
              fontSize: 11.5,
              padding: '4px 10px',
              borderRadius: 6,
              background: selectedCategories.length === 1 && selectedCategories[0] === 'STRANGER' ? 'rgba(245, 158, 11, 0.12)' : '#ffffff',
              borderColor: selectedCategories.length === 1 && selectedCategories[0] === 'STRANGER' ? '#f59e0b' : 'var(--border-subtle)',
              color: selectedCategories.length === 1 && selectedCategories[0] === 'STRANGER' ? '#b45309' : 'var(--text-secondary)',
              fontWeight: selectedCategories.length === 1 && selectedCategories[0] === 'STRANGER' ? 700 : 500
            }}
          >
            Stranger Only
          </button>

          {/* Active Scope Summary Banner */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: '#f8fafc',
              border: '1px solid #cbd5e1',
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--text-primary)'
            }}
          >
            <span>Forecasting {getScopeLabel()}:</span>
            <span style={{ color: 'var(--ai-primary)', fontFamily: 'var(--font-mono)' }}>
              {selectedSkuCount} SKUs
            </span>
            {allEligibleSelected && (
              <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)' }}>
                (includes all classified SKUs; excludes {segmentation.summary.UNCLASSIFIED?.count ?? 0} unclassified)
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 2. The Three Category Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))',
          gap: 14,
          alignItems: 'start'
        }}
      >
        {categories.map(({ key, title, theme, icon }) => {
          const summary: CategorySummary = segmentation.summary[key] || {
            count: 0,
            percentage: 0,
            label: title,
            description: '',
            criteria: []
          };
          const isSelected = selectedCategories.includes(key);
          const isExpanded = !!expandedCategories[key];

          return (
            <div
              key={key}
              onClick={() => toggleCategorySelection(key)}
              style={{
                background: isSelected ? theme.activeBg : theme.bg,
                border: `2px solid ${isSelected ? theme.activeBorder : theme.border}`,
                borderRadius: 10,
                padding: '14px 16px',
                cursor: 'pointer',
                transition: 'all 0.15s ease-in-out',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                boxShadow: isSelected ? `0 4px 12px ${theme.badgeBg}` : '0 1px 2px rgba(0,0,0,0.03)',
                alignSelf: 'start'
              }}
            >
              {/* Card Top: Checkbox, Icon, Title, and Chevron for Accordion */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {/* Selection Checkbox */}
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 5,
                      border: `2px solid ${isSelected ? theme.primary : '#94a3b8'}`,
                      background: isSelected ? theme.primary : '#ffffff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#ffffff',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    {isSelected && <Check size={14} strokeWidth={3} />}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {icon}
                    <h4
                      style={{
                        fontSize: 15,
                        fontWeight: 800,
                        color: isSelected ? theme.primary : 'var(--text-primary)',
                        margin: 0,
                        letterSpacing: '0.4px'
                      }}
                    >
                      {title}
                    </h4>
                  </div>
                </div>

                {/* Clickable Header Accordion Toggle */}
                <button
                  type="button"
                  onClick={(e) => toggleAccordion(key, e)}
                  title="Expand classification rules and criteria"
                  style={{
                    background: isExpanded ? theme.badgeBg : 'transparent',
                    border: '1px solid transparent',
                    borderRadius: 6,
                    padding: '3px 8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 11,
                    fontWeight: 600,
                    color: isExpanded ? theme.primary : 'var(--text-secondary)',
                    cursor: 'pointer'
                  }}
                >
                  <span>Criteria</span>
                  {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>

              {/* SKU Count and Percentage Display */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span
                  style={{
                    fontSize: 28,
                    fontWeight: 900,
                    color: isSelected ? theme.primary : 'var(--text-primary)',
                    fontFamily: 'var(--font-mono)',
                    lineHeight: 1
                  }}
                >
                  {summary.count.toLocaleString()}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: theme.badgeText,
                    background: theme.badgeBg,
                    padding: '2px 8px',
                    borderRadius: 12
                  }}
                >
                  {summary.percentage}% of classified
                </span>
              </div>

              {/* Category Short Description */}
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  margin: 0,
                  lineHeight: 1.4
                }}
              >
                {summary.description}
              </p>

              {/* 3. Clickable Expandable Classification Criteria Accordion */}
              {isExpanded && (
                <div
                  onClick={(e) => e.stopPropagation()} // Prevent card toggle when interacting inside accordion
                  style={{
                    marginTop: 8,
                    paddingTop: 12,
                    borderTop: `1px solid ${theme.border}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    background: '#ffffff',
                    padding: 12,
                    borderRadius: 8,
                    border: `1px solid ${theme.border}`
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: theme.primary }}>
                      Configured Classification Criteria
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                      Rule {segmentation.ruleVersion}
                    </span>
                  </div>

                  {/* Criteria List with Actual Configured Values & Satisfied Counts */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(summary.criteria || []).map((crit, idx) => (
                      <div
                        key={idx}
                        style={{
                          background: '#f8fafc',
                          border: '1px solid #e2e8f0',
                          borderRadius: 6,
                          padding: '6px 10px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 10,
                          fontSize: 11.5
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                            {crit.condition}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                            {crit.explanation}
                          </span>
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            background: '#e2e8f0',
                            color: '#1e293b',
                            padding: '2px 6px',
                            borderRadius: 4,
                            whiteSpace: 'nowrap',
                            fontFamily: 'var(--font-mono)'
                          }}
                          title="Number of SKUs in population satisfying this specific criterion"
                        >
                          {crit.satisfiedCount} SKUs
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Illustrative Real SKU Explanation */}
                  {summary.illustrativeSku && (
                    <div
                      style={{
                        background: theme.activeBg,
                        border: `1px solid ${theme.activeBorder}`,
                        borderRadius: 6,
                        padding: '8px 10px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: theme.badgeText }}>
                          Illustrative SKU Example:
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', color: theme.primary }}>
                          {summary.illustrativeSku.itemCode}
                        </span>
                      </div>
                      <p
                        style={{
                          fontSize: 11.5,
                          color: 'var(--text-primary)',
                          margin: 0,
                          lineHeight: 1.4,
                          fontStyle: 'italic'
                        }}
                      >
                        "{summary.illustrativeSku.classificationReason}"
                      </p>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                        <span className="badge-pill" style={{ fontSize: 10, background: '#ffffff', color: '#475569' }}>
                          ADI: {summary.illustrativeSku.adi}
                        </span>
                        <span className="badge-pill" style={{ fontSize: 10, background: '#ffffff', color: '#475569' }}>
                          CV²: {summary.illustrativeSku.cvSquared}
                        </span>
                        <span className="badge-pill" style={{ fontSize: 10, background: '#ffffff', color: '#475569' }}>
                          Active: {summary.illustrativeSku.activeMonths}M ({summary.illustrativeSku.demandFrequency}%)
                        </span>
                        <span className="badge-pill" style={{ fontSize: 10, background: '#ffffff', color: '#475569' }}>
                          History: {summary.illustrativeSku.historyLength}M
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* UNCLASSIFIED Pill & Explicit Scope Explanation */}
      <div
        style={{
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 8,
          fontSize: 12,
          color: 'var(--text-secondary)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Info size={15} color="#64748b" style={{ flexShrink: 0 }} />
          <span>
            <strong>{segmentation.summary.UNCLASSIFIED?.count ?? 0} Unclassified SKU(s)</strong> (0 lifetime sales records). Selecting all categories forecasts all classified SKUs (Runner, Repeater, Stranger) and excludes UNCLASSIFIED SKUs from forecasting.
          </span>
        </div>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', flexShrink: 0 }}>
          Preserved in dataset · Not converted to Stranger · Excluded from forecast
        </span>
      </div>
    </div>
  );
}
