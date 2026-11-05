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
