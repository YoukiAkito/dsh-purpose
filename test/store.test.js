import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurposeStore, localDayKey, EMPTY_STATE } from '../src/store.js';
import { nextGapMs } from '../src/engine.js';
import { DEFAULT_CONFIG, isInQuietHours, localZoneOffsetMinutes, parseClock, resolveConfig } from '../src/config.js';
import { tick } from '../src/engine.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purpose-'));
  return { dir, store: new PurposeStore(dir).load() };
}

test('store 初始为空状态', () => {
  const { dir, store } = tempStore();
  assert.equal(store.state.deliveredToday, 0);
  assert.deepEqual(store.kindStat('own_thought').confidence, 0.5);
  rmSync(dir, { recursive: true, force: true });
});

test('store 落盘后能读回', () => {
  const { dir, store } = tempStore();
  store.state.day = '2026-11-03';
  store.state.deliveredToday = 3;
  store.persist();
  assert.ok(existsSync(join(dir, 'state.json')));
  const again = new PurposeStore(dir).load();
  assert.equal(again.state.deliveredToday, 3);
  rmSync(dir, { recursive: true, force: true });
});

test('store 坏文件退回空状态而不是抛错', () => {
  const { dir } = tempStore();
  const file = join(dir, 'state.json');
  writeFileSync(file, '{ not json');
  const warnings = [];
  const store = new PurposeStore(dir).load((level, message) => warnings.push(`${level}:${message}`));
  assert.equal(store.corrupt, true);
  assert.equal(store.state.deliveredToday, 0);
  assert.equal(warnings.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('日配额按本地日期重置', () => {
  const { dir, store } = tempStore();
  const now = Date.parse('2026-11-03T10:00:00+08:00');
  store.state.day = localDayKey(now);
  store.state.deliveredToday = 2;
  assert.equal(store.canDeliverToday(now, 3), true);
  assert.equal(store.canDeliverToday(now, 2), false);
  const tomorrow = now + 24 * 3600_000;
  assert.equal(store.canDeliverToday(tomorrow, 2), true);
  rmSync(dir, { recursive: true, force: true });
});

test('小时配额会清掉过期唤醒', () => {
  const { dir, store } = tempStore();
  const now = Date.now();
  store.state.recentWakes = [now - 2 * 3600_000, now - 60_000, now - 30_000];
  assert.equal(store.wakeupsLastHour(now), 2);
  assert.equal(store.state.recentWakes.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('冷却到期后自动移除', () => {
  const { dir, store } = tempStore();
  const now = Date.now();
  store.cool('a:1', 60, now);
  assert.equal(store.coolingMap().size, 1);
  store.gcCooling(now + 61_000);
  assert.equal(store.coolingMap().size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('noteDelivery 写日志并截断指纹', () => {
  const { dir, store } = tempStore();
  const now = Date.now();
  for (let i = 0; i < 15; i += 1) store.noteDelivery(`文本 ${i}`, now);
  assert.equal(store.state.deliveredToday, 15);
  assert.equal(store.state.recentTexts.length, 12);
  store.persist();
  const lines = readFileSync(join(dir, 'state.json'), 'utf8');
  assert.match(lines, /文本 14/);
  rmSync(dir, { recursive: true, force: true });
});

test('goal 与 run 流水是 append-only JSONL', () => {
  const { dir, store } = tempStore();
  store.recordGoal({ goalId: 'a:1', kind: 'own_thought', owner: 'self', title: 't', rationale: 'r', score: 0.5, sourceIds: [] });
  store.recordRun({ decision: 'silent', reason: 'test' });
  const goals = store.recentGoals(10);
  const runs = store.recentRuns(10);
  assert.equal(goals.length, 1);
  assert.equal(runs.length, 1);
  assert.equal(goals[0].kind, 'own_thought');
  assert.equal(runs[0].reason, 'test');
  rmSync(dir, { recursive: true, force: true });
});

test('parseClock 只接受 HH:MM', () => {
  assert.equal(parseClock('07:30', 'start'), '07:30');
  assert.throws(() => parseClock('7:30', 'start'));
  assert.throws(() => parseClock('24:00', 'start'));
  assert.throws(() => parseClock('', 'start'));
});

test('isInQuietHours 支持跨零点', () => {
  const config = { quietHours: { start: '23:00', end: '08:00' } };
  const at = (iso) => Date.parse(iso);
  const zone = 480;
  assert.equal(isInQuietHours(at('2026-11-03T01:00:00+08:00'), config, zone), true);
  assert.equal(isInQuietHours(at('2026-11-03T12:00:00+08:00'), config, zone), false);
  assert.equal(isInQuietHours(at('2026-11-03T23:30:00+08:00'), config, zone), true);
});

test('isInQuietHours 起点等于终点视为不静默', () => {
  const config = { quietHours: { start: '08:00', end: '08:00' } };
  assert.equal(isInQuietHours(Date.parse('2026-11-03T08:00:00+08:00'), config, 480), false);
});

test('nextGapMs 落在配置区间内', () => {
  const config = { ...DEFAULT_CONFIG, minGapSeconds: 100, maxGapSeconds: 200 };
  assert.equal(nextGapMs(config, () => 0), 100_000);
  assert.equal(nextGapMs(config, () => 1), 200_000);
  const mid = nextGapMs(config, () => 0.5);
  assert.ok(mid > 100_000 && mid < 200_000);
});

test('resolveConfig 拒绝 Windows', () => {
  assert.throws(() => resolveConfig({ platform: 'win32', env: {}, file: {} }), /暂不支持 Windows/);
  assert.throws(() => resolveConfig({ platform: 'aix', env: {}, file: {} }), /不支持此平台/);
});

test('resolveConfig 环境变量与文件覆盖默认值', () => {
  const fromEnv = resolveConfig({
    platform: 'darwin',
    env: { DSH_HOME: '/tmp/home', DSH_PURPOSE_MIN_GAP: '120', DSH_PURPOSE_TARGET: 'sess-1' },
    file: {}
  });
  assert.equal(fromEnv.dataDir, '/tmp/home/purpose');
  assert.equal(fromEnv.minGapSeconds, 120);
  assert.equal(fromEnv.target.sessionId, 'sess-1');

  const fromFile = resolveConfig({
    platform: 'linux',
    env: {},
    file: { quietHours: { start: '01:00', end: '05:00' }, scoreThreshold: 0.66, target: { sessionId: 's2' } }
  });
  assert.equal(fromFile.quietHours.start, '01:00');
  assert.equal(fromFile.scoreThreshold, 0.66);
  assert.equal(fromFile.target.sessionId, 's2');
});

test('resolveConfig 对坏配置做钳制而不是抛错', () => {
  const config = resolveConfig({
    platform: 'darwin',
    env: {},
    file: { scoreThreshold: 5, maxDeliveriesPerDay: -3, quietHours: { start: '99:99', end: '17:00' } }
  });
  assert.equal(config.scoreThreshold, 1);
  assert.equal(config.maxDeliveriesPerDay, 0);
  assert.equal(config.quietHours.start, DEFAULT_CONFIG.quietHours.start);
});

test('tick 在日预算用尽时直接沉默', async () => {
  const { dir, store } = tempStore();
  store.state.day = localDayKey(Date.now());
  store.state.deliveredToday = 1;
  const result = await tick({
    store,
    config: { ...DEFAULT_CONFIG, maxDeliveriesPerDay: 1, quietHours: { start: '00:00', end: '00:00', timeZone: '' } },
    deliver: async () => 'sent',
    now: () => Date.parse('2026-11-03T12:00:00+08:00'),
    log: () => {}
  });
  assert.equal(result.decision, 'silent');
  assert.equal(result.reason, 'daily_budget');
  rmSync(dir, { recursive: true, force: true });
});

test('tick 在安静时段沉默', async () => {
  const { dir, store } = tempStore();
  const result = await tick({
    store,
    config: { ...DEFAULT_CONFIG, quietHours: { start: '00:00', end: '23:59', timeZone: '' } },
    deliver: async () => 'sent',
    now: () => Date.now(),
    log: () => {}
  });
  assert.equal(result.decision, 'silent');
  assert.equal(result.reason, 'quiet_hours');
  rmSync(dir, { recursive: true, force: true });
});

test('tick 没素材时沉默', async () => {
  const { dir, store } = tempStore();
  const result = await tick({
    store,
    config: { ...DEFAULT_CONFIG, quietHours: { start: '00:00', end: '00:00', timeZone: '' } },
    collector: () => [],
    deliver: async () => 'sent',
    log: () => {}
  });
  assert.equal(result.decision, 'silent');
  assert.equal(result.reason, 'no_materials');
  rmSync(dir, { recursive: true, force: true });
});

test('tick 打分够就投递并记账', async () => {
  const { dir, store } = tempStore();
  const delivered = [];
  const result = await tick({
    store,
    config: {
      ...DEFAULT_CONFIG,
      scoreThreshold: 0.1,
      quietHours: { start: '00:00', end: '00:00', timeZone: '' },
      minGapSeconds: 60,
      maxGapSeconds: 120
    },
    collector: () => [
      { id: 'm1', kind: 'pending_thought', text: '有件事想说', at: Date.now() },
      { id: 'm2', kind: 'user_message', text: '今天好累', at: Date.now() - 3600_000 }
    ],
    deliver: async ({ prompt }) => {
      delivered.push(prompt);
      return 'sent';
    },
    log: () => {}
  });
  assert.equal(result.decision, 'deliver');
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /目的机制/);
  assert.equal(store.state.deliveredToday, 1);
  assert.equal(store.coolingMap().size, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('tick 投递失败时不记配额，间隔缩短重试', async () => {
  const { dir, store } = tempStore();
  const result = await tick({
    store,
    config: {
      ...DEFAULT_CONFIG,
      scoreThreshold: 0.1,
      quietHours: { start: '00:00', end: '00:00', timeZone: '' },
      minGapSeconds: 600,
      maxGapSeconds: 900
    },
    collector: () => [{ id: 'm1', kind: 'pending_thought', text: '有件事想说', at: Date.now() }],
    deliver: async () => 'failed',
    log: () => {}
  });
  assert.equal(result.decision, 'silent');
  assert.equal(result.reason, 'delivery_failed');
  assert.equal(store.state.deliveredToday, 0);
  const nextAt = Date.parse(store.state.nextAt);
  assert.ok(nextAt - Date.now() <= 601_000);
  rmSync(dir, { recursive: true, force: true });
});
