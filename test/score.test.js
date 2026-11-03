import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEIGHTS,
  buildPrompt,
  proposeGoals,
  readSignals,
  scoreGoal,
  selectGoal,
  similarity,
  summarizeMaterials,
  MATERIAL_KIND
} from '../src/score.js';

const NOW = Date.parse('2026-11-03T12:00:00+08:00');

function material(kind, text, at = NOW - 60_000, id = text) {
  return { id, kind, text, at };
}

test('readSignals 认出情绪、需求与提问', () => {
  const hits = readSignals('我好累啊，怎么办？');
  const labels = hits.map((hit) => hit.label).sort();
  assert.deepEqual(labels, ['anxious', 'question', 'sad'].sort());
  // 求助要「帮我/求/救命」这类明确的词，光「怎么办」只算焦虑。
  assert.ok(readSignals('帮我看看这个').some((hit) => hit.label === 'help'));
  assert.equal(readSignals('').length, 0);
});

test('summarizeMaterials 算出主人沉默时长', () => {
  const materials = [
    material(MATERIAL_KIND.USER_MESSAGE, '在吗', NOW - 90 * 60_000),
    material(MATERIAL_KIND.EXTERNAL_ITEM, '一条新闻', NOW - 10 * 60_000)
  ];
  const signals = summarizeMaterials(materials, NOW);
  assert.equal(Math.round(signals.userSilenceMinutes), 90);
  assert.equal(signals.materialCount, 2);
});

test('summarizeMaterials 没有主人消息时沉默为 Infinity', () => {
  const signals = summarizeMaterials([material(MATERIAL_KIND.EXTERNAL_ITEM, '东西')], NOW);
  assert.equal(signals.userSilenceMinutes, Number.POSITIVE_INFINITY);
});

test('proposeGoals 每种素材各生成一条假设', () => {
  const materials = [
    material(MATERIAL_KIND.USER_MESSAGE, '今天好烦'),
    material(MATERIAL_KIND.GROUP_MESSAGE, '有人在吗'),
    material(MATERIAL_KIND.EXTERNAL_ITEM, '看这个'),
    material(MATERIAL_KIND.PENDING_THOUGHT, '想说的'),
    material(MATERIAL_KIND.ACTIVE_TOPIC, '话题')
  ];
  const signals = summarizeMaterials(materials, NOW);
  const goals = proposeGoals(materials, signals);
  const kinds = goals.map((goal) => goal.kind).sort();
  assert.deepEqual(kinds, [
    'active_topic_advance',
    'external_share',
    'follow_up_user',
    'group_thread',
    'own_thought'
  ].sort());
  for (const goal of goals) {
    assert.ok(goal.value >= 0 && goal.value <= 1);
    assert.ok(goal.urgency >= 0 && goal.urgency <= 1);
    assert.ok(goal.risk >= 0 && goal.risk <= 1);
    assert.match(goal.goalId, /^[a-z_]+:/);
  }
});

test('proposeGoals 用历史置信度覆盖 baseConfidence', () => {
  const materials = [material(MATERIAL_KIND.PENDING_THOUGHT, '想法')];
  const signals = summarizeMaterials(materials, NOW);
  const goals = proposeGoals(materials, signals, { own_thought: { confidence: 0.9 } });
  assert.equal(goals[0].baseConfidence, 0.9);
});

test('scoreGoal 落在 0..1 且风险会拉低分数', () => {
  const base = { value: 0.8, urgency: 0.7, risk: 0.1, baseConfidence: 0.5 };
  const risky = { ...base, risk: 0.9 };
  const low = scoreGoal(base);
  const high = scoreGoal(risky);
  assert.ok(low > high);
  assert.ok(low > 0 && low < 1);
  assert.ok(Math.abs(low - (base.value * WEIGHTS.value + base.urgency * WEIGHTS.urgency - base.risk * WEIGHTS.risk)) < 1e-9);
});

test('scoreGoal 的置信度是轻微缩放而不是重排', () => {
  const goal = { value: 0.6, urgency: 0.6, risk: 0.2 };
  assert.ok(scoreGoal({ ...goal, baseConfidence: 1 }) > scoreGoal({ ...goal, baseConfidence: 0 }));
  // 0.5 时应当与裸分数一致。
  assert.ok(Math.abs(scoreGoal({ ...goal, baseConfidence: 0.5 }) - scoreGoal(goal)) < 1e-9);
});

test('similarity 对完全相同为 1，对无关为 0', () => {
  assert.equal(similarity('今天天气不错', '今天天气不错'), 1);
  assert.equal(similarity('abc', 'xyz'), 0);
  assert.ok(similarity('今天天气不错', '今天天气不太好') > 0);
});

test('selectGoal 低于阈值返回 silent 并给出理由', () => {
  const goals = [{ goalId: 'a:1', kind: 'own_thought', title: 'x', rationale: 'y', value: 0.1, urgency: 0.1, risk: 0.5, baseConfidence: 0.5, sourceIds: [] }];
  const picked = selectGoal(goals, { threshold: 0.9, now: NOW });
  assert.equal(picked.decision, 'silent');
  assert.match(picked.reason, /^below_threshold/);
});

test('selectGoal 挑最高分', () => {
  const goals = [
    { goalId: 'a:1', kind: 'own_thought', title: '低', rationale: '', value: 0.2, urgency: 0.2, risk: 0.3, baseConfidence: 0.5, sourceIds: [] },
    { goalId: 'b:2', kind: 'group_thread', title: '高', rationale: '', value: 0.9, urgency: 0.9, risk: 0.1, baseConfidence: 0.5, sourceIds: [] }
  ];
  const picked = selectGoal(goals, { threshold: 0.2, now: NOW });
  assert.equal(picked.decision, 'deliver');
  assert.equal(picked.chosen.goalId, 'b:2');
});

test('selectGoal 跳过冷却中的目标', () => {
  const goals = [
    { goalId: 'a:1', kind: 'own_thought', title: '高', rationale: '', value: 0.9, urgency: 0.9, risk: 0.1, baseConfidence: 0.5, sourceIds: [] },
    { goalId: 'b:2', kind: 'group_thread', title: '低', rationale: '', value: 0.5, urgency: 0.5, risk: 0.1, baseConfidence: 0.5, sourceIds: [] }
  ];
  const picked = selectGoal(goals, { threshold: 0.1, now: NOW, coolingGoals: new Map([['a:1', NOW + 60_000]]) });
  assert.equal(picked.chosen.goalId, 'b:2');
});

test('selectGoal 全部冷却时返回 no_eligible_goal', () => {
  const goals = [{ goalId: 'a:1', kind: 'own_thought', title: 'x', rationale: '', value: 0.9, urgency: 0.9, risk: 0.1, baseConfidence: 0.5, sourceIds: [] }];
  const picked = selectGoal(goals, { now: NOW, coolingGoals: new Map([['a:1', NOW + 60_000]]) });
  assert.equal(picked.decision, 'silent');
  assert.equal(picked.reason, 'no_eligible_goal');
});

test('selectGoal 与最近投递过于相似时判重复', () => {
  const goals = [{ goalId: 'a:1', kind: 'own_thought', title: '我自己的一个想法', rationale: '3 条待说想法', value: 0.9, urgency: 0.9, risk: 0.1, baseConfidence: 0.5, sourceIds: [] }];
  const first = selectGoal(goals, { threshold: 0.1, now: NOW });
  assert.equal(first.decision, 'deliver');
  const text = `${goals[0].title} ${goals[0].rationale}`;
  const second = selectGoal(goals, { threshold: 0.1, now: NOW, recentTexts: [text], dedupeSimilarity: 0.72 });
  assert.equal(second.decision, 'silent');
  assert.equal(second.reason, 'duplicate_recent');
});

test('buildPrompt 带素材明细与三条收尾规定', () => {
  const chosen = {
    goalId: 'own_thought:1',
    kind: 'own_thought',
    owner: 'self',
    title: '我自己的一个想法',
    rationale: '2 条待说想法',
    score: 0.61,
    value: 0.7,
    urgency: 0.6,
    risk: 0.3,
    sourceIds: ['t1', 't2']
  };
  const materials = [
    { id: 't1', kind: 'pending_thought', text: '想说的一' },
    { id: 't2', kind: 'pending_thought', text: '想说的二' }
  ];
  const prompt = buildPrompt(chosen, materials, { nowIso: '2026-11-03T12:00:00.000Z' });
  assert.match(prompt, /目的机制/);
  assert.match(prompt, /想说的一/);
  assert.match(prompt, /purpose_reclaim/);
  assert.match(prompt, /不要提/);
});

test('buildPrompt 在素材全缺时给占位', () => {
  const prompt = buildPrompt(
    { goalId: 'x:1', kind: 'own_thought', owner: 'self', title: 't', rationale: 'r', score: 0.5, value: 0.5, urgency: 0.5, risk: 0.2, sourceIds: ['missing'] },
    [],
    {}
  );
  assert.match(prompt, /无可用素材明细/);
});
