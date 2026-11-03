import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSessionLogFile, findZstd, materializeSessionLog, resolveSessionLog } from '../src/sessionlog.js';

function workspace() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const dir = join(home, 'sessions', '--ws--', 'sid-1');
  mkdirSync(dir, { recursive: true });
  return { home, dir };
}

test('findSessionLogFile 在 workspace 子目录里找到日志', () => {
  const { home, dir } = workspace();
  writeFileSync(join(dir, 'session.v4.jsonl'), '{"type":"session"}\n');
  assert.equal(findSessionLogFile(home, 'sid-1'), join(dir, 'session.v4.jsonl'));
  assert.equal(findSessionLogFile(home, 'nope'), '');
  assert.equal(findSessionLogFile('', 'sid-1'), '');
});

test('materializeSessionLog 对明文 jsonl 原样返回', () => {
  const { home, dir } = workspace();
  const file = join(dir, 'session.v4.jsonl');
  writeFileSync(file, '{}\n');
  assert.equal(materializeSessionLog(file, join(home, 'cache')), file);
});

test('materializeSessionLog 对不存在的文件返回空串', () => {
  assert.equal(materializeSessionLog('/nope/session.v4.jsonl.zstd', '/tmp/x'), '');
  assert.equal(materializeSessionLog('', '/tmp/x'), '');
});

test('findZstd 要么给出存在的路径，要么给出空串', () => {
  const bin = findZstd();
  assert.equal(typeof bin, 'string');
  if (bin !== '' && bin !== 'zstd') assert.ok(bin.startsWith('/'));
});

test('resolveSessionLog 找不到会话时返回空串', () => {
  const { home } = workspace();
  assert.equal(resolveSessionLog(home, 'missing', join(home, 'cache')), '');
});
