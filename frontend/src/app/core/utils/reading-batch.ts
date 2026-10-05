/**
 * 测点读数分批与按批同步偏差：
 * - 顶升班组逐批录入，批次 = 同一步骤 + 同一记录时间（早期无批次概念的读数也按此归批）
 * - 每批同步偏差 = 批内最大位移 − 最小位移；只有一个测点的批次不参与偏差统计
 * - 同一测点在一批里提交过多条（现场更正）时，以最后提交的那条为准，
 *   避免被更正掉的旧值反而把批次偏差拉大
 * - 步骤页 / 读数页统一报最差的那批；步骤从顶升中推到已到位时，
 *   最差批偏差超过 1.5 mm 不放行
 */
import type { ReadingRow } from './db';
import { syncDeviationMm } from '../types/reading';
import { SYNC_TOLERANCE_MM } from './tolerance';

/** 一批读数（同一步骤、同一记录时间） */
export interface ReadingBatch {
  /** 批次键：stepId + recordedAt */
  key: string;
  stepId: string;
  /** 批次时间（recordedAt，yyyy-MM-dd HH:mm） */
  recordedAt: string;
  /** 参与计算的读数：同一测点只保留最后提交的一条 */
  effective: ReadingRow[];
  /** 被本批后续更正取代的旧读数 */
  superseded: ReadingRow[];
  /** 有效测点数（去重后） */
  pointCount: number;
  /** 本批同步偏差（极差）；单点批为 null */
  deviationMm: number | null;
}

/** 单步批次汇总 */
export interface StepBatchSummary {
  /** 该步骤的批次数 */
  batchCount: number;
  /** 最差批次偏差（单点批不参与）；无多点批次时为 null */
  worstDeviationMm: number | null;
  /** 最差批次时间标签 */
  worstBatchLabel: string | null;
  /** 最差批次序号（按记录时间排序，从 1 开始） */
  worstBatchSeq: number | null;
}

/** 提交先后裁决：createdAt 越晚越是"最后提交"，缺失时按 0 处理 */
function submissionRank(row: ReadingRow): number {
  const text = (row.createdAt ?? '').trim() || '1970-01-01T00:00:00.000Z';
  const time = Date.parse(text);
  return Number.isNaN(time) ? 0 : time;
}

/** 短批次标签：MM-DD HH:mm */
export function shortBatchLabel(recordedAt: string): string {
  // recordedAt 形如 yyyy-MM-dd HH:mm
  return recordedAt.length >= 16 ? recordedAt.slice(5) : recordedAt;
}

/**
 * 把读数按 步骤 + 记录时间 归批；批内同一测点只留最后提交的一条。
 * 返回结果按批次时间升序排列。
 */
export function buildReadingBatches(readings: ReadingRow[]): ReadingBatch[] {
  const groups = new Map<string, ReadingRow[]>();
  for (const row of readings) {
    const key = `${row.stepId}__${row.recordedAt}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const batches: ReadingBatch[] = [];
  for (const [key, list] of groups) {
    // 稳定排序：按提交时间升序，同一时刻保持原始先后，保证"最后提交"裁决可重复
    const ordered = [...list].sort((a, b) => submissionRank(a) - submissionRank(b));
    const lastByPoint = new Map<string, ReadingRow>();
    for (const row of ordered) lastByPoint.set(row.pointCode, row);
    const effective = [...lastByPoint.values()];
    const effectiveIds = new Set(effective.map((row) => row.id));
    const superseded = ordered.filter((row) => !effectiveIds.has(row.id));
    batches.push({
      key,
      stepId: list[0].stepId,
      recordedAt: list[0].recordedAt,
      effective,
      superseded,
      pointCount: effective.length,
      deviationMm: effective.length >= 2 ? syncDeviationMm(effective) : null,
    });
  }
  return batches.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

/** 汇总一个步骤的各批次，取偏差最差的那批（单点批不参与） */
export function summarizeStepBatches(stepBatches: ReadingBatch[]): StepBatchSummary {
  if (stepBatches.length === 0) {
    return { batchCount: 0, worstDeviationMm: null, worstBatchLabel: null, worstBatchSeq: null };
  }
  let worstDeviationMm: number | null = null;
  let worstBatchLabel: string | null = null;
  let worstBatchSeq: number | null = null;
  stepBatches.forEach((batch, index) => {
    if (batch.deviationMm === null) return;
    if (worstDeviationMm === null || batch.deviationMm > worstDeviationMm) {
      worstDeviationMm = batch.deviationMm;
      worstBatchLabel = batch.recordedAt;
      worstBatchSeq = index + 1;
    }
  });
  return { batchCount: stepBatches.length, worstDeviationMm, worstBatchLabel, worstBatchSeq };
}

/**
 * 到位放行校验：顶升中 → 已到位时，最差批偏差超过 1.5 mm 不放行。
 * @param stepSeq 步骤序号（仅用于文案）
 * @returns 拦截原因文案；放行时返回 null
 */
export function arrivalBlockText(stepSeq: number, summary: StepBatchSummary): string | null {
  if (summary.worstDeviationMm === null || summary.worstBatchSeq === null) return null;
  if (summary.worstDeviationMm <= SYNC_TOLERANCE_MM) return null;
  return `步骤 #${stepSeq} 不放行：第 ${summary.worstBatchSeq} 批（${shortBatchLabel(
    summary.worstBatchLabel ?? '',
  )}）同步偏差 ${summary.worstDeviationMm.toFixed(2)} mm，超过 ${SYNC_TOLERANCE_MM} mm 允许值，请调平补录后再推进`;
}
