import { Component, computed, inject, signal, type Signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { STEP_STATE_LABEL, SYNC_REQUIREMENT_LABEL, type StepView } from '../../../core/types/step';
import {
  STRESS_ALERT_MPA,
  batchLabel,
  buildStepBatchReports,
  meanDisplacement,
  readingBatchKey,
  readingDateHint,
  suggestPointCodes,
  syncDeviationMm,
  type ReadingView,
} from '../../../core/types/reading';
import { ROUTES } from '../../../core/router/app.routes';
import { stepActions } from '../../../core/store/step.actions';
import { buildStepViews, selectStepStats } from '../../../core/store/step.selectors';
import { selectBridges } from '../../../core/store/bridge.selectors';
import { IdbTableService } from '../../../core/services/idb-table.service';
import { submitReadingBatch, type ReadingRow } from '../../../core/utils/db';
import { formatMm, formatStress } from '../../../core/utils/unit';
import {
  SYNC_TOLERANCE_MM,
  TOLERANCE_HEX,
  TOLERANCE_LEVEL_LABEL,
  limitAlertText,
  overallLevel,
  syncAlertText,
  syncLevel,
} from '../../../core/utils/tolerance';
import { nowDateTime } from '../../../core/utils/export';
import { StatBadgeComponent } from '../../../shared/components/common/stat-badge.component';
import { EmptyPanelComponent } from '../../../shared/components/common/empty-panel.component';
import { FilterBarComponent, type FilterSelectSpec } from '../../../shared/components/common/filter-bar.component';
import type { BridgeRow, StepRow } from '../../../core/utils/db';
import type { ToleranceLevel } from '../../../core/utils/tolerance';

/** 批量录入的临时行 */
interface BatchRow {
  pointCode: string;
  displacementMm: number;
  stressMpa: number;
}

/**
 * /readings 测点读数录入
 * 按步骤批量录入位移与应力，实时显示同步偏差与限位告警；
 * 消费 Reading、Step 与 <FilterBar>。
 */
@Component({
  selector: 'app-reading-entry-page',
  standalone: true,
  imports: [
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    StatBadgeComponent,
    EmptyPanelComponent,
    FilterBarComponent,
  ],
  template: `
    <div class="page-head">
      <div>
        <h2 class="page-title">测点读数录入</h2>
        <div class="page-sub">
          选择顶升步骤后批量录入多测点位移与应力，实时计算同步偏差并按限位值给出告警。
        </div>
      </div>
      <div class="gb-inline-actions">
        <button mat-stroked-button (click)="go(ROUTES.steps)">
          <mat-icon>stairs</mat-icon>
          顶升步骤编排
        </button>
        <button mat-flat-button color="primary" [disabled]="batchRows().length === 0" (click)="submitBatch()">
          <mat-icon>save</mat-icon>
          提交 {{ batchRows().length }} 条读数
        </button>
      </div>
    </div>

    <div class="stat-grid">
      <app-stat-badge title="测点读数" [value]="stats().readingCount" [suffix]="'条'" color="#1565c0" />
      <app-stat-badge
        title="当前步骤平均位移"
        [value]="formatMm(currentAverage())"
        color="#00897b"
        [hint]="selectedStepLabel()"
      />
      <app-stat-badge
        title="最差批次同步偏差"
        [value]="formatMm(currentDeviation())"
        [percent]="deviationShare()"
        [color]="syncColor()"
        [hint]="'按批极差取最差批，允许值 1.5 mm · ' + worstBatchText()"
      />
      <app-stat-badge
        title="超限读数"
        [value]="exceedCount()"
        [suffix]="'条'"
        color="#c62828"
        [hint]="'限位值 ' + (selectedStep()?.limitMm ?? 0) + ' mm，应力关注值 ' + stressAlert + ' MPa'"
      />
    </div>

    <app-filter-bar
      keywordLabel="关键字"
      keywordPlaceholder="按测点编号 / 记录人搜索"
      [keyword]="keyword()"
      [selects]="selects()"
      [values]="filters()"
      [resultCount]="filtered().length"
      countUnit="条读数"
      (keywordChange)="onKeyword($event)"
      (filtersChange)="onFilters($event)"
    >
      <button mat-stroked-button (click)="clearFilters()">
        <mat-icon>filter_alt_off</mat-icon>
        清空筛选
      </button>
    </app-filter-bar>

    <div class="gb-section">
      <mat-card appearance="outlined">
        <div style="padding: 12px 14px">
          <div class="gb-card-title">批量录入面板</div>
          <div class="gb-inline-actions" style="margin-top: 10px">
            <mat-form-field appearance="outline" style="min-width: 300px">
              <mat-label>顶升步骤</mat-label>
              <mat-select
                [ngModel]="selectedStepId()"
                (ngModelChange)="onStepChange($event)"
              >
                @for (step of stepViews(); track step.id) {
                  <mat-option [value]="step.id">
                    #{{ step.seq }} {{ step.bridgeName }} · 目标 {{ step.targetLiftMm }} mm ·
                    {{ syncRequirementLabel[step.syncRequirement] }} · {{ stepStateLabel[step.state] }}
                  </mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline" style="min-width: 190px">
              <mat-label>记录人</mat-label>
              <input matInput [ngModel]="operator()" (ngModelChange)="operator.set($event)" />
            </mat-form-field>
            <mat-form-field appearance="outline" style="min-width: 230px">
              <mat-label>记录时间</mat-label>
              <input
                matInput
                type="datetime-local"
                [ngModel]="recordedAt()"
                (ngModelChange)="recordedAt.set($event)"
              />
            </mat-form-field>
            <button mat-stroked-button (click)="regenerateRows()">
              <mat-icon>autorenew</mat-icon>
              重排测点
            </button>
            <button mat-stroked-button (click)="fillReference()">
              <mat-icon>functions</mat-icon>
              按目标顶升量填参考值
            </button>
          </div>
          <div class="gb-hint">{{ dateHint() }}</div>

          @if (selectedStep(); as step) {
            <div class="gb-table-wrap" style="margin-top: 10px">
              <table class="gb-table">
                <thead>
                  <tr>
                    <th style="width: 120px">测点编号</th>
                    <th style="width: 190px">位移（mm）</th>
                    <th style="width: 190px">应力（MPa）</th>
                    <th>判定</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of batchRows(); track row.pointCode) {
                    <tr>
                      <td class="gb-mono">{{ row.pointCode }}</td>
                      <td>
                        <input
                          class="gb-input"
                          type="number"
                          step="0.01"
                          [ngModel]="row.displacementMm"
                          (ngModelChange)="updateRow(row.pointCode, 'displacementMm', $event)"
                        />
                      </td>
                      <td>
                        <input
                          class="gb-input"
                          type="number"
                          step="0.01"
                          [ngModel]="row.stressMpa"
                          (ngModelChange)="updateRow(row.pointCode, 'stressMpa', $event)"
                        />
                      </td>
                      <td>
                        <span [style.color]="rowColor(row)">
                          {{ rowLevelText(row) }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <div class="gb-timeline" style="margin-top: 10px">
              <div
                class="gb-timeline-node"
                [class.is-exceed]="batchDeviationLevel() === 'exceed'"
                [class.is-watch]="batchDeviationLevel() === 'watch'"
              >
                <div>{{ syncAlertText(batchDeviation(), syncRequirementLabel[step.syncRequirement]) }}</div>
                <div class="gb-hint">
                  本批 {{ batchRows().length }} 个测点，按本批最大值减最小值计偏差，平均位移
                  {{ formatMm(batchAverage()) }}；{{ limitAlertText(batchMax(), step.limitMm)
                  }}；同测点再次提交即更正，以最后提交的读数为准
                </div>
              </div>
            </div>
          } @else {
            <app-empty-panel
              title="请选择顶升步骤"
              description="先在顶升步骤编排页创建步骤，再回到本页批量录入测点读数。"
              icon="monitor_heart"
              actionLabel="去编排步骤"
              (action)="go(ROUTES.steps)"
            />
          }
        </div>
      </mat-card>
    </div>

    <div class="gb-section">
      <div class="gb-card-title" style="margin-bottom: 8px">已录入读数（{{ filtered().length }} 条）</div>
      @if (filtered().length === 0) {
        <app-empty-panel
          title="暂无测点读数"
          description="选择步骤后批量录入，或在步骤页推进状态后再录入。"
          icon="sensors"
        />
      } @else {
        <div class="gb-table-wrap">
          <table class="gb-table">
            <thead>
              <tr>
                <th>步骤</th>
                <th>桥梁</th>
                <th>批次</th>
                <th>测点</th>
                <th>位移</th>
                <th>批内偏差</th>
                <th>本批极差</th>
                <th>应力</th>
                <th>记录时间</th>
                <th>记录人</th>
                <th>判定</th>
                <th style="width: 90px">操作</th>
              </tr>
            </thead>
            <tbody>
              @for (reading of filtered(); track reading.id) {
                <tr [class.is-superseded]="reading.superseded">
                  <td>#{{ reading.stepSeq }}</td>
                  <td>{{ reading.bridgeName }}</td>
                  <td>
                    {{ reading.batchLabel }}
                    @if (reading.superseded) {
                      <mat-chip highlighted class="gb-mini-chip" title="同一测点在该批内有后提交的更正读数，本条不参与偏差计算">
                        已更正
                      </mat-chip>
                    }
                  </td>
                  <td class="gb-mono">{{ reading.pointCode }}</td>
                  <td>{{ formatMm(reading.displacementMm) }}</td>
                  <td [style.color]="reading.deviationMm === 0 ? '#2e7d32' : '#ed6c02'">
                    {{ formatMm(reading.deviationMm) }}
                  </td>
                  <td>
                    @if (reading.batchDeviationMm !== null) {
                      <span [style.color]="batchDeviationColor(reading.batchDeviationMm)">
                        {{ formatMm(reading.batchDeviationMm) }}
                      </span>
                    } @else {
                      <span class="gb-hint">单点批不计</span>
                    }
                  </td>
                  <td [style.color]="reading.stressAlert ? '#c62828' : '#2e7d32'">
                    {{ formatStress(reading.stressMpa) }}
                  </td>
                  <td>{{ reading.recordedAt }}</td>
                  <td>{{ reading.operator }}</td>
                  <td>
                    <mat-chip-set>
                      <mat-chip [style.background]="readingColor(reading)" [style.color]="'#fff'">
                        {{ readingLevelText(reading) }}
                      </mat-chip>
                    </mat-chip-set>
                  </td>
                  <td>
                    <button mat-button color="warn" (click)="deleteReading(reading)">
                      <mat-icon>delete</mat-icon>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .gb-input {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid rgba(22, 34, 46, 0.2);
        border-radius: 6px;
        font-size: 13px;
      }
      tr.is-superseded td {
        opacity: 0.55;
      }
      .gb-mini-chip {
        min-height: 20px !important;
        font-size: 11px !important;
        padding: 0 8px !important;
        margin-left: 4px;
      }
    `,
  ],
})
export class ReadingEntryPage {
  private readonly store = inject(Store);
  private readonly idb = inject(IdbTableService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly ROUTES = ROUTES;
  readonly syncRequirementLabel = SYNC_REQUIREMENT_LABEL;
  readonly stepStateLabel = STEP_STATE_LABEL;
  readonly stressAlert = STRESS_ALERT_MPA;
  readonly formatMm = formatMm;
  readonly formatStress = formatStress;
  readonly syncAlertText = syncAlertText;
  readonly limitAlertText = limitAlertText;

  private readonly bridges: Signal<BridgeRow[]> = toSignal(this.store.select(selectBridges), {
    initialValue: [] as BridgeRow[],
  });
  private readonly steps: Signal<StepRow[]> = toSignal(this.store.select((state) => state.step.steps), {
    initialValue: [] as StepRow[],
  });
  private readonly readings: Signal<ReadingRow[]> = toSignal(
    this.store.select((state) => state.step.readings),
    { initialValue: [] as ReadingRow[] },
  );

  readonly stats = toSignal(this.store.select(selectStepStats), {
    initialValue: {
      total: 0,
      cumulativeMm: 0,
      arrived: 0,
      lifting: 0,
      idle: 0,
      readingCount: 0,
      maxLimitMm: 0,
    },
  });

  readonly stepViews: Signal<StepView[]> = computed(() =>
    buildStepViews(this.steps(), this.readings(), this.bridges()),
  );

  readonly keyword = signal('');
  readonly filters = signal<Record<string, string[]>>({ step: [], level: [] });
  readonly selectedStepId = signal('');
  readonly batchRows = signal<BatchRow[]>([]);
  /** 记录人（signal，模板双向绑定到 signal.set） */
  readonly operator = signal('陈立强');
  /** 记录时间（datetime-local 口径 yyyy-MM-ddTHH:mm） */
  readonly recordedAt = signal(nowDateTime().replace(' ', 'T'));

  readonly selects = computed<FilterSelectSpec[]>(() => [
    {
      key: 'step',
      label: '顶升步骤',
      options: this.stepViews().map((step) => `#${step.seq} ${step.bridgeName}`),
    },
    { key: 'level', label: '判定', options: ['正常', '关注', '超限'] },
  ]);

  /** 读数视图：带步骤上下文、批次信息与批内偏差 */
  readonly readingViews: Signal<ReadingView[]> = computed(() => {
    const steps = new Map(this.stepViews().map((step) => [step.id, step]));
    const reports = buildStepBatchReports(this.readings());
    const views: ReadingView[] = [];
    for (const report of reports.values()) {
      for (const batch of report.batches) {
        // 批内有效测点（同一测点仅最后提交的一条），平均位移按有效读数计
        const effectiveIds = new Set(batch.rows.map((row) => row.id));
        const average = meanDisplacement(batch.rows);
        const label = batchLabel(batch);
        for (const reading of this.readings().filter((item) => readingBatchKey(item) === batch.batchId)) {
          const step = steps.get(reading.stepId);
          const limitMm = step?.limitMm ?? 0;
          views.push({
            ...reading,
            effectiveBatchId: batch.batchId,
            batchSeq: batch.seq,
            batchLabel: label,
            stepSeq: step?.seq ?? 0,
            bridgeId: step?.bridgeId ?? '',
            bridgeName: step?.bridgeName ?? '未归属桥梁',
            syncRequirement: step ? SYNC_REQUIREMENT_LABEL[step.syncRequirement] : '-',
            deviationMm: effectiveIds.has(reading.id)
              ? Number((reading.displacementMm - average).toFixed(3))
              : 0,
            batchDeviationMm: batch.deviationMm,
            superseded: !effectiveIds.has(reading.id),
            overLimit: limitMm > 0 && Math.abs(reading.displacementMm) >= limitMm,
            stressAlert: reading.stressMpa >= STRESS_ALERT_MPA,
          });
        }
      }
    }
    return views.sort((a, b) =>
      a.stepSeq === b.stepSeq
        ? a.batchSeq === b.batchSeq
          ? b.recordedAt.localeCompare(a.recordedAt)
          : b.batchSeq - a.batchSeq
        : a.stepSeq - b.stepSeq,
    );
  });

  readonly filtered = computed(() => {
    const lower = this.keyword().trim().toLowerCase();
    const stepLabels = this.filters()['step'] ?? [];
    const levelLabels = this.filters()['level'] ?? [];
    return this.readingViews().filter((reading) => {
      if (stepLabels.length > 0 && !stepLabels.includes(`#${reading.stepSeq} ${reading.bridgeName}`)) return false;
      if (levelLabels.length > 0 && !levelLabels.includes(this.readingLevelText(reading))) return false;
      if (lower && !`${reading.pointCode} ${reading.operator}`.toLowerCase().includes(lower)) return false;
      return true;
    });
  });

  readonly selectedStep = computed(() =>
    this.stepViews().find((step) => step.id === this.selectedStepId()) ?? null,
  );

  /** 按步骤汇总的批次报告 */
  private readonly batchReports = computed(() => buildStepBatchReports(this.readings()));

  readonly currentAverage = computed(() => {
    const step = this.selectedStep();
    if (!step) return 0;
    const report = this.batchReports().get(step.id);
    const effective = report ? report.batches.flatMap((batch) => batch.rows) : [];
    return meanDisplacement(effective);
  });

  /** 当前步骤最差批次的同步偏差（按批极差取最差） */
  readonly currentDeviation = computed(() => this.batchReports().get(this.selectedStep()?.id ?? '')?.worstDeviationMm ?? 0);

  readonly exceedCount = computed(() =>
    this.readingViews().filter((reading) => !reading.superseded && (reading.overLimit || reading.stressAlert)).length,
  );

  readonly batchAverage = computed(() => meanDisplacement(this.batchRows()));
  readonly batchDeviation = computed(() => syncDeviationMm(this.batchRows()));
  readonly batchMax = computed(() =>
    this.batchRows().length === 0 ? 0 : Math.max(...this.batchRows().map((item) => Math.abs(item.displacementMm))),
  );

  constructor() {
    this.route.queryParamMap.subscribe((params) => {
      this.keyword.set(params.get('kw') ?? '');
      const next: Record<string, string[]> = { step: [], level: [] };
      for (const key of Object.keys(next)) {
        const raw = params.get(key);
        next[key] = raw ? raw.split(',').map((item) => item.trim()).filter(Boolean) : [];
      }
      this.filters.set(next);
      const stepId = params.get('stepId');
      if (stepId) this.onStepChange(stepId);
    });

    // 默认选中第一个步骤并生成测点行
    queueMicrotask(() => {
      if (!this.selectedStepId() && this.stepViews().length > 0) {
        this.onStepChange(this.stepViews()[0].id);
      }
    });
  }

  selectedStepLabel(): string {
    const step = this.selectedStep();
    if (!step) return '未选择步骤';
    return `#${step.seq} ${step.bridgeName} · 目标 ${step.targetLiftMm} mm · 限位 ${step.limitMm} mm`;
  }

  dateHint(): string {
    const step = this.selectedStep();
    return readingDateHint(this.recordedAt().replace('T', ' '), step?.state ?? 'idle');
  }

  onStepChange(stepId: string): void {
    this.selectedStepId.set(stepId);
    this.regenerateRows();
    const queryParams: Record<string, string> = { stepId };
    if (this.keyword().trim()) queryParams['kw'] = this.keyword().trim();
    for (const [key, list] of Object.entries(this.filters())) {
      if (list.length > 0) queryParams[key] = list.join(',');
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams, replaceUrl: true });
  }

  /** 按同步要求生成测点行（同步 4 点、交叉 4 点、单点 1 点） */
  regenerateRows(): void {
    const step = this.selectedStep();
    if (!step) {
      this.batchRows.set([]);
      return;
    }
    const codes = step.syncRequirement === 'single' ? ['P1'] : suggestPointCodes(2).slice(0, 4);
    this.batchRows.set(
      codes.map((pointCode) => ({ pointCode, displacementMm: step.targetLiftMm, stressMpa: 8 })),
    );
  }

  /** 按目标顶升量填参考值（略带测点间差异，便于观察同步偏差） */
  fillReference(): void {
    const step = this.selectedStep();
    if (!step) return;
    this.batchRows.set(
      this.batchRows().map((row, index) => ({
        ...row,
        displacementMm: Number((step.targetLiftMm - index * 0.2).toFixed(2)),
        stressMpa: Number((8 + index * 0.4).toFixed(2)),
      })),
    );
  }

  updateRow(pointCode: string, field: 'displacementMm' | 'stressMpa', value: number): void {
    this.batchRows.set(
      this.batchRows().map((row) => (row.pointCode === pointCode ? { ...row, [field]: Number(value) } : row)),
    );
  }

  rowLevelText(row: BatchRow): string {
    const step = this.selectedStep();
    if (!step) return '—';
    const level = overallLevel(row.displacementMm, step.limitMm, row.stressMpa);
    return TOLERANCE_LEVEL_LABEL[level];
  }

  rowColor(row: BatchRow): string {
    const step = this.selectedStep();
    if (!step) return TOLERANCE_HEX.ok;
    return TOLERANCE_HEX[overallLevel(row.displacementMm, step.limitMm, row.stressMpa)];
  }

  batchDeviationLevel(): ToleranceLevel {
    return syncLevel(this.batchDeviation());
  }

  syncColor(): string {
    return TOLERANCE_HEX[syncLevel(this.currentDeviation())];
  }

  syncLevelText(): string {
    return TOLERANCE_LEVEL_LABEL[syncLevel(this.currentDeviation())];
  }

  /** 最差批次说明文案（顶部统计卡提示） */
  worstBatchText(): string {
    const report = this.batchReports().get(this.selectedStep()?.id ?? '');
    const worst = report?.worstBatch;
    if (!worst) return report && report.batches.length > 0 ? '仅单点批，不评偏差' : '暂无多点批次';
    return `${batchLabel(worst)}最差 · 当前 ${this.syncLevelText()}`;
  }

  /** 批次极差配色（读数表“本批极差”列） */
  batchDeviationColor(deviationMm: number): string {
    return TOLERANCE_HEX[syncLevel(deviationMm)];
  }

  deviationShare(): number {
    return Math.min(100, Number(((this.currentDeviation() / SYNC_TOLERANCE_MM) * 100).toFixed(1)));
  }

  readingLevelText(reading: ReadingView): string {
    if (reading.superseded) return '已更正';
    const step = this.selectedStep();
    const limitMm = this.stepViews().find((item) => item.id === reading.stepId)?.limitMm ?? step?.limitMm ?? 0;
    return TOLERANCE_LEVEL_LABEL[overallLevel(reading.displacementMm, limitMm, reading.stressMpa)];
  }

  readingColor(reading: ReadingView): string {
    if (reading.superseded) return '#90a4ae';
    const limitMm = this.stepViews().find((item) => item.id === reading.stepId)?.limitMm ?? 0;
    return TOLERANCE_HEX[overallLevel(reading.displacementMm, limitMm, reading.stressMpa)];
  }

  async submitBatch(): Promise<void> {
    const step = this.selectedStep();
    const rows = this.batchRows();
    if (!step || rows.length === 0) return;
    const recorded = this.recordedAt().replace('T', ' ');
    const result = await submitReadingBatch({
      stepId: step.id,
      recordedAt: recorded,
      operator: this.operator(),
      rows: rows.map((row) => ({
        pointCode: row.pointCode,
        displacementMm: row.displacementMm,
        stressMpa: row.stressMpa,
      })),
    });
    this.idb.emitChange();
    const correction = result.updated > 0 ? `，更正 ${result.updated} 个测点（以本次提交为准）` : '';
    this.snackBar.open(
      `已提交本批 ${rows.length} 条读数（新增 ${result.inserted} 条${correction}），本批同步偏差 ${formatMm(syncDeviationMm(rows))}`,
      '关闭',
      { duration: 3200 },
    );
  }

  async deleteReading(reading: ReadingView): Promise<void> {
    if (!confirm(`确认删除测点 ${reading.pointCode} 的读数？`)) return;
    await this.idb.database.readings.delete(reading.id);
    this.idb.emitChange();
    this.snackBar.open('测点读数已删除', '关闭', { duration: 2400 });
  }

  go(path: string): void {
    void this.router.navigate([path]);
  }

  onKeyword(value: string): void {
    this.keyword.set(value);
    this.syncQuery(value, this.filters());
  }

  onFilters(values: Record<string, string[]>): void {
    this.filters.set(values);
    this.syncQuery(this.keyword(), values);
  }

  clearFilters(): void {
    this.keyword.set('');
    this.filters.set({ step: [], level: [] });
    this.syncQuery('', { step: [], level: [] });
  }

  private syncQuery(keyword: string, values: Record<string, string[]>): void {
    const queryParams: Record<string, string> = {};
    if (keyword.trim()) queryParams['kw'] = keyword.trim();
    if (this.selectedStepId()) queryParams['stepId'] = this.selectedStepId();
    for (const [key, list] of Object.entries(values)) {
      if (list.length > 0) queryParams[key] = list.join(',');
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams, replaceUrl: true });
  }
}
