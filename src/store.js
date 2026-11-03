/**
 * 落盘状态：目标记账 + 投递历史 + 冷却表。
 *
 * 三个文件都在 <dataDir> 下：
 *   state.json    当前快照（nextAt / 计数 / 冷却 / 每类置信度）
 *   goals.jsonl   目标记账流水（append-only，只加不改，便于事后回溯）
 *   runs.jsonl    每次评估的结论流水（deliver / silent 及理由）
 *
 * 用 JSONL 而不是单个大 JSON，是因为它能在断电时只丢最后一行；
 * state.json 用原子写保证不会读到自己写了一半的版本。
 */
import { join } from 'node:path';
import { appendJsonl, newId, readJson, readJsonl, writeJsonAtomic, toIso } from './util.js';

export const EMPTY_STATE = Object.freeze({
  version: 1,
  /** 下一次评估的最早时间（ISO）。 */
  nextAt: '',
  /** 当前小时内的唤醒时间戳，用于 maxWakeupsPerHour。 */
  recentWakes: [],
  /** 当天（本地日期）已投递条数。 */
  day: '',
  deliveredToday: 0,
  /** 冷却中的目标：goalId → 解冻时间（ISO）。 */
  cooling: {},
  /** 每个 goal.kind 的历史统计：{sent, silent, confirmed, rejected, confidence}。 */
  kinds: {},
  /** 上一次投递的文本指纹，用于相似度去重。 */
  recentTexts: []
});

export class PurposeStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.statePath = join(dataDir, 'state.json');
    this.goalsPath = join(dataDir, 'goals.jsonl');
    this.runsPath = join(dataDir, 'runs.jsonl');
    this.state = { ...EMPTY_STATE };
    this.corrupt = false;
  }

  /** 读盘。坏文件不阻塞启动，退回空状态并标记 corrupt。 */
  load(log = () => {}) {
    const raw = readJson(this.statePath, null, (error) => {
      this.corrupt = true;
      log('warn', `state.json 读取失败，按空状态启动：${error.message}`);
    });
    if (raw === null) {
      this.state = { ...EMPTY_STATE, cooling: {}, kinds: {}, recentTexts: [], recentWakes: [] };
      return this;
    }
    this.state = {
      ...EMPTY_STATE,
      ...raw,
      cooling: isRecord(raw.cooling) ? raw.cooling : {},
      kinds: isRecord(raw.kinds) ? raw.kinds : {},
      recentTexts: Array.isArray(raw.recentTexts) ? raw.recentTexts.slice(-12) : [],
      recentWakes: Array.isArray(raw.recentWakes) ? raw.recentWakes.slice(-24) : []
    };
    return this;
  }

  /** 原子落盘。 */
  persist() {
    writeJsonAtomic(this.statePath, this.state);
  }

  /** 记一次目标假设（不管最后发没发）。 */
  recordGoal(goal, extras = {}) {
    const row = {
      id: newId('goal'),
      at: toIso(Date.now()),
      goalId: goal.goalId,
      kind: goal.kind,
      owner: goal.owner,
      title: goal.title,
      rationale: goal.rationale,
      score: goal.score ?? null,
      sourceIds: goal.sourceIds ?? [],
      ...extras
    };
    appendJsonl(this.goalsPath, row);
    return row;
  }

  /** 记一次评估结论。 */
  recordRun(entry) {
    const row = {
      id: newId('run'),
      at: toIso(Date.now()),
      ...entry
    };
    appendJsonl(this.runsPath, row);
    return row;
  }

  /** 读最近 N 条目标流水（调试 / 面板用）。 */
  recentGoals(limit = 20) {
    return readJsonl(this.goalsPath, limit);
  }

  /** 读最近 N 条评估流水。 */
  recentRuns(limit = 20) {
    return readJsonl(this.runsPath, limit);
  }

  /** 取某类目标的历史统计（缺省给中性值）。 */
  kindStat(kind) {
    const stat = this.state.kinds[kind];
    if (stat === undefined) return { sent: 0, silent: 0, confirmed: 0, rejected: 0, confidence: 0.5 };
    return { sent: 0, silent: 0, confirmed: 0, rejected: 0, confidence: 0.5, ...stat };
  }

  /** 更新某类目标的统计。 */
  bumpKind(kind, delta) {
    const stat = this.kindStat(kind);
    this.state.kinds[kind] = {
      ...stat,
      sent: stat.sent + (delta.sent ?? 0),
      silent: stat.silent + (delta.silent ?? 0),
      confirmed: stat.confirmed + (delta.confirmed ?? 0),
      rejected: stat.rejected + (delta.rejected ?? 0),
      confidence: delta.confidence ?? stat.confidence
    };
  }

  /** 把目标放进冷却，解冻时间 = now + seconds。 */
  cool(goalId, seconds, now = Date.now()) {
    this.state.cooling[goalId] = toIso(now + seconds * 1000);
    this.gcCooling(now);
  }

  /** 清掉已过期的冷却项，避免 state.json 无限增长。 */
  gcCooling(now = Date.now()) {
    for (const [goalId, iso] of Object.entries(this.state.cooling)) {
      const at = Date.parse(iso);
      if (!Number.isFinite(at) || at <= now) delete this.state.cooling[goalId];
    }
  }

  /** 冷却表 → Map<goalId, epochMs>。 */
  coolingMap() {
    const map = new Map();
    for (const [goalId, iso] of Object.entries(this.state.cooling)) {
      const at = Date.parse(iso);
      if (Number.isFinite(at)) map.set(goalId, at);
    }
    return map;
  }

  /** 记录一次投递：日计数、最近指纹、唤醒时间。 */
  noteDelivery(text, now = Date.now()) {
    const day = localDayKey(now);
    if (this.state.day !== day) {
      this.state.day = day;
      this.state.deliveredToday = 0;
    }
    this.state.deliveredToday += 1;
    this.state.recentWakes = [...this.state.recentWakes, now].slice(-24);
    if (typeof text === 'string' && text !== '') {
      this.state.recentTexts = [...this.state.recentTexts, text].slice(-12);
    }
  }

  /** 今天还可不可以再投一条。 */
  canDeliverToday(now, maxPerDay) {
    const day = localDayKey(now);
    const used = this.state.day === day ? this.state.deliveredToday : 0;
    return used < maxPerDay;
  }

  /** 最近一小时唤醒次数。 */
  wakeupsLastHour(now) {
    const floor = now - 3600_000;
    this.state.recentWakes = this.state.recentWakes.filter((t) => Number.isFinite(t) && t > floor);
    return this.state.recentWakes.length;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 本地日期键 YYYY-MM-DD（用于日配额重置）。 */
export function localDayKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
