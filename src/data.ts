import { ForecastParameters, NormalizedDataset } from './types';

/**
 * Creates dynamic default parameters tailored to the imported dataset.
 * Extracts categories, warehouses, and horizon periods directly from Excel data.
 */
export function createDefaultParameters(dataset?: NormalizedDataset | null): ForecastParameters {
  const currentYear = new Date().getFullYear();

  // If no dataset provided, provide generic clean defaults
  if (!dataset || dataset.items.length === 0) {
    return {
      forecastCode: `FC-${currentYear}-0001`,
      forecastName: 'Multi-Period Demand Forecast',
      startMonth: `${currentYear}-11`,
      horizon: 6,
      itemGroups: [],
      itemCodeFrom: '',
      itemCodeTo: '',
      warehouses: [],
      historyPeriod: 24,
      confidenceLevel: 90,
      seasonality: true,
      treatBulkProjectSeparately: true,
      includeOpenSalesOrders: true,
      includeNewCustomers: true,
      applyMoqOrderMultiple: true,
    };
  }

  // Extract unique item groups from dataset
  const uniqueGroups = Array.from(new Set(dataset.items.map(i => i.itemGroup).filter(Boolean))).sort();

  // Extract unique warehouses from inventory
  const uniqueWarehouses = Array.from(new Set(dataset.inventory.map(i => i.warehouse).filter(Boolean))).sort();

  // Extract start month from latest sales history period
  let nextStartMonth = `${currentYear}-11`;
  if (dataset.salesHistory.length > 0) {
    const periods = dataset.salesHistory.map(s => s.period).filter(Boolean).sort();
    const latestPeriod = periods[periods.length - 1]; // e.g. "2026-10"
    if (latestPeriod && latestPeriod.includes('-')) {
      const [yStr, mStr] = latestPeriod.split('-');
      let y = parseInt(yStr, 10);
      let m = parseInt(mStr, 10) + 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
      nextStartMonth = `${y}-${m.toString().padStart(2, '0')}`;
    }
  }

  const sortedSkus = dataset.items.map(i => i.itemCode).sort();

  return {
    forecastCode: `FC-${currentYear}-0001`,
    forecastName: `MRP Demand Forecast (${dataset.metadata.sourceName.replace('.xlsx', '')})`,
    startMonth: nextStartMonth,
    horizon: 6,
    itemGroups: uniqueGroups,
    itemCodeFrom: sortedSkus[0] || '',
    itemCodeTo: sortedSkus[sortedSkus.length - 1] || '',
    warehouses: uniqueWarehouses,
    historyPeriod: 24,
    confidenceLevel: 90,
    seasonality: true,
    treatBulkProjectSeparately: true,
    includeOpenSalesOrders: true,
    includeNewCustomers: true,
    applyMoqOrderMultiple: true,
  };
}

export const DEFAULT_PARAMETERS = createDefaultParameters(null);
