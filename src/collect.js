/**
 * 素材采集。
 *
 * 原则：只读，不改任何东西；任何一路失败都只降级成"这一路没素材"，不能让整个评估挂掉。
 *
 * 三路来源：
 *   1. 会话日志——主人/群友最近说的话（最重要，也最容易拿）
 *   2. 待说想法——我自己之前写下的 pendingThoughts
 *   3. 外部源——交给调用方注入（可以是从 B 站/网页拿到的条目）
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonl } from './util.js';
import { MATERIAL_KIND } from './score.js';

/**
 * 从会话日志里取最近的消息。
 *
 * 兼容两种形状：
 *   - {kind:'user'|'assistant', text|content, at|time|ts}
 *   - {type:'user/message'|'assistant/message', message:{content:[{type:'text',text}]}, at}
 * 拿不到就返回空数组——宁可少素材，也不要抛。
 */
export function readSessionLog(path, options = {}) {
  const { limit = 60, windowHours = 24 } = options;
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return [];
  const floor = Date.now() - windowHours * 3600_000;
  let rows;
  try {
    rows = readJsonl(path, limit * 4);
  } catch {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const parsed = parseLogRow(row);
    if (parsed === null) continue;
    if (parsed.at !== 0 && parsed.at < floor) continue;
    out.push(parsed);
  }
  return out.slice(-limit);
}

/** 单行日志 → {role, text, at}；认不出来返回 null。 */
function parseLogRow(row) {
  if (row === null || typeof row !== 'object') return null;

  // 形状一：{kind, text}
  if (typeof row.kind === 'string' && (row.kind === 'user' || row.kind === 'assistant')) {
    const text = textOf(row.text ?? row.content);
    if (text === '') return null;
    return { role: row.kind, text, at: timeOf(row) };
  }

  // 形状二：{type:'user/message', message:{content:[...]}}
  if (typeof row.type === 'string') {
    const role = row.type.startsWith('user/') ? 'user' : row.type.startsWith('assistant/') ? 'assistant' : '';
    if (role === '') return null;
    const text = textOf(row.message?.content ?? row.content ?? row.text);
    if (text === '') return null;
    return { role, text, at: timeOf(row) };
  }

  return null;
}

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const parts = [];
    for (const block of value) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join(' ').trim();
  }
  return '';
}

function timeOf(row) {
  for (const key of ['at', 'time', 'ts', 'timestamp']) {
    const raw = row[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

/** 把日志消息转成素材。只保留人类说的话；我自己的发言不进素材池。 */
export function materialsFromLog(rows, options = {}) {
  const { includeAssistant = false, maxChars = 220 } = options;
  const materials = [];
  let index = 0;
  for (const row of rows) {
    if (row.role !== 'user' && includeAssistant !== true) continue;
    index += 1;
    materials.push({
      id: `log:${row.at}:${index}`,
      kind: MATERIAL_KIND.USER_MESSAGE,
      text: row.text.slice(0, maxChars),
      at: row.at,
      source: 'session-log'
    });
  }
  return materials;
}

/** 我的待说想法（存在 state.json 里也行，这里是独立文件）。 */
export function materialsFromThoughts(path, options = {}) {
  const { maxChars = 220 } = options;
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return [];
  let rows;
  try {
    rows = readJsonl(path, 200);
  } catch {
    return [];
  }
  const materials = [];
  let index = 0;
  for (const row of rows) {
    const text = textOf(row?.text ?? row?.content);
    if (text === '') continue;
    if (row.done === true) continue;
    index += 1;
    materials.push({
      id: `thought:${row.id ?? index}`,
      kind: MATERIAL_KIND.PENDING_THOUGHT,
      text: text.slice(0, maxChars),
      at: timeOf(row),
      source: 'thoughts'
    });
  }
  return materials;
}

/** 外部条目（B站视频、网页、搜索结果……）→ 素材。 */
export function materialsFromExternal(items, options = {}) {
  const { maxChars = 220 } = options;
  const materials = [];
  if (!Array.isArray(items)) return materials;
  let index = 0;
  for (const item of items) {
    const text = textOf(item?.text ?? item?.title ?? item?.summary);
    if (text === '') continue;
    index += 1;
    materials.push({
      id: item.id ?? `ext:${index}`,
      kind: MATERIAL_KIND.EXTERNAL_ITEM,
      text: text.slice(0, maxChars),
      at: timeOf(item ?? {}) || Date.now(),
      source: item.source ?? 'external'
    });
  }
  return materials;
}

/**
 * 汇总所有来源。
 *
 * @param {object} input
 *   - sessionLogPath  会话日志绝对路径
 *   - thoughtsPath    待说想法文件
 *   - external        外部条目数组
 *   - windowHours / maxMaterials / maxMaterialChars
 *   - log             日志函数
 */
export function collectMaterials(input = {}) {
  const {
    sessionLogPath = '',
    thoughtsPath = '',
    external = [],
    windowHours = 24,
    maxMaterials = 24,
    maxMaterialChars = 220,
    log = () => {}
  } = input;

  const parts = [];
  try {
    const rows = readSessionLog(sessionLogPath, { limit: 80, windowHours });
    parts.push(...materialsFromLog(rows, { maxChars: maxMaterialChars }));
  } catch (error) {
    log('warn', `会话日志采集失败：${error.message}`);
  }
  try {
    parts.push(...materialsFromThoughts(thoughtsPath, { maxChars: maxMaterialChars }));
  } catch (error) {
    log('warn', `想法采集失败：${error.message}`);
  }
  try {
    parts.push(...materialsFromExternal(external, { maxChars: maxMaterialChars }));
  } catch (error) {
    log('warn', `外部素材采集失败：${error.message}`);
  }

  // 去重（同一段文本只留一条），再按时间新旧截断到上限。
  const seen = new Set();
  const unique = [];
  for (const material of parts) {
    if (seen.has(material.text)) continue;
    seen.add(material.text);
    unique.push(material);
  }
  unique.sort((left, right) => (right.at || 0) - (left.at || 0));
  return unique.slice(0, maxMaterials);
}

/** 会话日志所在目录的推断：给个文件路径，返回它的目录（调试用）。 */
export function dirOf(path) {
  return typeof path === 'string' && path !== '' ? dirname(path) : '';
}

/** 拼一个默认的日志路径（调用方通常自己传）。 */
export function defaultLogPath(home, sessionId) {
  if (typeof home !== 'string' || home === '' || typeof sessionId !== 'string' || sessionId === '') return '';
  return join(home, '.dsh', 'sessions', sessionId, 'session.v4.jsonl');
}
