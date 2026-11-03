import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionLog, materialsFromLog } from '../src/collect.js';

function tmpFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-purpose-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  return file;
}

test('readSessionLog 只收真人消息，丢掉 runtime-context 与插件唤醒', () => {
  const now = Date.now();
  const file = tmpFile([
    { type: 'session', version: 4, id: 'x' },
    { type: 'user/message', time: now - 3000, data: { content: [{ type: 'text', text: '[消息号: 1103ca]\n[2026-11-03 周二 14:56]\n\n还记得自主决策吗' }], source: { kind: 'user' }, role: 'user' } },
    { type: 'user/message', time: now - 2000, data: { content: [{ type: 'text', text: 'Current runtime context. blah blah' }], source: { kind: 'runtime-context' }, role: 'user' } },
    { type: 'user/message', time: now - 1000, data: { content: [{ type: 'text', text: '[心跳] 你自己醒的' }], source: { kind: 'plugin:dsh-proactive' }, role: 'user' } },
    { type: 'tool/call', time: now, data: { name: 'bash' } }
  ]);
  const rows = readSessionLog(file, { limit: 10, windowHours: 24 });
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /还记得自主决策吗/);
});

test('readSessionLog 按时间窗过滤太旧的消息', () => {
  const now = Date.now();
  const file = tmpFile([
    { type: 'user/message', time: now - 48 * 3600_000, data: { content: [{ type: 'text', text: '两天前' }], source: { kind: 'user' }, role: 'user' } },
    { type: 'user/message', time: now - 60_000, data: { content: [{ type: 'text', text: '刚才' }], source: { kind: 'user' }, role: 'user' } }
  ]);
  const rows = readSessionLog(file, { limit: 10, windowHours: 24 });
  assert.deepEqual(rows.map((row) => row.text), ['刚才']);
});

test('readSessionLog 文件不存在时返回空数组而不是抛错', () => {
  assert.deepEqual(readSessionLog('/nonexistent/xx/session.jsonl', {}), []);
  assert.deepEqual(readSessionLog('', {}), []);
});

test('materialsFromLog 剥掉消息号与时间前缀', () => {
  const now = Date.now();
  const materials = materialsFromLog([
    { role: 'user', text: '[消息号: 1103cj]\n[2026-11-03 周二 15:41]\n\n可以替换掉了', at: now }
  ]);
  assert.equal(materials.length, 1);
  assert.equal(materials[0].text, '可以替换掉了');
  assert.equal(materials[0].kind, 'user_message');
});

test('materialsFromLog 默认不收我自己的发言', () => {
  const now = Date.now();
  const materials = materialsFromLog([
    { role: 'assistant', text: '我自己说的话', at: now },
    { role: 'user', text: '她说的话', at: now }
  ]);
  assert.deepEqual(materials.map((m) => m.text), ['她说的话']);
});

test('materialsFromLog 按 maxChars 截断', () => {
  const materials = materialsFromLog([{ role: 'user', text: 'x'.repeat(500), at: Date.now() }], { maxChars: 20 });
  assert.equal(materials[0].text.length, 20);
});
