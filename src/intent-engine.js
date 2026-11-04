/**
 * 把「驱动 + 念头」换算成「现在要不要做、做什么」。
 *
 * 这是纯函数层：不读盘、不发消息、不起进程，方便单测。
 * 打分公式见 docs/DESIGN-DRIVES-AND-INTENTIONS.md 第五节：
 *   score = 0.34*value + 0.26*urgency + 0.18*freshness + 0.12*driveMatch + 0.10*(1-risk)
 */
import { DRIVES, tensionOf } from './drives.js';

/** 按动作类型给的静态风险。只读最安全，任何对外可见的动作都要她点头。 */
export const RISK = Object.freeze({
  read: 0.10,
  research: 0.15,
  write_workspace: 0.30,
  write_outside: 0.85,
  publish: 0.70,
  install: 0.75,
  contact: 0.80
});

/** 低于这个分不做。 */
export const DEFAULT_THRESHOLD = 0.45;
/** 高于这个分且 risk < 0.5，才可以不经确认直接开干。 */
export const AUTONOMOUS_THRESHOLD = 0.62;
/** 做完之后多久内不重复同一条念头（小时）。 */
const COOLDOWN_HOURS = 48;

const clamp01 = (v, fallback = 0) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);

/**
 * 从念头 + 驱动生成候选。
 *
 * @param {object[]} intentions  IntentionLedger.open() 的结果（已带 score 字段 = value）
 * @param {object} drives        当前驱动值
 * @param {object} opts
 * @param {number} [opts.now]
 * @param {string[]} [opts.recentIntentionIds] 最近 48 小时做过的念头 id
 */
export function buildCandidates(intentions, drives, { now = Date.now(), recentIntentionIds = [] } = {}) {
  const recent = new Set(recentIntentionIds);
  const out = [];
  for (const item of Array.isArray(intentions) ? intentions : []) {
    if (item === null || typeof item !== 'object') continue;
    const value = clamp01(Number(item.score ?? item.value ?? 0));
    if (value <= 0) continue;
    const touchedHours = Math.max(0, (now - (Number(item.lastTouchedAt) || now)) / 3600_000);
    // 憋得越久越急，但封顶；刚做过的不急。
    const urgency = clamp01(Math.min(1, touchedHours / 72) * 0.8 + 0.2 * (1 - (recent.has(item.id) ? 1 : 0)));
    const freshness = recent.has(item.id) ? 0 : 1;
    const driveKey = DRIVES.includes(item.drive) ? item.drive : '';
    const driveMatch = driveKey === '' ? 0.5 : clamp01(drives[driveKey] ?? 0);
    const riskClass = typeof item.riskClass === 'string' && item.riskClass !== '' ? item.riskClass : 'read';
    const risk = RISK[riskClass] ?? RISK.read;
    out.push({
      id: item.id,
      text: item.text,
      kind: item.kind,
      drive: driveKey,
      value,
      urgency,
      freshness,
      driveMatch,
      risk,
      riskClass,
      score: scoreCandidate({ value, urgency, freshness, driveMatch, risk }),
      attempts: Number(item.attempts) || 0
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 打分本体，单独导出便于调参和单测。 */
export function scoreCandidate({ value = 0, urgency = 0, freshness = 0, driveMatch = 0, risk = 0 } = {}) {
  const raw = 0.34 * clamp01(value)
    + 0.26 * clamp01(urgency)
    + 0.18 * clamp01(freshness)
    + 0.12 * clamp01(driveMatch)
    + 0.10 * (1 - clamp01(risk));
  return clamp01(raw);
}

/**
 * 决定这一次做不做。
 *
 * @returns {{
 *   decision: 'act'|'propose'|'skip',
 *   chosen?: object,
 *   ranked: object[],
 *   reason: string
 * }}
 *   act     = 分数够高且风险低，可以直接开 worker
 *   propose = 分数够但风险偏高，攒着等她说话时提一句
 *   skip    = 什么都不做
 */
export function decide(candidates, {
  tension = 0,
  threshold = DEFAULT_THRESHOLD,
  autonomousThreshold = AUTONOMOUS_THRESHOLD,
  minTension = 0.30
} = {}) {
  const ranked = Array.isArray(candidates) ? candidates : [];
  if (tension < minTension) {
    return { decision: 'skip', ranked, reason: `tension_low(${tension.toFixed(2)}<${minTension})` };
  }
  if (ranked.length === 0) {
    return { decision: 'skip', ranked, reason: 'no_intentions' };
  }
  const top = ranked[0];
  if (top.score < threshold) {
    return { decision: 'skip', ranked, reason: `below_threshold(${top.score.toFixed(2)}<${threshold})` };
  }
  if (top.score >= autonomousThreshold && top.risk < 0.5) {
    return { decision: 'act', chosen: top, ranked, reason: 'autonomous' };
  }
  return { decision: 'propose', chosen: top, ranked, reason: `needs_confirm(score=${top.score.toFixed(2)},risk=${top.risk.toFixed(2)})` };
}

/** 计算 tension 的便捷包装，方便调用方不额外 import。 */
export function tension(drives) {
  return tensionOf(drives);
}

export { COOLDOWN_HOURS };
