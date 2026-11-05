import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LANES, resolveConfig, resolveLane, resolveLanes } from '../src/config.js';

const base = { platform: 'darwin', env: { HOME: '/tmp/home' } };

test('不配 lanes 时用默认三路', () => {
  const c = resolveConfig({ ...base, file: {} });
  assert.deepEqual(c.external.lanes.map((l) => l.id), ['hot', 'popular', 'vtuber']);
  assert.equal(c.external.topics.enabled, true);
  assert.equal(c.external.maxItems, 16);
});

test('配了 lanes 就整份替换，不再混默认', () => {
  const c = resolveConfig({
    ...base,
    file: { external: { lanes: [{ id: 'cats', args: ['search', 'video', '猫'], format: 'video', prefix: '猫片' }] } }
  });
  assert.deepEqual(c.external.lanes.map((l) => l.id), ['cats']);
  assert.equal(c.external.lanes[0].prefix, '猫片');
});

test('lane 缺 args 被丢弃；全不合法就回落默认', () => {
  assert.equal(resolveLane({ id: 'x' }), null);
  assert.equal(resolveLane(null), null);
  const c = resolveConfig({ ...base, file: { external: { lanes: [{ id: 'x' }] } } });
  assert.deepEqual(c.external.lanes.map((l) => l.id), DEFAULT_LANES.map((l) => l.id));
});

test('format 不认识时按 video 处理，id 缺省由 args 拼', () => {
  const lane = resolveLane({ args: ['search', 'video', '猫'], format: 'whatever' });
  assert.equal(lane.format, 'video');
  assert.equal(lane.id, 'search_video');
});

test('lanes 最多 8 路', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, args: ['hot', 'search'] }));
  assert.equal(resolveLanes(many).length, 8);
});

test('topics 的开关与条数能配', () => {
  const c = resolveConfig({ ...base, file: { external: { topics: { enabled: false, limit: 9, size: 99 } } } });
  assert.equal(c.external.topics.enabled, false);
  assert.equal(c.external.topics.limit, 5);
  assert.equal(c.external.topics.size, 20);
});

test('驱动调参能配，写了一半就只覆盖那一半', () => {
  const c = resolveConfig({ ...base, file: { drives: { growthPerHour: { curiosity: 0.5 } } } });
  assert.equal(c.drives.growthPerHour.curiosity, 0.5);
  // 没写的那几项保持默认。
  assert.equal(c.drives.growthPerHour.boredom, 0.22);
  assert.equal(c.drives.tensionFloor, 0.35);
});

test('驱动调参里的未知键被丢掉，不会凭空多出一个驱动', () => {
  const c = resolveConfig({ ...base, file: { drives: { growthPerHour: { curiositty: 0.9 } } } });
  assert.equal(Object.keys(c.drives.growthPerHour).includes('curiositty'), false);
  assert.equal(c.drives.growthPerHour.curiosity, 0.16);
});

test('疲劳的负权重允许写成负数', () => {
  const c = resolveConfig({ ...base, file: { drives: { tensionWeight: { fatigue: -0.8 } } } });
  assert.equal(c.drives.tensionWeight.fatigue, -0.8);
});

test('循环节奏与追问冷却能配，越界夹回', () => {
  const c = resolveConfig({
    ...base,
    file: { timeouts: { tickMs: 1, busyRetryMs: 9e9 }, intent: { askCooldownHours: 999, minAskGapHours: -3, maxRecent: 500 } }
  });
  assert.equal(c.timeouts.tickMs, 5_000);
  assert.equal(c.timeouts.busyRetryMs, 3_600_000);
  assert.equal(c.intent.askCooldownHours, 720);
  assert.equal(c.intent.minAskGapHours, 0);
  assert.equal(c.intent.maxRecent, 500);
});

test('出门的每路条数、命令超时、问题长度能配', () => {
  const c = resolveConfig({
    ...base,
    file: { external: { perLane: 9, cmdTimeoutMs: 3000, topics: { maxQueryChars: 12 } } }
  });
  assert.equal(c.external.perLane, 9);
  assert.equal(c.external.cmdTimeoutMs, 3000);
  assert.equal(c.external.topics.maxQueryChars, 12);
});
