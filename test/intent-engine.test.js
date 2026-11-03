import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTONOMOUS_THRESHOLD,
  DEFAULT_THRESHOLD,
  RISK,
  buildCandidates,
  decide,
  scoreCandidate,
  tension
} from '../src/intent-engine.js';
import { normalizeDrives } from '../src/drives.js';

function intention(over = {}) {
  return {
    id: 'i1',
    text: '搞明白 zstd 多帧',
    kind: 'question',
    score: 0.8,
    lastTouchedAt: Date.now(),
    attempts: 0,
    ...over
  };
}

test('scoreCandidate 落在 0..1 且随风险下降', () => {
  const base = { value: 0.8, urgency: 0.6, freshness: 1, driveMatch: 0.7 };
  const low = scoreCandidate({ ...base, risk: 0.1 });
  const high = scoreCandidate({ ...base, risk: 0.8 });
  assert.ok(low > high);
  assert.ok(low <= 1 && low >= 0);
});

test('scoreCandidate 对缺字段不炸，返回 0 附近', () => {
  const s = scoreCandidate({});
  assert.ok(Number.isFinite(s));
  assert.ok(s >= 0 && s <= 1);
});

test('buildCandidates 把念头换成带打分的候选并按分排序', () => {
  const drives = normalizeDrives({ curiosity: 1 });
  const list = buildCandidates(
    [intention({ id: 'a', score: 0.9 }), intention({ id: 'b', score: 0.3, text: '别的事' })],
    drives
  );
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'a');
  assert.ok(list[0].score > list[1].score);
});

test('buildCandidates 里 drive 匹配会加权', () => {
  const hot = buildCandidates([intention({ drive: 'curiosity' })], normalizeDrives({ curiosity: 1 }));
  const cold = buildCandidates([intention({ drive: 'curiosity' })], normalizeDrives({ curiosity: 0 }));
  assert.ok(hot[0].driveMatch > cold[0].driveMatch);
  assert.ok(hot[0].score > cold[0].score);
});

test('buildCandidates 近期做过的会降 freshness', () => {
  const fresh = buildCandidates([intention({ id: 'x' })], normalizeDrives({}), { recentIntentionIds: [] });
  const recent = buildCandidates([intention({ id: 'x' })], normalizeDrives({}), { recentIntentionIds: ['x'] });
  assert.equal(fresh[0].freshness, 1);
  assert.equal(recent[0].freshness, 0);
  assert.ok(recent[0].score < fresh[0].score);
});

test('buildCandidates 默认风险按 read 记', () => {
  const [c] = buildCandidates([intention()], normalizeDrives({}));
  assert.equal(c.risk, RISK.read);
});

test('decide: tension 太低直接 skip', () => {
  const r = decide([{ score: 0.99, risk: 0 }], { tension: 0.1 });
  assert.equal(r.decision, 'skip');
  assert.match(r.reason, /tension_low/);
});

test('decide: 没有念头时 skip', () => {
  const r = decide([], { tension: 0.9 });
  assert.equal(r.decision, 'skip');
  assert.equal(r.reason, 'no_intentions');
});

test('decide: 分不够 skip 并说明差距', () => {
  const r = decide([{ score: 0.2, risk: 0.1 }], { tension: 0.9, threshold: DEFAULT_THRESHOLD });
  assert.equal(r.decision, 'skip');
  assert.match(r.reason, /below_threshold/);
});

test('decide: 高分低风险可以直接动手', () => {
  const r = decide([{ score: 0.9, risk: 0.1, id: 'a' }], { tension: 0.9 });
  assert.equal(r.decision, 'act');
  assert.equal(r.chosen.id, 'a');
});

test('decide: 高分但高风险只能提议', () => {
  const r = decide([{ score: 0.9, risk: 0.8, id: 'a' }], { tension: 0.9 });
  assert.equal(r.decision, 'propose');
  assert.match(r.reason, /needs_confirm/);
});

test('decide: 中等分也是 propose', () => {
  const score = (DEFAULT_THRESHOLD + AUTONOMOUS_THRESHOLD) / 2;
  const r = decide([{ score, risk: 0.1 }], { tension: 0.9 });
  assert.equal(r.decision, 'propose');
});

test('tension 是 tensionOf 的包装', () => {
  assert.equal(tension(normalizeDrives({})), tension(normalizeDrives({})));
  assert.ok(tension(normalizeDrives({})) >= 0);
});
