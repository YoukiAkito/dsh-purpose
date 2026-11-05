import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntentionLedger, intentionSimilarity, INTENTION_KINDS } from '../src/intentions.js';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'muri-purpose-intent-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('add 写入一条新念头并能读回', () => withDir((dir) => {
  const ledger = new IntentionLedger(dir);
  const { row, merged } = ledger.add({ text: '搞明白 zstd 多帧是怎么回事', kind: 'question', drive: 'curiosity', weight: 0.8 });
  assert.equal(merged, false);
  assert.equal(row.kind, 'question');
  const all = ledger.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].text, '搞明白 zstd 多帧是怎么回事');
  assert.equal(all[0].status, 'open');
}));

test('add 拒绝空文本', () => withDir((dir) => {
  const ledger = new IntentionLedger(dir);
  assert.throws(() => ledger.add({ text: '   ' }), /不能为空/);
}));

test('未知 kind 回落成 whim', () => withDir((dir) => {
  const ledger = new IntentionLedger(dir);
  const { row } = ledger.add({ text: '看看有没有人做过类似的事', kind: '胡扯' });
  assert.ok(INTENTION_KINDS.includes(row.kind));
  assert.equal(row.kind, 'whim');
}));

test('相似念头会被合并而不是新增', () => withDir((dir) => {
  const ledger = new IntentionLedger(dir);
  const first = ledger.add({ text: '把会话日志解压改成流式', weight: 0.4 });
  const second = ledger.add({ text: '把会话日志解压改成流式', weight: 0.9 });
  assert.equal(second.merged, true);
  assert.equal(ledger.all().length, 1);
  assert.equal(ledger.all()[0].weight, 0.9);
  assert.equal(ledger.all()[0].id, second.row.id);
  assert.notEqual(first.row.id, second.row.id);
}));

test('patch 追加一行并通过 supersedes 生效', () => withDir((dir) => {
  const ledger = new IntentionLedger(dir);
  const { row } = ledger.add({ text: '试一下 ffmpeg 的 rubberband', weight: 0.6 });
  const next = ledger.patch(row.id, { status: 'doing' });
  const all = ledger.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'doing');
  assert.equal(all[0].id, next.id);
  // 原始那行还在文件里（append-only）
  const lines = readFileSync(join(dir, 'intentions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
}));

test('patch 找不到 id 时抛错', () => withDir((dir) => {
  const ledger = new IntentionLedger(dir);
  assert.throws(() => ledger.patch('nope', { status: 'done' }), /找不到念头/);
}));

test('drop 只改状态，记录仍可追溯', () => withDir((dir) => {
  const ledger = new IntentionLedger(dir);
  const { row } = ledger.add({ text: '去查一下 B 站直播分区规则', kind: 'question' });
  ledger.drop(row.id, '暂时不需要');
  const all = ledger.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'dropped');
  assert.equal(all[0].note, '暂时不需要');
}));

test('open 过滤掉 done/dropped/wish 并按价值排序', () => withDir((dir) => {
  const ledger = new IntentionLedger(dir);
  const a = ledger.add({ text: '甲：把驱动值接进日志', kind: 'question', weight: 0.9 });
  const b = ledger.add({ text: '乙：随便看看发型教程', kind: 'whim', weight: 0.5 });
  const c = ledger.add({ text: '丙：想要一张 4090', kind: 'wish', weight: 1 });
  ledger.drop(b.row.id, '没意思');
  const open = ledger.open();
  assert.equal(open.length, 1);
  assert.equal(open[0].id, a.row.id);
  assert.ok(open[0].score > 0);
  assert.ok(!open.some((r) => r.id === c.row.id), 'wish 不参与排序');
}));

test('valueOf 随时间衰减但有下限', () => withDir((dir) => {
  const ledger = new IntentionLedger(dir);
  const now = Date.now();
  const { row } = ledger.add({ text: '想想直播到底该播什么', kind: 'question', weight: 1 }, now);
  const fresh = ledger.valueOf(row, now);
  const old = ledger.valueOf(row, now + 30 * 24 * 3600_000);
  assert.ok(old < fresh);
  assert.ok(old > 0.1, '不能衰减到零');
}));

test('坏行被跳过而不是整份丢弃', () => withDir((dir) => {
  writeFileSync(join(dir, 'intentions.jsonl'), '{坏行}\n{"text":"好的那行","kind":"whim"}\n');
  const ledger = new IntentionLedger(dir);
  const all = ledger.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].text, '好的那行');
}));

test('intentionSimilarity 判定同文与异文', () => {
  assert.equal(intentionSimilarity('把日志解开', '把日志解开'), 1);
  assert.ok(intentionSimilarity('把日志解压改成流式', '把日志解压改成流式读取') > 0.5);
  assert.ok(intentionSimilarity('看看 B 站', '修 ffmpeg 参数') < 0.1);
});
