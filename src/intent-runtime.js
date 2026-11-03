/**
 * 念头机制的运行时：把驱动值、账本、打分串成一次评估。
 *
 * 这一版（第一步）**只做评估和记日志，不开 worker、不发消息**。
 * 目的：先攒几天日志，看冒出来的念头像不像我自己，再决定要不要真放它去动手。
 *
 * 状态落 <dataDir>/intent-state.json：
 *   { version, drives, lastEvolvedAt, recentIntentionIds, lastDecision, lastRunAt }
 */
import { join } from 'node:path';
import { evolveDrives, normalizeDrives, tensionOf, describeDrives, satisfyDrive } from './drives.js';
import { IntentionLedger } from './intentions.js';
import { buildCandidates, decide, DEFAULT_THRESHOLD } from './intent-engine.js';
import { readJson, writeJsonAtomic } from './util.js';

export const EMPTY_INTENT_STATE = Object.freeze({
  version: 1,
  drives: {},
  lastEvolvedAt: 0,
  recentIntentionIds: [],
  lastDecision: '',
  lastRunAt: 0
});

const MAX_RECENT = 20;
const RECENT_WINDOW_HOURS = 48;

export class IntentRuntime {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.statePath = join(dataDir, 'intent-state.json');
    this.ledger = new IntentionLedger(dataDir);
    this.state = { ...EMPTY_INTENT_STATE, drives: normalizeDrives({}) };
  }

  load(log = () => {}) {
    const raw = readJson(this.statePath, null, (e) => log('warn', `读 intent-state 失败：${e.message}`));
    if (raw !== null && typeof raw === 'object') {
      this.state = {
        ...EMPTY_INTENT_STATE,
        ...raw,
        drives: normalizeDrives(raw.drives),
        recentIntentionIds: Array.isArray(raw.recentIntentionIds) ? raw.recentIntentionIds.slice(-MAX_RECENT) : []
      };
    }
    if (this.state.lastEvolvedAt === 0) this.state.lastEvolvedAt = Date.now();
    return this.state;
  }

  persist() {
    writeJsonAtomic(this.statePath, this.state);
  }

  /** 把驱动推进到此刻（幂等：按流逝时间算，多次调用无害）。 */
  advanceDrives(now = Date.now(), opts = {}) {
    const last = Number(this.state.lastEvolvedAt) || now;
    const hours = Math.max(0, (now - last) / 3600_000);
    if (hours > 0) {
      this.state.drives = evolveDrives(this.state.drives, { hoursSince: hours, ...opts });
      this.state.lastEvolvedAt = now;
    }
    return this.state.drives;
  }

  /** 记录"某个念头被做掉了"，用来给驱动回落。 */
  satisfy(drive, strength = 1) {
    this.state.drives = satisfyDrive(this.state.drives, drive, strength);
    return this.state.drives;
  }

  /**
   * 跑一次评估。**不做任何外部动作**，只返回结论。
   *
   * @param {object} opts
   * @param {number} [opts.now]
   * @param {object} [opts.config]  取 intentThreshold / intentAutonomousThreshold / minTension
   * @param {(level:string,msg:string)=>void} [opts.log]
   * @param {number} [opts.wakeupsLastHour]
   * @param {number} [opts.maxWakeupsPerHour]
   */
  evaluate({ now = Date.now(), config = {}, log = () => {}, wakeupsLastHour = 0, maxWakeupsPerHour = 6 } = {}) {
    this.advanceDrives(now, { wakeupsLastHour, maxWakeupsPerHour });

    const tension = tensionOf(this.state.drives);
    const minTension = Number.isFinite(config.minTension) ? config.minTension : 0.30;
    if (tension < minTension) {
      const result = {
        decision: 'skip',
        reason: `tension_low(${tension.toFixed(2)}<${minTension.toFixed(2)})`,
        tension: Number(tension.toFixed(3)),
        drives: describeDrives(this.state.drives),
        ranked: []
      };
      this.#remember(result, now);
      log('info', `[念头] 不动：${result.reason} / ${result.drives}`);
      return result;
    }

    const open = this.ledger.open(now);
    const candidates = buildCandidates(open, this.state.drives, {
      now,
      recentIntentionIds: this.state.recentIntentionIds
    });
    const picked = decide(candidates, {
      tension,
      threshold: Number.isFinite(config.intentThreshold) ? config.intentThreshold : DEFAULT_THRESHOLD,
      autonomousThreshold: Number.isFinite(config.intentAutonomousThreshold) ? config.intentAutonomousThreshold : undefined,
      minTension
    });

    const result = {
      decision: picked.decision,
      reason: picked.reason,
      tension: Number(tension.toFixed(3)),
      drives: describeDrives(this.state.drives),
      chosen: picked.chosen === undefined ? null : {
        id: picked.chosen.id,
        text: picked.chosen.text,
        kind: picked.chosen.kind,
        score: Number(picked.chosen.score.toFixed(3)),
        risk: picked.chosen.risk
      },
      ranked: picked.ranked.slice(0, 5).map((c) => ({
        id: c.id,
        kind: c.kind,
        score: Number(c.score.toFixed(3)),
        text: c.text.slice(0, 60)
      }))
    };

    if (result.chosen !== null && result.decision !== 'skip') {
      this.state.recentIntentionIds = [...this.state.recentIntentionIds, result.chosen.id].slice(-MAX_RECENT);
    }
    this.#remember(result, now);

    // 第一步：只记日志。真开 worker 是下一步的事。
    const head = result.chosen === null
      ? `[念头] ${result.decision}：${result.reason}`
      : `[念头] ${result.decision}：${result.chosen.kind} ${result.chosen.text.slice(0, 40)}（${result.chosen.score}）`;
    log('info', `${head} / ${result.drives}`);
    return result;
  }

  #remember(result, now) {
    this.state.lastDecision = result.reason;
    this.state.lastRunAt = now;
    this.persist();
  }

  /** 日志视图：给 purpose_status 用，不暴露内部全量。 */
  view() {
    const now = Date.now();
    const open = this.ledger.open(now);
    return {
      drives: { ...this.state.drives },
      tension: Number(tensionOf(this.state.drives).toFixed(3)),
      lastDecision: this.state.lastDecision,
      lastRunAt: this.state.lastRunAt === 0 ? '' : new Date(this.state.lastRunAt).toISOString(),
      openIntentions: open.length,
      top: open.slice(0, 5).map((r) => ({
        id: r.id,
        kind: r.kind,
        text: r.text,
        value: Number((r.score ?? 0).toFixed(3))
      }))
    };
  }
}

export { RECENT_WINDOW_HOURS };
