// Read-only rerating of archived published candidate geometry. This is not a historical replay.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const { calculateTradeExpectancyPlan } = require(path.join(root, 'smc_engine/src/tradeExpectancyEngine.ts'));
const queue = JSON.parse(fs.readFileSync(path.join(root, 'smc_engine/data/signal_delivery_queue.json'), 'utf8'));
const results = [];
for (const item of queue) {
  if (!['SENT', 'SCREENSHOT_FAILED'].includes(item.state)) continue;
  if (!Number.isFinite(Date.parse(item.telegramSentAt ?? ''))) continue;
  const c = item.candidate;
  try {
    const low = c.poiType === 'OB' ? c.poi.low : c.poi.gapLow;
    const high = c.poiType === 'OB' ? c.poi.high : c.poi.gapHigh;
    const input = { symbol: c.symbol, direction: c.tradeDirection, zoneLow: low, zoneHigh: high,
      currentPrice: c.currentPrice, grade: c.gradeResult.grade, totalScore: c.gradeResult.totalScore,
      atr15mPips: c.atr15mPips, liquidityMagnet: c.liquidityMagnet, opposingObstacle: c.opposingObstacle,
      macroEvaluation: c.macroEvaluation };
    const reference = calculateTradeExpectancyPlan(input);
    const rawNetRR = (reference.primaryRR - reference.estimatedCostR) / (1 + reference.estimatedCostR);
    // Freeze the target, stop and cost distance; moving the reference entry must not move the goalpost.
    // The zone edge is a hypothetical entry, not an observed fill or an M1 setup.
    const alternateEntry = c.tradeDirection === 'long' ? low : high;
    const risk = Math.abs(alternateEntry - reference.stopLoss);
    const reward = (c.tradeDirection === 'long' ? 1 : -1) * (reference.tp2.price - alternateEntry);
    const costDistance = reference.estimatedCostR * Math.abs(reference.entryPrice - reference.stopLoss);
    const alternateNetRR = (reward - costDistance) / (risk + costDistance);
    results.push({ signalId: item.signalId, symbol: c.symbol, sentAt: item.telegramSentAt,
      model: 'ARCHIVED_GEOMETRY_ONLY', oldPlanVersion: c.expectancyPlan?.version ?? null,
      netRR: rawNetRR, grossRR: reference.primaryRR, costR: reference.estimatedCostR,
      constraint: reference.targetConstraint, stopSource: reference.stopVolatilitySource,
      pass15: rawNetRR >= 1.5, pass175: rawNetRR >= 1.75,
      pass20: rawNetRR >= 2,
      alternateZoneEdgeNetRR: alternateNetRR,
      rejectedReferenceButZoneEdgeFeasible: !reference.isAdmissible && alternateNetRR >= 2 && reference.targetConstraint !== 'SYNTHETIC_FALLBACK' });
  } catch (error) { results.push({ signalId: item.signalId, error: String(error.message) }); }
}
const usable = results.filter(r => !r.error);
const subset = rows => ({ n: rows.length, pass15: rows.filter(r => r.pass15).length,
  pass175: rows.filter(r => r.pass175).length, pass20: rows.filter(r => r.pass20).length,
  rejectedReferenceButZoneEdgeFeasible: rows.filter(r => r.rejectedReferenceButZoneEdgeFeasible).length });
const summary = { archivedPublished: results.length, usable: usable.length,
  pass15: usable.filter(r => r.pass15).length, pass175: usable.filter(r => r.pass175).length,
  pass20: usable.filter(r => r.pass20).length,
  rejectedReferenceButZoneEdgeFeasible: usable.filter(r => r.rejectedReferenceButZoneEdgeFeasible).length,
  costExceedsFallbackThreshold: usable.filter(r => r.costR > 1 / 6).length,
  stopSources: Object.fromEntries([...new Set(usable.map(r => r.stopSource))].map(k => [k, usable.filter(r => r.stopSource === k).length])),
  storedAtrOnly: subset(usable.filter(r => r.stopSource === 'ATR')),
  withArchivedPlan: subset(usable.filter(r => r.oldPlanVersion === 'v1.0')),
  constraints: Object.fromEntries([...new Set(usable.map(r => r.constraint))].map(k => [k, usable.filter(r => r.constraint === k).length])),
  interpretation: 'Feasibility sensitivity only. Stored magnet/obstacle snapshots are not a full reconstruction of historical pools; no manual fill or PnL is inferred.' };
fs.writeFileSync(path.join(__dirname, 'geometry_results.json'), JSON.stringify({ summary, results }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
