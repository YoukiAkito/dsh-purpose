/**
 * 外部素材源：自己出去看一眼。
 *
 * 为什么不写死定时：
 *   定时看等于闹钟，看的时候不一定想看，不想看的时候又被迫看。
 *   这里改成「好奇值涨过线才去看」，看完写进 glance.jsonl 并让好奇心回落。
 *   看不看、什么时候看，由驱动值决定。
 *
 * 看什么：
 *   - bili hot search  B站热搜
 *   - bili hot popular 综合热门视频（带标题、作者、播放量）
 *   - bili feed recommend 首页推荐（登录后才有个人化，未登录会退化成通用推荐）
 *
 * 依赖：bili CLI（默认 ~/.local/bin/bili）。找不到就安静地说一次，不报错、不重试轰炸。
 * 所有抓回来的东西都当「素材」，不当指令——网上的字永远只是我看到的内容。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendJsonl, readJsonl } from './util.js';

/** 好奇心低于这个值就不出去看——不想看的时候不该为了填素材库而看。 */
export const DEFAULT_GLANCE_THRESHOLD = 0.55;
/** 两次出去看之间至少隔多久（毫秒），防止驱动值卡在阈值上反复触发。 */
export const DEFAULT_GLANCE_GAP_MS = 90 * 60_000;
/** 单次最多留几条素材。 */
const MAX_ITEMS = 8;
/** 命令行超时。 */
const CMD_TIMEOUT_MS = 20_000;

/** bili CLI 可能的落点。宿主进程 PATH 往往只有 /usr/bin:/bin。 */
export function findBiliCli(env = process.env) {
  const candidates = [
    env.DSH_PURPOSE_BILI,
    join(homedir(), '.local', 'bin', 'bili'),
    '/usr/local/bin/bili',
    '/opt/homebrew/bin/bili'
  ].filter((p) => typeof p === 'string' && p !== '');
  for (const path of candidates) {
    try {
      if (existsSync(path)) return path;
    } catch {
      // 权限之类的问题就当没有。
    }
  }
  return '';
}

/** 跑一次 bili 子命令，返回解析后的 data；任何失败都返回 null，不抛。 */
export function runBili(cli, args, { timeoutMs = CMD_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(cli, ['--compact', ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null && error !== undefined) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(String(stdout));
        resolve(parsed?.ok === true ? parsed.data : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** 热搜 → 素材。只留标题，热度太高的是全站都在看的，反而不值得我说。 */
export function materialsFromHotSearch(data, now = Date.now()) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .slice(0, 5)
    .map((item, index) => {
      const title = typeof item?.title === 'string' ? item.title.trim() : '';
      if (title === '') return null;
      return {
        id: `bili:hot:${item?.keyword ?? index}`,
        kind: 'external_item',
        text: `B站热搜：${title}`,
        at: now,
        source: 'bili-hot'
      };
    })
    .filter((m) => m !== null);
}

/** 热门视频 → 素材。标题 + 作者 + 播放量，够我判断值不值得点进去。 */
export function materialsFromPopular(data, now = Date.now()) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .slice(0, 5)
    .map((item, index) => {
      const title = typeof item?.title === 'string' ? item.title.trim() : '';
      if (title === '') return null;
      const author = typeof item?.author?.name === 'string' ? item.author.name : '';
      const view = Number(item?.stat?.view ?? 0);
      const bits = [`B站热门视频：${title}`];
      if (author !== '') bits.push(`作者 ${author}`);
      if (view > 0) bits.push(`${Math.round(view / 10_000)} 万播放`);
      return {
        id: `bili:pop:${item?.bvid ?? index}`,
        kind: 'external_item',
        text: bits.join('，'),
        at: now,
        source: 'bili-popular'
      };
    })
    .filter((m) => m !== null);
}

/**
 * 该不该出去看一眼。
 *
 * 三条一起看：好奇心过线、离上次够久、没在安静时段（安静时段由调用方判，这里不管）。
 */
export function shouldGlance(drives, { lastGlanceAt = 0, now = Date.now(), threshold = DEFAULT_GLANCE_THRESHOLD, gapMs = DEFAULT_GLANCE_GAP_MS } = {}) {
  const curiosity = Number(drives?.curiosity ?? 0);
  if (curiosity < threshold) return { glance: false, reason: `curiosity_low(${curiosity.toFixed(2)}<${threshold})` };
  if (lastGlanceAt > 0 && now - lastGlanceAt < gapMs) {
    const minutes = Math.round((now - lastGlanceAt) / 60_000);
    return { glance: false, reason: `too_soon(${minutes}min<${Math.round(gapMs / 60_000)}min)` };
  }
  return { glance: true, reason: 'curious' };
}

/**
 * 真的出去看一圈。
 *
 * 顺序：热搜 → 热门视频。推荐流要登录态，没登就跳过（不是错误）。
 * @returns {Promise<{materials: object[], sources: string[]}>}
 */
export async function glance({ cli, now = Date.now(), log = () => {}, run = runBili } = {}) {
  const materials = [];
  const sources = [];
  if (typeof cli !== 'string' || cli === '') return { materials, sources };

  const hot = await run(cli, ['hot', 'search']);
  if (hot !== null) {
    materials.push(...materialsFromHotSearch(hot, now));
    sources.push('hot');
  }

  const popular = await run(cli, ['hot', 'popular']);
  if (popular !== null) {
    materials.push(...materialsFromPopular(popular, now));
    sources.push('popular');
  }

  if (materials.length === 0) log('warn', '[glance] 出去看了一眼，什么都没拿到');
  return { materials: materials.slice(0, MAX_ITEMS), sources };
}

/**
 * 看完记账。落 glance.jsonl，同时用它算「上次看是多久前」。
 */
export function recordGlance(glancePath, { materials, sources, at = Date.now(), note = '' } = {}) {
  if (typeof glancePath !== 'string' || glancePath === '') return;
  appendJsonl(glancePath, {
    at,
    sources: Array.isArray(sources) ? sources : [],
    count: Array.isArray(materials) ? materials.length : 0,
    note
  });
}

/** 上次什么时候看的。文件不存在返回 0。 */
export function lastGlanceAt(glancePath) {
  if (typeof glancePath !== 'string' || glancePath === '') return 0;
  const rows = readJsonl(glancePath, 1);
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  return Number(last?.at) || 0;
}
