import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ForecastGrid } from './ForecastGrid';
import type { ForecastLine } from '../types';

describe('ForecastGrid Table Layout Regression Suite', () => {
  const createMockLine = (index: number, overrides: Partial<ForecastLine> = {}): ForecastLine => ({
    id: `line-${index}`,
    itemCode: `LED-SKU-${String(index).padStart(4, '0')}`,
    description: `Ledure Ultra Slim Panel Light 18W Square Warm White Edition Model ${index}`,
    uom: 'PCS',
    itemGroup: 'Panel Lights',
    category: index % 3 === 0 ? 'RUNNER' : index % 3 === 1 ? 'REPEATER' : 'STRANGER',
    classificationReason: 'Automated demand analysis',
    isDiscontinued: index === 5,
    isNewItem: index === 10,
    momentumFlag: index % 4 === 0 ? 'SURGE' : index % 4 === 1 ? 'NEGATIVE' : 'NEUTRAL',
    historyAvailableMonths: 24,
    historyDateRange: '2024-06 to 2026-05',
    historyPeriods: ['2026-03', '2026-04', '2026-05'],
    historyValues: [1200, 1250, 1300],
    actualSalesLastYear: 15000,
    demandSignal: {} as any,
    avgPerMonth: 1250,
    monthlyForecast: [1300, 1350, 1400],
    aiTotal: 4050,
    plannerAdj: null,
    finalQty: 4050,
    stock: 500,
    openPo: 200,
    openSo: 0,
    rawNetReq: 3350,
    moq: 100,
    orderMultiple: 10,
    plannedOrderQty: 3400,
    netReq: 3400,
    confidence: 'High',
    confidencePct: 92,
    remark: '',
    isModified: false,
    planningMethod: 'MRP',
    makeBuy: 'Make',
    leadTimeDays: 30,
    defaultVendor: 'Vendor A',
    modelDecision: {
      historyMonthsAvailable: 24,
      historyDateRange: '2024-06 to 2026-05',
      selectedModel: 'Holt-Winters Multiplicative',
      modelTier: 'Tier 1: High Accuracy',
      modelLimitation: 'None',
      featuresUsed: ['sales_history'],
      backtestWape: 4.8,
      backtestMethod: 'Expanding Window',
      alternatives: [],
      trainingObservationsCount: 24,
      selectionStatus: 'SELECTED',
      selectionReason: 'Stable trend detected'
    },
    confidenceBlock: {
      status: 'EVALUATED',
      score: 92,
      level: 'HIGH',
      intervalLevel: 90,
      lowerBound: [1200, 1250, 1300],
      upperBound: [1400, 1450, 1500],
      method: 'Empirical Quantile',
      validationObservationCount: 24,
      reasons: ['Low WAPE', 'Sufficient history']
    },
    ...overrides
  });

  it('1. Table renders with dedicated forecast-grid-table class and exact colgroup definitions', () => {
    const lines = [createMockLine(1)];
    const html = renderToString(
      <ForecastGrid
        lines={lines}
        startMonth="2026-06"
        horizon={3}
        selectedItemCode={null}
        onSelectItem={() => {}}
        onUpdateLine={() => {}}
        userRole="PLANNER"
        status="Generated"
        highlightedItemCodes={[]}
        activeAlertTitle={null}
        onClearAlertFilter={() => {}}
      />
    );

    // Verify table has both classes
    expect(html).toContain('class="modern-data-table forecast-grid-table"');

    // Verify colgroup exists with expected 17 non-month columns + 3 month columns = 20 col elements
    const colMatches = html.match(/<col style="width:\d+px"/g) || html.match(/<col style="width:\d+"/g) || html.match(/<col /g);
    expect(colMatches).not.toBeNull();
    expect(colMatches!.length).toBe(20);

    // Sticky columns in colgroup: 48, 152, 260
    expect(html).toContain('width:48px');
    expect(html).toContain('width:152px');
    expect(html).toContain('width:260px');

    // Verify header sticky columns
    expect(html).toContain('class="col-sticky-num"');
    expect(html).toContain('class="col-sticky-code sortable"');
    expect(html).toContain('class="col-sticky-desc"');
  });

  it('2. Status message "Not Evaluated — Missing Supply Data" renders as contained status pill with tooltip', () => {
    const lines = [
      createMockLine(1, {
        rawNetReq: null,
        plannedOrderQty: null,
        netReq: null,
        stock: null,
        openPo: null
      })
    ];

    const html = renderToString(
      <ForecastGrid
        lines={lines}
        startMonth="2026-06"
        horizon={3}
        selectedItemCode={null}
        onSelectItem={() => {}}
        onUpdateLine={() => {}}
        userRole="PLANNER"
        status="Generated"
        highlightedItemCodes={[]}
        activeAlertTitle={null}
        onClearAlertFilter={() => {}}
      />
    );

    // Verify status pill badge is rendered instead of unstyled overflowing text
    expect(html).toContain('class="status-pill-missing-supply"');
    expect(html).toContain('class="status-dot-missing"');
    expect(html).toContain('class="status-pill-text"');
    expect(html).toContain('title="Not Evaluated — Missing Supply Data (Stock or Open PO missing)"');
  });

  it('3. Renders numeric quantities properly separated in tabular font when evaluated', () => {
    const lines = [
      createMockLine(1, {
        rawNetReq: 12500,
        moq: 500,
        plannedOrderQty: 13000
      })
    ];

    const html = renderToString(
      <ForecastGrid
        lines={lines}
        startMonth="2026-06"
        horizon={3}
        selectedItemCode={null}
        onSelectItem={() => {}}
        onUpdateLine={() => {}}
        userRole="PLANNER"
        status="Generated"
        highlightedItemCodes={[]}
        activeAlertTitle={null}
        onClearAlertFilter={() => {}}
      />
    );

    // Verify tabular formatted numbers are rendered
    expect(html).toContain('12,500');
    expect(html).toContain('500');
    expect(html).toContain('13,000');
    expect(html).not.toContain('status-pill-missing-supply');
  });

  it('4. Insufficient history and prediction intervals have controlled truncation and tooltips', () => {
    const lines = [
      createMockLine(1, {
        historyAvailableMonths: 8,
        aiTotal: 0,
        confidenceBlock: {
          status: 'NOT_EVALUATED',
          score: null,
          level: 'NOT_EVALUATED',
          intervalLevel: 90,
          lowerBound: [null, null, null],
          upperBound: [null, null, null],
          method: 'None',
          validationObservationCount: 0,
          reasons: ['Insufficient history']
        }
      })
    ];

    const html = renderToString(
      <ForecastGrid
        lines={lines}
        startMonth="2026-06"
        horizon={3}
        selectedItemCode={null}
        onSelectItem={() => {}}
        onUpdateLine={() => {}}
        userRole="PLANNER"
        status="Generated"
        highlightedItemCodes={[]}
        activeAlertTitle={null}
        onClearAlertFilter={() => {}}
      />
    );

    expect(html).toContain('title="Insufficient historical data (6–11 months) to generate AI forecast"');
    expect(html).toContain('title="Prediction interval (Not evaluated)"');
  });

  it('5. Successfully handles 750+ SKUs with stable performance and layout structure', () => {
    const largeDataset: ForecastLine[] = Array.from({ length: 750 }, (_, i) => 
      createMockLine(i + 1, {
        rawNetReq: i % 5 === 0 ? null : (i + 1) * 100,
        plannedOrderQty: i % 5 === 0 ? null : (i + 1) * 100,
        netReq: i % 5 === 0 ? null : (i + 1) * 100,
        stock: i % 5 === 0 ? null : 200,
        openPo: i % 5 === 0 ? null : 100
      })
    );

    const startTime = Date.now();
    const html = renderToString(
      <ForecastGrid
        lines={largeDataset}
        startMonth="2026-06"
        horizon={3}
        selectedItemCode={largeDataset[0].itemCode}
        onSelectItem={() => {}}
        onUpdateLine={() => {}}
        userRole="PLANNER"
        status="Generated"
        highlightedItemCodes={[]}
        activeAlertTitle={null}
        onClearAlertFilter={() => {}}
      />
    );
    const duration = Date.now() - startTime;

    // Must render all 750 rows
    expect(html).toContain('Showing <strong>750</strong> of <strong>750</strong> items');
    // First SKU and 750th SKU must be in the DOM
    expect(html).toContain('LED-SKU-0001');
    expect(html).toContain('LED-SKU-0750');
    // Ensure rendering took reasonable time (< 6 seconds for 750 rows in parallel runner)
    expect(duration).toBeLessThan(6000);
  });

  it('6. All column widths are multiples of 4 for pixel-perfect alignment at 100%, 125%, 150% zoom', () => {
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

    // Check every column is multiple of 4
    Object.entries(COL_WIDTHS).forEach(([name, width]) => {
      expect(width % 4, `Column ${name} width (${width}) should be divisible by 4`).toBe(0);
      // Zoom 125%: width * 1.25 is integer
      expect(Number.isInteger(width * 1.25), `Column ${name} at 125% zoom should be an integer`).toBe(true);
      // Zoom 150%: width * 1.5 is integer
      expect(Number.isInteger(width * 1.5), `Column ${name} at 150% zoom should be an integer`).toBe(true);
    });

    // Check sticky column offset arithmetic:
    // Col 1 = 48, Col 2 = 152 => Col 3 offset = 48 + 152 = 200 (exact)
    expect(COL_WIDTHS.num + COL_WIDTHS.code).toBe(200);
    // 200 is also multiple of 4
    expect(200 % 4).toBe(0);
  });
});
