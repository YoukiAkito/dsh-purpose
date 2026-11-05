import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GLANCE_GAP_MS,
  DEFAULT_GLANCE_THRESHOLD,
  glance,
  lastGlanceAt,
  materialsFromHotSearch,
  materialsFromPopular,
  materialsFromVtuberClips,
  recordGlance,
  shouldGlance,
  topicQueries
} from '../src/glance.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'glance-'));
}

test('好奇心不够就不出门', () => {
  const v = shouldGlance({ curiosity: 0.3 }, { now: 1_000_000 });
  assert.equal(v.glance, false);
  assert.match(v.reason, /^curiosity_low/);
});

test('好奇心够但刚看过也不出门', () => {
  const now = 10_000_000;
  const v = shouldGlance({ curiosity: 0.9 }, { lastGlanceAt: now - 5 * 60_000, now });
  assert.equal(v.glance, false);
  assert.match(v.reason, /^too_soon/);
});

test('好奇心够且隔够了就出门', () => {
  const now = 10_000_000;
  const v = shouldGlance({ curiosity: 0.9 }, { lastGlanceAt: now - DEFAULT_GLANCE_GAP_MS - 1, now });
  assert.equal(v.glance, true);
  assert.equal(v.reason, 'curious');
});

test('从没看过时不受间隔限制', () => {
  const v = shouldGlance({ curiosity: DEFAULT_GLANCE_THRESHOLD }, { lastGlanceAt: 0, now: 5 });
  assert.equal(v.glance, true);
});

test('热搜转成素材，只取前五条', () => {
  const data = {
    items: Array.from({ length: 9 }, (_, i) => ({ keyword: `k${i}`, title: `标题${i}` }))
  };
  const items = materialsFromHotSearch(data, 999);
  assert.equal(items.length, 5);
  assert.equal(items[0].text, 'B站热搜：标题0');
  assert.equal(items[0].source, 'bili-hot');
  assert.equal(items[0].at, 999);
});

test('热门视频带作者与播放量', () => {
  const data = {
    items: [
      { bvid: 'BV1', title: '某视频', author: { name: '某人' }, stat: { view: 123456 } },
      { bvid: 'BV2', title: '  ', author: { name: 'x' }, stat: { view: 1 } }
    ]
  };
  const items = materialsFromPopular(data, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'B站热门视频：某视频，作者 某人，12 万播放');
  assert.equal(items[0].source, 'bili-popular');
});

test('虚拟主播切片：UP 与本播放量，播放少的就不写播放量', () => {
  const data = {
    items: [
      { bvid: 'BV1', title: '主播笑了', author: { name: '某某'} , play: 123456 },
      { bvid: 'BV2', title: '刚开播', author: { name: '另一个' }, play: 3 },
      { bvid: 'BV3', title: '   ', play: 9 }
    ]
  };
  const items = materialsFromVtuberClips(data, 1);
  assert.equal(items.length, 2);
  assert.equal(items[0].text, '虚拟主播切片：主播笑了，UP 某某，12 万播放');
  assert.equal(items[0].source, 'bili-vtuber');
  assert.equal(items[1].text, '虚拟主播切片：刚开播，UP 另一个');
});

test('没有 cli 就不走路，也不抛', async () => {
  const seen = await glance({ cli: '' });
  assert.deepEqual(seen, { materials: [], sources: [] });
});

test('跑默认三路命令并把素材合起来', async () => {
  const calls = [];
  const run = async (cli, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'hot' && args[1] === 'search') return { items: [{ title: '热搜一' }] };
    if (args[0] === 'hot' && args[1] === 'popular') return { items: [{ bvid: 'BV1', title: '热门一' }] };
    if (args[0] === 'search' && args[1] === 'video') return { items: [{ bvid: 'BV9', title: '切片一' }] };
    return null;
  };
  const seen = await glance({ cli: '/fake/bili', run, now: 7 });
  assert.equal(seen.materials.length, 3);
  assert.deepEqual(seen.sources, ['hot', 'popular', 'vtuber']);
  assert.deepEqual(calls, ['hot search', 'hot popular', 'search video 虚拟主播 切片 --order views --size 10']);
});

test('lane 由配置决定：给什么就跑什么，不再写死', async () => {
  const calls = [];
  const run = async (cli, args) => {
    calls.push(args.join(' '));
    return { items: [{ bvid: 'BV1', title: '猫片一' }] };
  };
  const lanes = [{ id: 'cats', label: '猫片', args: ['search', 'video', '猫'], format: 'video', prefix: '猫片' }];
  const seen = await glance({ cli: '/fake/bili', run, now: 1, lanes });
  assert.deepEqual(calls, ['search video 猫']);
  assert.deepEqual(seen.sources, ['cats']);
  assert.equal(seen.materials[0].text, '猫片：猫片一');
  assert.equal(seen.materials[0].source, 'bili-cats');
});

test('lanes 为空数组就什么都不跑', async () => {
  let called = 0;
  const run = async () => { called += 1; return null; };
  const seen = await glance({ cli: '/fake/bili', run, lanes: [] });
  assert.equal(called, 0);
  assert.deepEqual(seen.sources, []);
});

test('念头里的问题会变成搜索词', async () => {
  const calls = [];
  const run = async (cli, args) => {
    calls.push(args.join(' '));
    return { items: [{ bvid: 'BV1', title: '答案在这' }] };
  };
  const seen = await glance({
    cli: '/fake/bili',
    run,
    now: 1,
    lanes: [],
    topics: { queries: ['TTS 为什么慢'], order: 'views', size: 8 }
  });
  assert.deepEqual(calls, ['search video TTS 为什么慢 --order views --size 8']);
  assert.deepEqual(seen.sources, ['topic:TTS 为什么慢']);
  assert.equal(seen.materials[0].text, '搜「TTS 为什么慢」：答案在这');
});

test('topicQueries 只取 question 类、去重、截断', () => {
  const rows = [
    { kind: 'unfinished', status: 'open', text: '把第二步做完' },
    { kind: 'question', status: 'open', text: '为什么显卡会降频？' },
    { kind: 'question', status: 'open', text: '为什么显卡会降频？' },
    { kind: 'question', status: 'open', text: 'TTS：到底该不该换音色' },
    { kind: 'question', status: 'open', text: '这句子特别特别特别特别特别特别特别特别特别长的东西' },
    { kind: 'question', status: 'done', text: '已经想明白的事' }
  ];
  const q = topicQueries(rows, { limit: 3 });
  assert.deepEqual(q, ['为什么显卡会降频', 'TTS', '这句子特别特别特别特别特别特别特别特别特别长的东']);
});

test('三条都失败时记一条警告', async () => {
  const warns = [];
  const seen = await glance({ cli: '/fake/bili', run: async () => null, log: (lvl, msg) => warns.push([lvl, msg]) });
  assert.equal(seen.materials.length, 0);
  assert.equal(warns.length, 1);
  assert.equal(warns[0][0], 'warn');
});

test('记账与读回上次时间', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'glance.jsonl');
    assert.equal(lastGlanceAt(path), 0);
    recordGlance(path, { materials: [{}, {}], sources: ['hot'], at: 1234 });
    assert.equal(lastGlanceAt(path), 1234);
    recordGlance(path, { materials: [], sources: [], at: 5678 });
    assert.equal(lastGlanceAt(path), 5678);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空路径不炸', () => {
  recordGlance('', { materials: [] });
  assert.equal(lastGlanceAt(''), 0);
});
