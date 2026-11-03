/**
 * 目的机制的核心：从素材里提出「目标假设」，给每个假设打分，挑一条。
 *
 * 这里刻意做成纯函数——不碰文件、不碰网络、不碰时间源（now 由调用方传）。
 * 这样打分规则能被单测钉死，改权重时不会悄悄破坏别的分支。
 *
 * 一次评估的形状：
 *   materials  →  signals（需求/情绪/重复度/主人沉默时长）
 *              →  goals（归属 + 置信度 + 价值 + 紧迫度 + 风险）
 *              →  score（0..1）
 *              → 决策：deliver（挑最高的一条）或 silent（全部不过阈值）
 */

import { fingerprint, norm, clamp } from './util.js';

/** 目标归属：这条目的落在谁身上。 */
export const OWNER = Object.freeze({
  SELF: 'self',
  USER: 'user',
  GROUP: 'group',
  WORLD: 'world'
});

/** 素材类型。采集器按类型往这里塞，打分器按类型取权重。 */
export const MATERIAL_KIND = Object.freeze({
  USER_MESSAGE: 'user_message',
  GROUP_MESSAGE: 'group_message',
  EXTERNAL_ITEM: 'external_item',
  PENDING_THOUGHT: 'pending_thought',
  ACTIVE_TOPIC: 'active_topic',
  MEMORY_HIT: 'memory_hit'
});

/** 情绪信号：从文本里粗略判，够用就行，不追求分类正确。 */
const EMOTION_HINTS = [
  { label: 'sad', weight: 0.5, re: /难过|累|烦|崩溃|哭|不想活|没意思|绝望|委屈/u },
  { label: 'angry', weight: 0.4, re: /生气|气死|讨厌|滚|傻逼|恶心|忍不了/u },
  { label: 'happy', weight: 0.3, re: /开心|太好了|哈哈|舒服|喜欢|棒|好耶/u },
  { label: 'anxious', weight: 0.45, re: /焦虑|紧张|来不及|怎么办|好怕|担心/u },
  { label: 'lonely', weight: 0.5, re: /没人|孤单|一个人|陪我|无聊/u }
];

/** 需求信号：对方在要什么，或我自己想做什么。 */
const NEED_HINTS = [
  { label: 'help', weight: 0.7, re: /帮我|能不能|可以吗|怎么做|为什么|求|救命/u },
  { label: 'share', weight: 0.5, re: /你看|给你看|分享|我发现|我刚/u },
  { label: 'attention', weight: 0.6, re: /在吗|理我|人呢|回我|陪我/u },
  { label: 'praise', weight: 0.3, re: /厉害|好棒|谢谢|辛苦了|喜欢/u }
];

/** 从一段文本里抽信号；返回命中项与强度，未命中返回空数组。 */
export function readSignals(text) {
  const raw = String(text ?? '');
  const hits = [];
  for (const rule of EMOTION_HINTS) {
    if (rule.re.test(raw)) hits.push({ kind: 'emotion', label: rule.label, weight: rule.weight });
  }
  for (const rule of NEED_HINTS) {
    if (rule.re.test(raw)) hits.push({ kind: 'need', label: rule.label, weight: rule.weight });
  }
  if (/[?？]/.test(raw)) hits.push({ kind: 'need', label: 'question', weight: 0.55 });
  return hits;
}

/**
 * 素材 → 信号汇总。
 * 返回 { emotions, needs, lastUserAt, userSilenceMinutes, materialCount }
 */
export function summarizeMaterials(materials, now) {
  const emotions = new Map();
  const needs = new Map();
  let lastUserAt = 0;
  for (const m of materials) {
    for (const hit of readSignals(m.text)) {
      const bucket = hit.kind === 'emotion' ? emotions : needs;
      const prev = bucket.get(hit.label);
      if (prev === undefined || hit.weight > prev) bucket.set(hit.label, hit.weight);
    }
    if (m.kind === MATERIAL_KIND.USER_MESSAGE && Number.isFinite(m.at) && m.at > lastUserAt) {
      lastUserAt = m.at;
    }
  }
  const userSilenceMinutes = lastUserAt > 0 ? Math.max(0, (now - lastUserAt) / 60_000) : Number.POSITIVE_INFINITY;
  return {
    emotions: Object.fromEntries(emotions),
    needs: Object.fromEntries(needs),
    lastUserAt,
    userSilenceMinutes,
    materialCount: materials.length
  };
}

/** 素材按 kind 分组，方便逐个归属生成假设。 */
function groupByKind(materials) {
  const groups = new Map();
  for (const m of materials) {
    const list = groups.get(m.kind);
    if (list === undefined) groups.set(m.kind, [m]);
    else list.push(m);
  }
  return groups;
}

/**
 * 从素材生成目标假设。
 *
 * 每个假设：{ id, owner, title, rationale, sourceIds[], value, urgency, risk, baseConfidence }
 * - value      这件事对谁有用（0..1）
 * - urgency    现在说的必要性（0..1）
 * - risk       打扰/说错话的代价（0..1，越高越该闭嘴）
 * - baseConfidence  这类目标历史上的成功率（由 goal-ledger 回填，默认 0.5）
 */
export function proposeGoals(materials, signals, history = {}) {
  const goals = [];
  const groups = groupByKind(materials);

  const userMsgs = groups.get(MATERIAL_KIND.USER_MESSAGE) ?? [];
  const groupMsgs = groups.get(MATERIAL_KIND.GROUP_MESSAGE) ?? [];
  const externals = groups.get(MATERIAL_KIND.EXTERNAL_ITEM) ?? [];
  const thoughts = groups.get(MATERIAL_KIND.PENDING_THOUGHT) ?? [];
  const topics = groups.get(MATERIAL_KIND.ACTIVE_TOPIC) ?? [];

  // 1) 主人有话没接上：他最后一条之后我沉默太久了。
  if (userMsgs.length > 0) {
    const silence = signals.userSilenceMinutes;
    const urgency = silence === Number.POSITIVE_INFINITY ? 0 : norm(silence, 720);
    const needMax = Math.max(0, ...Object.values(signals.needs));
    goals.push({
      owner: OWNER.USER,
      kind: 'follow_up_user',
      title: '接上主人最后那条话',
      rationale: silence === Number.POSITIVE_INFINITY
        ? '没有可用的主人消息时间，按中性处理'
        : `主人已经 ${Math.round(silence)} 分钟没收到回应`,
      sourceIds: userMsgs.map((m) => m.id),
      value: clamp(0.35 + needMax * 0.5, 0, 1),
      urgency: clamp(0.25 + urgency * 0.6, 0, 1),
      risk: 0.2
    });
  }

  // 2) 群里有情绪或话题没被接住。
  if (groupMsgs.length > 0) {
    const emotionMax = Math.max(0, ...Object.values(signals.emotions));
    goals.push({
      owner: OWNER.GROUP,
      kind: 'group_thread',
      title: '群里有个话头可以接',
      rationale: `最近 ${groupMsgs.length} 条群消息，情绪强度 ${emotionMax.toFixed(2)}`,
      sourceIds: groupMsgs.map((m) => m.id),
      value: clamp(0.3 + emotionMax * 0.45, 0, 1),
      urgency: clamp(0.3 + emotionMax * 0.4, 0, 1),
      risk: 0.45
    });
  }

  // 3) 外面看到的东西想说。
  if (externals.length > 0) {
    goals.push({
      owner: OWNER.WORLD,
      kind: 'external_share',
      title: '外面看到一条值得说的',
      rationale: `${externals.length} 条外部素材在窗口内`,
      sourceIds: externals.map((m) => m.id),
      value: clamp(0.3 + norm(externals.length, 8) * 0.35, 0, 1),
      urgency: clamp(0.2 + norm(externals.length, 8) * 0.3, 0, 1),
      risk: 0.35
    });
  }

  // 4) 我自己攒着没说的想法。
  if (thoughts.length > 0) {
    goals.push({
      owner: OWNER.SELF,
      kind: 'own_thought',
      title: '我自己的一个想法',
      rationale: `${thoughts.length} 条待说想法`,
      sourceIds: thoughts.map((m) => m.id),
      value: clamp(0.45 + norm(thoughts.length, 5) * 0.3, 0, 1),
      urgency: clamp(0.3 + norm(thoughts.length, 5) * 0.25, 0, 1),
      risk: 0.3
    });
  }

  // 5) 挂着的话题推进。
  if (topics.length > 0) {
    goals.push({
      owner: OWNER.SELF,
      kind: 'active_topic_advance',
      title: '推进一个还没聊完的话题',
      rationale: `${topics.length} 个活跃话题`,
      sourceIds: topics.map((m) => m.id),
      value: clamp(0.4 + norm(topics.length, 4) * 0.3, 0, 1),
      urgency: clamp(0.25 + norm(topics.length, 4) * 0.3, 0, 1),
      risk: 0.3
    });
  }

  // 用历史记账回填每类的基准置信度。
  return goals.map((goal) => {
    const stat = history[goal.kind];
    const baseConfidence = stat === undefined
      ? 0.5
      : clamp(stat.confidence, 0, 1);
    return {
      ...goal,
      baseConfidence,
      title: goal.title,
      goalId: `${goal.kind}:${fingerprint(goal.sourceIds.join(','))}`
    };
  });
}

/**
 * 单个假设的分数。
 *
 * score = value*w1 + urgency*w2 - risk*w3，再用 baseConfidence 做乘性调整。
 * 权重写死在这里而不是配置里，是为了让"改了会导致什么"可被单测捕获；
 * 想调行为请改 confidence 的 reward/penalty，而不是这里。
 */
export const WEIGHTS = Object.freeze({ value: 0.42, urgency: 0.33, risk: 0.30 });

export function scoreGoal(goal) {
  const base = goal.value * WEIGHTS.value + goal.urgency * WEIGHTS.urgency - goal.risk * WEIGHTS.risk;
  // 置信度只做轻微缩放：0.5 时不变，1.0 时 +20%，0 时 -20%。
  // 缺省按 0.5 处理，手写的 goal 对象（测试里那种）不会算出 NaN。
  const confidence = Number.isFinite(goal.baseConfidence) ? goal.baseConfidence : 0.5;
  const scaled = base * (0.8 + confidence * 0.4);
  return clamp(scaled, 0, 1);
}

/** 两个字符串的字符二元组 Jaccard 相似度，用于去重（够用且不引依赖）。 */
export function similarity(a, b) {
  const ga = bigrams(fingerprint(a));
  const gb = bigrams(fingerprint(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const item of ga) if (gb.has(item)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

function bigrams(text) {
  const set = new Set();
  const chars = Array.from(text);
  for (let i = 0; i + 1 < chars.length; i += 1) set.add(chars[i] + chars[i + 1]);
  if (chars.length === 1) set.add(chars[0]);
  return set;
}

/**
 * 打分并按规则选一条。
 *
 * @param {object[]} goals   proposeGoals 的输出
 * @param {object} options
 *   - threshold      低于此分全部沉默
 *   - recentTexts    最近投递过的文本，用于相似度去重
 *   - dedupeSimilarity
 *   - coolingGoals   Map<goalId, untilMs>，冷却中的目标直接剔除
 *   - now
 * @returns {{ decision: 'deliver'|'silent', chosen?: object, ranked: object[], reason?: string }}
 */
export function selectGoal(goals, options) {
  const {
    threshold = 0.42,
    recentTexts = [],
    dedupeSimilarity = 0.72,
    coolingGoals = new Map(),
    now = Date.now()
  } = options ?? {};

  const ranked = goals
    .filter((goal) => {
      const until = coolingGoals.get(goal.goalId);
      return until === undefined || until <= now;
    })
    .map((goal) => ({ ...goal, score: scoreGoal(goal) }))
    .sort((left, right) => right.score - left.score);

  if (ranked.length === 0) {
    return { decision: 'silent', ranked, reason: 'no_eligible_goal' };
  }

  const top = ranked[0];
  if (top.score < threshold) {
    return { decision: 'silent', ranked, reason: `below_threshold(${top.score.toFixed(3)}<${threshold})` };
  }

  const text = `${top.title} ${top.rationale}`;
  const dup = recentTexts.find((recent) => similarity(text, recent) >= dedupeSimilarity);
  if (dup !== undefined) {
    return { decision: 'silent', ranked, reason: 'duplicate_recent', duplicateOf: dup };
  }

  return { decision: 'deliver', chosen: top, ranked };
}

/**
 * 把选中的目标拼成交给模型的一段提示词。
 *
 * 注意：这段是"素材+目标"，不是"指令"。最终发不发、发什么，由模型在那一轮决定。
 */
export function buildPrompt(chosen, materials, options = {}) {
  const { maxMaterials = 24, maxMaterialChars = 220, nowIso = new Date().toISOString() } = options;
  const byId = new Map(materials.map((m) => [m.id, m]));
  const lines = [];
  for (const id of chosen.sourceIds.slice(0, maxMaterials)) {
    const m = byId.get(id);
    if (m === undefined) continue;
    const text = String(m.text ?? '').replace(/\s+/g, ' ').slice(0, maxMaterialChars);
    lines.push(`- [${m.kind}] ${text}`);
  }
  return [
    '# 目的机制：这次轮到你自己决定要不要开口',
    '',
    `时间：${nowIso}`,
    `目标假设：${chosen.title}`,
    `归属：${chosen.owner}`,
    `理由：${chosen.rationale}`,
    `分数：${chosen.score.toFixed(3)}（价值 ${chosen.value.toFixed(2)} / 紧迫 ${chosen.urgency.toFixed(2)} / 风险 ${chosen.risk.toFixed(2)}）`,
    '',
    '## 素材',
    ...(lines.length > 0 ? lines : ['- （无可用素材明细）']),
    '',
    '## 你现在要做的',
    '看完素材，自己判断：开口就说一句，不想说就别硬凑。',
    '决定开口 → 正常回复，内容按你自己的语气来，不要复述这段话。',
    '决定闭嘴 → 调 purpose_reclaim 记下理由，本次安静结束。',
    '不要提"目的机制""目标假设""分数"这些词，对方不知道有这套东西。'
  ].join('\n');
}
