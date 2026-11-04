import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_INTENT_STATE, IntentRuntime, ASK_COOLDOWN_HOURS, MIN_ASK_GAP_HOURS } from '../src/intent-runtime.js';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purpose-rt-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('首次 load 用空状态并填默认驱动', () => withDir((dir) => {
  const rt = new IntentRuntime(dir);
  const state = rt.load().state;
  assert.equal(state.version, EMPTY_INTENT_STATE.version);
  assert.ok(state.drives.curiosity > 0);
  assert.deepEqual(state.recentIntentionIds, []);
}));

test('persist 之后重新 load 能读回驱动值', () => withDir((dir) => {
  const rt = new IntentRuntime(dir);
  rt.load();
  rt.state.drives.curiosity = 0.77;
  rt.persist();
  const again = new IntentRuntime(dir);
  again.load();
  assert.ok(Math.abs(again.state.drives.curiosity - 0.77) < 1e-6);
}));

test('advanceDrives 按流逝时间推进，幂等', () => withDir((dir) => {
  const rt = new IntentRuntime(dir);
  rt.load();
  const t0 = Date.now();
  rt.state.lastEvolvedAt = t0 - 2 * 3600_000;
  const before = { ...rt.state.drives };
  rt.advanceDrives(t0);
  assert.ok(rt.state.drives.boredom > before.boredom);
  const snapshot = { ...rt.state.drives };
  rt.advanceDrives(t0); // 同一时刻再调一次，不该继续涨
  assert.deepEqual(rt.state.drives, snapshot);
}));

test('evaluate: tension 低时返回 skip 且不抛', () => withDir((dir) => {
  const rt = new IntentRuntime(dir);
  rt.load();
  rt.state.drives = { curiosity: 0, boredom: 0, restlessness: 0, pride: 0, fatigue: 1 };
  rt.state.lastEvolvedAt = Date.now();
  const logs = [];
  const r = rt.evaluate({ config: { minTension: 0.9 }, log: (lv, m) => logs.push(`${lv}:${m}`) });
  assert.equal(r.decision, 'skip');
  assert.match(r.reason, /tension_low/);
  assert.equal(logs.length, 1);
  assert.equal(r.ranked.length, 0);
}));

test('evaluate: 有高价值念头时给出 act/propose 并记录', () => withDir((dir) => {
  const rt = new IntentRuntime(dir);
  rt.load();
  rt.state.drives = { curiosity: 1, boredom: 1, restlessness: 1, pride: 1, fatigue: 0 };
  rt.state.lastEvolvedAt = Date.now();
  rt.ledger.add({ text: '搞明白 zstd 多帧到底怎么拼的', kind: 'question', drive: 'curiosity', weight: 1 });
  const r = rt.evaluate({ config: { minTension: 0.1, intentThreshold: 0.1 } });
  assert.notEqual(r.decision, 'skip');
  assert.ok(r.chosen !== null);
  assert.ok(rt.state.recentIntentionIds.includes(r.chosen.id));
}));

test('evaluate: 没有念头时 skip 且原因是 no_intentions', () => withDir((dir) => {
  const rt = new IntentRuntime(dir);
  rt.load();
  rt.state.drives = { curiosity: 1, boredom: 1, restlessness: 1, pride: 1, fatigue: 0 };
  rt.state.lastEvolvedAt = Date.now();
  const r = rt.evaluate({ config: { minTension: 0.1 } });
  assert.equal(r.decision, 'skip');
  assert.equal(r.reason, 'no_intentions');
}));

test('satisfy 让对应驱动回落', () => withDir((dir) => {
  const rt = new IntentRuntime(dir);
  rt.load();
  rt.state.drives.curiosity = 0.9;
  const after = rt.satisfy('curiosity');
  assert.ok(after.curiosity < 0.9);
}));

test('view 输出可用摘要', () => withDir((dir) => {
  const rt = new IntentRuntime(dir);
  rt.load();
  rt.ledger.add({ text: '把念头接进日志', kind: 'unfinished', weight: 0.8 });
  const view = rt.view();
  assert.ok(typeof view.tension === 'number');
  assert.equal(view.openIntentions, 1);
  assert.equal(view.top.length, 1);
  assert.equal(view.top[0].kind, 'unfinished');
}));

test('坏 state.json 不炸，回落默认', () => withDir((dir) => {
  writeFileSync(join(dir, 'intent-state.json'), '{这不是 json');
  const rt = new IntentRuntime(dir);
  assert.equal(rt.load().state.version, EMPTY_INTENT_STATE.version);
}));

test('load 返回 runtime 自己，可以链式接 ledger', () => withDir((dir) => {
  const rt = new IntentRuntime(dir).load();
  assert.equal(typeof rt.ledger.add, 'function');
  assert.equal(rt.ledger.all().length, 0);
}));

test('shouldAsk：没念头就不问', () => withDir((dir) => {
  const rt = new IntentRuntime(dir).load();
  assert.equal(rt.shouldAsk({ chosen: null }).ask, false);
  assert.equal(rt.shouldAsk({ chosen: null }).reason, 'no_intention');
}));

test('shouldAsk：够格且没问过 → 问', () => withDir((dir) => {
  const rt = new IntentRuntime(dir).load();
  const gate = rt.shouldAsk({ chosen: { id: 'i_a', text: 'x' } });
  assert.equal(gate.ask, true);
  assert.equal(gate.reason, 'qualified');
}));

test('markAsked 之后同一念头进入冷却，不再追问', () => withDir((dir) => {
  const rt = new IntentRuntime(dir).load();
  const now = Date.parse('2026-11-04T04:00:00.000Z');
  rt.markAsked('i_a', now);
  const gate = rt.shouldAsk({ chosen: { id: 'i_a', text: 'x' } }, now + 3600_000);
  assert.equal(gate.ask, false);
  assert.equal(gate.reason, 'already_asked');
}));

test('冷却期满之后同一念头可以再问', () => withDir((dir) => {
  const rt = new IntentRuntime(dir).load();
  const now = Date.parse('2026-11-04T04:00:00.000Z');
  rt.markAsked('i_a', now);
  const later = now + (ASK_COOLDOWN_HOURS + 1) * 3600_000;
  assert.equal(rt.shouldAsk({ chosen: { id: 'i_a', text: 'x' } }, later).ask, true);
}));

test('两次追问之间至少隔 MIN_ASK_GAP_HOURS', () => withDir((dir) => {
  const rt = new IntentRuntime(dir).load();
  const now = Date.parse('2026-11-04T04:00:00.000Z');
  rt.markAsked('i_a', now);
  // 换一条新念头，但刚问过一次，仍然要等
  const gate = rt.shouldAsk({ chosen: { id: 'i_b', text: 'y' } }, now + 1800_000);
  assert.equal(gate.ask, false);
  assert.match(gate.reason, /^ask_gap\(/);
}));

test('问 A 不会刷新 B 的冷却', () => withDir((dir) => {
  const rt = new IntentRuntime(dir).load();
  const t0 = Date.parse('2026-11-04T04:00:00.000Z');
  rt.markAsked('i_a', t0);
  const t1 = t0 + (MIN_ASK_GAP_HOURS + 1) * 3600_000;
  rt.markAsked('i_b', t1);
  const t2 = t1 + 3600_000;
  // A 上次是 t0，过了 ASK_COOLDOWN_HOURS 就放行；B 刚问过还在冷却
  const after = t0 + (ASK_COOLDOWN_HOURS + 1) * 3600_000;
  assert.equal(rt.shouldAsk({ chosen: { id: 'i_b', text: 'y' } }, after).ask, false);
}));

test('askedAt 落盘后重新 load 仍然生效', () => withDir((dir) => {
  const rt = new IntentRuntime(dir).load();
  const now = Date.parse('2026-11-04T04:00:00.000Z');
  rt.markAsked('i_a', now);
  const again = new IntentRuntime(dir).load();
  assert.equal(again.shouldAsk({ chosen: { id: 'i_a', text: 'x' } }, now + 600_000).ask, false);
  assert.ok(typeof again.view().lastAskAt === 'string');
}));

test('view 暴露 lastAskAt 与 askedCount', () => withDir((dir) => {
  const rt = new IntentRuntime(dir).load();
  assert.equal(rt.view().lastAskAt, '');
  assert.equal(rt.view().askedCount, 0);
  rt.markAsked('i_a', Date.parse('2026-11-04T04:00:00.000Z'));
  assert.equal(rt.view().askedCount, 1);
  assert.notEqual(rt.view().lastAskAt, '');
}));
