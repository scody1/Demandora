export type UserRole = 'PLANNER' | 'PURCHASE_MANAGER' | 'APPROVER' | 'ADMINISTRATOR';

export type ForecastStatus = 
  | 'Draft' 
  | 'Generated' 
  | 'Submitted' 
  | 'Approved' 
  | 'Returned';

export type ConfidenceLevel = 'High' | 'Medium' | 'Low' | 'Not evaluated';

export type PlanningMethod = 'MRP' | 'None';

export type MakeBuy = 'Make' | 'Buy';

// ============================================================
// NORMALIZED DATA MODELS (Derived from Excel Ingestion)
// ============================================================

export interface Item {
  itemCode: string;
  description: string;
  itemGroup: string;
  uom: string;
  leadTimeDays: number | null;
  moq: number;
  orderMultiple: number;
  planningMethod: PlanningMethod;
  makeBuy: MakeBuy;
  defaultVendor: string;
  isDiscontinued?: boolean;
  isNewItem?: boolean;
}

export interface SalesHistoryRecord {
  itemCode: string;
  period: string; // YYYY-MM
  quantity: number;
  channel?: string;
  orderType?: 'Regular' | 'Project' | 'Tender';
}

export interface InventoryRecord {
  itemCode: string;
  warehouse: string;
  onHandStock: number;
  safetyStock?: number;
}

export interface OpenOrderRecord {
  orderId: string;
  itemCode: string;
  type: 'PO' | 'SO'; // PO = supply, SO = firm demand
  quantity: number;
  dueDate?: string;
  warehouse?: string;
}

export interface BOMRecord {
  parentItemCode: string;
  componentCode: string;
  componentName: string;
  qtyPerUnit: number;
  uom: string;
  currentStock?: number;
  openPo?: number;
  leadTimeDays?: number;
}

export interface AccuracyRecord {
  itemCode: string;
  description: string;
  itemGroup: string;
  month: string;
  forecast: number;
  actual: number;
  variance: number;
  wape: number;
}

export interface DetectedColumnMapping {
  sheetName: string;
  excelColumn: string;
  mappedField: string;
  sampleValue: string;
  status: 'matched' | 'unmapped' | 'optional';
}

export interface DatasetHistorySummary {
  earliestPeriod: string;
  latestPeriod: string;
  totalMonths: number;
  totalObservations: number;
  itemsWithHistory: number;
  itemHistoryMap: Record<string, number>;
  incrementalStats?: {
    newObservations: number;
    unchangedObservations: number;
    updatedObservations: number;
    duplicatesIgnored: number;
    conflictingObservations: number;
    invalidObservations: number;
    previousTotalMonths: number;
    affectedItems: string[];
    missingPeriodsMap: Record<string, string[]>;
    forecastAffectedItems?: string[];
    mrpAffectedItems?: string[];
    bomAffectedItems?: string[];
    inventoryChangesCount?: number;
    orderChangesCount?: number;
    bomChangesCount?: number;
    itemMasterChangesCount?: number;
  };
}

export interface NormalizedDataset {
  items: Item[];
  salesHistory: SalesHistoryRecord[];
  inventory: InventoryRecord[];
  openOrders: OpenOrderRecord[];
  boms: BOMRecord[];
  accuracyRecords?: AccuracyRecord[];
  dataVersion: number;
  historySummary: DatasetHistorySummary;
  metadata: {
    sourceName: string;
    totalRecords: number;
    sheetsDetected: string[];
    importedAt: string;
    isDemo: boolean;
  };
}

// ============================================================
// FORECASTING & DEMAND INTELLIGENCE MODELS
// ============================================================

export interface ForecastParameters {
  forecastCode: string;
  forecastName: string;
  startMonth: string; // YYYY-MM
  horizon: number; // 1-12
  itemGroups: string[];
  itemCodeFrom: string;
  itemCodeTo: string;
  warehouses: string[];
  historyPeriod: number; // Configured window (e.g. 24)
  confidenceLevel: number; // 80 | 90 | 95
  seasonality: boolean;
  treatBulkProjectSeparately: boolean;
  includeOpenSalesOrders: boolean;
  includeNewCustomers: boolean;
  applyMoqOrderMultiple: boolean;
}

export interface DemandDriver {
  label: string;
  impact: 'positive' | 'negative' | 'neutral';
  detail: string;
}

export interface ModelAlternative {
  modelName: string;
  modelType?: string;
  backtestWape: number | null;
  mae?: number | null;
  rmse?: number | null;
  bias?: number | null;
  validationWindows?: number;
  eligibility: 'Eligible' | 'Insufficient Data' | 'Not Eligible' | 'Sub-optimal';
  notes: string;
}

export interface ValidationWindowResult {
  origin: string;
  targetPeriod: string;
  originIdx: number;
  actual: number[];
  forecast: number[];
  mae: number;
  rmse: number;
  wape: number;
  bias: number;
}

export interface ItemModelDecision {
  historyMonthsAvailable: number;
  historyDateRange: string;
  selectedModel: string;
  selectionStatus?: 'SELECTED' | 'INSUFFICIENT_HISTORY' | 'COLD_START' | 'SPARSE_HISTORY' | 'USER_OVERRIDE' | 'FALLBACK' | 'DISCONTINUED_SKU';
  selectionReason?: string;
  modelTier: string;
  modelLimitation: string;
  featuresUsed: string[];
  backtestWape: number | null;
  mae?: number | null;
  rmse?: number | null;
  bias?: number | null;
  validationWindows?: number;
  backtestMethod: string;
  alternatives: ModelAlternative[];
  trainingObservationsCount: number;
  windows?: ValidationWindowResult[];
}

export interface ConfidenceBlock {
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
  components?: {
    accuracy: number;
    bias: number;
    interval: number;
    stability: number;
    validationSufficiency: number;
  };
  metrics?: {
    wape: number;
    bias: number;
    intervalWidthRatio: number;
    validationWindows: number;
  };
}

export interface ItemDemandSignal {
  itemCode: string;
  signalHeadline: string;
  signalTone: 'strong-growth' | 'moderate-growth' | 'stable' | 'volatile' | 'declining';
  confidencePct: number | null;
  confidenceBlock?: ConfidenceBlock;
  drivers: DemandDriver[];
  seasonalityFactor: number;
  velocityTrendPct: number;
  anomalies: string[];
  aiRecommendation: string;
  modelDecision: ItemModelDecision;
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
}

export interface ForecastLine {
  id: string;
  itemCode: string;
  description: string;
  uom: string;
  itemGroup: string;
  avgPerMonth: number;
  monthlyForecast: number[];
  aiTotal: number;
  plannerAdj: number | null;
  finalQty: number;
  stock: number | null;
  openPo: number | null;
  openSo: number | null;
  rawNetReq: number | null; // Raw shortage before lot-sizing: MAX(0, finalQty - stock - openPo)
  plannedOrderQty: number | null; // Recommended procurement quantity after applying MOQ and Order Multiple
  netReq: number | null; // Planned order procurement quantity (null if planningMethod === 'None')
  confidencePct: number | null;
  confidence: ConfidenceLevel;
  confidenceBlock?: ConfidenceBlock;
  remark: string;
  isModified: boolean;
  planningMethod: PlanningMethod;
  makeBuy: MakeBuy;
  leadTimeDays: number | null;
  moq: number;
  orderMultiple: number;
  defaultVendor: string;
  hasHistoryIssue?: boolean;
  isDiscontinued?: boolean;
  isNewItem?: boolean;
  // Historical data for trend & analytics
  historyAvailableMonths: number;
  historyDateRange: string;
  historyPeriods: string[];
  historyValues: number[];
  actualSalesLastYear: number;
  demandSignal: ItemDemandSignal;
  modelDecision: ItemModelDecision;
  // Demand-Based SKU Segmentation
  category?: SKUCategory;
  classificationReason?: string;
  // Phase 2.2: Pattern Intelligence & Procurement Guardrails
  lifecycleRegime?: LifecycleRegime;
  momentumFlag?: MomentumFlag;
  yoyVelocityPct?: number | null;
  heuristicAdvisories?: string[];
  procurementSchedule?: ProcurementSchedule;
}

export type LifecycleRegime = 'CONTRACTION_PHASE_OUT' | 'SUSTAINED_GROWTH_RAMP' | 'INTERMITTENT_LUMPY' | 'STABLE_STATIONARY' | 'INSUFFICIENT_HISTORY';

export type MomentumFlag = 'NEGATIVE' | 'SURGE' | 'NEUTRAL';

export interface ProcurementSchedule {
  leadTimeDays: number | null;
  requirementStartDate: string | null;
  latestOrderDate: string | null;
  daysUntilOrderDeadline: number | null;
  isOverdue: boolean;
  urgency: 'OVERDUE' | 'IMMINENT' | 'NORMAL' | 'NO_LEAD_TIME';
  message: string;
}

export type SKUCategory = 'RUNNER' | 'REPEATER' | 'STRANGER' | 'UNCLASSIFIED';

export interface ClassificationCriterion {
  condition: string;
  explanation: string;
  satisfiedCount: number;
}

export interface IllustrativeSKUExplanation {
  itemCode: string;
  description: string;
  itemGroup?: string;
  category: SKUCategory;
  classificationReason: string;
  demandFrequency: number;
  activeMonths: number;
  zeroDemandMonths: number;
  averageMonthlyDemand: number;
  cv: number;
  cvSquared: number;
  adi: number;
  historyLength: number;
  ruleVersion: string;
  _rawAdi?: number;
  _rawCvSquared?: number;
}

export interface CategorySummary {
  count: number;
  percentage: number;
  label: string;
  description: string;
  criteria?: ClassificationCriterion[];
  illustrativeSku?: IllustrativeSKUExplanation | null;
}

export interface SegmentationConfig {
  version: string;
  adi_threshold: number;
  cv2_threshold: number;
  min_history_months: number;
  runner_min_active_ratio: number;
  runner_min_active_months: number;
  repeater_min_active_months: number;
  stranger_min_zero_ratio: number;
  [key: string]: any;
}

export interface SegmentationResult {
  ruleVersion: string;
  totalSKUs: number;
  eligibleSKUs: number;
  config: SegmentationConfig;
  summary: {
    RUNNER: CategorySummary;
    REPEATER: CategorySummary;
    STRANGER: CategorySummary;
    UNCLASSIFIED: CategorySummary;
  };
  items: IllustrativeSKUExplanation[];
}

export interface AlertItem {
  id: string;
  title: string;
  description: string;
  severity: 'Information' | 'Warning' | 'Critical';
  count: number;
  filterType: 'low-confidence' | 'no-history' | 'large-variance' | 'large-adj' | 'shortage' | 'inactive';
  itemCodes: string[];
}

export interface AdjustmentLog {
  id: string;
  itemCode: string;
  description: string;
  oldValue: number;
  newValue: number;
  user: string;
  date: string;
  remark: string;
}

export interface ComponentRequirementRow {
  id: string;
  parentItemCode: string;
  parentDescription: string;
  componentCode: string;
  componentName: string;
  qtyPerUnit: number;
  requiredQty: number;
  stock: number;
  openPo: number;
  shortage: number;
  month: string;
  uom: string;
  level?: number;
}

export interface ForecastVersion {
  version: number;
  date: string;
  user: string;
  parameters: ForecastParameters;
  status: ForecastStatus;
  adjustmentsCount: number;
  aiTotal: number;
  finalQty: number;
  rawNetReqTotal?: number;
  plannedOrderTotal?: number;
  netReqTotal: number;
  avgConfidencePct: number | null;
  linesSnapshot: ForecastLine[];
  datasetVersion?: number;
  datasetName?: string;
}

export interface MRPRecommendation {
  itemCode: string;
  description: string;
  type: 'PR' | 'PO' | 'Production Order';
  qty: number;
  uom: string;
  requiredDate: string;
  vendorOrShop: string;
  leadTimeDays: number;
  reason: string;
}

export interface ForecastResult {
  lines: ForecastLine[];
  kpis: {
    totalItems: number;
    aiForecastTotal: number;
    finalQtyTotal: number;
    rawNetRequirementTotal?: number;
    plannedOrderTotal?: number;
    netRequirementTotal: number;
    avgConfidencePct: number | null;
    baselineGrowthPct: number;
    adjustmentsCount: number;
    lowConfidenceCount: number;
    shortagesCount: number;
    wapePct: number | null; // null if no benchmark data
    wapeStatus: 'Calculated' | 'Not Available';
    availableHistoryMonths: number;
    historyDateSpan: string;
    modelReadinessTier: string;
    modelReadinessDescription: string;
  };
  alerts: AlertItem[];
  parameters?: ForecastParameters;
}

export interface ExplanationPayload {
  itemCode: string;
  description: string;
  pattern: string;
  historyLength: number;
  historicalAvg: number;
  recentDemand: number[];
  fullForecast: number[];
  forecastTotal: number;
  confidencePct: number | null;
  predictionInterval: { lower: number; upper: number } | null;
  intervalMethod: string | null;
  wape: number | null;
  mae: number | null;
  rmse: number | null;
  bias: number | null;
  validationWindowCount: number | null;
  selectedModel: string;
  modelType: string;
  trendDirection: string | null;
  trendStrength: number | null;
  seasonalityDetected: boolean | null;
  seasonalityPeriod: number | null;
  seasonalityStrength: number | null;
  outlierCount: number | null;
  missingPeriods: number | null;
  zeroDemandRatio: number | null;
  forecastEligibility: string | null;
  recommendedModelFamily: string | null;
  dataQualityFlags: string[] | null;
  stock: number | null;
  openPo: number | null;
  netReq: number | null;
  plannerAdj: number | null;
  finalQuantity: number | null;
  alerts: string[];
}

export interface ExplanationResponse {
  summary?: string;
  drivers?: string[];
  risk?: string;
  plannerAttention?: string;
  recommendation?: string;
  unavailable?: boolean;
  reason?: string;
}
