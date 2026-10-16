import * as XLSX from 'xlsx';
import {
  Item,
  SalesHistoryRecord,
  InventoryRecord,
  OpenOrderRecord,
  BOMRecord,
  AccuracyRecord,
  NormalizedDataset,
  PlanningMethod,
  MakeBuy,
  DetectedColumnMapping,
  DatasetHistorySummary,
  ForecastLine,
  ForecastParameters,
  ForecastStatus
} from '../types';

export interface IngestionResult {
  success: boolean;
  dataset: NormalizedDataset | null;
  errors: string[];
  warnings: string[];
  detectedMappings: DetectedColumnMapping[];
  stats: {
    itemsCount: number;
    salesRecordsCount: number;
    inventoryCount: number;
    openOrdersCount: number;
    bomsCount: number;
    accuracyRecordsCount: number;
    detectedSheets: string[];
    historyMonthsSpan: number;
    conflictingObservations?: number;
    invalidObservations?: number;
  };
}

// Normalized fuzzy match column header finder with exact match preference
function findColumnKey(row: Record<string, any>, candidateAliases: string[]): string | null {
  const keys = Object.keys(row);
  const cleanKeys = keys.map(k => ({
    original: k,
    clean: k.toLowerCase().replace(/[^a-z0-9]/g, '')
  }));

  // Pass 1: Exact matches against candidate aliases
  for (const alias of candidateAliases) {
    const cleanAlias = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const item of cleanKeys) {
      if (item.clean === cleanAlias) {
        return item.original;
      }
    }
  }

  // Pass 2: Prefix / Substring matches
  for (const alias of candidateAliases) {
    const cleanAlias = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const item of cleanKeys) {
      if (item.clean.startsWith(cleanAlias) || item.clean.includes(cleanAlias)) {
        return item.original;
      }
    }
  }
  return null;
}

function parseNumber(val: any, fallback: number = 0): number {
  if (val === null || val === undefined || val === '') return fallback;
  const num = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
  return isNaN(num) ? fallback : num;
}

function parsePeriodFromColumn(col: string): string | null {
  if (!col) return null;
  const str = String(col).trim();
  if (/^\d{4}-\d{2}$/.test(str)) return str;
  
  // Excel date serial number e.g. 46082 -> 2026-03
  const num = Number(str);
  if (!isNaN(num) && num > 30000 && num < 60000) {
    const d = new Date(Math.round((num - 25569) * 86400 * 1000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  // Month names followed by 2 or 4 digit year e.g. Jan-26, Jan 2026, January 2026, Sales Mar-26
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  for (let i = 0; i < monthNames.length; i++) {
    const mName = monthNames[i];
    const regex = new RegExp(`(?:^|[^a-zA-Z])${mName}[a-z]*[^a-zA-Z0-9]*([0-9]{2,4})`, 'i');
    const match = str.match(regex);
    if (match) {
      let yr = parseInt(match[1], 10);
      if (yr < 100) yr += 2000;
      return `${yr}-${String(i + 1).padStart(2, '0')}`;
    }
  }

  // ISO or Delimited year-month e.g. 2026-04-01, 2026/04, 2026_04
  const ym = str.match(/(?:^|[^0-9])(20\d{2})[-_\/.](0[1-9]|1[0-2])(?=[^0-9]|$)/);
  if (ym) {
    return `${ym[1]}-${ym[2]}`;
  }

  // Month-first delimited e.g. 04/2026, 04-2026
  const my = str.match(/(?:^|[^0-9])(0[1-9]|1[0-2])[-_\/.](20\d{2})(?=[^0-9]|$)/);
  if (my) {
    return `${my[2]}-${my[1]}`;
  }

  // Native Date parsing fallback
  if (/^\d{1,2}[\/\-]\d{2,4}$/.test(str) || /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(str)) {
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
    }
  }
  
  return null;
}

/**
 * Parses any uploaded .xlsx ArrayBuffer or binary data,
 * intelligently detects sheets and fuzzy column headers,
 * records column mappings, validates constraints, and returns a clean NormalizedDataset.
 */
export function parseExcelWorkbook(
  data: ArrayBuffer | Uint8Array,
  fileName: string = 'imported_data.xlsx',
  isDemo: boolean = false
): IngestionResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const detectedMappings: DetectedColumnMapping[] = [];

  let totalMonths = 0;
  let conflictingCount = 0;
  let invalidCount = 0;

  try {
    const workbook = XLSX.read(data, { type: 'array' });
    const sheetNames = workbook.SheetNames;

    if (!sheetNames || sheetNames.length === 0) {
      return {
        success: false,
        dataset: null,
        errors: ['Uploaded Excel workbook contains no readable sheets.'],
        warnings: [],
        detectedMappings: [],
        stats: {
          itemsCount: 0,
          salesRecordsCount: 0,
          inventoryCount: 0,
          openOrdersCount: 0,
          bomsCount: 0,
          accuracyRecordsCount: 0,
          detectedSheets: [],
          historyMonthsSpan: 0
        }
      };
    }

    // Helper to safely extract rows from a sheet with banner/title row skipping and smart header finding
    const extractSheetRows = (sheet: any): Record<string, any>[] => {
      if (!sheet) return [];
      let rows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (rows.length === 0) return [];

      const sample = rows[0];
      const keys = Object.keys(sample);
      const isBannerRow = keys.some(k => k.startsWith('__EMPTY')) || !keys.some(k => {
        const lk = k.toLowerCase().replace(/[^a-z0-9]/g, '');
        return lk.includes('code') || lk.includes('sku') || lk.includes('item') || lk.includes('product') || lk.includes('part') || lk.includes('desc') || lk.includes('material') || lk.includes('sale') || lk.includes('qty');
      });

      if (isBannerRow) {
        const rawAoa = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: '' });
        const keywords = ['code', 'sku', 'item', 'part', 'product', 'material', 'desc', 'name', 'group', 'category', 'qty', 'sales', 'demand', 'stock', 'inventory', 'date', 'month', 'period', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        
        let bestRowIdx = -1;
        let bestScore = -1;
        for (let r = 0; r < Math.min(rawAoa.length, 25); r++) {
          const row = rawAoa[r];
          if (!Array.isArray(row)) continue;
          let score = 0;
          for (let c = 0; c < row.length; c++) {
            const val = String(row[c] || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
            if (val && keywords.some(k => val.includes(k))) score += 2;
          }
          if (score > bestScore && score >= 2) {
            bestScore = score;
            bestRowIdx = r;
          }
        }

        if (bestRowIdx >= 0) {
          const headerRow = rawAoa[bestRowIdx] || [];
          const customHeaders = headerRow.map((h, i) => String(h || '').trim() || `__COL_${i}`);
          const customRows: Record<string, any>[] = [];
          for (let nextR = bestRowIdx + 1; nextR < rawAoa.length; nextR++) {
            const dataRow = rawAoa[nextR];
            if (!Array.isArray(dataRow) || dataRow.every(v => v === '' || v === null || v === undefined)) continue;
            const obj: Record<string, any> = {};
            for (let c = 0; c < customHeaders.length; c++) {
              obj[customHeaders[c]] = dataRow[c] !== undefined ? dataRow[c] : '';
            }
            customRows.push(obj);
          }
          if (customRows.length > 0) {
            return customRows;
          }
        }
      }
      return rows;
    };

    // Identify sheets by semantic names
    const getSheetByName = (aliases: string[]) => {
      for (const alias of aliases) {
        const found = sheetNames.find(s => s.toLowerCase().includes(alias.toLowerCase()));
        if (found) return { sheet: workbook.Sheets[found], name: found };
      }
      return null;
    };

    const itemsSheetObj = getSheetByName(['item', 'product', 'master', 'sku']) || { sheet: workbook.Sheets[sheetNames[0]], name: sheetNames[0] };
    const salesSheetObj = getSheetByName(['sale', 'history', 'actual', 'demand', 'transaction']);
    const inventorySheetObj = getSheetByName(['inventory', 'stock', 'warehouse', 'onhand']);
    const ordersSheetObj = getSheetByName(['order', 'open', 'po', 'so', 'supply']);
    const bomSheetObj = getSheetByName(['bom', 'bill', 'component', 'structure']);
    const accuracySheetObj = getSheetByName(['accuracy', 'benchmark', 'wape', 'model', 'forecastvsactual']);

    // 1. Parse Items
    const rawItems: Record<string, any>[] = extractSheetRows(itemsSheetObj.sheet);
    if (rawItems.length === 0) {
      errors.push('No item master records found in the workbook.');
    }

    const items: Item[] = [];
    const itemMap = new Set<string>();

    if (rawItems.length > 0) {
      const sample = rawItems[0];
      const codeKey = findColumnKey(sample, ['itemcode', 'item code', 'sku', 'code', 'product code', 'material', 'part number', 'part no', 'part', 'part#', 'item #', 'item id', 'product id', 'article', 'item']);
      const descKey = findColumnKey(sample, ['description', 'item description', 'product name', 'item name', 'name', 'product', 'title', 'desc']);
      const groupKey = findColumnKey(sample, ['itemgroup', 'item group', 'category', 'group', 'family', 'series', 'product line', 'class']);
      const uomKey = findColumnKey(sample, ['uom', 'unit', 'unit of measure']);

      if (codeKey) detectedMappings.push({ sheetName: itemsSheetObj.name, excelColumn: codeKey, mappedField: 'Item Code', sampleValue: String(sample[codeKey] || ''), status: 'matched' });
      if (descKey) detectedMappings.push({ sheetName: itemsSheetObj.name, excelColumn: descKey, mappedField: 'Item Description', sampleValue: String(sample[descKey] || ''), status: 'matched' });
      if (groupKey) detectedMappings.push({ sheetName: itemsSheetObj.name, excelColumn: groupKey, mappedField: 'Item Group', sampleValue: String(sample[groupKey] || ''), status: 'matched' });
      if (uomKey) detectedMappings.push({ sheetName: itemsSheetObj.name, excelColumn: uomKey, mappedField: 'UoM', sampleValue: String(sample[uomKey] || ''), status: 'matched' });
    }

    for (let i = 0; i < rawItems.length; i++) {
      const row = rawItems[i];
      let codeKey = findColumnKey(row, ['itemcode', 'item code', 'sku', 'code', 'product code', 'material', 'part number', 'part no', 'part', 'part#', 'item #', 'item id', 'product id', 'article', 'item']);
      // Fallback: If no recognized header, try first non-empty column
      if (!codeKey) {
        const rowKeys = Object.keys(row);
        if (rowKeys.length > 0 && row[rowKeys[0]]) {
          codeKey = rowKeys[0];
        }
      }
      const descKey = findColumnKey(row, ['description', 'item description', 'product name', 'item name', 'name', 'product', 'title', 'desc']);
      
      if (!codeKey || !row[codeKey]) {
        if (i < 3) warnings.push(`Row ${i + 2}: Missing Item Code. Row skipped.`);
        continue;
      }

      const itemCode = String(row[codeKey]).trim().toUpperCase();
      if (itemMap.has(itemCode)) continue;
      itemMap.add(itemCode);

      const description = descKey && row[descKey] ? String(row[descKey]).trim() : itemCode;
      
      const groupKey = findColumnKey(row, ['itemgroup', 'item group', 'category', 'group', 'family']);
      const uomKey = findColumnKey(row, ['uom', 'unit', 'unit of measure']);
      const leadKey = findColumnKey(row, ['leadtime', 'lead time', 'lead time days', 'lt days']);
      const moqKey = findColumnKey(row, ['moq', 'minimum order qty', 'min order']);
      const multKey = findColumnKey(row, ['ordermultiple', 'order multiple', 'multiple', 'pack size']);
      const planKey = findColumnKey(row, ['planningmethod', 'planning method', 'method', 'mrp']);
      const makeBuyKey = findColumnKey(row, ['makebuy', 'make/buy', 'make buy', 'procurement type', 'type']);
      const vendorKey = findColumnKey(row, ['defaultvendor', 'vendor', 'supplier', 'source']);
      const discKey = findColumnKey(row, ['discontinued', 'isdiscontinued', 'status', 'phaseout']);
      const newKey = findColumnKey(row, ['newitem', 'isnew', 'isnewitem']);

      const planningMethodStr = planKey ? String(row[planKey]).toUpperCase() : '';
      const planningMethod: PlanningMethod = planningMethodStr.includes('NONE') || planningMethodStr.includes('NO') ? 'None' : 'MRP';

      const makeBuyStr = makeBuyKey ? String(row[makeBuyKey]).toUpperCase() : '';
      const makeBuy: MakeBuy = makeBuyStr.includes('BUY') || makeBuyStr.includes('PROCURE') ? 'Buy' : 'Make';

      const statusStr = discKey ? String(row[discKey]).toLowerCase() : '';
      const isDiscontinued = statusStr.includes('disc') || statusStr.includes('inactive') || statusStr.includes('phase');
      const isNewItem = newKey ? String(row[newKey]).toLowerCase().includes('true') || String(row[newKey]).toLowerCase().includes('yes') : false;

      items.push({
        itemCode,
        description,
        itemGroup: groupKey && row[groupKey] ? String(row[groupKey]).trim() : 'General Lighting',
        uom: uomKey && row[uomKey] ? String(row[uomKey]).trim().toUpperCase() : 'PCS',
        leadTimeDays: leadKey && row[leadKey] !== undefined && row[leadKey] !== '' ? parseNumber(row[leadKey], NaN) : null,
        moq: moqKey && row[moqKey] !== undefined && row[moqKey] !== '' ? parseNumber(row[moqKey], 500) : 500,
        orderMultiple: multKey && row[multKey] !== undefined && row[multKey] !== '' ? parseNumber(row[multKey], 1) : 1,
        planningMethod,
        makeBuy,
        defaultVendor: vendorKey && row[vendorKey] ? String(row[vendorKey]).trim() : (makeBuy === 'Make' ? 'Ledure Manufacturing Plant' : 'Approved Lighting Vendor'),
        isDiscontinued,
        isNewItem
      });
    }

    if (items.length === 0) {
      errors.push('Failed to parse any valid Item records. Please ensure sheet includes "Item Code" and "Description".');
    } else {
      const missingLeadTime = items.filter(i => i.leadTimeDays === null || isNaN(i.leadTimeDays)).length;
      if (missingLeadTime > 0) {
        warnings.push(`DATA QUALITY: ${missingLeadTime} items are missing Lead Time. Lead time is unavailable for these items and will not be artificially fabricated.`);
      }
    }

    // 2. Parse Sales History
    const salesHistory: SalesHistoryRecord[] = [];
    const detectedPeriods = new Set<string>();

    if (salesSheetObj) {
      const rawSales: Record<string, any>[] = extractSheetRows(salesSheetObj.sheet);
      if (rawSales.length > 0) {
        const sample = rawSales[0];
        const codeKey = findColumnKey(sample, ['itemcode', 'item code', 'sku', 'code']);
        const periodKey = findColumnKey(sample, ['period', 'month', 'date', 'yearmonth', 'year-month']);
        const qtyKey = findColumnKey(sample, ['qty', 'quantity', 'sales', 'salesqty', 'actual']);
        const statusKey = findColumnKey(sample, ['status', 'iscancelled', 'cancelled', 'return', 'isreturn', 'documentstatus']);
        
        if (codeKey) detectedMappings.push({ sheetName: salesSheetObj.name, excelColumn: codeKey, mappedField: 'Sales SKU Code', sampleValue: String(sample[codeKey] || ''), status: 'matched' });
        if (periodKey) detectedMappings.push({ sheetName: salesSheetObj.name, excelColumn: periodKey, mappedField: 'Demand Period (YYYY-MM)', sampleValue: String(sample[periodKey] || ''), status: 'matched' });
        if (qtyKey) detectedMappings.push({ sheetName: salesSheetObj.name, excelColumn: qtyKey, mappedField: 'Demand Invoiced Qty', sampleValue: String(sample[qtyKey] || ''), status: 'matched' });
        
        if (statusKey) {
           detectedMappings.push({ sheetName: salesSheetObj.name, excelColumn: statusKey, mappedField: 'Document Status', sampleValue: String(sample[statusKey] || ''), status: 'matched' });
        } else {
           warnings.push('SOURCE QUALITY LIMITATION: No status or cancellation column found in sales history. Cannot automatically filter cancelled documents or returns.');
        }
      }

      const rowSalesMap = new Map<string, number>();

      for (const row of rawSales) {
        const codeKey = findColumnKey(row, ['itemcode', 'item code', 'sku', 'code']);
        const periodKey = findColumnKey(row, ['period', 'month', 'date', 'yearmonth', 'year-month']);
        const qtyKey = findColumnKey(row, ['qty', 'quantity', 'sales', 'salesqty', 'invoicedqty', 'actual']);
        const statusKey = findColumnKey(row, ['status', 'iscancelled', 'cancelled', 'return', 'isreturn', 'documentstatus']);

        if (codeKey && periodKey && qtyKey && row[codeKey]) {
          const itemCode = String(row[codeKey]).trim().toUpperCase();
          const period = String(row[periodKey]).trim();
          const qtyVal = row[qtyKey];
          
          if (statusKey) {
             const stat = String(row[statusKey]).toLowerCase();
             if (stat.includes('cancel') || stat.includes('return') || stat.includes('invalid') || stat.includes('rejected')) {
                 continue; // Source Document Quality: Exclude cancelled or returned items
             }
          }

          if (qtyVal === '' || qtyVal === null || qtyVal === undefined) {
            continue; // Skip missing period
          }

          const parsed = parseNumber(qtyVal, NaN);
          if (isNaN(parsed)) {
            invalidCount++;
            continue;
          }
          const quantity = parsed;

          if (period) {
            const orderType = String(row['OrderType'] || row['Order Type'] || 'Regular').includes('Project') ? 'Project' : 'Regular';
            const key = `${itemCode}__${period}__${orderType}`;
            
            if (rowSalesMap.has(key)) {
              if (rowSalesMap.get(key) !== quantity) {
                conflictingCount++;
                errors.push(`CONFLICT: Conflicting duplicate found in upload for ${itemCode} in ${period} (${orderType}): ${rowSalesMap.get(key)} vs ${quantity}. This must be resolved before proceeding.`);
              }
              continue; // Identical or conflicting duplicate, skip
            }

            rowSalesMap.set(key, quantity);
            detectedPeriods.add(period);
            salesHistory.push({
              itemCode,
              period,
              quantity,
              orderType: orderType as any
            });
          }
        }
      }

      if (salesHistory.length === 0) {
         // Fallback: Sales sheet might be a wide table
         for (const row of rawSales) {
            const codeKey = findColumnKey(row, ['itemcode', 'item code', 'sku', 'code']);
            if (!codeKey || !row[codeKey]) continue;
            const itemCode = String(row[codeKey]).trim().toUpperCase();
            for (const col of Object.keys(row)) {
              const parsedPeriod = parsePeriodFromColumn(col);
              if (parsedPeriod) {
                const qtyVal = row[col];
                if (qtyVal === '' || qtyVal === null || qtyVal === undefined) continue;
                const qty = parseNumber(qtyVal, 0);
                detectedPeriods.add(parsedPeriod);
                salesHistory.push({ itemCode, period: parsedPeriod, quantity: qty });
              }
            }
         }
      }
    } else {
      // Fallback: Check if Items sheet has monthly columns
      for (const row of rawItems) {
        const codeKey = findColumnKey(row, ['itemcode', 'item code', 'sku', 'code', 'product code', 'material']);
        if (!codeKey || !row[codeKey]) continue;
        const itemCode = String(row[codeKey]).trim().toUpperCase();

        for (const col of Object.keys(row)) {
          const parsedPeriod = parsePeriodFromColumn(col);
          if (parsedPeriod) {
            const qtyVal = row[col];
            if (qtyVal === '' || qtyVal === null || qtyVal === undefined) {
              continue; // Skip explicit missing month
            }
            const qty = parseNumber(qtyVal, 0);
            detectedPeriods.add(parsedPeriod);
            salesHistory.push({
              itemCode,
              period: parsedPeriod,
              quantity: qty
            });
          }
        }
      }
    }

    // 3. Parse Inventory
    const inventory: InventoryRecord[] = [];
    if (inventorySheetObj) {
      const rawInv: Record<string, any>[] = extractSheetRows(inventorySheetObj.sheet);
      if (rawInv.length > 0) {
        const sample = rawInv[0];
        const codeKey = findColumnKey(sample, ['itemcode', 'item code', 'sku']);
        const whKey = findColumnKey(sample, ['warehouse', 'wh', 'location']);
        const stockKey = findColumnKey(sample, ['stock', 'onhand', 'on hand', 'qty', 'inventory']);
        if (codeKey) detectedMappings.push({ sheetName: inventorySheetObj.name, excelColumn: codeKey, mappedField: 'Inventory Item Code', sampleValue: String(sample[codeKey] || ''), status: 'matched' });
        if (whKey) detectedMappings.push({ sheetName: inventorySheetObj.name, excelColumn: whKey, mappedField: 'Warehouse Location', sampleValue: String(sample[whKey] || ''), status: 'matched' });
        if (stockKey) detectedMappings.push({ sheetName: inventorySheetObj.name, excelColumn: stockKey, mappedField: 'On-Hand Stock Qty', sampleValue: String(sample[stockKey] || ''), status: 'matched' });
      }

      for (const row of rawInv) {
        const codeKey = findColumnKey(row, ['itemcode', 'item code', 'sku']);
        const whKey = findColumnKey(row, ['warehouse', 'wh', 'location']);
        const stockKey = findColumnKey(row, ['stock', 'onhand', 'on hand', 'qty', 'inventory']);

        if (codeKey && stockKey && row[codeKey]) {
          inventory.push({
            itemCode: String(row[codeKey]).trim().toUpperCase(),
            warehouse: whKey && row[whKey] ? String(row[whKey]).trim() : 'WH-01 (Sonipat Central Plant)',
            onHandStock: parseNumber(row[stockKey], 0)
          });
        }
      }
    } else {
      // Fallback: look for Stock column in Items sheet
      for (const row of rawItems) {
        const codeKey = findColumnKey(row, ['itemcode', 'item code', 'sku']);
        const stockKey = findColumnKey(row, ['stock', 'onhand', 'on hand', 'inventory', 'current stock']);
        if (codeKey && stockKey && row[codeKey]) {
          inventory.push({
            itemCode: String(row[codeKey]).trim().toUpperCase(),
            warehouse: 'WH-01 (Sonipat Central Plant)',
            onHandStock: parseNumber(row[stockKey], 0)
          });
        }
      }
    }

    // 4. Parse Open Orders
    const openOrders: OpenOrderRecord[] = [];
    if (ordersSheetObj) {
      const rawOrders: Record<string, any>[] = extractSheetRows(ordersSheetObj.sheet);
      for (let idx = 0; idx < rawOrders.length; idx++) {
        const row = rawOrders[idx];
        const codeKey = findColumnKey(row, ['itemcode', 'item code', 'sku']);
        const typeKey = findColumnKey(row, ['type', 'ordertype', 'doc type']);
        const qtyKey = findColumnKey(row, ['qty', 'quantity', 'openqty', 'order qty']);

        if (codeKey && qtyKey && row[codeKey]) {
          const typeStr = typeKey ? String(row[typeKey]).toUpperCase() : '';
          const isSo = typeStr.includes('SO') || typeStr.includes('SALES');
          openOrders.push({
            orderId: String(row['OrderID'] || row['Order ID'] || `ORD-${idx + 1000}`),
            itemCode: String(row[codeKey]).trim().toUpperCase(),
            type: isSo ? 'SO' : 'PO',
            quantity: parseNumber(row[qtyKey], 0)
          });
        }
      }
    } else {
      for (let idx = 0; idx < rawItems.length; idx++) {
        const row = rawItems[idx];
        const codeKey = findColumnKey(row, ['itemcode', 'item code', 'sku']);
        const poKey = findColumnKey(row, ['openpo', 'open po', 'po qty', 'open purchase']);
        const soKey = findColumnKey(row, ['openso', 'open so', 'so qty', 'open sales']);

        if (codeKey && row[codeKey]) {
          const itemCode = String(row[codeKey]).trim().toUpperCase();
          if (poKey && row[poKey]) {
            const poQty = parseNumber(row[poKey], 0);
            if (poQty > 0) {
              openOrders.push({
                orderId: `PO-IMPORT-${idx + 1}`,
                itemCode,
                type: 'PO',
                quantity: poQty
              });
            }
          }
          if (soKey && row[soKey]) {
            const soQty = parseNumber(row[soKey], 0);
            if (soQty > 0) {
              openOrders.push({
                orderId: `SO-IMPORT-${idx + 1}`,
                itemCode,
                type: 'SO',
                quantity: soQty
              });
            }
          }
        }
      }
    }

    // 5. Parse BOM
    const boms: BOMRecord[] = [];
    if (bomSheetObj) {
      const rawBOM: Record<string, any>[] = extractSheetRows(bomSheetObj.sheet);
      if (rawBOM.length > 0) {
        const sample = rawBOM[0];
        const parentKey = findColumnKey(sample, ['parent', 'parentitem', 'parent item', 'fg code']);
        const compKey = findColumnKey(sample, ['component', 'componentcode', 'component code', 'part']);
        const qtyKey = findColumnKey(sample, ['qty', 'qtyperunit', 'per unit', 'quantity']);
        if (parentKey) detectedMappings.push({ sheetName: bomSheetObj.name, excelColumn: parentKey, mappedField: 'Parent Finished Good SKU', sampleValue: String(sample[parentKey] || ''), status: 'matched' });
        if (compKey) detectedMappings.push({ sheetName: bomSheetObj.name, excelColumn: compKey, mappedField: 'BOM Component Code', sampleValue: String(sample[compKey] || ''), status: 'matched' });
        if (qtyKey) detectedMappings.push({ sheetName: bomSheetObj.name, excelColumn: qtyKey, mappedField: 'Qty Per Unit', sampleValue: String(sample[qtyKey] || ''), status: 'matched' });
      }

      for (const row of rawBOM) {
        const parentKey = findColumnKey(row, ['parent', 'parentitem', 'parent item', 'fg code', 'finished good']);
        const compKey = findColumnKey(row, ['component', 'componentcode', 'component code', 'part', 'raw material']);
        const descKey = findColumnKey(row, ['name', 'description', 'component name']);
        const qtyKey = findColumnKey(row, ['qty', 'qtyperunit', 'per unit', 'quantity']);
        const uomKey = findColumnKey(row, ['uom', 'unit']);
        const stockKey = findColumnKey(row, ['stock', 'currentstock']);
        const poKey = findColumnKey(row, ['openpo', 'po']);

        if (parentKey && compKey && row[parentKey] && row[compKey]) {
          boms.push({
            parentItemCode: String(row[parentKey]).trim().toUpperCase(),
            componentCode: String(row[compKey]).trim().toUpperCase(),
            componentName: descKey && row[descKey] ? String(row[descKey]).trim() : String(row[compKey]),
            qtyPerUnit: parseNumber(qtyKey ? row[qtyKey] : 1, 1),
            uom: uomKey && row[uomKey] ? String(row[uomKey]).trim().toUpperCase() : 'PCS',
            currentStock: parseNumber(stockKey ? row[stockKey] : 0, 0),
            openPo: parseNumber(poKey ? row[poKey] : 0, 0),
            leadTimeDays: 14
          });
        }
      }
    }

    // 6. Parse Accuracy Benchmarks (If provided in workbook)
    const accuracyRecords: AccuracyRecord[] = [];
    if (accuracySheetObj) {
      const rawAcc: Record<string, any>[] = extractSheetRows(accuracySheetObj.sheet);
      for (const row of rawAcc) {
        const codeKey = findColumnKey(row, ['itemcode', 'item code', 'sku', 'code']);
        const descKey = findColumnKey(row, ['description', 'name']);
        const groupKey = findColumnKey(row, ['itemgroup', 'group', 'category']);
        const monthKey = findColumnKey(row, ['month', 'period', 'date']);
        const fcstKey = findColumnKey(row, ['forecast', 'forecastqty', 'predicted']);
        const actKey = findColumnKey(row, ['actual', 'actualsales', 'invoiced']);

        if (codeKey && monthKey && fcstKey && actKey && row[codeKey]) {
          const forecast = parseNumber(row[fcstKey], 0);
          const actual = parseNumber(row[actKey], 0);
          const variance = forecast - actual;
          const wape = actual > 0 ? Math.abs(variance) / actual : 0;

          accuracyRecords.push({
            itemCode: String(row[codeKey]).trim().toUpperCase(),
            description: descKey && row[descKey] ? String(row[descKey]).trim() : String(row[codeKey]),
            itemGroup: groupKey && row[groupKey] ? String(row[groupKey]).trim() : 'General Lighting',
            month: String(row[monthKey]).trim(),
            forecast,
            actual,
            variance,
            wape
          });
        }
      }
    }

    // Calculate history summary dynamically from actual observations
    const sortedPeriods = Array.from(detectedPeriods).sort();
    const earliestPeriod = sortedPeriods[0] || 'Unknown';
    const latestPeriod = sortedPeriods[sortedPeriods.length - 1] || 'Unknown';
    const totalMonths = sortedPeriods.length;

    const itemHistoryMap: Record<string, number> = {};
    const itemDistinctPeriods = new Map<string, Set<string>>();
    for (const sh of salesHistory) {
      if (!itemDistinctPeriods.has(sh.itemCode)) {
        itemDistinctPeriods.set(sh.itemCode, new Set());
      }
      itemDistinctPeriods.get(sh.itemCode)!.add(sh.period);
    }
    for (const item of items) {
      itemHistoryMap[item.itemCode] = itemDistinctPeriods.get(item.itemCode)?.size || 0;
    }
    const itemsWithHistory = Object.values(itemHistoryMap).filter(c => c > 0).length;

    const historySummary: DatasetHistorySummary = {
      earliestPeriod,
      latestPeriod,
      totalMonths,
      totalObservations: salesHistory.length,
      itemsWithHistory,
      itemHistoryMap
    };

    const dataset: NormalizedDataset = {
      items,
      salesHistory,
      inventory,
      openOrders,
      boms,
      accuracyRecords: accuracyRecords.length > 0 ? accuracyRecords : undefined,
      dataVersion: 1,
      historySummary,
      metadata: {
        sourceName: fileName,
        totalRecords: items.length + salesHistory.length + inventory.length + openOrders.length + boms.length + accuracyRecords.length,
        sheetsDetected: sheetNames,
        importedAt: new Date().toISOString(),
        isDemo
      }
    };

    return {
      success: errors.length === 0,
      dataset: errors.length === 0 ? dataset : null,
      errors,
      warnings,
      detectedMappings,
      stats: {
        itemsCount: items.length,
        salesRecordsCount: salesHistory.length,
        inventoryCount: inventory.length,
        openOrdersCount: openOrders.length,
        bomsCount: boms.length,
        accuracyRecordsCount: accuracyRecords.length,
        detectedSheets: sheetNames,
        historyMonthsSpan: totalMonths,
        conflictingObservations: conflictingCount,
        invalidObservations: invalidCount
      }
    };
  } catch (err: any) {
    return {
      success: false,
      dataset: null,
      errors: [`Excel parsing error: ${err.message || 'Corrupt or unsupported Excel workbook.'}`],
      warnings: [],
      detectedMappings: [],
      stats: {
        itemsCount: 0,
        salesRecordsCount: 0,
        inventoryCount: 0,
        openOrdersCount: 0,
        bomsCount: 0,
        accuracyRecordsCount: 0,
        detectedSheets: [],
        historyMonthsSpan: 0
      }
    };
  }
}

export const INVENTORY_SHEET_ALIASES = ['inventory', 'stock', 'warehouse', 'onhand'];
export const ORDERS_SHEET_ALIASES = ['order', 'open', 'po', 'so', 'supply'];
export const BOM_SHEET_ALIASES = ['bom', 'bill', 'component', 'structure'];

export function isSheetDetected(sheetsDetected: string[] | undefined, aliases: string[]): boolean {
  if (!sheetsDetected || !Array.isArray(sheetsDetected) || sheetsDetected.length === 0) {
    return false;
  }
  return sheetsDetected.some(s => aliases.some(alias => s.toLowerCase().includes(alias.toLowerCase())));
}

/**
 * Safely merges an incremental Excel upload into the existing dataset,
 * identifying new observations, updating corrected values, and ignoring
 * duplicate records using natural key deduplication.
 */
export function mergeIncrementalDataset(
  existing: NormalizedDataset,
  incoming: NormalizedDataset,
  options?: {
    isReplaceInventory?: boolean;
    isReplaceOrders?: boolean;
    isReplaceBoms?: boolean;
    isReplace?: boolean;
    confirmedEmptyReplacement?: {
      inventory?: boolean;
      orders?: boolean;
      boms?: boolean;
    };
  }
): NormalizedDataset {
  let newObservations = 0;
  let updatedObservations = 0;
  let duplicatesIgnored = 0;

  const affectedItemsSet = new Set<string>();
  const forecastAffectedItemsSet = new Set<string>();
  const mrpAffectedItemsSet = new Set<string>();
  const bomAffectedItemsSet = new Set<string>();

  let inventoryChangesCount = 0;
  let orderChangesCount = 0;
  let bomChangesCount = 0;
  let itemMasterChangesCount = 0;

  // Natural key deduplication for sales records
  // Natural key: itemCode + period + orderType
  const makeKey = (r: SalesHistoryRecord) => `${r.itemCode}__${r.period}__${r.orderType || 'Regular'}`;
  const salesMap = new Map<string, SalesHistoryRecord>();
  for (const r of existing.salesHistory) {
    salesMap.set(makeKey(r), { ...r });
  }

  for (const r of incoming.salesHistory) {
    const key = makeKey(r);
    if (salesMap.has(key)) {
      const current = salesMap.get(key)!;
      if (current.quantity !== r.quantity) {
        salesMap.set(key, { ...r });
        updatedObservations++;
        forecastAffectedItemsSet.add(r.itemCode);
        affectedItemsSet.add(r.itemCode);
      } else {
        duplicatesIgnored++;
      }
    } else {
      salesMap.set(key, { ...r });
      newObservations++;
      forecastAffectedItemsSet.add(r.itemCode);
      affectedItemsSet.add(r.itemCode);
    }
  }

  const mergedSalesHistory = Array.from(salesMap.values());

  // Merge items master and track new items or modified item attributes
  const existingItemsMap = new Map<string, Item>();
  for (const it of existing.items) existingItemsMap.set(it.itemCode, { ...it });

  const itemsMap = new Map<string, Item>();
  for (const it of existing.items) itemsMap.set(it.itemCode, { ...it });
  for (const it of incoming.items) {
    const prev = existingItemsMap.get(it.itemCode);
    if (!prev) {
      itemMasterChangesCount++;
      forecastAffectedItemsSet.add(it.itemCode);
      mrpAffectedItemsSet.add(it.itemCode);
      affectedItemsSet.add(it.itemCode);
    } else {
      const isForecastCritical =
        prev.isDiscontinued !== it.isDiscontinued ||
        prev.itemGroup !== it.itemGroup ||
        prev.description !== it.description ||
        prev.isNewItem !== it.isNewItem;

      const isMrpOnly =
        prev.planningMethod !== it.planningMethod ||
        prev.uom !== it.uom ||
        prev.moq !== it.moq ||
        prev.orderMultiple !== it.orderMultiple ||
        prev.leadTimeDays !== it.leadTimeDays ||
        prev.makeBuy !== it.makeBuy ||
        prev.defaultVendor !== it.defaultVendor;

      if (isForecastCritical) {
        itemMasterChangesCount++;
        forecastAffectedItemsSet.add(it.itemCode);
        affectedItemsSet.add(it.itemCode);
      }
      if (isMrpOnly) {
        itemMasterChangesCount++;
        mrpAffectedItemsSet.add(it.itemCode);
        affectedItemsSet.add(it.itemCode);
      }
    }
    itemsMap.set(it.itemCode, { ...it });
  }
  const mergedItems = Array.from(itemsMap.values());

  // Merge inventory positions
  // Natural key: itemCode + warehouse
  const invKey = (inv: InventoryRecord) => `${inv.itemCode}__${inv.warehouse}`;
  const invMap = new Map<string, InventoryRecord>();
  for (const inv of existing.inventory) invMap.set(invKey(inv), { ...inv });

  const hasInvSheet = isSheetDetected(incoming.metadata?.sheetsDetected, INVENTORY_SHEET_ALIASES);
  const wantsReplaceInv = !!(options?.isReplaceInventory || options?.isReplace);

  for (const inv of incoming.inventory) {
    const key = invKey(inv);
    const prev = invMap.get(key);
    if (!prev) {
      inventoryChangesCount++;
      mrpAffectedItemsSet.add(inv.itemCode);
      affectedItemsSet.add(inv.itemCode);
    } else if (
      prev.onHandStock !== inv.onHandStock ||
      (prev.safetyStock ?? 0) !== (inv.safetyStock ?? 0)
    ) {
      inventoryChangesCount++;
      mrpAffectedItemsSet.add(inv.itemCode);
      affectedItemsSet.add(inv.itemCode);
    }
    invMap.set(key, { ...inv });
  }

  // Explicit replacement handling:
  // Case 1: Sheet absent (!hasInvSheet) -> retain existing records (no deletion).
  // Case 2: Sheet present with records (hasInvSheet && incoming.inventory.length > 0) -> remove absent records if wantsReplaceInv.
  // Case 3: Sheet present with 0 records (hasInvSheet && incoming.inventory.length === 0) -> clear dataset ONLY if wantsReplaceInv AND confirmed.
  if (hasInvSheet && wantsReplaceInv) {
    if (incoming.inventory.length > 0) {
      const incomingKeys = new Set(incoming.inventory.map(invKey));
      for (const inv of existing.inventory) {
        const key = invKey(inv);
        if (!incomingKeys.has(key)) {
          inventoryChangesCount++;
          mrpAffectedItemsSet.add(inv.itemCode);
          affectedItemsSet.add(inv.itemCode);
          invMap.delete(key);
        }
      }
    } else if (options?.confirmedEmptyReplacement?.inventory) {
      for (const inv of existing.inventory) {
        inventoryChangesCount++;
        mrpAffectedItemsSet.add(inv.itemCode);
        affectedItemsSet.add(inv.itemCode);
      }
      invMap.clear();
    }
  }
  const mergedInventory = Array.from(invMap.values());

  // Merge open orders
  // Natural key: orderId (or orderId + itemCode)
  const orderKey = (ord: OpenOrderRecord) =>
    ord.orderId ? `${ord.orderId}__${ord.itemCode}` : `${ord.itemCode}__${ord.type}__${ord.warehouse || ''}__${ord.dueDate || ''}`;
  const ordersMap = new Map<string, OpenOrderRecord>();
  for (const ord of existing.openOrders) ordersMap.set(orderKey(ord), { ...ord });

  const hasOrdersSheet = isSheetDetected(incoming.metadata?.sheetsDetected, ORDERS_SHEET_ALIASES);
  const wantsReplaceOrders = !!(options?.isReplaceOrders || options?.isReplace);

  for (const ord of incoming.openOrders) {
    const key = orderKey(ord);
    const prev = ordersMap.get(key);
    if (!prev) {
      orderChangesCount++;
      mrpAffectedItemsSet.add(ord.itemCode);
      affectedItemsSet.add(ord.itemCode);
    } else if (
      prev.quantity !== ord.quantity ||
      prev.type !== ord.type ||
      prev.warehouse !== ord.warehouse ||
      prev.dueDate !== ord.dueDate
    ) {
      orderChangesCount++;
      mrpAffectedItemsSet.add(ord.itemCode);
      affectedItemsSet.add(ord.itemCode);
    }
    ordersMap.set(key, { ...ord });
  }

  if (hasOrdersSheet && wantsReplaceOrders) {
    if (incoming.openOrders.length > 0) {
      const incomingOrderKeys = new Set(incoming.openOrders.map(orderKey));
      for (const ord of existing.openOrders) {
        const key = orderKey(ord);
        if (!incomingOrderKeys.has(key)) {
          orderChangesCount++;
          mrpAffectedItemsSet.add(ord.itemCode);
          affectedItemsSet.add(ord.itemCode);
          ordersMap.delete(key);
        }
      }
    } else if (options?.confirmedEmptyReplacement?.orders) {
      for (const ord of existing.openOrders) {
        orderChangesCount++;
        mrpAffectedItemsSet.add(ord.itemCode);
        affectedItemsSet.add(ord.itemCode);
      }
      ordersMap.clear();
    }
  }
  const mergedOrders = Array.from(ordersMap.values());

  // Merge BOM records
  // Natural key: parentItemCode + componentCode
  const bomKey = (b: BOMRecord) => `${b.parentItemCode}__${b.componentCode}`;
  const bomMap = new Map<string, BOMRecord>();
  for (const b of existing.boms) bomMap.set(bomKey(b), { ...b });

  const hasBomSheet = isSheetDetected(incoming.metadata?.sheetsDetected, BOM_SHEET_ALIASES);
  const wantsReplaceBoms = !!(options?.isReplaceBoms || options?.isReplace);

  for (const b of incoming.boms) {
    const key = bomKey(b);
    const prev = bomMap.get(key);
    if (!prev) {
      bomChangesCount++;
      bomAffectedItemsSet.add(b.parentItemCode);
      bomAffectedItemsSet.add(b.componentCode);
      mrpAffectedItemsSet.add(b.parentItemCode);
      mrpAffectedItemsSet.add(b.componentCode);
      affectedItemsSet.add(b.parentItemCode);
      affectedItemsSet.add(b.componentCode);
    } else if (
      prev.qtyPerUnit !== b.qtyPerUnit ||
      prev.componentName !== b.componentName ||
      prev.uom !== b.uom ||
      (prev.currentStock ?? 0) !== (b.currentStock ?? 0) ||
      (prev.openPo ?? 0) !== (b.openPo ?? 0) ||
      (prev.leadTimeDays ?? 0) !== (b.leadTimeDays ?? 0)
    ) {
      bomChangesCount++;
      bomAffectedItemsSet.add(b.parentItemCode);
      bomAffectedItemsSet.add(b.componentCode);
      mrpAffectedItemsSet.add(b.parentItemCode);
      mrpAffectedItemsSet.add(b.componentCode);
      affectedItemsSet.add(b.parentItemCode);
      affectedItemsSet.add(b.componentCode);
    }
    bomMap.set(key, { ...b });
  }

  if (hasBomSheet && wantsReplaceBoms) {
    if (incoming.boms.length > 0) {
      const incomingBomKeys = new Set(incoming.boms.map(bomKey));
      for (const b of existing.boms) {
        const key = bomKey(b);
        if (!incomingBomKeys.has(key)) {
          bomChangesCount++;
          bomAffectedItemsSet.add(b.parentItemCode);
          bomAffectedItemsSet.add(b.componentCode);
          mrpAffectedItemsSet.add(b.parentItemCode);
          mrpAffectedItemsSet.add(b.componentCode);
          affectedItemsSet.add(b.parentItemCode);
          affectedItemsSet.add(b.componentCode);
          bomMap.delete(key);
        }
      }
    } else if (options?.confirmedEmptyReplacement?.boms) {
      for (const b of existing.boms) {
        bomChangesCount++;
        bomAffectedItemsSet.add(b.parentItemCode);
        bomAffectedItemsSet.add(b.componentCode);
        mrpAffectedItemsSet.add(b.parentItemCode);
        mrpAffectedItemsSet.add(b.componentCode);
        affectedItemsSet.add(b.parentItemCode);
        affectedItemsSet.add(b.componentCode);
      }
      bomMap.clear();
    }
  }
  const mergedBoms = Array.from(bomMap.values());

  // Re-evaluate full historical time span
  const periodsSet = new Set<string>();
  const itemDistinctPeriods = new Map<string, Set<string>>();
  for (const sh of mergedSalesHistory) {
    periodsSet.add(sh.period);
    if (!itemDistinctPeriods.has(sh.itemCode)) {
      itemDistinctPeriods.set(sh.itemCode, new Set());
    }
    itemDistinctPeriods.get(sh.itemCode)!.add(sh.period);
  }

  const sortedPeriods = Array.from(periodsSet).sort();
  const earliestPeriod = sortedPeriods[0] || 'Unknown';
  const latestPeriod = sortedPeriods[sortedPeriods.length - 1] || 'Unknown';
  const totalMonths = sortedPeriods.length;

  const itemHistoryMap: Record<string, number> = {};
  const missingPeriodsMap: Record<string, string[]> = {};

  for (const it of mergedItems) {
    const itemCode = it.itemCode;
    const periods = itemDistinctPeriods.get(itemCode);
    itemHistoryMap[itemCode] = periods?.size || 0;

    if (periods && periods.size > 1) {
      const sorted = Array.from(periods).sort();
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      
      const expected: string[] = [];
      let [y, m] = first.split('-').map(Number);
      const [ey, em] = last.split('-').map(Number);
      
      while (y < ey || (y === ey && m <= em)) {
        expected.push(`${y}-${m.toString().padStart(2, '0')}`);
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }
      
      const missing = expected.filter(period => !periods.has(period));
      if (missing.length > 0) {
        missingPeriodsMap[itemCode] = missing;
      }
    }
  }

  const itemsWithHistory = Object.values(itemHistoryMap).filter(c => c > 0).length;

  const mergedVersion = (existing.dataVersion || 1) + 1;

  const historySummary: DatasetHistorySummary = {
    earliestPeriod,
    latestPeriod,
    totalMonths,
    totalObservations: mergedSalesHistory.length,
    itemsWithHistory,
    itemHistoryMap,
    incrementalStats: {
      newObservations,
      unchangedObservations: duplicatesIgnored,
      updatedObservations,
      duplicatesIgnored,
      conflictingObservations: 0, // handeled in parse
      invalidObservations: 0, // handeled in parse
      previousTotalMonths: existing.historySummary.totalMonths,
      affectedItems: Array.from(affectedItemsSet),
      forecastAffectedItems: Array.from(forecastAffectedItemsSet),
      mrpAffectedItems: Array.from(mrpAffectedItemsSet),
      bomAffectedItems: Array.from(bomAffectedItemsSet),
      inventoryChangesCount,
      orderChangesCount,
      bomChangesCount,
      itemMasterChangesCount,
      missingPeriodsMap
    }
  };

  return {
    items: mergedItems,
    salesHistory: mergedSalesHistory,
    inventory: mergedInventory,
    openOrders: mergedOrders,
    boms: mergedBoms,
    accuracyRecords: incoming.accuracyRecords || existing.accuracyRecords,
    dataVersion: mergedVersion,
    historySummary,
    metadata: {
      sourceName: `${existing.metadata.sourceName.split(' + ')[0]} (+${newObservations} new in v${mergedVersion})`,
      totalRecords: mergedItems.length + mergedSalesHistory.length + mergedInventory.length + mergedOrders.length + mergedBoms.length,
      sheetsDetected: Array.from(new Set([...existing.metadata.sheetsDetected, ...incoming.metadata.sheetsDetected])),
      importedAt: new Date().toISOString(),
      isDemo: existing.metadata.isDemo || incoming.metadata.isDemo
    }
  };
}

/**
 * Builds a realistic multi-sheet Excel Workbook binary representing
 * Ledure Lighting's factory demand planning dataset.
 */
export function generateDemoExcelWorkbook(): Uint8Array {
  const wb = XLSX.utils.book_new();

  // 1. Items Master Sheet
  const itemsData = [
    { 'Item Code': 'LED-BLB-09W', 'Description': 'Ledure Glitz 9W LED Bulb B22 Cool Daylight 6500K', 'Item Group': 'LED Bulbs', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 14, 'MOQ': 1000, 'Order Multiple': 500, 'Default Vendor': 'Ledure Unit 1 (Sonipat In-House)', 'Current Stock': 74000, 'Open PO': 45000, 'Open SO': 18000, 'Status': 'Active' },
    { 'Item Code': 'LED-BLB-12W', 'Description': 'Ledure Glitz 12W LED Bulb B22 Warm White 3000K', 'Item Group': 'LED Bulbs', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 14, 'MOQ': 1000, 'Order Multiple': 500, 'Default Vendor': 'Ledure Unit 1 (Sonipat In-House)', 'Current Stock': 42000, 'Open PO': 25000, 'Open SO': 8500, 'Status': 'Active' },
    { 'Item Code': 'LED-PNL-36W', 'Description': 'Ledure Slim Edge-lit 2x2ft 36W Recessed Panel Light', 'Item Group': 'LED Panels', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 21, 'MOQ': 500, 'Order Multiple': 100, 'Default Vendor': 'Ledure Assembly Line 2 (Sonipat)', 'Current Stock': 8500, 'Open PO': 6000, 'Open SO': 4200, 'Status': 'Active' },
    { 'Item Code': 'LED-PNL-48W', 'Description': 'Ledure Ultra Bright 2x2ft 48W Commercial Panel', 'Item Group': 'LED Panels', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 21, 'MOQ': 500, 'Order Multiple': 100, 'Default Vendor': 'Ledure Assembly Line 2 (Sonipat)', 'Current Stock': 3200, 'Open PO': 2500, 'Open SO': 1600, 'Status': 'Active' },
    { 'Item Code': 'LED-DWL-12W', 'Description': 'Ledure Sharp COB Deep Recessed Downlight 12W', 'Item Group': 'LED Downlights', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 18, 'MOQ': 500, 'Order Multiple': 200, 'Default Vendor': 'Ledure Unit 2 (Gurgaon Assembly)', 'Current Stock': 6800, 'Open PO': 5000, 'Open SO': 3100, 'Status': 'Active' },
    { 'Item Code': 'LED-FLD-100W', 'Description': 'Ledure Titan Outdoor LED Flood Light 100W IP66 Heavy Duty', 'Item Group': 'LED Floodlights', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 25, 'MOQ': 200, 'Order Multiple': 50, 'Default Vendor': 'Ledure Heavy Fab Division (Sonipat)', 'Current Stock': 1200, 'Open PO': 1500, 'Open SO': 850, 'Status': 'Active' },
    { 'Item Code': 'LED-STR-60W', 'Description': 'Ledure Highway LED Street Light 60W IP66 140 Lm/W', 'Item Group': 'LED Streetlights', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 28, 'MOQ': 200, 'Order Multiple': 50, 'Default Vendor': 'Ledure Heavy Fab Division (Sonipat)', 'Current Stock': 2100, 'Open PO': 2000, 'Open SO': 1400, 'Status': 'Active' },
    { 'Item Code': 'LED-BTN-20W', 'Description': 'Ledure Prism 4ft 20W LED Batten Surface Mounted Cool Daylight', 'Item Group': 'LED Battens', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 14, 'MOQ': 1000, 'Order Multiple': 500, 'Default Vendor': 'Ledure Extrusion & Batten Line', 'Current Stock': 48000, 'Open PO': 30000, 'Open SO': 12000, 'Status': 'Active' },
    { 'Item Code': 'LED-DRV-36W', 'Description': 'Ledure Isolated Electronic LED Driver 36W 900mA High PF', 'Item Group': 'LED Drivers', 'UoM': 'PCS', 'Make / Buy': 'Buy', 'Planning Method': 'MRP', 'Lead Time Days': 30, 'MOQ': 1000, 'Order Multiple': 500, 'Default Vendor': 'Shenzhen Power Technology Co.', 'Current Stock': 18500, 'Open PO': 12000, 'Open SO': 0, 'Status': 'Active' },
    { 'Item Code': 'LED-DRV-50W', 'Description': 'Ledure Waterproof Driver 50W IP67 Surge 4kV', 'Item Group': 'LED Drivers', 'UoM': 'PCS', 'Make / Buy': 'Buy', 'Planning Method': 'MRP', 'Lead Time Days': 35, 'MOQ': 1000, 'Order Multiple': 250, 'Default Vendor': 'Meanwell Power Electronics Ltd', 'Current Stock': 6400, 'Open PO': 4000, 'Open SO': 0, 'Status': 'Active' },
    { 'Item Code': 'LED-STR-RGB-24V', 'Description': 'Ledure Flexible 5050 RGB Strip Light 24V IP20 60 LED/m', 'Item Group': 'LED Strips', 'UoM': 'MTR', 'Make / Buy': 'Buy', 'Planning Method': 'None', 'Lead Time Days': 45, 'MOQ': 500, 'Order Multiple': 100, 'Default Vendor': 'Everlight Electronics Ltd', 'Current Stock': 3200, 'Open PO': 0, 'Open SO': 0, 'Status': 'Discontinued' },
    { 'Item Code': 'LED-STP-5M12V', 'Description': 'Ledure Accent 2835 Warm White 12V 5M Reel Silicone IP65', 'Item Group': 'LED Strips', 'UoM': 'ROLL', 'Make / Buy': 'Buy', 'Planning Method': 'MRP', 'Lead Time Days': 25, 'MOQ': 500, 'Order Multiple': 100, 'Default Vendor': 'Guangdong Opto Supply Co.', 'Current Stock': 9800, 'Open PO': 6000, 'Open SO': 2100, 'Status': 'Active' },
    { 'Item Code': 'LED-BLB-07W', 'Description': 'Ledure Glitz 7W LED Bulb B22 Cool Daylight 6500K Economy', 'Item Group': 'LED Bulbs', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 14, 'MOQ': 1000, 'Order Multiple': 500, 'Default Vendor': 'Ledure Unit 1 (Sonipat In-House)', 'Current Stock': 52000, 'Open PO': 30000, 'Open SO': 11000, 'Status': 'Active' },
    { 'Item Code': 'LED-DWL-07W', 'Description': 'Ledure Prime Slim Recessed Downlight 7W Round Neutral White', 'Item Group': 'LED Downlights', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 18, 'MOQ': 500, 'Order Multiple': 200, 'Default Vendor': 'Ledure Unit 2 (Gurgaon Assembly)', 'Current Stock': 14200, 'Open PO': 8000, 'Open SO': 3500, 'Status': 'Active' },
    { 'Item Code': 'LED-FLD-50W', 'Description': 'Ledure Eco Flood Light 50W IP65 Outdoor Architectural', 'Item Group': 'LED Floodlights', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 21, 'MOQ': 300, 'Order Multiple': 100, 'Default Vendor': 'Ledure Heavy Fab Division (Sonipat)', 'Current Stock': 4200, 'Open PO': 3000, 'Open SO': 1200, 'Status': 'Active' },
    { 'Item Code': 'LED-STR-120W', 'Description': 'Ledure Master LED Street Light 120W Lens IP66 10kV Surge', 'Item Group': 'LED Streetlights', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 30, 'MOQ': 100, 'Order Multiple': 50, 'Default Vendor': 'Ledure Heavy Fab Division (Sonipat)', 'Current Stock': 850, 'Open PO': 1000, 'Open SO': 600, 'Status': 'Active' },
    { 'Item Code': 'LED-BLB-SMART', 'Description': 'Ledure IoT Smart WiFi+BLE Tunable 9W Bulb RGB+CCT', 'Item Group': 'LED Bulbs', 'UoM': 'PCS', 'Make / Buy': 'Buy', 'Planning Method': 'MRP', 'Lead Time Days': 40, 'MOQ': 1000, 'Order Multiple': 500, 'Default Vendor': 'Tuya Smart IoT Solutions Ltd', 'Current Stock': 3500, 'Open PO': 5000, 'Open SO': 1800, 'Status': 'New Item' }
  ];
  const itemsWs = XLSX.utils.json_to_sheet(itemsData);
  XLSX.utils.book_append_sheet(wb, itemsWs, 'Items_Master');

  // 2. Sales History Sheet (24 Months)
  const salesData: any[] = [];
  const periods = [
    '2024-11', '2024-12', '2025-01', '2025-02', '2025-03', '2025-04',
    '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10',
    '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04',
    '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'
  ];

  const baseDemands: Record<string, number> = {
    'LED-BLB-09W': 82000, 'LED-BLB-12W': 48000, 'LED-PNL-36W': 14500, 'LED-PNL-48W': 5800,
    'LED-DWL-12W': 11200, 'LED-FLD-100W': 2400, 'LED-STR-60W': 6200, 'LED-BTN-20W': 55000,
    'LED-DRV-36W': 21000, 'LED-DRV-50W': 7500, 'LED-STR-RGB-24V': 1200, 'LED-STP-5M12V': 12400,
    'LED-BLB-07W': 64000, 'LED-DWL-07W': 18500, 'LED-FLD-50W': 4600, 'LED-STR-120W': 1800, 'LED-BLB-SMART': 2200
  };

  for (const item of itemsData) {
    const code = item['Item Code'];
    const base = baseDemands[code] || 10000;
    const isNew = item['Status'] === 'New Item';
    const isDisc = item['Status'] === 'Discontinued';

    periods.forEach((p, idx) => {
      // Deterministic pseudo-random noise between -10% and +10%
      const pseudoRandom = Math.sin((idx + 1) * code.length) * 0.1;
      const yrGrowth = 1.0 + (idx * 0.005); // slight upward trend
      let qty = Math.round(base * yrGrowth * (1 + pseudoRandom));

      if (isNew) qty = idx >= 21 ? Math.round(base * 0.9) : 0;
      else if (isDisc) qty = idx < 18 ? Math.round(base * 0.8) : 0;

      if (qty > 0) {
        salesData.push({
          'Item Code': code,
          'Period': p,
          'Quantity': qty,
          'Order Type': idx === 22 && code === 'LED-STR-60W' ? 'Project' : 'Regular'
        });
      }
    });
  }
  const salesWs = XLSX.utils.json_to_sheet(salesData);
  XLSX.utils.book_append_sheet(wb, salesWs, 'Sales_History_24Mo');

  // 3. Inventory Sheet
  const invData = itemsData.map(item => ({
    'Item Code': item['Item Code'],
    'Warehouse': 'WH-01 (Sonipat Central Plant)',
    'On Hand Stock': item['Current Stock']
  }));
  const invWs = XLSX.utils.json_to_sheet(invData);
  XLSX.utils.book_append_sheet(wb, invWs, 'Inventory_Position');

  // 4. Open Orders Sheet
  const ordersData: any[] = [];
  itemsData.forEach((item, i) => {
    if (item['Open PO'] > 0) {
      ordersData.push({ 'Order ID': `PO-2026-${1000 + i}`, 'Item Code': item['Item Code'], 'Type': 'PO', 'Quantity': item['Open PO'] });
    }
    if (item['Open SO'] > 0) {
      ordersData.push({ 'Order ID': `SO-2026-${5000 + i}`, 'Item Code': item['Item Code'], 'Type': 'SO', 'Quantity': item['Open SO'] });
    }
  });
  const ordersWs = XLSX.utils.json_to_sheet(ordersData);
  XLSX.utils.book_append_sheet(wb, ordersWs, 'Open_Orders_PO_SO');

  // 5. BOM Sheet
  const bomData = [
    { 'Parent Item': 'LED-PNL-36W', 'Component Code': 'CMP-PCB-36W', 'Component Name': 'High-Lumen SMD PCB 36W', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 12000, 'Open PO': 5000 },
    { 'Parent Item': 'LED-PNL-36W', 'Component Code': 'CMP-DRV-36W', 'Component Name': 'Isolated Constant Current Driver 36W', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 4500, 'Open PO': 4000 },
    { 'Parent Item': 'LED-PNL-36W', 'Component Code': 'CMP-HSG-2X2', 'Component Name': 'Extruded Aluminum Frame 2x2ft', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 8200, 'Open PO': 3000 },
    { 'Parent Item': 'LED-PNL-36W', 'Component Code': 'CMP-DIF-PMMA', 'Component Name': 'Optical PMMA Light Guide & Diffuser', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 6100, 'Open PO': 2000 },
    { 'Parent Item': 'LED-PNL-36W', 'Component Code': 'CMP-CLP-SET', 'Component Name': 'Spring Ceiling Clamps (Set of 4)', 'Qty Per Unit': 1, 'UoM': 'SET', 'Current Stock': 25000, 'Open PO': 10000 },

    { 'Parent Item': 'LED-BLB-09W', 'Component Code': 'CMP-PCB-09W', 'Component Name': 'DOB Aluminum Substrate 9W', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 65000, 'Open PO': 30000 },
    { 'Parent Item': 'LED-BLB-09W', 'Component Code': 'CMP-HSG-B9', 'Component Name': 'Thermoplastic Heatsink Body B22', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 42000, 'Open PO': 20000 },
    { 'Parent Item': 'LED-BLB-09W', 'Component Code': 'CMP-CAP-B22', 'Component Name': 'Nickel-Plated Brass B22 Base Cap', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 88000, 'Open PO': 40000 },
    { 'Parent Item': 'LED-BLB-09W', 'Component Code': 'CMP-DIF-GLB', 'Component Name': 'Frosted Polycarbonate Globe Dome', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 51000, 'Open PO': 25000 },

    { 'Parent Item': 'LED-DWL-12W', 'Component Code': 'CMP-COB-12W', 'Component Name': 'Bridgelux COB LED Chipset 12W', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 7400, 'Open PO': 5000 },
    { 'Parent Item': 'LED-DWL-12W', 'Component Code': 'CMP-DRV-12W', 'Component Name': 'Flicker-Free Compact Driver 12W', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 3200, 'Open PO': 4000 },
    { 'Parent Item': 'LED-DWL-12W', 'Component Code': 'CMP-HSG-DW12', 'Component Name': 'Die-Cast Aluminum Recessed Trim', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 4800, 'Open PO': 2500 },

    { 'Parent Item': 'LED-FLD-100W', 'Component Code': 'CMP-MTX-100W', 'Component Name': 'SMD 3030 LED Matrix Array 100W', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 1400, 'Open PO': 1200 },
    { 'Parent Item': 'LED-FLD-100W', 'Component Code': 'CMP-DRV-100W', 'Component Name': 'Meanwell IP67 Surge Driver 100W', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 650, 'Open PO': 800 },
    { 'Parent Item': 'LED-FLD-100W', 'Component Code': 'CMP-HSG-FLD', 'Component Name': 'Heavy Die-Cast Marine Aluminum Heatsink', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 890, 'Open PO': 500 },

    { 'Parent Item': 'LED-BTN-20W', 'Component Code': 'CMP-PCB-20W', 'Component Name': 'Linear Aluminum PCB Strip 4ft 20W', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 41000, 'Open PO': 25000 },
    { 'Parent Item': 'LED-BTN-20W', 'Component Code': 'CMP-DRV-20W', 'Component Name': 'Internal Integrated Driver 20W', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 35000, 'Open PO': 20000 }
  ];
  const bomWs = XLSX.utils.json_to_sheet(bomData);
  XLSX.utils.book_append_sheet(wb, bomWs, 'BOM_Explosion_Master');

  // 6. Accuracy Benchmarks Sheet
  const accData = [
    { 'Item Code': 'LED-BLB-09W', 'Description': 'Ledure Glitz 9W LED Bulb B22 Cool Daylight', 'Item Group': 'LED Bulbs', 'Month': '2026-08', 'Forecast': 96000, 'Actual': 102400 },
    { 'Item Code': 'LED-BLB-09W', 'Description': 'Ledure Glitz 9W LED Bulb B22 Cool Daylight', 'Item Group': 'LED Bulbs', 'Month': '2026-09', 'Forecast': 105000, 'Actual': 108900 },
    { 'Item Code': 'LED-BLB-09W', 'Description': 'Ledure Glitz 9W LED Bulb B22 Cool Daylight', 'Item Group': 'LED Bulbs', 'Month': '2026-10', 'Forecast': 115000, 'Actual': 111200 },
    { 'Item Code': 'LED-PNL-36W', 'Description': 'Ledure Slim Edge-lit 2x2ft 36W Recessed Panel', 'Item Group': 'LED Panels', 'Month': '2026-08', 'Forecast': 14500, 'Actual': 14100 },
    { 'Item Code': 'LED-PNL-36W', 'Description': 'Ledure Slim Edge-lit 2x2ft 36W Recessed Panel', 'Item Group': 'LED Panels', 'Month': '2026-09', 'Forecast': 16500, 'Actual': 16200 },
    { 'Item Code': 'LED-PNL-36W', 'Description': 'Ledure Slim Edge-lit 2x2ft 36W Recessed Panel', 'Item Group': 'LED Panels', 'Month': '2026-10', 'Forecast': 18000, 'Actual': 17500 },
    { 'Item Code': 'LED-DWL-12W', 'Description': 'Ledure Sharp COB Deep Recessed Downlight 12W', 'Item Group': 'LED Downlights', 'Month': '2026-09', 'Forecast': 12000, 'Actual': 11200 },
    { 'Item Code': 'LED-DWL-12W', 'Description': 'Ledure Sharp COB Deep Recessed Downlight 12W', 'Item Group': 'LED Downlights', 'Month': '2026-10', 'Forecast': 14500, 'Actual': 13400 },
    { 'Item Code': 'LED-BTN-20W', 'Description': 'Ledure Prism 4ft 20W LED Batten Surface Mounted', 'Item Group': 'LED Battens', 'Month': '2026-09', 'Forecast': 56000, 'Actual': 56200 },
    { 'Item Code': 'LED-BTN-20W', 'Description': 'Ledure Prism 4ft 20W LED Batten Surface Mounted', 'Item Group': 'LED Battens', 'Month': '2026-10', 'Forecast': 62000, 'Actual': 61000 }
  ];
  const accWs = XLSX.utils.json_to_sheet(accData);
  XLSX.utils.book_append_sheet(wb, accWs, 'Accuracy_Benchmarks');

  const excelBinary = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(excelBinary);
}

/**
 * Builds an alternate, distinct Excel dataset (Dataset B) representing
 * Ledure Architectural & High-Bay Industrial Lighting lines.
 * Useful for validating that replacing datasets completely and dynamically
 * updates all calculations, items, BOMs, and KPIs with zero stale values.
 */
export function generateAlternateExcelWorkbook(): Uint8Array {
  const wb = XLSX.utils.book_new();

  const itemsData = [
    { 'Item Code': 'ARCH-PRO-50W', 'Description': 'Ledure Architectural Magnetic Track Light 50W CRI95', 'Item Group': 'Architectural', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 21, 'MOQ': 300, 'Order Multiple': 50, 'Default Vendor': 'Ledure Design Studio (Gurgaon)', 'Current Stock': 4500, 'Open PO': 3000, 'Open SO': 1500, 'Status': 'Active' },
    { 'Item Code': 'ARCH-PRO-100W', 'Description': 'Ledure Architectural Curved Profile 100W DALI Dimmable', 'Item Group': 'Architectural', 'UoM': 'MTR', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 28, 'MOQ': 200, 'Order Multiple': 20, 'Default Vendor': 'Ledure Design Studio (Gurgaon)', 'Current Stock': 1800, 'Open PO': 1200, 'Open SO': 900, 'Status': 'Active' },
    { 'Item Code': 'IND-HB-150W', 'Description': 'Ledure High-Bay Industrial Light 150W UFO IP65 21000Lm', 'Item Group': 'Industrial', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 25, 'MOQ': 150, 'Order Multiple': 30, 'Default Vendor': 'Heavy Industrial Fab Unit', 'Current Stock': 2200, 'Open PO': 2500, 'Open SO': 1100, 'Status': 'Active' },
    { 'Item Code': 'IND-HB-200W', 'Description': 'Ledure High-Bay Warehouse Master 200W IP66 10kV Surge', 'Item Group': 'Industrial', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 30, 'MOQ': 100, 'Order Multiple': 25, 'Default Vendor': 'Heavy Industrial Fab Unit', 'Current Stock': 950, 'Open PO': 800, 'Open SO': 750, 'Status': 'Active' },
    { 'Item Code': 'SMART-HUB-V2', 'Description': 'Ledure Central Zigbee 3.0 Commercial Lighting Gateway Hub', 'Item Group': 'Smart Controls', 'UoM': 'PCS', 'Make / Buy': 'Buy', 'Planning Method': 'MRP', 'Lead Time Days': 45, 'MOQ': 500, 'Order Multiple': 100, 'Default Vendor': 'Nordic IoT Systems AS', 'Current Stock': 1200, 'Open PO': 2000, 'Open SO': 600, 'Status': 'Active' },
    { 'Item Code': 'SMART-SEN-BLE', 'Description': 'Ledure Daylight Harvesting Microwave Presence Sensor', 'Item Group': 'Smart Controls', 'UoM': 'PCS', 'Make / Buy': 'Buy', 'Planning Method': 'MRP', 'Lead Time Days': 35, 'MOQ': 500, 'Order Multiple': 100, 'Default Vendor': 'Shenzhen Sensor Corp', 'Current Stock': 3100, 'Open PO': 2500, 'Open SO': 1400, 'Status': 'Active' }
  ];
  const itemsWs = XLSX.utils.json_to_sheet(itemsData);
  XLSX.utils.book_append_sheet(wb, itemsWs, 'Items_Master');

  const salesData: any[] = [];
  const periods = [
    '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10',
    '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04',
    '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'
  ];

  const baseMap: Record<string, number> = {
    'ARCH-PRO-50W': 5200, 'ARCH-PRO-100W': 2100, 'IND-HB-150W': 3400,
    'IND-HB-200W': 1800, 'SMART-HUB-V2': 1100, 'SMART-SEN-BLE': 3200
  };

  for (const item of itemsData) {
    const code = item['Item Code'];
    const base = baseMap[code] || 2000;
    periods.forEach(p => {
      salesData.push({
        'Item Code': code,
        'Period': p,
        'Quantity': Math.round(base * (0.9 + Math.random() * 0.25))
      });
    });
  }
  const salesWs = XLSX.utils.json_to_sheet(salesData);
  XLSX.utils.book_append_sheet(wb, salesWs, 'Sales_History');

  const invData = itemsData.map(it => ({
    'Item Code': it['Item Code'],
    'Warehouse': 'WH-05 (South Hub - Bengaluru)',
    'On Hand Stock': it['Current Stock']
  }));
  const invWs = XLSX.utils.json_to_sheet(invData);
  XLSX.utils.book_append_sheet(wb, invWs, 'Inventory_Position');

  const bomData = [
    { 'Parent Item': 'ARCH-PRO-50W', 'Component Code': 'RAW-ALUM-TRACK', 'Component Name': 'Precision Extruded Magnetic Track 1M', 'Qty Per Unit': 1, 'UoM': 'MTR', 'Current Stock': 5000, 'Open PO': 2000 },
    { 'Parent Item': 'ARCH-PRO-50W', 'Component Code': 'RAW-OSRAM-CRI95', 'Component Name': 'Osram Oslon High-CRI LED Board', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 4200, 'Open PO': 3000 },
    { 'Parent Item': 'IND-HB-150W', 'Component Code': 'RAW-DIECAST-UFO', 'Component Name': 'Heavy Aluminum Cold-Forged UFO Heatsink', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 1800, 'Open PO': 1500 },
    { 'Parent Item': 'IND-HB-150W', 'Component Code': 'RAW-SOSEN-DRIVER', 'Component Name': 'Sosen IP67 High-Bay Driver 150W 0-10V', 'Qty Per Unit': 1, 'UoM': 'PCS', 'Current Stock': 900, 'Open PO': 1200 }
  ];
  const bomWs = XLSX.utils.json_to_sheet(bomData);
  XLSX.utils.book_append_sheet(wb, bomWs, 'BOM_Structure');

  const excelBinary = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(excelBinary);
}

/**
 * Builds a 4-month short history dataset (e.g., Q1 Jan to Apr 2026).
 * Demonstrates Tier 2 capability (Basic Statistics, 3-5M, low confidence).
 */
export function generateShortHistoryWorkbook(): Uint8Array {
  const wb = XLSX.utils.book_new();

  const itemsData = [
    { 'Item Code': 'LED-BLB-09W', 'Description': 'Ledure Glitz 9W LED Bulb B22 Cool Daylight', 'Item Group': 'LED Bulbs', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 14, 'MOQ': 1000, 'Order Multiple': 500, 'Default Vendor': 'Ledure Unit 1 (Sonipat)', 'Current Stock': 74000, 'Open PO': 45000, 'Open SO': 18000, 'Status': 'Active' },
    { 'Item Code': 'LED-PNL-36W', 'Description': 'Ledure Slim Edge-lit 2x2ft 36W Recessed Panel', 'Item Group': 'LED Panels', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 21, 'MOQ': 500, 'Order Multiple': 100, 'Default Vendor': 'Ledure Assembly Line 2', 'Current Stock': 8500, 'Open PO': 6000, 'Open SO': 4200, 'Status': 'Active' },
    { 'Item Code': 'LED-DWL-12W', 'Description': 'Ledure Sharp COB Deep Recessed Downlight 12W', 'Item Group': 'LED Downlights', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 18, 'MOQ': 500, 'Order Multiple': 200, 'Default Vendor': 'Ledure Unit 2', 'Current Stock': 6800, 'Open PO': 5000, 'Open SO': 3100, 'Status': 'Active' },
    { 'Item Code': 'LED-BTN-20W', 'Description': 'Ledure Prism 4ft 20W LED Batten Surface Mounted', 'Item Group': 'LED Battens', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 15, 'MOQ': 800, 'Order Multiple': 200, 'Default Vendor': 'Ledure Unit 1 (Sonipat)', 'Current Stock': 28000, 'Open PO': 18000, 'Open SO': 9500, 'Status': 'Active' }
  ];
  const itemsWs = XLSX.utils.json_to_sheet(itemsData);
  XLSX.utils.book_append_sheet(wb, itemsWs, 'Items_Master');

  // Exactly 4 months of history
  const periods = ['2026-01', '2026-02', '2026-03', '2026-04'];
  const salesData: any[] = [];
  const baseMap: Record<string, number> = {
    'LED-BLB-09W': 72000, 'LED-PNL-36W': 12000, 'LED-DWL-12W': 9500, 'LED-BTN-20W': 34000
  };

  itemsData.forEach(it => {
    const code = it['Item Code'];
    const base = baseMap[code] || 10000;
    periods.forEach((p, idx) => {
      salesData.push({
        'Item Code': code,
        'Period': p,
        'Quantity': Math.round(base * (1 + idx * 0.04)) // gentle upward momentum
      });
    });
  });
  const salesWs = XLSX.utils.json_to_sheet(salesData);
  XLSX.utils.book_append_sheet(wb, salesWs, 'Sales_History_4Mo');

  const invData = itemsData.map(it => ({
    'Item Code': it['Item Code'],
    'Warehouse': 'WH-01 (Sonipat Central Plant)',
    'On Hand Stock': it['Current Stock']
  }));
  const invWs = XLSX.utils.json_to_sheet(invData);
  XLSX.utils.book_append_sheet(wb, invWs, 'Inventory_Position');

  const excelBinary = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(excelBinary);
}

/**
 * Builds an incremental +2 month dataset (May & Jun 2026).
 * Merges with the 4-month dataset to expand history to 6 months,
 * triggering automatic model promotion to Tier 3 (Exponential Smoothing).
 */
export function generateIncrementalUpdateWorkbook(): Uint8Array {
  const wb = XLSX.utils.book_new();

  const incrementalSales = [
    { 'Item Code': 'LED-BLB-09W', 'Period': '2026-05', 'Quantity': 82000 },
    { 'Item Code': 'LED-BLB-09W', 'Period': '2026-06', 'Quantity': 86000 },
    { 'Item Code': 'LED-PNL-36W', 'Period': '2026-05', 'Quantity': 13800 },
    { 'Item Code': 'LED-PNL-36W', 'Period': '2026-06', 'Quantity': 14500 },
    { 'Item Code': 'LED-DWL-12W', 'Period': '2026-05', 'Quantity': 10800 },
    { 'Item Code': 'LED-DWL-12W', 'Period': '2026-06', 'Quantity': 11400 },
    { 'Item Code': 'LED-BTN-20W', 'Period': '2026-05', 'Quantity': 38500 },
    { 'Item Code': 'LED-BTN-20W', 'Period': '2026-06', 'Quantity': 40200 },
    // Duplicate of 2026-04 with same value to test duplicate detection
    { 'Item Code': 'LED-BLB-09W', 'Period': '2026-04', 'Quantity': 80640 }
  ];

  const salesWs = XLSX.utils.json_to_sheet(incrementalSales);
  XLSX.utils.book_append_sheet(wb, salesWs, 'Incremental_Sales_May_Jun');

  const excelBinary = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(excelBinary);
}

/**
 * Builds a multi-tier history dataset where different items have
 * distinct history lengths: 24M, 18M, 9M, 4M, and 2M.
 * Verifies per-item adaptive model selection and capability hierarchy.
 */
export function generateMultiTierHistoryWorkbook(): Uint8Array {
  const wb = XLSX.utils.book_new();

  const itemsData = [
    { 'Item Code': 'ITEM-24M-BLB', 'Description': 'LED Bulb 9W Classic (24M Full Telemetry)', 'Item Group': 'LED Bulbs', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 14, 'MOQ': 1000, 'Order Multiple': 500, 'Default Vendor': 'Ledure Unit 1', 'Current Stock': 50000, 'Open PO': 30000, 'Open SO': 15000, 'Status': 'Active' },
    { 'Item Code': 'ITEM-18M-PNL', 'Description': 'LED Panel 36W Commercial (18M Medium-Long Telemetry)', 'Item Group': 'LED Panels', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 21, 'MOQ': 500, 'Order Multiple': 100, 'Default Vendor': 'Assembly Line 2', 'Current Stock': 8000, 'Open PO': 5000, 'Open SO': 3000, 'Status': 'Active' },
    { 'Item Code': 'ITEM-09M-DWL', 'Description': 'LED Downlight Deep COB (9M Mid-Range Telemetry)', 'Item Group': 'LED Downlights', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 18, 'MOQ': 500, 'Order Multiple': 200, 'Default Vendor': 'Assembly Unit 2', 'Current Stock': 4500, 'Open PO': 3500, 'Open SO': 2000, 'Status': 'Active' },
    { 'Item Code': 'ITEM-04M-FLD', 'Description': 'LED Floodlight 100W Marine (4M Early Telemetry)', 'Item Group': 'LED Floodlights', 'UoM': 'PCS', 'Make / Buy': 'Make', 'Planning Method': 'MRP', 'Lead Time Days': 25, 'MOQ': 200, 'Order Multiple': 50, 'Default Vendor': 'Heavy Fab Unit', 'Current Stock': 1200, 'Open PO': 1000, 'Open SO': 800, 'Status': 'Active' },
    { 'Item Code': 'ITEM-02M-STR', 'Description': 'LED Smart Strip RGBW V2 (2M Minimal Telemetry)', 'Item Group': 'LED Strips', 'UoM': 'MTR', 'Make / Buy': 'Buy', 'Planning Method': 'MRP', 'Lead Time Days': 30, 'MOQ': 500, 'Order Multiple': 100, 'Default Vendor': 'Shenzhen Tech Corp', 'Current Stock': 800, 'Open PO': 1500, 'Open SO': 600, 'Status': 'Active' }
  ];
  const itemsWs = XLSX.utils.json_to_sheet(itemsData);
  XLSX.utils.book_append_sheet(wb, itemsWs, 'Items_Master');

  const full24Periods = [
    '2024-11', '2024-12', '2025-01', '2025-02', '2025-03', '2025-04',
    '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10',
    '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04',
    '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'
  ];

  const salesData: any[] = [];

  // ITEM-24M: 24 observations
  full24Periods.forEach(p => {
    salesData.push({ 'Item Code': 'ITEM-24M-BLB', 'Period': p, 'Quantity': Math.round(55000 * (0.9 + Math.random() * 0.25)) });
  });

  // ITEM-18M: 18 observations (from 2025-05 to 2026-10)
  full24Periods.slice(6).forEach(p => {
    salesData.push({ 'Item Code': 'ITEM-18M-PNL', 'Period': p, 'Quantity': Math.round(11000 * (0.9 + Math.random() * 0.25)) });
  });

  // ITEM-09M: 9 observations (from 2026-02 to 2026-10)
  full24Periods.slice(15).forEach(p => {
    salesData.push({ 'Item Code': 'ITEM-09M-DWL', 'Period': p, 'Quantity': Math.round(7200 * (0.9 + Math.random() * 0.25)) });
  });

  // ITEM-04M: 4 observations (from 2026-07 to 2026-10)
  full24Periods.slice(20).forEach(p => {
    salesData.push({ 'Item Code': 'ITEM-04M-FLD', 'Period': p, 'Quantity': Math.round(3100 * (0.9 + Math.random() * 0.25)) });
  });

  // ITEM-02M: 2 observations (from 2026-09 to 2026-10)
  full24Periods.slice(22).forEach(p => {
    salesData.push({ 'Item Code': 'ITEM-02M-STR', 'Period': p, 'Quantity': Math.round(1800 * (0.9 + Math.random() * 0.25)) });
  });

  const salesWs = XLSX.utils.json_to_sheet(salesData);
  XLSX.utils.book_append_sheet(wb, salesWs, 'Sales_History_MultiTier');

  const invData = itemsData.map(it => ({
    'Item Code': it['Item Code'],
    'Warehouse': 'WH-01 (Sonipat Central Plant)',
    'On Hand Stock': it['Current Stock']
  }));
  const invWs = XLSX.utils.json_to_sheet(invData);
  XLSX.utils.book_append_sheet(wb, invWs, 'Inventory_Position');

  const excelBinary = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(excelBinary);
}

/**
 * Downloads a standardized Demandora Demand Planning Excel template
 */
export function downloadExcelTemplate() {
  const binary = generateDemoExcelWorkbook();
  const blob = new Blob([binary.buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Demandora_Demand_Planning_Template.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Exports current forecast result mapped to real Excel workbook
 */
export function exportForecastToExcel(
  lines: ForecastLine[],
  parameters: ForecastParameters,
  status: ForecastStatus,
  version: number,
  monthLabels: string[]
): void {
  const headers = [
    'Forecast Code', 'Version', 'Status', 'Item Code', 'Description', 'Item Group', 'UoM', 'Monthly Avg',
    ...monthLabels,
    'AI Forecast Total', 'Planner Adjustment', 'Final Qty', 'Current Stock', 'Open PO',
    'Net Requirement Before Lot Sizing', 'MOQ', 'Order Multiple', 'Planned Order Qty After Lot Sizing', 'Net Requirement',
    'AI Confidence Pct', 'Planning Method', 'Procurement Type', 'Remark'
  ];

  const rows = lines.map(l => {
    const rowObj: any = {
      'Forecast Code': parameters.forecastCode,
      'Version': version,
      'Status': status,
      'Item Code': l.itemCode,
      'Description': l.description,
      'Item Group': l.itemGroup,
      'UoM': l.uom,
      'Monthly Avg': l.avgPerMonth
    };

    l.monthlyForecast.forEach((val: number, i: number) => {
      rowObj[monthLabels[i]] = val;
    });

    rowObj['AI Forecast Total'] = l.aiTotal;
    rowObj['Planner Adjustment'] = l.plannerAdj !== null && l.plannerAdj !== undefined ? l.plannerAdj : '';
    rowObj['Final Qty'] = l.finalQty;
    rowObj['Current Stock'] = l.stock !== null && l.stock !== undefined ? l.stock : 'Unknown';
    rowObj['Open PO'] = l.openPo !== null && l.openPo !== undefined ? l.openPo : 'Unknown';
    rowObj['Net Requirement Before Lot Sizing'] = l.planningMethod !== 'MRP'
      ? 'Not planned by MRP'
      : l.isDiscontinued
        ? 0
        : l.rawNetReq !== null && l.rawNetReq !== undefined
          ? l.rawNetReq
          : 'Not Evaluated — Missing Supply Data';
    rowObj['MOQ'] = l.moq !== undefined ? l.moq : 500;
    rowObj['Order Multiple'] = l.orderMultiple !== undefined ? l.orderMultiple : 1;
    rowObj['Planned Order Qty After Lot Sizing'] = l.planningMethod !== 'MRP'
      ? 'Not planned by MRP'
      : l.isDiscontinued
        ? 0
        : (l.plannedOrderQty ?? l.netReq) !== null && (l.plannedOrderQty ?? l.netReq) !== undefined
          ? (l.plannedOrderQty ?? l.netReq)!
          : 'Not Evaluated — Missing Supply Data';
    rowObj['Net Requirement'] = l.planningMethod !== 'MRP'
      ? 'Not planned by MRP'
      : l.isDiscontinued
        ? 0
        : (l.plannedOrderQty ?? l.netReq) !== null && (l.plannedOrderQty ?? l.netReq) !== undefined
          ? (l.plannedOrderQty ?? l.netReq)!
          : 'Not Evaluated — Missing Supply Data';
    rowObj['AI Confidence Pct'] = l.confidencePct !== null && l.confidencePct !== undefined ? `${l.confidencePct.toFixed(1)}%` : 'Not evaluated';
    rowObj['Planning Method'] = l.planningMethod;
    rowObj['Procurement Type'] = l.makeBuy;
    rowObj['Remark'] = l.remark || '';
    
    return rowObj;
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  XLSX.utils.book_append_sheet(wb, ws, 'Forecast_Export');
  
  const excelBinary = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBinary], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  
  // Create download (browser only)
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Demandora_Demand_Plan_${parameters.forecastCode}_v${version}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
