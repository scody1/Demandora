import { ForecastStatus, ForecastVersion, ForecastResult, ForecastParameters } from '../types';

export const VersionService = {
  forkVersionIfNeeded(
    currentStatus: ForecastStatus,
    currentVersion: number,
    currentUser: string,
    parameters: ForecastParameters,
    forecastResult: ForecastResult,
    newStatus: ForecastStatus
  ): { newVersion: number, newSnapshot: ForecastVersion } {
    let nextVer = currentVersion;
    if (currentStatus === 'Approved' || currentStatus === 'Submitted') {
      nextVer = currentVersion + 1;
    }
    
    const newSnapshot: ForecastVersion = {
      version: nextVer,
      date: new Date().toISOString().slice(0, 19).replace('T', ' '),
      user: currentUser,
      parameters: { ...parameters },
      status: newStatus,
      adjustmentsCount: forecastResult.lines.filter(l => l.plannerAdj !== null).length,
      aiTotal: forecastResult.kpis.aiForecastTotal,
      finalQty: forecastResult.kpis.finalQtyTotal,
      netReqTotal: forecastResult.kpis.netRequirementTotal,
      avgConfidencePct: forecastResult.kpis.avgConfidencePct,
      linesSnapshot: [...forecastResult.lines]
    };
    
    return { newVersion: nextVer, newSnapshot };
  },

  checkUnsavedChanges(originalLines: any[], currentLines: any[]): boolean {
    if (originalLines.length !== currentLines.length) return true;
    for (let i = 0; i < originalLines.length; i++) {
      if (originalLines[i].plannerAdj !== currentLines[i].plannerAdj) return true;
      if (originalLines[i].remark !== currentLines[i].remark) return true;
    }
    return false;
  }
};
