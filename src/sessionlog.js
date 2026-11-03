/**
 * 会话日志定位与解压。
 *
 * DSH 把会话日志压成 `<DSH_HOME>/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`，
 * 直接读是二进制。这里负责：找到文件 → 解压 → 只留尾部若干行 → 落到缓存，交给 collect.js 去读。
 *
 * **坑：这个 .zstd 是多个 frame 首尾相接**（宿主每次 append 压一段）。node 的
 * `zstdDecompressSync` 只解第一个 frame，解出来只有文件头那行 session 记录，
 * 表现就是"日志读到了但一条消息都没有"。所以优先调 zstd 命令行（`-dc` 会顺着解到底），
 * 只有找不到命令时才退回 node 解压（那时会警告说可能只拿到第一帧）。
 *
 * 为什么不抛错：素材只是加分项，找不到就当这次没素材，不能把整条评估链拖垮。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as zlib from 'node:zlib';

/** 缓存里只留最后这么多行——够 24 小时窗口用，也不至于让缓存文件胀到几十兆。 */
const TAIL_LINES = 3000;
/** 缓存文件超过这个大小就不落盘了（防跑飞）。 */
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
/** 解压产物多久算新鲜，超过就重新解一次。 */
const CACHE_FRESH_MS = 60_000;
/** zstd 命令行的常见落点（宿主进程的 PATH 往往只有 /usr/bin:/bin）。 */
const ZSTD_CANDIDATES = ['/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/usr/bin/zstd'];

let zstdPathCache;

/** 找一个能用的 zstd 命令行，找不到返回 ''。 */
export function findZstd() {
  if (zstdPathCache !== undefined) return zstdPathCache;
  for (const candidate of ZSTD_CANDIDATES) {
    if (existsSync(candidate)) {
      zstdPathCache = candidate;
      return candidate;
    }
  }
  const probe = spawnSync('zstd', ['--version'], { encoding: 'utf8' });
  zstdPathCache = probe.status === 0 ? 'zstd' : '';
  return zstdPathCache;
}

/**
 * 在 sessions 目录里找某个 sessionId 的日志文件。
 * 结构是 `sessions/<workspace-dir>/<sessionId>/session.v4.jsonl.zstd`。
 */
export function findSessionLogFile(dshHome, sessionId) {
  if (typeof dshHome !== 'string' || dshHome === '' || typeof sessionId !== 'string' || sessionId === '') {
    return '';
  }
  const root = join(dshHome, 'sessions');
  if (!existsSync(root)) return '';
  let workspaces;
  try {
    workspaces = readdirSync(root, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of workspaces) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name, sessionId);
    for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/** 只留最后 TAIL_LINES 行，返回 Buffer。 */
function tailLines(plain) {
  let start = 0;
  let seen = 0;
  for (let i = plain.length - 1; i >= 0; i -= 1) {
    if (plain[i] === 0x0a) {
      seen += 1;
      if (seen === TAIL_LINES) {
        start = i + 1;
        break;
      }
    }
  }
  return start === 0 ? plain : plain.subarray(start);
}

/** 用 zstd 命令行解压；失败返回 null。 */
function decompressWithCli(bin, logFile) {
  const run = spawnSync(bin, ['-dc', logFile], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024
  });
  if (run.status !== 0 && (run.stdout === null || run.stdout.length === 0)) return null;
  return run.stdout ?? null;
}

/**
 * 把日志文件解压成可读 jsonl，返回路径。
 *
 * 已经是明文 jsonl 就原样返回；解压失败返回 ''。
 * 产物落在 `<cacheDir>/<cacheName>.jsonl`，60 秒内复用。
 */
export function materializeSessionLog(logFile, cacheDir, options = {}) {
  const { freshMs = CACHE_FRESH_MS, log, cacheName = '' } = options;
  if (typeof logFile !== 'string' || logFile === '' || !existsSync(logFile)) return '';

  const isCompressed = logFile.endsWith('.zstd');
  if (!isCompressed) return logFile;

  const stem = cacheName !== '' ? cacheName : basename(logFile).replace(/\.zstd$/, '');
  const cachePath = join(cacheDir, `${stem}.jsonl`);

  if (existsSync(cachePath)) {
    try {
      const src = statSync(logFile).mtimeMs;
      const dst = statSync(cachePath);
      if (dst.mtimeMs >= src && Date.now() - dst.mtimeMs < freshMs) return cachePath;
    } catch {
      // 落到下面重新解。
    }
  }

  try {
    if (statSync(logFile).size === 0) return '';
  } catch {
    return '';
  }

  let plain = null;
  const bin = findZstd();
  if (bin !== '') plain = decompressWithCli(bin, logFile);

  if (plain === null) {
    // 退回 node 内置 zstd（22.15+ 才有）：只能拿到第一个 frame，通常只有文件头。
    const inflate = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
    if (inflate === null) {
      log?.('warn', `没找到 zstd 命令行，且 node ${process.versions.node} 不支持 zstd，跳过会话日志`);
      return '';
    }
    try {
      plain = inflate(readFileSync(logFile));
      log?.('warn', '没找到 zstd 命令行，退回 node 解压（多帧日志可能只解出第一帧）');
    } catch (error) {
      log?.('warn', `会话日志解压失败：${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }

  if (plain.length === 0) return '';

  const tail = tailLines(plain);
  if (tail.length > MAX_CACHE_BYTES) {
    log?.('warn', `会话日志尾部 ${tail.length} 字节，超过上限，跳过`);
    return '';
  }

  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, tail);
  } catch (error) {
    log?.('warn', `会话日志缓存写入失败：${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
  return cachePath;
}

/**
 * 一步到位：sessionId → 能读的 jsonl 路径（找不到返回 ''）。
 */
export function resolveSessionLog(dshHome, sessionId, cacheDir, options = {}) {
  const file = findSessionLogFile(dshHome, sessionId);
  if (file === '') return '';
  return materializeSessionLog(file, cacheDir, { ...options, cacheName: sessionId });
}
