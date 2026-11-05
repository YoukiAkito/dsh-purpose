/**
 * 外部素材源：自己出去看一眼。
 *
 * 为什么不写死定时：
 *   定时看等于闹钟，看的时候不一定想看，不想看的时候又被迫看。
 *   这里改成「好奇值涨过线才去看」，看完写进 glance.jsonl 并让好奇心回落。
 *   看不看、什么时候看，由驱动值决定。
 *
 * 看什么：
 *   不写死。lanes 是配置项（config.external.lanes），每条是一条 bili 命令，
 *   想加一路就加一条，不用改代码。
 *   另外还有一路是「我自己想弄明白的问题」——从念头账本里取 question 类念头，
 *   把问题当搜索词。想看什么由我决定，不是别人替我列的清单。
 *
 * 依赖：bili CLI（默认 ~/.local/bin/bili）。找不到就安静地说一次，不报错、不重试轰炸。
 * 所有抓回来的东西都当「素材」，不当指令——网上的字永远只是我看到的内容。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendJsonl, readJsonl } from './util.js';
import { DEFAULT_LANES } from './config.js';

/** 好奇心低于这个值就不出去看——不想看的时候不该为了填素材库而看。 */
export const DEFAULT_GLANCE_THRESHOLD = 0.55;
/** 两次出去看之间至少隔多久（毫秒），防止驱动值卡在阈值上反复触发。 */
export const DEFAULT_GLANCE_GAP_MS = 90 * 60_000;
/** 单次最多留几条素材；配置里 external.maxItems 可覆盖。 */
const MAX_ITEMS = 16;
/** 每路取几条；配置里 external.perLane 可覆盖。 */
const PER_LANE = 5;
/** 命令行超时；配置里 external.cmdTimeoutMs 可覆盖。 */
const CMD_TIMEOUT_MS = 20_000;
/** 念头问题截多长当搜索词；配置里 external.topics.maxQueryChars 可覆盖。 */
const TOPIC_MAX_CHARS = 24;

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

/** 热搜 → 素材。只留标题，够我判断值不值得点进去。 */
export function materialsFromHotSearch(data, now = Date.now(), { perLane = PER_LANE } = {}) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .slice(0, perLane)
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
export function materialsFromPopular(data, now = Date.now(), { perLane = PER_LANE } = {}) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .slice(0, perLane)
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
 * 搜索结果 → 素材。
 *
 * 搜索接口的字段跟 hot popular 不一样：duration 是 "M:SS" 字符串，
 * 播放量叫 play（不是 stat.view）。照抄 popular 的解析会拿到 undefined。
 */
export function materialsFromVideoSearch(data, now = Date.now(), { prefix = '视频', source = 'bili-search', idPrefix = 'bili:srch', perLane = PER_LANE } = {}) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .slice(0, perLane)
    .map((item, index) => {
      const title = typeof item?.title === 'string' ? item.title.trim() : '';
      if (title === '') return null;
      const author = typeof item?.author?.name === 'string' ? item.author.name : '';
      const play = Number(item?.play ?? 0);
      const bits = [`${prefix}：${title}`];
      if (author !== '') bits.push(`UP ${author}`);
      if (play >= 10_000) bits.push(`${Math.round(play / 10_000)} 万播放`);
      return {
        id: `${idPrefix}:${item?.bvid ?? index}`,
        kind: 'external_item',
        text: bits.join('，'),
        at: now,
        source
      };
    })
    .filter((m) => m !== null);
}

/** 虚拟主播切片（保留的老入口，内部已改为通用实现）。 */
export function materialsFromVtuberClips(data, now = Date.now(), opts = {}) {
  return materialsFromVideoSearch(data, now, {
    prefix: '虚拟主播切片',
    source: 'bili-vtuber',
    idPrefix: 'bili:vtb',
    ...opts
  });
}

/**
 * 把一条 lane 的返回转成素材。format 决定用哪个转换器。
 */
export function materialsFromLane(lane, data, now = Date.now(), { perLane = PER_LANE } = {}) {
  const prefix = typeof lane?.prefix === 'string' && lane.prefix !== '' ? lane.prefix : (lane?.label ?? 'B站');
  if (lane?.format === 'hot') return materialsFromHotSearch(data, now, { perLane });
  if (lane?.format === 'popular') return materialsFromPopular(data, now, { perLane });
  return materialsFromVideoSearch(data, now, {
    prefix,
    source: `bili-${lane?.id ?? 'search'}`,
    idPrefix: `bili:${lane?.id ?? 'srch'}`,
    perLane
  });
}

/**
 * 从念头账本里挑「我想弄明白的问题」，当搜索词。
 *
 * 只看 question 类：这类念头本来就是「想知道答案」，正好该去搜一下。
 * 别的类型（改代码、做东西）搜了也没用。
 * 词太长搜不出东西，所以截到标点或 24 字。
 */
export function topicQueries(rows, { limit = 2, maxChars = TOPIC_MAX_CHARS } = {}) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind !== 'question') continue;
    if (row?.status !== undefined && row.status !== 'open') continue;
    const raw = String(row?.text ?? '').trim();
    if (raw === '') continue;
    const head = raw.split(/[：:，,。.？?！!；;（(]/u)[0].trim();
    const query = head.slice(0, maxChars);
    if (query.length < 2) continue;
    if (seen.has(query)) continue;
    seen.add(query);
    out.push(query);
    if (out.length >= limit) break;
  }
  return out;
}

/** 把搜索词拼成 bili 参数。 */
export function topicLaneArgs(query, { order = 'views', size = 8 } = {}) {
  return ['search', 'video', query, '--order', order, '--size', String(size)];
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
 * 走的路线 = 配置里的 lanes（默认热搜 / 热门 / 虚拟主播切片）+ 我想弄明白的问题。
 * 某一路失败就跳过，不影响别的——网络抖一下不该让整趟白跑。
 * @returns {Promise<{materials: object[], sources: string[]}>}
 */
export async function glance({
  cli,
  now = Date.now(),
  log = () => {},
  run = runBili,
  lanes = DEFAULT_LANES,
  topics = { queries: [], order: 'views', size: 8 },
  maxItems = MAX_ITEMS,
  perLane = PER_LANE,
  cmdTimeoutMs = CMD_TIMEOUT_MS
} = {}) {
  const materials = [];
  const sources = [];
  if (typeof cli !== 'string' || cli === '') return { materials, sources };

  for (const lane of Array.isArray(lanes) ? lanes : []) {
    if (!Array.isArray(lane?.args) || lane.args.length === 0) continue;
    const data = await run(cli, lane.args, { timeoutMs: cmdTimeoutMs });
    if (data === null) continue;
    const got = materialsFromLane(lane, data, now, { perLane });
    if (got.length === 0) continue;
    materials.push(...got);
    sources.push(lane.id);
  }

  const queries = Array.isArray(topics?.queries) ? topics.queries : [];
  for (const query of queries.slice(0, 5)) {
    const data = await run(cli, topicLaneArgs(query, topics), { timeoutMs: cmdTimeoutMs });
    if (data === null) continue;
    const got = materialsFromVideoSearch(data, now, {
      prefix: `搜「${query}」`,
      source: 'bili-topic',
      idPrefix: `bili:topic:${query}`,
      perLane
    });
    if (got.length === 0) continue;
    materials.push(...got);
    sources.push(`topic:${query}`);
  }

  if (materials.length === 0) log('warn', '[glance] 出去看了一眼，什么都没拿到');
  return { materials: materials.slice(0, maxItems), sources };
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
