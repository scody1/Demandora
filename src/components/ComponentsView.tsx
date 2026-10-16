import React, { useState, useMemo } from 'react';
import { ForecastLine, NormalizedDataset, ComponentRequirementRow, ForecastParameters } from '../types';
import { formatNumber, getMonthLabels } from './UI';
import { Cpu, Search, AlertTriangle, CheckCircle2, Factory, Package } from 'lucide-react';

interface ComponentsViewProps {
  lines: ForecastLine[];
  dataset: NormalizedDataset;
  parameters: ForecastParameters;
}

export function ComponentsView({ lines, dataset, parameters }: ComponentsViewProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [shortagesOnly, setShortagesOnly] = useState(false);

  // BOM explosion calculation
  const componentRequirements = useMemo<ComponentRequirementRow[]>(() => {
    const rows: ComponentRequirementRow[] = [];
    const monthLabels = getMonthLabels(parameters.startMonth, parameters.horizon);

    const explode = (
      parentCode: string,
      parentDesc: string,
      parentQty: number,
      level: number,
      visited: Set<string>
    ) => {
      if (level > 8 || visited.has(parentCode)) return;
      const nextVisited = new Set(visited);
      nextVisited.add(parentCode);

      const itemBOMs = dataset.boms.filter(b => b.parentItemCode === parentCode);
      itemBOMs.forEach((bom, bIdx) => {
        const reqQty = Math.round(parentQty * bom.qtyPerUnit);
        const stock = bom.currentStock || 0;
        const openPo = bom.openPo || 0;
        const shortage = Math.max(reqQty - stock - openPo, 0);

        rows.push({
          id: `${parentCode}-${bom.componentCode}-${level}-${bIdx}`,
          parentItemCode: parentCode,
          parentDescription: parentDesc,
          componentCode: bom.componentCode,
          componentName: bom.componentName,
          qtyPerUnit: bom.qtyPerUnit,
          requiredQty: reqQty,
          stock,
          openPo,
          shortage,
          month: monthLabels[0] || 'Month 1',
          uom: bom.uom,
          level
        });

        // Recursively explode if this component is also a parent/sub-assembly in BOMs
        const isSubassembly = dataset.boms.some(b => b.parentItemCode === bom.componentCode);
        if (isSubassembly && reqQty > 0) {
          explode(bom.componentCode, bom.componentName || bom.componentCode, reqQty, level + 1, nextVisited);
        }
      });
    };

    lines.forEach(line => {
      if (line.makeBuy === 'Make') {
        explode(line.itemCode, line.description, line.finalQty, 1, new Set());
      }
    });

    return rows;
  }, [lines, dataset.boms, parameters.startMonth, parameters.horizon]);

  const totalShortagesCount = useMemo(() => {
    return componentRequirements.filter(r => r.shortage > 0).length;
  }, [componentRequirements]);

  const filteredRows = useMemo(() => {
    return componentRequirements.filter(r => {
      if (shortagesOnly && r.shortage <= 0) return false;
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        return (
          r.componentCode.toLowerCase().includes(q) ||
          r.componentName.toLowerCase().includes(q) ||
          r.parentItemCode.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [componentRequirements, shortagesOnly, searchTerm]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Workspace Header */}
      <div className="workspace-header-bar">
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Cpu size={18} color="var(--ai-primary)" />
            BOM COMPONENT EXPLOSION & RAW MATERIAL REQUIREMENTS
          </h2>
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
            Explosion of in-house 'Make' parent items into raw material and sub-assembly demand based on Final Quantity
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">Make Parent SKUs</span>
            <span className="bento-tag blue">In-House</span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num" style={{ color: 'var(--text-primary)' }}>
              {lines.filter(l => l.makeBuy === 'Make').length}
            </span>
          </div>
          <span className="bento-subtext">Assembly lines requiring components</span>
        </div>

        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">BOM Component Links</span>
            <span className="bento-tag blue">BOM Graph</span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num" style={{ color: 'var(--ai-primary)' }}>
              {componentRequirements.length}
            </span>
          </div>
          <span className="bento-subtext">Active raw material dependencies</span>
        </div>

        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">Component Shortages</span>
            <span className={`bento-tag ${totalShortagesCount > 0 ? 'red' : 'green'}`}>
              {totalShortagesCount > 0 ? 'Action Needed' : 'Covered'}
            </span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num" style={{ color: totalShortagesCount > 0 ? 'var(--danger)' : 'var(--success)' }}>
              {totalShortagesCount}
            </span>
          </div>
          <span className="bento-subtext">Required qty &gt; stock + open PO</span>
        </div>

        <div className="bento-intel-card">
          <div className="bento-card-top">
            <span className="bento-label">Procurement Status</span>
            <span className="bento-tag green">Pipeline</span>
          </div>
          <div className="bento-value-row">
            <span className="bento-val-large num" style={{ color: '#047857' }}>
              {componentRequirements.filter(r => r.openPo > 0).length} POs
            </span>
          </div>
          <span className="bento-subtext">In-transit raw materials tracked</span>
        </div>
      </div>

      {/* Components Grid */}
      <div className="workspace-table-card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="toolbar-search-wrapper" style={{ width: 240 }}>
              <Search size={13} color="#64748b" />
              <input
                type="text"
                placeholder="Filter component or SKU..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={shortagesOnly}
                onChange={(e) => setShortagesOnly(e.target.checked)}
              />
              <span>Highlight Net Shortages Only</span>
            </label>
          </div>

          <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            Showing <strong>{filteredRows.length}</strong> of <strong>{componentRequirements.length}</strong> component requirements
          </span>
        </div>

        <div className="modern-table-container">
          <table className="modern-data-table">
            <thead>
              <tr>
                <th>Parent Item</th>
                <th>Component Code</th>
                <th>Component Description</th>
                <th style={{ textAlign: 'center' }}>Per Unit</th>
                <th style={{ textAlign: 'center' }}>UoM</th>
                <th style={{ textAlign: 'right' }}>Total Required</th>
                <th style={{ textAlign: 'right' }}>On-Hand Stock</th>
                <th style={{ textAlign: 'right' }}>Open PO</th>
                <th style={{ textAlign: 'right' }}>Net Shortage</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(r => (
                <tr key={r.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--ai-primary)' }}>
                    {r.parentItemCode}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                    {r.componentCode}
                  </td>
                  <td>{r.componentName}</td>
                  <td style={{ textAlign: 'center' }} className="num">{r.qtyPerUnit}</td>
                  <td style={{ textAlign: 'center' }} className="num">{r.uom}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }} className="num">
                    {formatNumber(r.requiredQty)}
                  </td>
                  <td style={{ textAlign: 'right' }} className="num">
                    {formatNumber(r.stock)}
                  </td>
                  <td style={{ textAlign: 'right' }} className="num">
                    {formatNumber(r.openPo)}
                  </td>
                  <td style={{ textAlign: 'right' }} className="num">
                    {r.shortage > 0 ? (
                      <span style={{ color: 'var(--danger)', fontWeight: 800, background: 'var(--danger-subtle)', padding: '2px 8px', borderRadius: 4 }}>
                        {formatNumber(r.shortage)} Short
                      </span>
                    ) : (
                      <span style={{ color: 'var(--success)', fontWeight: 600 }}>Covered</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
