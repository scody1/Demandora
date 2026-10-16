import { NormalizedDataset, ForecastResult, ForecastStatus, ForecastVersion, ForecastParameters, ForecastLine, AdjustmentLog } from '../types';

export const STORAGE_KEY = 'DEMANDORA_SUPPLY_INTEL_V1';
export const LEGACY_STORAGE_KEY = 'LEDURE_SUPPLY_INTEL_V4';

export interface AppState {
  dataset: NormalizedDataset;
  parameters: ForecastParameters;
  isForecastGenerated: boolean;
  forecastResult: ForecastResult;
  existingLines: ForecastLine[];
  status: ForecastStatus;
  version: number;
  versions?: ForecastVersion[];
  adjustmentLogs?: AdjustmentLog[];
  lastUpdated: string;
}

export const PersistenceService = {
  loadAppState(): AppState | null {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          // Backward compatibility & safety for malformed stored arrays
          if (parsed.versions && !Array.isArray(parsed.versions)) {
            parsed.versions = [];
          }
          if (parsed.adjustmentLogs && !Array.isArray(parsed.adjustmentLogs)) {
            parsed.adjustmentLogs = [];
          }
          return parsed;
        }
      }
    } catch (e) {
      console.warn('Could not restore cached AppState:', e);
    }
    return null;
  },

  saveAppState(state: Partial<AppState>): boolean {
    try {
      const existing = this.loadAppState() || {};
      const merged = { ...existing, ...state, lastUpdated: new Date().toISOString() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      return true;
    } catch (e) {
      console.warn('Could not save AppState:', e);
      return false;
    }
  },

  clearAppState() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
};

