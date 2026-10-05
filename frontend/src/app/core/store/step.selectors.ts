import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { StepStateSlice } from './step.reducer';
import type { BridgeRow, ReadingRow, StepRow } from '../utils/db';
import { SYNC_REQUIREMENT_LABEL, syncLayoutHint, type StepView } from '../types/step';
import { meanDisplacement } from '../types/reading';
import { syncLevel, SYNC_TOLERANCE_MM, type ToleranceLevel } from '../utils/tolerance';
import {
  buildReadingBatches,
  shortBatchLabel,
  summarizeStepBatches,
  type ReadingBatch,
} from '../utils/reading-batch';

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

/** 按步骤分组批次（批次 = 同步骤 + 同记录时间，批内同测点取最后提交） */
export function selectStepBatches(readings: ReadingRow[]): Map<string, ReadingBatch[]> {
  const grouped = new Map<string, ReadingBatch[]>();
  for (const batch of buildReadingBatches(readings)) {
    const list = grouped.get(batch.stepId) ?? [];
    list.push(batch);
    grouped.set(batch.stepId, list);
  }
  return grouped;
}

/** 步骤视图：含累计顶升量、最差批次同步偏差与校验结论 */
export function buildStepViews(steps: StepRow[], readings: ReadingRow[], bridges: BridgeRow[]): StepView[] {
  const bridgeName = new Map(bridges.map((item) => [item.id, item.name]));
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  const batchesByStep = selectStepBatches(readings);
  let running = 0;
  return ordered.map((step) => {
    running += step.targetLiftMm;
    const stepBatches = batchesByStep.get(step.id) ?? [];
    const summary = summarizeStepBatches(stepBatches);
    const deviation = summary.worstDeviationMm;
    const rowCount = readings.filter((item) => item.stepId === step.id).length;
    const cumulativeLiftMm = Number(running.toFixed(2));
    const overLimit = cumulativeLiftMm > step.limitMm;
    return {
      ...step,
      bridgeName: bridgeName.get(step.bridgeId) ?? '未归属桥梁',
      cumulativeLiftMm,
      overLimit,
      readingCount: rowCount,
      batchCount: summary.batchCount,
      syncDeviationMm: deviation,
      worstBatchLabel: summary.worstBatchLabel,
      worstBatchSeq: summary.worstBatchSeq,
      validation: overLimit
        ? `累计顶升量 ${cumulativeLiftMm} mm 超过限位 ${step.limitMm} mm`
        : deviation !== null && deviation > SYNC_TOLERANCE_MM
          ? `第 ${summary.worstBatchSeq} 批（${shortBatchLabel(summary.worstBatchLabel ?? '')}）同步偏差 ${deviation.toFixed(
              2,
            )} mm 超允许值`
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
  const result: Record<string, ToleranceLevel> = {};
  const batchesByStep = selectStepBatches(readings);
  for (const step of steps) {
    const summary = summarizeStepBatches(batchesByStep.get(step.id) ?? []);
    result[step.id] = syncLevel(summary.worstDeviationMm ?? 0);
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

/** 各步骤最近一批平均位移（测点页展示） */
export const selectStepAverages = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const result: Record<string, number> = {};
  const batchesByStep = selectStepBatches(readings);
  for (const step of steps) {
    const stepBatches = batchesByStep.get(step.id) ?? [];
    const latest = stepBatches[stepBatches.length - 1];
    result[step.id] = latest ? meanDisplacement(latest.effective) : 0;
  }
  return result;
});
