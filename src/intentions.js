/**
 * 念头账本：我自己写的"想做什么"，不是从对话里抽出来的关键词。
 *
 * 一条念头分四种 kind：
 *   question   想弄明白的事（做完 = 能一句话说清答案）
 *   unfinished 做了一半的事（做完 = 能指出下一步）
 *   whim       一闪而过、先记下来慢慢掂量的（可以长期不处理）
 *   wish       想要但暂时做不到（要权限/硬件/她点头），不参与排序
 *
 * 存 <dataDir>/intentions.jsonl，append-only。
 * 更新状态时追加一行带 supersedes 的记录，读取时以最后一条为准
 * （这样断电最多丢最后一行，历史还能回溯）。
 *
 * 注意：这里**不做**任何自动生成。念头要么我手写，要么不存在。
 */
import { join } from 'node:path';
import { appendJsonl, newId, readJsonl, toIso } from './util.js';

export const INTENTION_KINDS = Object.freeze(['question', 'unfinished', 'whim', 'wish']);
export const INTENTION_STATUSES = Object.freeze(['open', 'doing', 'done', 'dropped']);

/** 各 kind 的基础价值系数：想弄明白和没做完的比一闪而过更值得做。 */
const KIND_VALUE = Object.freeze({
  question: 1.0,
  unfinished: 0.9,
  whim: 0.55,
  wish: 0.0
});

/** 多久没碰就掉权重（小时）。 */
const DECAY_HALF_LIFE_HOURS = 72;

const clamp01 = (v, fallback = 0.5) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
const clip = (s, n) => String(s ?? '').slice(0, n);

function normalizeRow(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const kind = INTENTION_KINDS.includes(raw.kind) ? raw.kind : 'whim';
  const status = INTENTION_STATUSES.includes(raw.status) ? raw.status : 'open';
  const text = clip(raw.text, 200).trim();
  if (text === '') return null;
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId('i'),
    text,
    kind,
    status,
    drive: clip(raw.drive, 20),
    weight: clamp01(Number(raw.weight), 0.5),
    createdAt: Number(raw.createdAt) || Date.now(),
    lastTouchedAt: Number(raw.lastTouchedAt) || Number(raw.createdAt) || Date.now(),
    attempts: Number.isFinite(Number(raw.attempts)) ? Math.max(0, Math.trunc(Number(raw.attempts))) : 0,
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    note: clip(raw.note, 300),
    supersedes: typeof raw.supersedes === 'string' ? raw.supersedes : null
  };
}

/** 文本相似度：字符二元组 Jaccard，和 score.js 里的一致（不引第三方）。 */
function similarity(a, b) {
  const grams = (s) => {
    const t = String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const out = new Set();
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export class IntentionLedger {
  constructor(dataDir) {
    this.path = join(dataDir, 'intentions.jsonl');
  }

  /**
   * 读全部念头，应用 supersedes 链后返回当前视图。
   * 同 id 的多行里，最后一行赢；被 superseded 的行丢弃。
   */
  all() {
    const rows = readJsonl(this.path, 0).map(normalizeRow).filter(Boolean);
    const byId = new Map();
    const removed = new Set();
    for (const row of rows) {
      if (row.supersedes !== null) removed.add(row.supersedes);
      byId.set(row.id, row);
    }
    // supersedes 只是"覆盖同 id 的旧值"：如果更新用的是新 id，把旧 id 标掉。
    const out = [];
    for (const [id, row] of byId) {
      if (removed.has(id)) continue;
      out.push(row);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 只要 open 的，按 kind 价值 × 权重 × 衰减后的分排序。 */
  open(now = Date.now()) {
    return this.all()
      .filter((r) => r.status === 'open' && r.kind !== 'wish')
      .map((r) => ({ ...r, score: this.valueOf(r, now) }))
      .filter((r) => r.score > 0.1)
      .sort((a, b) => b.score - a.score);
  }

  /** 某个念头的当前价值（含时间衰减）。 */
  valueOf(row, now = Date.now()) {
    const base = KIND_VALUE[row.kind] ?? 0.5;
    const hours = Math.max(0, (now - row.lastTouchedAt) / 3600_000);
    const decay = Math.pow(0.5, hours / DECAY_HALF_LIFE_HOURS);
    // 下限 0.35：重要的念头不该因为放置太久彻底消失。
    return clamp01(base * row.weight * Math.max(0.35, decay));
  }

  /**
   * 写一条新念头。
   * 如果与已有 open 念头高度相似（≥0.8），合并：权重取大、lastTouchedAt 刷新，不新增。
   * @returns {{row: object, merged: boolean, mergedInto?: string}}
   */
  add({ text, kind = 'whim', drive = '', weight = 0.5, parentId = null, note = '' }, now = Date.now()) {
    const clean = clip(text, 200).trim();
    if (clean === '') throw new Error('念头不能为空');
    const existing = this.all().find(
      (r) => r.status === 'open' && similarity(r.text, clean) >= 0.8
    );
    if (existing !== undefined) {
      const bumped = {
        ...existing,
        id: newId('i'),
        weight: Math.max(existing.weight, clamp01(Number(weight), 0.5)),
        lastTouchedAt: now,
        note: note !== '' ? clip(note, 300) : existing.note,
        supersedes: existing.id
      };
      appendJsonl(this.path, { ...bumped, at: toIso(now) });
      return { row: bumped, merged: true, mergedInto: existing.id };
    }
    const row = {
      id: newId('i', now),
      text: clean,
      kind: INTENTION_KINDS.includes(kind) ? kind : 'whim',
      status: 'open',
      drive: clip(drive, 20),
      weight: clamp01(Number(weight), 0.5),
      createdAt: now,
      lastTouchedAt: now,
      attempts: 0,
      parentId,
      note: clip(note, 300),
      supersedes: null
    };
    appendJsonl(this.path, { ...row, at: toIso(now) });
    return { row, merged: false };
  }

  /**
   * 改状态 / 追加备注 / 增加尝试次数。
   * 内部靠追加一行 supersedes 记录实现，不重写历史。
   */
  patch(id, changes = {}, now = Date.now()) {
    const cur = this.all().find((r) => r.id === id);
    if (cur === undefined) throw new Error(`找不到念头 ${id}`);
    const next = {
      ...cur,
      ...changes,
      id: newId('i', now),
      lastTouchedAt: now,
      supersedes: cur.id
    };
    appendJsonl(this.path, { ...next, at: toIso(now) });
    return next;
  }

  /** 软删除：只改状态，历史上还留着。 */
  drop(id, reason = '', now = Date.now()) {
    return this.patch(id, { status: 'dropped', note: clip(reason, 300) || undefined }, now);
  }
}

export { similarity as intentionSimilarity };
