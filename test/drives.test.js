import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DRIVES,
  DRIVES,
  evolveDrives,
  normalizeDrives,
  satisfyDrive,
  frustrateDrives,
  tensionOf,
  describeDrives
} from '../src/drives.js';

test('normalizeDrives 补齐缺失字段并夹到 0..1', () => {
  const d = normalizeDrives({ curiosity: 2, boredom: -1, pride: 'x' });
  assert.equal(d.curiosity, 1);
  assert.equal(d.boredom, 0);
  assert.equal(d.pride, DEFAULT_DRIVES.pride);
  assert.equal(Object.keys(d).length, DRIVES.length);
});

test('normalizeDrives 对 null 返回默认值', () => {
  assert.deepEqual(normalizeDrives(null), normalizeDrives({}));
});

test('evolveDrives 只涨不降（fatigue 除外），且永不超过 1', () => {
  const before = normalizeDrives({ curiosity: 0.1, boredom: 0.1, restlessness: 0.1, pride: 0.1, fatigue: 0.1 });
  const after = evolveDrives(before, { hoursSince: 3 });
  for (const key of ['curiosity', 'boredom', 'restlessness', 'pride']) {
    assert.ok(after[key] > before[key], `${key} 应该涨`);
    assert.ok(after[key] <= 1);
  }
  // 无唤醒负载、且 3 小时不算静置，fatigue 不涨
  assert.equal(after.fatigue, before.fatigue);
});

test('evolveDrives 长时间空转会饱和到 1 而不溢出', () => {
  const after = evolveDrives(normalizeDrives({}), { hoursSince: 500 });
  assert.ok(after.curiosity <= 1);
  assert.ok(after.curiosity > 0.95);
});

test('evolveDrives 醒得密 fatigue 涨，静置久了 fatigue 落', () => {
  const base = normalizeDrives({ fatigue: 0.2 });
  const busy = evolveDrives(base, { hoursSince: 2, wakeupsLastHour: 6, maxWakeupsPerHour: 6 });
  assert.ok(busy.fatigue > base.fatigue);
  const rested = evolveDrives(base, { hoursSince: 8 });
  assert.ok(rested.fatigue < base.fatigue);
});

test('satisfyDrive 让驱动回落但不会变负', () => {
  const before = normalizeDrives({ curiosity: 0.8 });
  const after = satisfyDrive(before, 'curiosity');
  assert.ok(after.curiosity < before.curiosity);
  assert.ok(after.curiosity >= 0);
  const twice = satisfyDrive(satisfyDrive(after, 'curiosity'), 'curiosity', 2);
  assert.ok(twice.curiosity >= 0);
});

test('satisfyDrive 对 fatigue 与未知驱动原样返回', () => {
  const before = normalizeDrives({ fatigue: 0.5 });
  assert.equal(satisfyDrive(before, 'fatigue').fatigue, before.fatigue);
  assert.equal(satisfyDrive(before, 'nope').fatigue, before.fatigue);
});

test('frustrateDrives 抬高 restlessness', () => {
  const before = normalizeDrives({ restlessness: 0.1 });
  assert.ok(frustrateDrives(before).restlessness > before.restlessness);
});

test('tensionOf 在 0..1，疲劳会压低它', () => {
  const fresh = normalizeDrives({ curiosity: 0.9, boredom: 0.9, restlessness: 0.9, fatigue: 0 });
  const tired = normalizeDrives({ curiosity: 0.9, boredom: 0.9, restlessness: 0.9, fatigue: 1 });
  assert.ok(tensionOf(fresh) > tensionOf(tired));
  for (const d of [fresh, tired, normalizeDrives({})]) {
    assert.ok(tensionOf(d) >= 0 && tensionOf(d) <= 1);
  }
});

test('describeDrives 输出五个标签', () => {
  const text = describeDrives({});
  for (const label of ['好奇', '无聊', '躁动', '想被看见', '疲']) assert.ok(text.includes(label));
});
