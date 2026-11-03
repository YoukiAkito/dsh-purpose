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
 * 兼容三种形状：
 *   - {kind:'user'|'assistant', text|content, at|time|ts}
 *   - {type:'user/message'|'assistant/message', message:{content:[{type:'text',text}]}, at}
 *   - DSH 真实日志：{type:'user/message', time, data:{content:[…], source:{kind}, role}}
 *
 * **DSH 日志里大部分 user/message 是系统塞进来的**（runtime-context 快照、
 * 插件唤醒、工具任务回灌），真正人说的话 source.kind === 'user'。
 * 采集时必须按 source.kind 过滤，否则素材池会被几百条英文运行时快照淹掉。
 *
 * 拿不到就返回空数组——宁可少素材，也不要抛。
 */
export function readSessionLog(path, options = {}) {
  const { limit = 60, windowHours = 24, maxScanLines = 20_000 } = options;
  if (typeof path !== 'string' || path === '' || !existsSync(path)) return [];
  const floor = Date.now() - windowHours * 3600_000;
  let rows;
  try {
    // 别只读尾部几百行：日志里 tool/call、tool/result、runtime-context 占绝大多数，
    // 真人消息很稀疏（实测 3000 行里只有 76 条），截太短就一条都捞不到。
    rows = readJsonl(path, maxScanLines);
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

  if (typeof row.type !== 'string') return null;
  const role = row.type.startsWith('user/') ? 'user' : row.type.startsWith('assistant/') ? 'assistant' : '';
  if (role === '') return null;

  const data = asObject(row.data);
  // 只收真人说的话：source.kind 不是 'user' 的全是系统注入。
  if (role === 'user') {
    const sourceKind = asObject(data?.source)?.kind;
    if (typeof sourceKind === 'string' && sourceKind !== 'user') return null;
  }

  const text = textOf(data?.content ?? row.message?.content ?? row.content ?? row.text);
  if (text === '') return null;
  return { role, text, at: timeOf(row) };
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
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
    const text = cleanText(row.text);
    if (text === '') continue;
    index += 1;
    materials.push({
      id: `log:${row.at}:${index}`,
      kind: MATERIAL_KIND.USER_MESSAGE,
      text: text.slice(0, maxChars),
      at: row.at,
      source: 'session-log'
    });
  }
  return materials;
}

/** QQ 通道会在正文前面盖 `[消息号: xxx]` 和 `[2026-11-03 周二 15:41]`，素材里不需要。 */
const META_PREFIX_RE = /^\s*(?:\[消息号:[^\]]*\]|\[20\d\d-\d\d-\d\d[^\]]*\])\s*\n?/;

function cleanText(text) {
  let out = String(text ?? '');
  // 可能连着盖两行，循环剥。
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(META_PREFIX_RE, '');
    if (next === out) break;
    out = next;
  }
  return out.trim();
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
