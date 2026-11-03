import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_INTENT_STATE, IntentRuntime } from '../src/intent-runtime.js';

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
