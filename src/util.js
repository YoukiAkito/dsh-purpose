/**
 * 纯工具函数：原子写、JSONL 追加、时间归一化、轻量 id。
 * 只依赖 node:fs / node:crypto，保证 macOS 与 Linux 行为一致。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

/** 毫秒时间戳 → ISO 字符串（统一用 UTC，展示层再用 zone 转）。 */
export function toIso(ms) {
  return new Date(ms).toISOString();
}

/** ISO 字符串或毫秒数 → 毫秒；无法解析返回 NaN。 */
export function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

/** 稳定 id：时间前缀 + 随机后缀，便于按时间排序又不会撞。 */
export function newId(prefix = 'g', now = Date.now()) {
  return `${prefix}_${now.toString(36)}${randomBytes(3).toString('hex')}`;
}

/** 原子写 JSON：先写临时文件再 rename，避免半截文件。 */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(2).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** 读 JSON，缺文件或坏文件都返回 fallback（并可选回调告警）。 */
export function readJson(path, fallback, onError) {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed === null || typeof parsed !== 'object' ? fallback : parsed;
  } catch (error) {
    if (error && error.code !== 'ENOENT' && typeof onError === 'function') {
      onError(error);
    }
    return fallback;
  }
}

/** 追加一行 JSONL。 */
export function appendJsonl(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

/** 读 JSONL，坏行跳过，最多返回 limit 条（取最后 limit 条后按原序）。 */
export function readJsonl(path, limit = 0) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // 坏行（写一半就断电）直接跳过，不阻塞后续读取。
    }
  }
  return limit > 0 && out.length > limit ? out.slice(out.length - limit) : out;
}

/** 数值夹取。 */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** 归一化成 [0,1]；分母为 0 时返回 0.5（中性）。 */
export function norm(value, max) {
  if (!Number.isFinite(value) || max <= 0) return 0.5;
  return clamp(value / max, 0, 1);
}

/** 文本归一化后用于去重比对：去空白、去标点、小写。 */
export function fingerprint(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 240);
}

/** 截断到指定码点数，不切坏代理对。 */
export function sliceCodePoints(text, max) {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}
