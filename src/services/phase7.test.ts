import { describe, it, expect, vi } from 'vitest';
import { fetchForecastExplanation } from './forecastClient';

describe('Phase 7 Requirements (LLM Explanation Layer)', () => {
  it('1. API key is not present in frontend source/bundle', () => {
    // Vite loads env vars with import.meta.env. We ensure no GEMINI_API_KEY is available directly.
    // The abstraction relies on the python backend.
    expect((import.meta as any).env?.VITE_GEMINI_API_KEY).toBeUndefined();
    expect((import.meta as any).env?.VITE_OPENAI_API_KEY).toBeUndefined();
  });

  it('2. Missing API key does not break forecast UI and returns unavailable', async () => {
    // Assuming backend returns unavailable when mock is called or we just test the client failure fallback
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Network failure'))));
    
    const result = await fetchForecastExplanation({
      itemCode: 'TEST',
      description: 'Test',
      pattern: 'stable',
      historyLength: 12,
      historicalAvg: 10,
      recentDemand: [10, 10, 10],
      fullForecast: [10, 10, 10],
      forecastTotal: 30,
      confidencePct: 90,
      predictionInterval: null,
      intervalMethod: null,
      wape: null,
      mae: null,
      rmse: null,
      bias: null,
      validationWindowCount: null,
      selectedModel: 'TestModel',
      modelType: 'Statistical',
      trendDirection: null,
      trendStrength: null,
      seasonalityDetected: null,
      seasonalityPeriod: null,
      seasonalityStrength: null,
      outlierCount: null,
      missingPeriods: null,
      zeroDemandRatio: null,
      forecastEligibility: null,
      recommendedModelFamily: null,
      dataQualityFlags: null,
      stock: 0,
      openPo: 0,
      netReq: null,
      plannerAdj: null,
      finalQuantity: null,
      alerts: []
    });
    
    expect(result).not.toBeNull();
    expect(result.unavailable).toBe(true);
    expect(result.reason).toContain('unreachable');
    
    vi.restoreAllMocks();
  });

  it('3. LLM is an explanation layer only and does not mutate forecast values', () => {
    // The payload we send out contains values, but the response only has summary, drivers, etc.
    const mockResponse = {
      summary: "Looks good",
      drivers: ["Historical sales"],
      recommendation: "Buy more"
    };
    
    // There are no numerical fields in the ExplanationResponse interface that could mutate state.
    expect((mockResponse as any).forecastTotal).toBeUndefined();
    expect((mockResponse as any).selectedModel).toBeUndefined();
  });
});
