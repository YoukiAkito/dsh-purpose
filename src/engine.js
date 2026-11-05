/**
 * 引擎：一次 tick 走完「闸门 → 收集 → 假设 → 打分 → 投递 → 记账」。
 *
 * 设计上刻意把"决定要动"和"真的动"分开：
 *   - 引擎只负责算出这一刻该不该叫醒，以及把 prompt 准备好
 *   - 真正投递 / 唤醒由注入的 deps 完成（插件里是 dsh 的 agent resume + followup）
 * 这样引擎能在测试里跑，不需要真的有个 agent。
 *
 * 闸门顺序按代价从低到高：开关 → 间隔 → 安静时段 → 日上限 → 小时上限 → 目标打分。
 */
import { collectMaterials } from './collect.js';
import {
  buildPrompt,
  proposeGoals,
  selectGoal,
  summarizeMaterials
} from './score.js';
import { isInQuietHours, localZoneOffsetMinutes } from './config.js';
import { localDayKey } from './store.js';

/**
 * 计算下一次评估时间：在 [minGap, maxGap] 之间随机。
 * 用随机而不是固定间隔，是为了避免"整点准时冒头"的机械感。
 */
export function nextGapMs(config, random = Math.random) {
  const min = Math.max(60, config.minGapSeconds) * 1000;
  const max = Math.max(min, config.maxGapSeconds * 1000);
  return Math.round(min + random() * (max - min));
}

/**
 * 跑一次评估。
 *
 * @param {object} deps
 *   - store        PurposeStore
 *   - config       已 resolve 的配置
 *   - collector    (input) => materials[]，默认 collectMaterials
 *   - deliver      async ({ prompt, chosen, materials, now }) => 'sent'|'silent'|'failed'
 *   - log          (level, msg) => void
 *   - now          () => number
 *   - random       () => number
 *   - sessionLogPath / thoughtsPath / external  传给 collector
 * @returns {Promise<object>} 本次结论（也会写进 runs.jsonl）
 */
export async function tick(deps) {
  const {
    store,
    config,
    collector = collectMaterials,
    deliver,
    log = () => {},
    now = () => Date.now(),
    random = Math.random,
    sessionLogPath = '',
    thoughtsPath = '',
    external = []
  } = deps;

  const at = now();
  const finish = (result) => {
    store.persist();
    store.recordRun({ ...result, at: undefined });
    return result;
  };

  // 闸门一：日上限
  if (!store.canDeliverToday(at, config.maxDeliveriesPerDay)) {
    return finish({ decision: 'silent', reason: 'daily_budget', nextAt: new Date(at + nextGapMs(config, random)).toISOString() });
  }

  // 闸门二：小时上限
  if (store.wakeupsLastHour(at) >= config.maxWakeupsPerHour) {
    return finish({ decision: 'silent', reason: 'hourly_budget', nextAt: new Date(at + nextGapMs(config, random)).toISOString() });
  }

  // 闸门三：安静时段（按本机时区）
  if (isInQuietHours(at, config, localZoneOffsetMinutes(at))) {
    return finish({ decision: 'silent', reason: 'quiet_hours', nextAt: new Date(at + nextGapMs(config, random)).toISOString() });
  }

  // 收集素材
  let materials = [];
  try {
    materials = collector({
      sessionLogPath,
      thoughtsPath,
      external,
      windowHours: config.materialWindowHours,
      maxMaterials: config.maxMaterials,
      maxMaterialChars: config.maxMaterialChars,
      log
    }) ?? [];
  } catch (error) {
    log('warn', `素材收集抛错：${error.message}`);
    materials = [];
  }

  if (materials.length === 0) {
    return finish({ decision: 'silent', reason: 'no_materials', nextAt: new Date(at + nextGapMs(config, random)).toISOString() });
  }

  // 假设 → 打分
  const signals = summarizeMaterials(materials, at);
  const history = {};
  for (const kind of ['follow_up_user', 'group_thread', 'external_share', 'own_thought', 'active_topic_advance']) {
    history[kind] = store.kindStat(kind);
  }
  const goals = proposeGoals(materials, signals, history);
  const picked = selectGoal(goals, {
    threshold: config.scoreThreshold,
    recentTexts: store.state.recentTexts,
    dedupeSimilarity: config.dedupeSimilarity,
    coolingGoals: store.coolingMap(),
    now: at
  });

  for (const goal of picked.ranked.slice(0, 5)) {
    store.recordGoal(goal, { selected: goal.goalId === picked.chosen?.goalId });
  }

  if (picked.decision !== 'deliver' || picked.chosen === undefined) {
    return finish({
      decision: 'silent',
      reason: picked.reason ?? 'no_goal',
      ranked: summarizeRanked(picked.ranked),
      nextAt: new Date(at + nextGapMs(config, random)).toISOString()
    });
  }

  const chosen = picked.chosen;
  const prompt = buildPrompt(chosen, materials, {
    maxMaterials: config.maxMaterials,
    maxMaterialChars: config.maxMaterialChars,
    nowIso: new Date(at).toISOString()
  });

  // 投递前先记冷却与记账——投递失败也不该立刻重试同一条。
  store.cool(chosen.goalId, config.goalCooldownSeconds, at);
  store.bumpKind(chosen.kind, { sent: 1 });

  let outcome = 'failed';
  try {
    outcome = (await deliver({ prompt, chosen, materials, now: at })) ?? 'failed';
  } catch (error) {
    log('warn', `投递失败：${error.message}`);
    outcome = 'failed';
  }

  if (outcome === 'sent') {
    store.noteDelivery(prompt, at);
    store.state.nextAt = new Date(at + nextGapMs(config, random)).toISOString();
  } else {
    // 没发出去：回退 sent 计数，并把间隔推近一点再试。
    store.bumpKind(chosen.kind, { sent: -1 });
    store.state.nextAt = new Date(at + Math.min(300, config.minGapSeconds) * 1000).toISOString();
  }

  return finish({
    decision: outcome === 'sent' ? 'deliver' : 'silent',
    reason: outcome === 'sent' ? 'delivered' : `delivery_${outcome}`,
    goalId: chosen.goalId,
    kind: chosen.kind,
    score: Number(chosen.score.toFixed(3)),
    nextAt: store.state.nextAt
  });
}

/** 只保留可展示的字段，避免把整颗 goal 写进流水。 */
function summarizeRanked(ranked) {
  return ranked.slice(0, 5).map((goal) => ({
    goalId: goal.goalId,
    kind: goal.kind,
    score: Number(goal.score.toFixed(3))
  }));
}

/**
 * 按反馈调整某类目标的置信度。
 *
 * 反馈来源只能是主人：正面 → 加，负面 → 减，沉默不惩罚（沉默本身就够多了）。
 * 这个函数不做 IO，调用方负责 bumpKind + persist。
 */
export function feedback(kind, verdict, config) {
  const { reward, penalty, min, max } = config.confidence;
  const delta = verdict === 'positive' ? reward : verdict === 'negative' ? -penalty : 0;
  return { kind, delta, min, max };
}

/** 判断今天是否已经跨日（用于日配额重置时打日志）。 */
export function dayChanged(prevDay, now) {
  return prevDay !== localDayKey(now);
}
