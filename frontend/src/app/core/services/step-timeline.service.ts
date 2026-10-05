/**
 * 顶升步骤时间线服务（Angular 以 Injectable 实现 useStepTimeline 语义）
 * 提供顶升步骤时间线、累计顶升量与同步偏差的 RxJS 派生流，
 * 被顶升步骤页、测点读数页消费。
 *
 * 同步偏差口径：顶升班组逐批录入位移，按“每批极差”逐批计算后取最差的一批；
 * 同一测点同批改过多条时以最后提交的一条为准，单点批不参与偏差评定；
 * 早期读数没有批次号，按步骤 + 记录时间归成一批。
 */
import { Injectable, inject } from '@angular/core';
import { Observable, combineLatest, map, shareReplay } from 'rxjs';
import { IdbTableService } from './idb-table.service';
import { listBearings, listBridges, listReadings, listSteps } from '../utils/db';
import type { BridgeRow, BearingRow, ReadingRow, StepRow } from '../utils/db';
import {
  SYNC_REQUIREMENT_LABEL,
  sortSteps,
  type StepView,
} from '../types/step';
import {
  batchLabel,
  buildStepBatchReports,
  meanDisplacement,
  readingBatchKey,
  type ReadingView,
} from '../types/reading';
import { overallLevel, syncLevel, type ToleranceLevel } from '../utils/tolerance';

/** 步骤时间线的一级节点 */
export interface StepTimelineNode {
  step: StepView;
  /** 该步骤的读数（含批次与批内偏差） */
  readings: ReadingView[];
  /** 同步偏差等级（最差批次） */
  deviationLevel: ToleranceLevel;
  /** 综合限位等级 */
  limitLevel: ToleranceLevel;
}

/** 时间线汇总 */
export interface StepTimelineSnapshot {
  steps: StepRow[];
  readings: ReadingRow[];
  bearings: BearingRow[];
  bridges: BridgeRow[];
}

@Injectable({ providedIn: 'root' })
export class StepTimelineService {
  private readonly idb = inject(IdbTableService);

  /** 原始快照流 */
  readonly snapshot$: Observable<StepTimelineSnapshot> = this.idb
    .watch<StepTimelineSnapshot>(
      async () => {
        const [steps, readings, bearings, bridges] = await Promise.all([
          listSteps(),
          listReadings(),
          listBearings(),
          listBridges(),
        ]);
        return { steps, readings, bearings, bridges };
      },
      { steps: [], readings: [], bearings: [], bridges: [] },
    )
    .pipe(shareReplay({ bufferSize: 1, refCount: true }));

  /** 步骤视图流：含累计顶升量、最差批次同步偏差与校验结论 */
  readonly stepViews$: Observable<StepView[]> = this.snapshot$.pipe(
    map((snapshot) => this.buildStepViews(snapshot)),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 时间线节点流：步骤 + 该步读数 + 等级判定 */
  readonly timeline$: Observable<StepTimelineNode[]> = combineLatest([
    this.stepViews$,
    this.snapshot$,
  ]).pipe(
    map(([steps, snapshot]) => {
      const bridges = new Map(snapshot.bridges.map((item) => [item.id, item.name]));
      const reports = buildStepBatchReports(snapshot.readings);
      return steps.map((step) => {
        const report = reports.get(step.id);
        const stepReadings: ReadingView[] = [];
        for (const batch of report?.batches ?? []) {
          const effectiveIds = new Set(batch.rows.map((row) => row.id));
          const average = meanDisplacement(batch.rows);
          const label = batchLabel(batch);
          for (const reading of snapshot.readings.filter((item) => readingBatchKey(item) === batch.batchId)) {
            stepReadings.push({
              ...reading,
              stepSeq: step.seq,
              bridgeId: step.bridgeId,
              bridgeName: bridges.get(step.bridgeId) ?? '未归属桥梁',
              syncRequirement: SYNC_REQUIREMENT_LABEL[step.syncRequirement],
              effectiveBatchId: batch.batchId,
              batchSeq: batch.seq,
              batchLabel: label,
              deviationMm: effectiveIds.has(reading.id)
                ? Number((reading.displacementMm - average).toFixed(3))
                : 0,
              batchDeviationMm: batch.deviationMm,
              superseded: !effectiveIds.has(reading.id),
              overLimit: Math.abs(reading.displacementMm) >= step.limitMm,
              stressAlert: reading.stressMpa >= 12,
            });
          }
        }
        const effectiveReadings = stepReadings.filter((reading) => !reading.superseded);
        return {
          step,
          readings: stepReadings.sort((a, b) =>
            a.batchSeq === b.batchSeq ? a.recordedAt.localeCompare(b.recordedAt) : a.batchSeq - b.batchSeq,
          ),
          deviationLevel: syncLevel(step.syncDeviationMm ?? 0),
          limitLevel: effectiveReadings.reduce<ToleranceLevel>((worst, reading) => {
            const level = overallLevel(reading.displacementMm, step.limitMm, reading.stressMpa);
            if (level === 'exceed' || worst === 'exceed') return 'exceed';
            if (level === 'watch' || worst === 'watch') return 'watch';
            return 'ok';
          }, 'ok' as ToleranceLevel),
        };
      });
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 按桥梁分组的步骤流 */
  readonly stepsByBridge$: Observable<Map<string, StepView[]>> = this.stepViews$.pipe(
    map((steps) => {
      const grouped = new Map<string, StepView[]>();
      for (const step of steps) {
        const list = grouped.get(step.bridgeId) ?? [];
        list.push(step);
        grouped.set(step.bridgeId, list);
      }
      return grouped;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 累计顶升量流：桥梁 id → 累计值 */
  readonly cumulativeLift$: Observable<Record<string, number>> = this.stepViews$.pipe(
    map((steps) => {
      const totals: Record<string, number> = {};
      for (const step of steps) {
        totals[step.bridgeId] = Number(((totals[step.bridgeId] ?? 0) + step.targetLiftMm).toFixed(2));
      }
      return totals;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 同步偏差流：步骤 id → 最差批次极差 */
  readonly syncDeviation$: Observable<Record<string, number>> = this.snapshot$.pipe(
    map((snapshot) => {
      const reports = buildStepBatchReports(snapshot.readings);
      const result: Record<string, number> = {};
      for (const step of snapshot.steps) {
        result[step.id] = reports.get(step.id)?.worstDeviationMm ?? 0;
      }
      return result;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 构建步骤视图（供派生流与页面共用） */
  buildStepViews(snapshot: StepTimelineSnapshot): StepView[] {
    const bridgeName = new Map(snapshot.bridges.map((item) => [item.id, item.name]));
    const ordered = sortSteps(snapshot.steps);
    const cumulative = new Map<string, number>();
    let running = 0;
    for (const step of ordered) {
      running += step.targetLiftMm;
      cumulative.set(step.id, Number(running.toFixed(2)));
    }
    const reports = buildStepBatchReports(snapshot.readings);
    return ordered.map((step) => {
      const rows = snapshot.readings.filter((item) => item.stepId === step.id);
      const report = reports.get(step.id);
      const worst = report?.worstBatch ?? null;
      const worstLabel = worst ? batchLabel(worst) : null;
      const deviation = worst?.deviationMm ?? null;
      const cumulativeLiftMm = cumulative.get(step.id) ?? step.targetLiftMm;
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
          ? `累计顶升量 ${cumulativeLiftMm} mm 已超过限位 ${step.limitMm} mm，需立即停止并复核`
          : deviation !== null && worstLabel && syncLevel(deviation) === 'exceed'
            ? `${worstLabel}同步偏差 ${deviation.toFixed(2)} mm 超允许值，需调平后继续`
            : '顶升参数与监测数据均在控制范围内',
      };
    });
  }
}
