/**
 * FORECASTING SERVICE CONTRACT
 * 
 * Formal TypeScript interface definitions for the decoupled machine-learning
 * and time-series forecasting service.
 * 
 * NOTE: Phase 0 Architecture Freeze.
 * These interfaces define the contract between the React application state
 * and the external/underlying forecasting engine. Do not add fake implementations.
 */

// ---------------------------------------------------------------------------
// 1. Data Profiling & Feature Engineering Types
// ---------------------------------------------------------------------------

export interface TimeSeriesObservation {
  period: string; // ISO period (e.g., 'YYYY-MM')
  value: number;
}

export interface SKUProfile {
  itemCode: string;
  totalObservations: number;
  earliestPeriod: string;
  latestPeriod: string;
  hasContinuousMonthlyIndex: boolean;
  missingPeriodsCount: number;
  zeroDemandPeriodsCount: number;
  coefficientOfVariation: number;
  adi: number; // Average Demand Interval (for intermittency categorization)
  demandType: 'smooth' | 'erratic' | 'lumpy' | 'intermittent';
  isEligibleForML: boolean;
  isEligibleForSeasonality: boolean;
}

export interface DatasetProfile {
  datasetId: string;
  totalSKUs: number;
  minHistoryLength: number;
  maxHistoryLength: number;
  medianHistoryLength: number;
  globalPeriodRange: {
    start: string;
    end: string;
    totalMonths: number;
  };
  skuProfiles: Record<string, SKUProfile>;
}

export interface FeatureMatrix {
  itemCode: string;
  periods: string[];
  featureNames: string[];
  /**
   * 2D array [sampleIndex][featureIndex] containing lags, rolling means,
   * exponential moving averages, and seasonal calendar regressors.
   */
  matrix: number[][];
  target: number[];
}

// ---------------------------------------------------------------------------
// 2. Candidate Model Specifications (Phase 1 Target Library)
// ---------------------------------------------------------------------------

export type CandidateModelType =
  | 'Naive'
  | 'Mean'
  | 'MovingAverage'
  | 'WeightedMovingAverage'
  | 'LinearTrend'
  | 'ExponentialSmoothingHolt'
  | 'GradientBoosting';

export interface ModelMetadata {
  name: CandidateModelType;
  displayName: string;
  version: string;
  family: 'baseline' | 'statistical' | 'machine-learning';
  minRequiredHistoryMonths: number;
  supportsSeasonality: boolean;
  supportsExogenousVariables: boolean;
  hyperparameters: Record<string, number | string | boolean>;
}

export interface BacktestSplit {
  trainIndices: number[];
  validationIndices: number[];
  forecastHorizon: number;
}

export interface BacktestResult {
  modelName: CandidateModelType;
  wape: number;
  mae: number;
  rmse: number;
  bias: number;
  actuals: number[];
  predictions: number[];
}

// ---------------------------------------------------------------------------
// 3. Individual Model Contract
// ---------------------------------------------------------------------------

export interface IForecastModel {
  readonly metadata: ModelMetadata;

  /**
   * Checks whether the SKU's historical depth is adequate for this model.
   */
  supportsHistoryLength(historyLength: number): boolean;

  /**
   * Fits model parameters or trains estimator on the provided feature matrix/series.
   */
  fit(series: number[], features?: FeatureMatrix): Promise<void>;

  /**
   * Generates out-of-sample forecasts for the requested horizon steps.
   */
  predict(horizon: number, futureFeatures?: FeatureMatrix): Promise<{
    pointForecast: number[];
    lowerBound80?: number[];
    upperBound80?: number[];
    lowerBound95?: number[];
    upperBound95?: number[];
  }>;

  /**
   * Evaluates performance on historical holdout partitions.
   */
  backtest(series: number[], splits: BacktestSplit[]): Promise<BacktestResult>;
}

// ---------------------------------------------------------------------------
// 4. Master Forecasting Service Contract
// ---------------------------------------------------------------------------

export interface ForecastExecutionConfig {
  horizonMonths: number;
  startMonth: string;
  historyWindowCap?: number;
  seasonalityEnabled: boolean;
  crossValidationFolds: number;
  confidenceIntervalPct: 80 | 90 | 95;
}

export interface ItemForecastOutput {
  itemCode: string;
  monthlyForecast: number[];
  predictionIntervals: {
    lower: number[];
    upper: number[];
  };
  selectedModel: {
    modelName: CandidateModelType;
    version: string;
    backtestWape: number;
    backtestMethod: string;
    trainingObservations: number;
    hyperparametersUsed: Record<string, any>;
    featureImportances?: Record<string, number>;
  };
  candidateLeaderboard: Array<{
    modelName: CandidateModelType;
    backtestWape: number | null;
    isEligible: boolean;
    reasonIfNotEligible?: string;
  }>;
  confidenceScore: number;
  demandSignals: {
    velocityTrendPct: number;
    seasonalityStrength: number;
    anomalies: string[];
    headline: string;
  };
}

export interface ServiceExecutionSummary {
  serviceVersion: string;
  executionTimeMs: number;
  datasetId: string;
  itemsProcessed: number;
  modelDistribution: Record<CandidateModelType, number>;
  portfolioWeightedWape: number | null;
}

/**
 * Top-Level Forecasting Service Interface
 * Replaces the monolithic evaluateAndForecastItem logic.
 */
export interface IForecastService {
  /**
   * Inspects incoming series continuity, missing points, and distribution characteristics.
   */
  profileDataset(observations: TimeSeriesObservation[]): Promise<DatasetProfile>;

  /**
   * Constructs lag arrays, rolling statistics, and seasonal indicators.
   */
  engineerFeatures(series: number[], periods: string[]): Promise<FeatureMatrix>;

  /**
   * Filters the model suite to candidates eligible for the SKU's historical depth.
   */
  getEligibleModels(historyLength: number): ModelMetadata[];

  /**
   * Fits an explicit candidate model on time-series history.
   */
  train(modelName: CandidateModelType, series: number[], features?: FeatureMatrix): Promise<IForecastModel>;

  /**
   * Executes walk-forward temporal cross-validation for a candidate.
   */
  backtest(modelName: CandidateModelType, series: number[], folds?: number): Promise<BacktestResult>;

  /**
   * Evaluates all eligible candidates and selects the one with minimum holdout error.
   */
  selectBestModel(
    series: number[],
    periods: string[],
    config: ForecastExecutionConfig
  ): Promise<{
    bestModel: CandidateModelType;
    leaderboard: BacktestResult[];
  }>;

  /**
   * Top-level forecast generator: runs profiling, feature generation, model selection,
   * final refit, and multi-period extrapolation.
   */
  forecast(
    skuObservations: Record<string, TimeSeriesObservation[]>,
    config: ForecastExecutionConfig
  ): Promise<{
    items: ItemForecastOutput[];
    summary: ServiceExecutionSummary;
  }>;

  /**
   * Computes out-of-sample accuracy between previously generated forecasts and actual realized demand.
   */
  evaluate(actuals: TimeSeriesObservation[], forecasts: TimeSeriesObservation[]): Promise<{
    wape: number;
    mape: number;
    bias: number;
  }>;

  /**
   * Incrementally updates models when new monthly sales data arrives.
   */
  retrain(
    existingModel: IForecastModel,
    newObservations: TimeSeriesObservation[]
  ): Promise<IForecastModel>;

  /**
   * Returns metadata and capability specifications for all models in the library.
   */
  getModelMetadata(): ModelMetadata[];
}
