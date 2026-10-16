import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createForecastJob,
  getForecastJobStatus,
  cancelForecastJob,
  ForecastJobStatus
} from './forecastClient';
import { ACCURATE_FORECAST_STAGES } from '../components/ForecastGenerationModal';

describe('Real Python Background Job Progress & Polling Workflow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Verifies the accurate 11 stages sequence', () => {
    expect(ACCURATE_FORECAST_STAGES).toEqual([
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
    ]);
    expect(ACCURATE_FORECAST_STAGES.length).toBe(11);
  });

  it('2. createForecastJob sends batch payload and receives job ID immediately', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jobId: 'job_abc123', status: 'QUEUED' })
    });
    vi.stubGlobal('fetch', mockFetch);

    const items = [{ itemCode: 'SKU-01', history: [10, 20, 30] }];
    const res = await createForecastJob(items, 6, '2026-11');

    expect(res.jobId).toBe('job_abc123');
    expect(res.status).toBe('QUEUED');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/forecast/jobs');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      items,
      horizon: 6,
      startMonth: '2026-11'
    });
  });

  it('3. getForecastJobStatus retrieves live backend job telemetry', async () => {
    const mockStatus: ForecastJobStatus = {
      jobId: 'job_abc123',
      status: 'RUNNING',
      currentStage: 'Training eligible candidate models',
      completedStages: [
        'Validating Excel demand history',
        'Constructing chronological features',
        'Profiling SKU demand patterns'
      ],
      completedItems: 8,
      totalItems: 27,
      currentItemCode: '29053FG',
      currentModel: 'HistGradientBoostingRegressor',
      elapsedSeconds: 24.5,
      progressPercentage: 29.6,
      error: null,
      result: null
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockStatus
    });
    vi.stubGlobal('fetch', mockFetch);

    const status = await getForecastJobStatus('job_abc123');
    expect(status.jobId).toBe('job_abc123');
    expect(status.status).toBe('RUNNING');
    expect(status.completedItems).toBe(8);
    expect(status.totalItems).toBe(27);
    expect(status.currentItemCode).toBe('29053FG');
    expect(status.currentModel).toBe('HistGradientBoostingRegressor');
    expect(status.elapsedSeconds).toBe(24.5);
    expect(status.progressPercentage).toBe(29.6);
  });

  it('4. Temporary polling failure retries safely without re-submitting forecast', async () => {
    let pollAttempts = 0;
    let createAttempts = 0;

    const mockFetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (url.includes('/api/forecast/jobs') && opts?.method === 'POST') {
        createAttempts++;
        return Promise.resolve({
          ok: true,
          json: async () => ({ jobId: 'job_safe_poll', status: 'QUEUED' })
        });
      }
      if (url.includes('/api/forecast/jobs/job_safe_poll')) {
        pollAttempts++;
        if (pollAttempts === 1) {
          // Simulate temporary network blip
          return Promise.reject(new Error('Network offline temporary blip'));
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            jobId: 'job_safe_poll',
            status: 'COMPLETED',
            currentStage: 'Calculating MRP and procurement requirements',
            completedStages: ACCURATE_FORECAST_STAGES.slice(0, 9),
            completedItems: 1,
            totalItems: 1,
            currentItemCode: 'SKU-1',
            currentModel: 'Historical Mean',
            elapsedSeconds: 1.2,
            progressPercentage: 100,
            error: null,
            result: {
              engine: 'Ledure Python ML Engine',
              version: '2.0.0',
              horizon: 6,
              startMonth: '2026-11',
              totalItemsProcessed: 1,
              modelDistribution: { 'Historical Mean': 1 },
              results: []
            }
          })
        });
      }
      return Promise.reject(new Error('Unexpected URL'));
    });
    vi.stubGlobal('fetch', mockFetch);

    // Initial creation
    const { jobId } = await createForecastJob([{ itemCode: 'SKU-1', history: [1, 2, 3] }]);
    expect(createAttempts).toBe(1);

    // Poll 1: fails
    await expect(getForecastJobStatus(jobId)).rejects.toThrow('Network offline temporary blip');
    // Forecast is NOT re-submitted!
    expect(createAttempts).toBe(1);

    // Poll 2: succeeds
    const status = await getForecastJobStatus(jobId);
    expect(status.status).toBe('COMPLETED');
    expect(createAttempts).toBe(1); // Still exactly 1 creation request
    expect(pollAttempts).toBe(2);
  });

  it('5. cancelForecastJob sends cancellation to backend', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jobId: 'job_cancel', status: 'CANCELLED' })
    });
    vi.stubGlobal('fetch', mockFetch);

    const res = await cancelForecastJob('job_cancel');
    expect(res.status).toBe('CANCELLED');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/forecast/jobs/job_cancel/cancel'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('6. Duplicate job creation prevention (409 Conflict)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () => JSON.stringify({ detail: 'A forecast job is already in progress (jobId: job_running_123).' })
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      createForecastJob([{ itemCode: 'SKU-01', history: [10, 20] }])
    ).rejects.toThrow(/already in progress/);
  });
});
