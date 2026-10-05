import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { StepStateSlice } from './step.reducer';
import type { BridgeRow, ReadingRow, StepRow } from '../utils/db';
import { SYNC_REQUIREMENT_LABEL, syncLayoutHint, type StepView } from '../types/step';
import {
  batchLabel,
  buildStepBatchReports,
  meanDisplacement,
} from '../types/reading';
import { syncLevel, type ToleranceLevel } from '../utils/tolerance';

export const selectStepState = createFeatureSelector<StepStateSlice>('step');
export const selectSteps = createSelector(selectStepState, (state) => state.steps);
export const selectReadings = createSelector(selectStepState, (state) => state.readings);
export const selectActiveStepBridgeId = createSelector(selectStepState, (state) => state.activeBridgeId);

/** 按桥梁分组 */
export const selectStepsByBridge = createSelector(selectSteps, (steps) => {
  const grouped = new Map<string, StepRow[]>();
  for (const step of steps) {
    const list = grouped.get(step.bridgeId) ?? [];
    list.push(step);
    grouped.set(step.bridgeId, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => a.seq - b.seq);
  return grouped;
});

/** 找出受影响桥梁的步骤列表 */
export const selectActiveSteps = createSelector(
  selectSteps,
  selectActiveStepBridgeId,
  (steps, bridgeId) => steps.filter((item) => !bridgeId || item.bridgeId === bridgeId).sort((a, b) => a.seq - b.seq),
);

/**
 * 步骤视图：含累计顶升量、按批计算的最差同步偏差与校验结论。
 * 同步偏差按“每批极差”逐批计算后取最差的一批，
 * 同一测点同批多条时以最后提交的一条为准，单点批不参与评定。
 */
export function buildStepViews(steps: StepRow[], readings: ReadingRow[], bridges: BridgeRow[]): StepView[] {
  const bridgeName = new Map(bridges.map((item) => [item.id, item.name]));
  const batchReports = buildStepBatchReports(readings);
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  let running = 0;
  return ordered.map((step) => {
    running += step.targetLiftMm;
    const rows = readings.filter((item) => item.stepId === step.id);
    const report = batchReports.get(step.id);
    const worst = report?.worstBatch ?? null;
    const worstLabel = worst ? batchLabel(worst) : null;
    const deviation = worst?.deviationMm ?? null;
    const cumulativeLiftMm = Number(running.toFixed(2));
    const overLimit = cumulativeLiftMm > step.limitMm;
    return {
      ...step,
      bridgeName: bridgeName.get(step.bridgeId) ?? '未归属桥梁',
      cumulativeLiftMm,
      overLimit,
      readingCount: rows.length,
      batchCount: report?.batches.length ?? 0,
      ratedBatchCount: report?.ratedBatchCount ?? 0,
      syncDeviationMm: deviation,
      worstBatchSeq: worst?.seq ?? null,
      worstBatchLabel: worstLabel,
      validation: overLimit
        ? `累计顶升量 ${cumulativeLiftMm} mm 超过限位 ${step.limitMm} mm`
        : deviation !== null && worstLabel
          ? syncLevel(deviation) === 'exceed'
            ? `${worstLabel}同步偏差 ${deviation.toFixed(2)} mm 超允许值`
            : `同步偏差 ${deviation.toFixed(2)} mm（${worstLabel}最差）`
          : '顶升参数与监测数据均在控制范围内',
    };
  });
}

/** 步骤统计：总级数、累计顶升量、就位数、超限数 */
export const selectStepStats = createSelector(selectSteps, selectReadings, (steps, readings) => {
  const cumulative = steps.reduce((sum, item) => sum + item.targetLiftMm, 0);
  return {
    total: steps.length,
    cumulativeMm: Number(cumulative.toFixed(2)),
    arrived: steps.filter((item) => item.state === 'arrived').length,
    lifting: steps.filter((item) => item.state === 'lifting').length,
    idle: steps.filter((item) => item.state === 'idle').length,
    readingCount: readings.length,
    maxLimitMm: steps.reduce((max, item) => Math.max(max, item.limitMm), 0),
  };
});

/** 同步偏差等级（按步骤最差批次） */
export const selectSyncLevels = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const reports = buildStepBatchReports(readings);
  const result: Record<string, ToleranceLevel> = {};
  for (const step of steps) {
    result[step.id] = syncLevel(reports.get(step.id)?.worstDeviationMm ?? 0);
  }
  return result;
});

/** 步骤同步布置建议 */
export const selectSyncHints = createSelector(selectSteps, (steps) =>
  steps.map((step) => ({
    id: step.id,
    seq: step.seq,
    requirement: SYNC_REQUIREMENT_LABEL[step.syncRequirement],
    hint: syncLayoutHint(step.syncRequirement),
  })),
);

/** 各步骤平均位移（按批次去重后的有效读数，测点页展示） */
export const selectStepAverages = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const reports = buildStepBatchReports(readings);
  const result: Record<string, number> = {};
  for (const step of steps) {
    const report = reports.get(step.id);
    const effective = report ? report.batches.flatMap((batch) => batch.rows) : [];
    result[step.id] = meanDisplacement(effective);
  }
  return result;
});
