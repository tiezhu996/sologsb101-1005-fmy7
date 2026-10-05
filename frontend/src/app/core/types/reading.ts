import type { RowMeta } from './persistence';

/** 测点读数 */
export interface Reading extends RowMeta {
  id: string;
  /** 所属顶升步骤 */
  stepId: string;
  /** 测点编号，如 P1、J-2 */
  pointCode: string;
  /** 位移（mm） */
  displacementMm: number;
  /** 应力（MPa） */
  stressMpa: number;
  /** 记录时间 yyyy-MM-dd HH:mm */
  recordedAt: string;
  /** 记录人 */
  operator: string;
  /**
   * 批次号：顶升班组每提交一批读数共用一个批次号。
   * 早期读数没有该字段，按“步骤 + 记录时间”归批（见 readingBatchKey）。
   */
  batchId?: string;
}

/** 测点读数表单草稿 */
export interface ReadingDraft {
  stepId: string;
  pointCode: string;
  displacementMm: number;
  stressMpa: number;
  recordedAt: string;
  operator: string;
}

/** 测点读数视图：带步骤上下文、批次信息与批内偏差 */
export interface ReadingView extends Reading {
  stepSeq: number;
  bridgeId: string;
  bridgeName: string;
  syncRequirement: string;
  /** 有效批次号（无 batchId 的早期读数按步骤 + 记录时间归批） */
  effectiveBatchId: string;
  /** 该批在步骤内的序号（按记录时间从 1 开始） */
  batchSeq: number;
  /** 批次标签，如 第2批（09:15） */
  batchLabel: string;
  /** 同批内相对平均位移的偏差（mm） */
  deviationMm: number;
  /** 所属批次的极差（mm）；单点批为 null */
  batchDeviationMm: number | null;
  /** 同一测点在该批内被后提交的读数更正（本条不再参与偏差计算） */
  superseded: boolean;
  /** 是否超过限位值 */
  overLimit: boolean;
  /** 应力是否超过关注值 */
  stressAlert: boolean;
}

/** 同一步骤的批量录入行 */
export interface ReadingBatchRow {
  pointCode: string;
  displacementMm: number;
  stressMpa: number;
}

/** 批次统计所需的最小读数结构 */
export interface ReadingBatchInput {
  id: string;
  stepId: string;
  pointCode: string;
  displacementMm: number;
  recordedAt: string;
  createdAt?: string;
  batchId?: string;
}

/** 单批统计结果 */
export interface ReadingBatchStat {
  /** 批次号（有 batchId 用 batchId，否则用步骤+记录时间归批键） */
  batchId: string;
  stepId: string;
  /** 批次记录时间（同批一致） */
  recordedAt: string;
  /** 该批在步骤内按记录时间排序的序号（从 1 开始） */
  seq: number;
  /** 批内有效读数（同一测点仅保留最后提交的一条） */
  rows: ReadingBatchInput[];
  /** 批内有效读数条数（去重后） */
  pointCount: number;
  /** 批内极差（mm）：最大位移 − 最小位移；单点批为 null，不参与同步偏差评定 */
  deviationMm: number | null;
}

/** 步骤批次汇总 */
export interface StepBatchReport {
  stepId: string;
  /** 该步骤的全部批次（按记录时间排序，已编号） */
  batches: ReadingBatchStat[];
  /** 参与偏差评定的批次数（剔除单点批） */
  ratedBatchCount: number;
  /** 最差批次；没有多点批时为 null */
  worstBatch: ReadingBatchStat | null;
  /** 最差批次的极差（mm）；单点步骤 / 无读数为 null */
  worstDeviationMm: number | null;
}

/** 测点编号建议：按同步要求给出四角测点 */
export const POINT_CODES: string[] = ['P1', 'P2', 'P3', 'P4', 'J1', 'J2', 'J3', 'J4'];

/** 应力关注值（MPa）：超过即提示复核 */
export const STRESS_ALERT_MPA = 12;

/** 批量生成测点编号 */
export function suggestPointCodes(bearingCount: number): string[] {
  const count = Math.max(2, Math.min(POINT_CODES.length, bearingCount * 2));
  return POINT_CODES.slice(0, count);
}

/** 位移平均 */
export function meanDisplacement(rows: Array<{ displacementMm: number }>): number {
  if (rows.length === 0) return 0;
  return Number((rows.reduce((sum, item) => sum + item.displacementMm, 0) / rows.length).toFixed(3));
}

/** 同步偏差（mm）：最大位移 − 最小位移 */
export function syncDeviationMm(rows: Array<{ displacementMm: number }>): number {
  if (rows.length === 0) return 0;
  const values = rows.map((item) => item.displacementMm);
  return Number((Math.max(...values) - Math.min(...values)).toFixed(3));
}

/**
 * 早期读数没有批次号，按“步骤 + 记录时间”归成一批。
 * 新读数携带 batchId，直接以 batchId 归批。
 */
export function readingBatchKey(reading: Pick<ReadingBatchInput, 'stepId' | 'recordedAt' | 'batchId'>): string {
  return reading.batchId || `legacy:${reading.stepId}:${reading.recordedAt}`;
}

/**
 * 提交先后排序：同一测点在一批里改过两条，以最后提交的那条为准。
 * 先按入库时间（createdAt / id 均为单调递增），再按记录时间兜底。
 */
function bySubmittedAt(a: ReadingBatchInput, b: ReadingBatchInput): number {
  const created = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  if (created !== 0) return created;
  const recorded = a.recordedAt.localeCompare(b.recordedAt);
  if (recorded !== 0) return recorded;
  return a.id.localeCompare(b.id);
}

/** 批内去重：同一测点只保留最后提交的一条读数 */
export function latestPerPoint(rows: ReadingBatchInput[]): ReadingBatchInput[] {
  const latest = new Map<string, ReadingBatchInput>();
  for (const row of [...rows].sort(bySubmittedAt)) {
    latest.set(row.pointCode, row);
  }
  return [...latest.values()];
}

/**
 * 按步骤、按批次归组读数并逐批计算极差。
 * - 每批最大值减最小值为该批同步偏差；
 * - 同一测点同批多条时只取最后提交的一条；
 * - 单点批不计算偏差（deviationMm 为 null）。
 */
export function buildStepBatchReports<T extends ReadingBatchInput>(readings: T[]): Map<string, StepBatchReport> {
  const byStep = new Map<string, T[]>();
  for (const reading of readings) {
    const list = byStep.get(reading.stepId) ?? [];
    list.push(reading);
    byStep.set(reading.stepId, list);
  }

  const reports = new Map<string, StepBatchReport>();
  for (const [stepId, stepReadings] of byStep) {
    const groups = new Map<string, T[]>();
    for (const reading of stepReadings) {
      const key = readingBatchKey(reading);
      const list = groups.get(key) ?? [];
      list.push(reading);
      groups.set(key, list);
    }

    const batches: ReadingBatchStat[] = [...groups.entries()]
      .map(([batchId, rows]) => {
        const effective = latestPerPoint(rows);
        return {
          batchId,
          stepId,
          recordedAt: rows[0].recordedAt,
          seq: 0,
          rows: effective,
          pointCount: effective.length,
          deviationMm: effective.length >= 2 ? syncDeviationMm(effective) : null,
        };
      })
      .sort((a, b) =>
        a.recordedAt === b.recordedAt ? a.batchId.localeCompare(b.batchId) : a.recordedAt.localeCompare(b.recordedAt),
      );

    batches.forEach((batch, index) => {
      batch.seq = index + 1;
    });

    const rated = batches.filter((batch) => batch.deviationMm !== null);
    const worstBatch = rated.reduce<ReadingBatchStat | null>(
      (worst, batch) =>
        worst === null || (batch.deviationMm ?? 0) > (worst.deviationMm ?? 0) ? batch : worst,
      null,
    );

    reports.set(stepId, {
      stepId,
      batches,
      ratedBatchCount: rated.length,
      worstBatch,
      worstDeviationMm: worstBatch?.deviationMm ?? null,
    });
  }

  return reports;
}

/** 单步批次汇总的便捷封装 */
export function buildStepBatchReport<T extends ReadingBatchInput>(
  stepId: string,
  readings: T[],
): StepBatchReport | null {
  return buildStepBatchReports(readings).get(stepId) ?? null;
}

/** 批次展示标签：第N批 + 记录时间 */
export function batchLabel(batch: Pick<ReadingBatchStat, 'seq' | 'recordedAt'>): string {
  const time = batch.recordedAt.slice(11, 16);
  return time ? `第${batch.seq}批（${time}）` : `第${batch.seq}批`;
}

/** 读数时间格式校验提示 */
export function readingDateHint(recordedAt: string, stepState: string): string {
  if (!recordedAt) return '请选择记录时间';
  if (stepState === 'idle') return '该步骤尚未开始顶升，录入读数前请先推进状态';
  return '记录时间应晚于步骤开始时间，并按 5~10 分钟间隔连续记录';
}
