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
import { evolveDrives, normalizeDrives, tensionOf, describeDrives, satisfyDrive, DEFAULT_DRIVE_TUNING } from './drives.js';
import { IntentionLedger } from './intentions.js';
import { buildCandidates, decide, DEFAULT_THRESHOLD } from './intent-engine.js';
import { readJson, writeJsonAtomic } from './util.js';

export const EMPTY_INTENT_STATE = Object.freeze({
  version: 1,
  drives: {},
  lastEvolvedAt: 0,
  recentIntentionIds: [],
  /** 已经开口问过她的念头 id（避免同一条反复追问）。 */
  askedIntentionIds: [],
  /** 每条念头上次被问的毫秒时间戳：{ intentionId: ms }。 */
  askedAt: {},
  /** 上一次开口问的时间（毫秒），用来限制追问频率。 */
  lastAskAt: 0,
  lastDecision: '',
  lastRunAt: 0
});

const DEFAULT_MAX_RECENT = 20;
const RECENT_WINDOW_HOURS = 48;
/** 同一条念头问过一次后，多久之内不再追问（默认值；config.intent.askCooldownHours 可覆盖）。 */
export const ASK_COOLDOWN_HOURS = 20;
/** 两次追问之间至少隔多久，防止一天里反复冒出来烦人（config.intent.minAskGapHours 可覆盖）。 */
export const MIN_ASK_GAP_HOURS = 4;

export class IntentRuntime {
  /**
   * @param {string} dataDir
   * @param {object} [options]
   * @param {object} [options.tuning]        驱动调参（config.drives 归一化后的结果）
   * @param {number} [options.maxRecent]     最近念头记多少条
   * @param {number} [options.askCooldownHours]
   * @param {number} [options.minAskGapHours]
   */
  constructor(dataDir, { tuning = DEFAULT_DRIVE_TUNING, maxRecent = DEFAULT_MAX_RECENT,
    askCooldownHours = ASK_COOLDOWN_HOURS, minAskGapHours = MIN_ASK_GAP_HOURS } = {}) {
    this.dataDir = dataDir;
    this.statePath = join(dataDir, 'intent-state.json');
    this.ledger = new IntentionLedger(dataDir);
    this.tuning = tuning ?? DEFAULT_DRIVE_TUNING;
    this.maxRecent = Number.isFinite(maxRecent) && maxRecent > 0 ? Math.trunc(maxRecent) : DEFAULT_MAX_RECENT;
    this.askCooldownHours = Number.isFinite(askCooldownHours) ? askCooldownHours : ASK_COOLDOWN_HOURS;
    this.minAskGapHours = Number.isFinite(minAskGapHours) ? minAskGapHours : MIN_ASK_GAP_HOURS;
    this.state = { ...EMPTY_INTENT_STATE, drives: normalizeDrives({}, this.tuning) };
  }

  load(log = () => {}) {
    const raw = readJson(this.statePath, null, (e) => log('warn', `读 intent-state 失败：${e.message}`));
    if (raw !== null && typeof raw === 'object') {
      this.state = {
        ...EMPTY_INTENT_STATE,
        ...raw,
        drives: normalizeDrives(raw.drives, this.tuning),
        recentIntentionIds: Array.isArray(raw.recentIntentionIds) ? raw.recentIntentionIds.slice(-this.maxRecent) : [],
        askedIntentionIds: Array.isArray(raw.askedIntentionIds) ? raw.askedIntentionIds.slice(-this.maxRecent) : [],
        askedAt: raw.askedAt !== null && typeof raw.askedAt === 'object' ? { ...raw.askedAt } : {},
        lastAskAt: Number(raw.lastAskAt) || 0
      };
    }
    if (this.state.lastEvolvedAt === 0) this.state.lastEvolvedAt = Date.now();
    return this;
  }

  persist() {
    writeJsonAtomic(this.statePath, this.state);
  }

  /** 把驱动推进到此刻（幂等：按流逝时间算，多次调用无害）。 */
  advanceDrives(now = Date.now(), opts = {}) {
    const last = Number(this.state.lastEvolvedAt) || now;
    const hours = Math.max(0, (now - last) / 3600_000);
    if (hours > 0) {
      this.state.drives = evolveDrives(this.state.drives, { hoursSince: hours, tuning: this.tuning, ...opts });
      this.state.lastEvolvedAt = now;
    }
    return this.state.drives;
  }

  /** 记录"某个念头被做掉了"，用来给驱动回落。 */
  satisfy(drive, strength = 1) {
    this.state.drives = satisfyDrive(this.state.drives, drive, strength, this.tuning);
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

    const tension = tensionOf(this.state.drives, this.tuning);
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
        drive: picked.chosen.drive ?? '',
        score: Number(picked.chosen.score.toFixed(3)),
        risk: picked.chosen.risk,
        riskClass: picked.chosen.riskClass ?? 'read'
      },
      ranked: picked.ranked.slice(0, 5).map((c) => ({
        id: c.id,
        kind: c.kind,
        score: Number(c.score.toFixed(3)),
        text: c.text.slice(0, 60)
      }))
    };

    if (result.chosen !== null && result.decision !== 'skip') {
      this.state.recentIntentionIds = [...this.state.recentIntentionIds, result.chosen.id].slice(-this.maxRecent);
    }
    this.#remember(result, now);

    // 第二步：这里只把结论返回给调用方（index.js），由它决定要不要开 worker。
    // 评估本身保持纯函数性：读驱动、读账本、打分、记账，不动手、不起进程。
    const head = result.chosen === null
      ? `[念头] ${result.decision}：${result.reason}`
      : `[念头] ${result.decision}：${result.chosen.kind} ${result.chosen.text.slice(0, 40)}（${result.chosen.score}）`;
    log('info', `${head} / ${result.drives}`);
    return result;
  }

  /**
   * 某个念头动过手之后收尾：记账 + 让对应驱动回落。
   *
   * 单独一个方法而不是塞进 evaluate，是为了让「评估」和「动手的结果」解耦：
   * 以后换成别的执行通道，只要最后调它一次就行。
   *
   * @param {object} result  evaluate() 的返回值
   * @param {object} outcome run() 的返回值（ok / skipped / error）
   */
  settle(result, outcome = {}) {
    const chosen = result?.chosen ?? null;
    if (chosen === null) return this.state;
    const drive = typeof chosen.drive === 'string' && chosen.drive !== '' ? chosen.drive : '';
    if (drive !== '') {
      // 动手成功才算满足；失败不倒扣，但也不给奖励，下次还会再冒出来。
      const strength = outcome.ok === true ? 1 : 0.35;
      this.satisfy(drive, strength);
    }
    const entry = {
      at: new Date().toISOString(),
      intentionId: chosen.id,
      decision: result?.decision ?? '',
      ok: outcome.ok === true,
      skipped: outcome.skipped === true,
      reason: outcome.reason ?? outcome.error ?? ''
    };
    this.state.recentIntentionIds = [...this.state.recentIntentionIds, chosen.id].slice(-this.maxRecent);
    this.state.lastDecision = `${entry.decision}/${entry.ok ? 'done' : entry.skipped ? 'skipped' : 'failed'}`;
    this.persist();
    return { ...this.state, lastSettle: entry };
  }

  #remember(result, now) {
    this.state.lastDecision = result.reason;
    this.state.lastRunAt = now;
    this.persist();
  }

  /**
   * 该不该为这个念头开口问她。
   *
   * 规则：同一条念头问过就不再问（除非过了冷却期）；两次追问之间也要隔开，
   * 免得一天里反复拿账本上的事去烦她。
   *
   * @returns {{ask:boolean, reason:string}}
   */
  shouldAsk(result, now = Date.now()) {
    const chosen = result?.chosen ?? null;
    if (chosen === null) return { ask: false, reason: 'no_intention' };
    // 先看这条念头自己：问过且还在冷却里，直接挡掉（哪怕刚过全局间隔）。
    // 按「这条念头上次被问的时间」判，而不是全局上次问的时间——
    // 否则问过 A 之后再问 B，A 的冷却会被 B 的询问刷新掉。
    const askedAt = this.state.askedAt ?? {};
    const mineAt = Number(askedAt[chosen.id]) || 0;
    if (mineAt > 0 && (now - mineAt) / 3600_000 < this.askCooldownHours) {
      return { ask: false, reason: 'already_asked' };
    }
    const lastAskAt = Number(this.state.lastAskAt) || 0;
    const hoursSinceAsk = lastAskAt === 0 ? Infinity : (now - lastAskAt) / 3600_000;
    if (hoursSinceAsk < this.minAskGapHours) {
      return { ask: false, reason: `ask_gap(${hoursSinceAsk.toFixed(1)}h<${this.minAskGapHours}h)` };
    }
    return { ask: true, reason: 'qualified' };
  }

  /** 记下「为这条念头开口问过了」。 */
  markAsked(intentionId, now = Date.now()) {
    if (typeof intentionId !== 'string' || intentionId === '') return;
    this.state.askedIntentionIds = [...this.state.askedIntentionIds, intentionId].slice(-this.maxRecent);
    const askedAt = { ...(this.state.askedAt ?? {}), [intentionId]: now };
    // 只留最近 maxRecent 条，防止文件无限长大。
    const keep = new Set(this.state.askedIntentionIds);
    this.state.askedAt = Object.fromEntries(Object.entries(askedAt).filter(([id]) => keep.has(id)));
    this.state.lastAskAt = now;
    this.persist();
  }

  /** 日志视图：给 purpose_status 用，不暴露内部全量。 */
  view() {
    const now = Date.now();
    const open = this.ledger.open(now);
    return {
      drives: { ...this.state.drives },
      tension: Number(tensionOf(this.state.drives, this.tuning).toFixed(3)),
      lastDecision: this.state.lastDecision,
      lastRunAt: this.state.lastRunAt === 0 ? '' : new Date(this.state.lastRunAt).toISOString(),
      lastAskAt: Number(this.state.lastAskAt) > 0 ? new Date(Number(this.state.lastAskAt)).toISOString() : '',
      askedCount: Array.isArray(this.state.askedIntentionIds) ? this.state.askedIntentionIds.length : 0,
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
