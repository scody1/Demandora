/**
 * Python ML Forecasting Service Client.
 * Authoritative client communicating directly with the Python FastAPI service on http://127.0.0.1:8000.
 */
import { ExplanationPayload, ExplanationResponse } from '../types';

export interface PythonModelComparisonItem {
  model: string;
  modelType: string;
  eligible: boolean;
  reason: string;
  wape: number | null;
  mae: number | null;
  rmse: number | null;
  bias: number | null;
  validationWindows: number;
  validWindows: number;
  windows?: Array<{
    origin: string;
    targetPeriod: string;
    originIdx: number;
    actual: number[];
    forecast: number[];
    mae: number;
    rmse: number;
    wape: number;
    bias: number;
  }>;
}

export interface PythonForecastResult {
  itemCode: string;
  modelName: string;
  modelType: string;
  selectedModel: string;
  selectionStatus: 'SELECTED' | 'INSUFFICIENT_HISTORY' | 'COLD_START' | 'SPARSE_HISTORY' | 'USER_OVERRIDE' | 'FALLBACK' | 'DISCONTINUED_SKU';
  selectionReason: string;
  historyMonths: number;
  trainingRows: number;
  forecast: number[];
  rawForecast?: number[];
  selectedModelMetrics?: {
    wape: number;
    mae: number;
    rmse: number;
    bias: number;
    validationWindows: number;
  } | null;
  modelComparison?: PythonModelComparisonItem[];
  metadata: {
    features_used?: string[];
    training_rows?: number;
    history_months?: number;
    training_timestamp?: string;
    forecast_horizon?: number;
    clipped?: boolean;
    raw_predictions?: number[];
    history_start?: string;
    history_end?: string;
    [key: string]: any;
  };
  demandProfile?: {
    demand_pattern: string;
    trend_direction: string;
    trend_strength: number;
    seasonality_detected: boolean;
    seasonality_period: number | null;
    seasonality_strength: number;
    outlier_count: number;
    missing_periods: number;
    zero_demand_ratio: number;
    forecast_eligibility: string;
    recommended_model_family: string;
    cv_squared: number;
    average_inter_demand_interval: number;
    data_quality_flags: string[];
    [key: string]: any;
  };
  skuCategory?: string;
  skuClassification?: any;
  lifecycleRegime?: string;
  lifecycle_regime?: string;
  momentumFlag?: string;
  momentum_flag?: string;
  yoyVelocityPct?: number | null;
  yoy_velocity_pct?: number | null;
  heuristicAdvisories?: string[];
  procurement_heuristics?: any;
  eligibility: Array<{
    modelName: string;
    modelType: string;
    minRequiredHistory: number;
    isEligible: boolean;
    status: string;
    reason: string;
  }>;
  backtestWape?: number | null;
  backtestMethod?: string;
  confidencePct?: number | null;
  confidence?: {
    status: 'EVALUATED' | 'NOT_EVALUATED';
    score: number | null;
    level: 'HIGH' | 'MEDIUM' | 'LOW' | 'NOT_EVALUATED';
    intervalLevel: number;
    lowerBound: (number | null)[];
    upperBound: (number | null)[];
    method: string;
    validationObservationCount: number;
    errorSummary?: string | null;
    reasons: string[];
  };
}

export interface PythonBatchResponse {
  engine: string;
  version: string;
  horizon: number;
  startMonth: string;
  totalItemsProcessed: number;
  modelDistribution: Record<string, number>;
  telemetry?: {
    totalItems: number;
    successfulItems: number;
    processingTimeSeconds: number;
    avgProcessingTimePerSkuMs: number;
    candidateModelsEvaluated: number;
    validationWindowsCompleted: number;
    categoriesProcessed: string[];
    classificationRuleVersion: string;
  };
  results: PythonForecastResult[];
}

export interface ForecastJobStatus {
  jobId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  currentStage: string;
  completedStages: string[];
  completedItems: number;
  totalItems: number;
  currentItemCode: string | null;
  currentModel: string | null;
  elapsedSeconds: number;
  progressPercentage: number | null;
  error: string | null;
  telemetry?: any;
  allowedCategories?: string[] | null;
  result: PythonBatchResponse | null;
}

const BACKEND_URL = typeof window !== 'undefined' ? '' : 'http://127.0.0.1:8000';

async function fetchWithFallback(endpoint: string, options: RequestInit): Promise<Response> {
  const url = `${BACKEND_URL}${endpoint}`;
  try {
    return await fetch(url, options);
  } catch (err: any) {
    if (BACKEND_URL === '') {
      return await fetch(`http://127.0.0.1:8000${endpoint}`, options);
    }
    throw err;
  }
}

export async function checkPythonServiceHealth(): Promise<{ online: boolean; details?: any }> {
  try {
    const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const data = await res.json();
      return { online: true, details: data };
    }
  } catch (e) {
    if (BACKEND_URL === '') {
      try {
        const directRes = await fetch('http://127.0.0.1:8000/health', { signal: AbortSignal.timeout(2500) });
        if (directRes.ok) {
          const data = await directRes.json();
          return { online: true, details: data };
        }
      } catch (err) {}
    }
  }
  return { online: false };
}

export async function createForecastJob(
  items: Array<{ itemCode: string; history: number[]; periods?: string[]; missingPeriods?: string[]; description?: string; itemGroup?: string }>,
  horizon: number = 6,
  startMonth: string = '2026-11',
  allowedCategories?: string[],
  candidatePool?: Array<{ itemCode: string; history: number[]; periods?: string[]; missingPeriods?: string[]; description?: string; itemGroup?: string }>,
  force?: boolean
): Promise<{ jobId: string; status: string }> {
  const payload: any = { items, horizon, startMonth };
  if (allowedCategories && allowedCategories.length > 0) {
    payload.allowedCategories = allowedCategories;
  }
  if (candidatePool && candidatePool.length > 0) {
    payload.candidatePool = candidatePool;
  }
  if (force) {
    payload.force = true;
  }

  const res = await fetchWithFallback('/api/forecast/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Failed to create forecast job (${res.status}): ${errorBody || res.statusText}`);
  }
  return (await res.json()) as { jobId: string; status: string };
}

export async function getForecastJobStatus(jobId: string): Promise<ForecastJobStatus> {
  const res = await fetchWithFallback(`/api/forecast/jobs/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000)
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Failed to get forecast job status (${res.status}): ${errorBody || res.statusText}`);
  }
  return (await res.json()) as ForecastJobStatus;
}

export async function cancelForecastJob(jobId: string): Promise<{ jobId: string; status: string }> {
  const res = await fetchWithFallback(`/api/forecast/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Failed to cancel forecast job (${res.status}): ${errorBody || res.statusText}`);
  }
  return (await res.json()) as { jobId: string; status: string };
}

export async function fetchBatchForecastFromPython(
  items: Array<{ itemCode: string; history: number[]; periods?: string[]; missingPeriods?: string[]; description?: string; itemGroup?: string }>,
  horizon: number = 6,
  startMonth: string = '2026-11',
  allowedCategories?: string[],
  candidatePool?: Array<{ itemCode: string; history: number[]; periods?: string[]; missingPeriods?: string[]; description?: string; itemGroup?: string }>
): Promise<PythonBatchResponse> {
  const url = `${BACKEND_URL}/api/forecast/batch`;
  const payload: any = { items, horizon, startMonth };
  if (allowedCategories && allowedCategories.length > 0) {
    payload.allowedCategories = allowedCategories;
  }
  if (candidatePool && candidatePool.length > 0) {
    payload.candidatePool = candidatePool;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300000)
    });
  } catch (err: any) {
    if (BACKEND_URL === '') {
      res = await fetch('http://127.0.0.1:8000/api/forecast/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300000)
      });
    } else {
      throw err;
    }
  }

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Python ML Service Error (${res.status}): ${errorBody || res.statusText}`);
  }
  return (await res.json()) as PythonBatchResponse;
}

export async function fetchForecastExplanation(payload: ExplanationPayload): Promise<ExplanationResponse> {
  try {
    const url = `${BACKEND_URL}/api/forecast/explain`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000)
      });
    } catch {
      res = await fetch('http://127.0.0.1:8000/api/forecast/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000)
      });
    }
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error('Python ML service explain call failed:', e);
  }
  return {
    unavailable: true,
    reason: "AI explanation service is unreachable. Numerical forecast is fully operational."
  };
}
