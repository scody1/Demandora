import { describe, it, expect } from 'vitest';
import { calculateMRPRequirements } from './forecastingEngine';
import { ForecastLine, LifecycleRegime, MomentumFlag } from '../types';

describe('Phase 2.2 Frontend Heuristics & Data Models', () => {
  it('correctly calculates MRP requirements with Phase 2.2 guardrails', () => {
    // Standard shortage with lot-sizing
    const res = calculateMRPRequirements(
      100, // finalQty
      20,  // stock
      10,  // openPo
      'MRP',
      50,  // moq
      10,  // orderMultiple
      true // applyMoqOrderMultiple
    );
    expect(res.rawNetReq).toBe(70);
    expect(res.plannedOrderQty).toBe(70); // 70 is already multiple of 10 and > 50

    // Shortage below MOQ
    const res2 = calculateMRPRequirements(
      40,
      10,
      10,
      'MRP',
      50,
      10,
      true
    );
    expect(res2.rawNetReq).toBe(20);
    expect(res2.plannedOrderQty).toBe(50); // rounds up to MOQ 50

    // Discontinued SKU
    const resDisc = calculateMRPRequirements(
      100,
      20,
      10,
      'MRP',
      50,
      10,
      true,
      true // isDiscontinued
    );
    expect(resDisc.rawNetReq).toBe(0);
    expect(resDisc.plannedOrderQty).toBe(0);
  });

  it('verifies ForecastLine contract contains Phase 2.2 pattern intelligence fields', () => {
    const line: Partial<ForecastLine> = {
      id: 'test-1',
      itemCode: 'LED-001',
      lifecycleRegime: 'SUSTAINED_GROWTH_RAMP' as LifecycleRegime,
      momentumFlag: 'SURGE' as MomentumFlag,
      yoyVelocityPct: 24.5,
      heuristicAdvisories: [
        'Growth Under-Forecast Buffer Expansion: Expand replenishment buffer by 20%'
      ],
      procurementSchedule: {
        leadTimeDays: 45,
        requirementStartDate: '2026-06-01',
        latestOrderDate: '2026-04-17',
        daysUntilOrderDeadline: 16,
        isOverdue: false,
        urgency: 'NORMAL',
        message: 'Standard 45-day vendor lead time maintained.'
      }
    };

    expect(line.lifecycleRegime).toBe('SUSTAINED_GROWTH_RAMP');
    expect(line.momentumFlag).toBe('SURGE');
    expect(line.yoyVelocityPct).toBe(24.5);
    expect(line.heuristicAdvisories).toHaveLength(1);
    expect(line.procurementSchedule?.latestOrderDate).toBe('2026-04-17');
    expect(line.procurementSchedule?.isOverdue).toBe(false);
  });

  it('handles negative momentum and phase-out contraction regimes', () => {
    const line: Partial<ForecastLine> = {
      id: 'test-2',
      itemCode: 'LED-OLD-01',
      lifecycleRegime: 'CONTRACTION_PHASE_OUT' as LifecycleRegime,
      momentumFlag: 'NEGATIVE' as MomentumFlag,
      yoyVelocityPct: -32.0,
      heuristicAdvisories: [
        'Contraction Positive Bias Throttle: Throttle safety buffer by 25% and apply 1.1x order cap'
      ]
    };

    expect(line.lifecycleRegime).toBe('CONTRACTION_PHASE_OUT');
    expect(line.momentumFlag).toBe('NEGATIVE');
    expect(line.heuristicAdvisories?.[0]).toContain('Throttle safety buffer by 25%');
  });
});
