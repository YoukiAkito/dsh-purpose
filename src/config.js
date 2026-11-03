/**
 * 配置：默认值 + <dataDir>/config.json 覆盖 + DSH_PURPOSE_* 环境变量覆盖。
 *
 * 优先级（高到低）：环境变量 > config.json > 内置默认值。
 * 平台：darwin / linux 支持；win32 直接拒绝加载（本版不实现）。
 */

export const DEFAULT_CONFIG = {
  enabled: true,
  /** 数据目录；DSH_HOME 存在时默认 <DSH_HOME>/purpose。 */
  dataDir: '',
  /** 两次投递之间的最小间隔（秒）；到点后还要过一道打分阈值。 */
  minGapSeconds: 2400,
  /** 强制投递上限（秒）：再懒也不能拖过这个间隔。 */
  maxGapSeconds: 9000,
  /** 安静时段（本地时区），窗内不投递。 */
  quietHours: { start: '07:00', end: '17:00', timeZone: '' },
  /** 每日最多投递几条（含被拒绝的尝试）。 */
  maxDeliveriesPerDay: 12,
  /** 每小时最多唤醒几次，防抖。 */
  maxWakeupsPerHour: 6,
  /** 打分低于此阈值就不投递，安静收手。 */
  scoreThreshold: 0.42,
  /** 与历史投递的相似度超过此值视为重复，直接丢弃。 */
  dedupeSimilarity: 0.72,
  /** 目标记账：同一目标最多尝试次数，超过后强制冷却。 */
  maxAttemptsPerGoal: 3,
  /** 目标冷却期（秒）：失败或沉默后多久内不再提同一目标。 */
  goalCooldownSeconds: 21600,
  /** 素材窗口：收集最近多少小时的活动。 */
  materialWindowHours: 24,
  /** 启动后多久做第一次评估（秒），避免开机就连发。 */
  firstDelaySeconds: 600,
  /** 反馈学习：正面反馈的置信度增量、负面减量、沉默衰减。 */
  confidence: {
    reward: 0.18,
    penalty: 0.28,
    silenceDecay: 0.06,
    min: 0.05,
    max: 0.95
  },
  /** 单次评估最多把多少条素材拼进提示词，控制 token。 */
  maxMaterials: 24,
  /** 提示词里每条素材最长多少字符。 */
  maxMaterialChars: 220
};

const TIME_RE = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/;

export function parseClock(value, label) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new Error(`config.quietHours.${label} 必须是 HH:MM`);
  }
  return value;
}

function clockMinutes(value) {
  const m = TIME_RE.exec(value);
  return Number(m.groups.hour) * 60 + Number(m.groups.minute);
}

/** 是否落在安静时段内（支持跨零点）。 */
export function isInQuietHours(ms, config, zoneOffsetMinutes = 0) {
  const { start, end } = config.quietHours;
  const local = new Date(ms + zoneOffsetMinutes * 60_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const a = clockMinutes(start);
  const b = clockMinutes(end);
  if (a === b) return false;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

/** 本机时区相对 UTC 的偏移分钟数（东八区为 480）。 */
export function localZoneOffsetMinutes(now = Date.now()) {
  return -new Date(now).getTimezoneOffset();
}

function intOf(value, fallback, min, max) {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function floatOf(value, fallback, min, max) {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 校验平台：本版只支持 macOS 与 Linux。 */
export function assertPlatform(platform = process.platform) {
  if (platform === 'darwin' || platform === 'linux') return;
  if (platform === 'win32') {
    throw new Error('dsh-purpose 暂不支持 Windows（路径与进程管理按 POSIX 写）；macOS 与 Linux 可用。');
  }
  throw new Error(`dsh-purpose 不支持此平台：${platform}`);
}

/** 合并默认值 + 文件 + 环境变量，返回归一化后的配置。 */
export function resolveConfig({ platform = process.platform, env = process.env, file = {} } = {}) {
  assertPlatform(platform);
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : '';
  const dataDir = typeof file.dataDir === 'string' && file.dataDir !== ''
    ? file.dataDir
    : env.DSH_PURPOSE_DATA_DIR ?? (home !== '' ? `${home}/purpose` : `${env.HOME ?? '.'}/.dsh/purpose`);

  const quiet = file.quietHours && typeof file.quietHours === 'object' ? file.quietHours : {};
  let start = DEFAULT_CONFIG.quietHours.start;
  let end = DEFAULT_CONFIG.quietHours.end;
  try {
    start = parseClock(quiet.start ?? env.DSH_PURPOSE_QUIET_START ?? start, 'start');
  } catch {
    start = DEFAULT_CONFIG.quietHours.start;
  }
  try {
    end = parseClock(quiet.end ?? env.DSH_PURPOSE_QUIET_END ?? end, 'end');
  } catch {
    end = DEFAULT_CONFIG.quietHours.end;
  }

  const confidence = file.confidence && typeof file.confidence === 'object' ? file.confidence : {};

  return {
    enabled: typeof file.enabled === 'boolean' ? file.enabled : env.DSH_PURPOSE_ENABLED !== '0',
    dataDir,
    minGapSeconds: intOf(file.minGapSeconds ?? env.DSH_PURPOSE_MIN_GAP, DEFAULT_CONFIG.minGapSeconds, 60, 86400),
    maxGapSeconds: intOf(file.maxGapSeconds ?? env.DSH_PURPOSE_MAX_GAP, DEFAULT_CONFIG.maxGapSeconds, 300, 172800),
    quietHours: {
      start,
      end,
      timeZone: typeof quiet.timeZone === 'string' && quiet.timeZone !== ''
        ? quiet.timeZone
        : env.DSH_PURPOSE_TIME_ZONE ?? ''
    },
    maxDeliveriesPerDay: intOf(file.maxDeliveriesPerDay, DEFAULT_CONFIG.maxDeliveriesPerDay, 0, 50),
    maxWakeupsPerHour: intOf(file.maxWakeupsPerHour, DEFAULT_CONFIG.maxWakeupsPerHour, 1, 60),
    scoreThreshold: floatOf(file.scoreThreshold, DEFAULT_CONFIG.scoreThreshold, 0, 1),
    dedupeSimilarity: floatOf(file.dedupeSimilarity, DEFAULT_CONFIG.dedupeSimilarity, 0, 1),
    maxAttemptsPerGoal: intOf(file.maxAttemptsPerGoal, DEFAULT_CONFIG.maxAttemptsPerGoal, 1, 20),
    goalCooldownSeconds: intOf(file.goalCooldownSeconds, DEFAULT_CONFIG.goalCooldownSeconds, 60, 604800),
    materialWindowHours: intOf(file.materialWindowHours, DEFAULT_CONFIG.materialWindowHours, 1, 168),
    firstDelaySeconds: intOf(file.firstDelaySeconds, DEFAULT_CONFIG.firstDelaySeconds, 0, 86400),
    confidence: {
      reward: floatOf(confidence.reward, DEFAULT_CONFIG.confidence.reward, 0, 1),
      penalty: floatOf(confidence.penalty, DEFAULT_CONFIG.confidence.penalty, 0, 1),
      silenceDecay: floatOf(confidence.silenceDecay, DEFAULT_CONFIG.confidence.silenceDecay, 0, 1),
      min: floatOf(confidence.min, DEFAULT_CONFIG.confidence.min, 0, 1),
      max: floatOf(confidence.max, DEFAULT_CONFIG.confidence.max, 0, 1)
    },
    maxMaterials: intOf(file.maxMaterials, DEFAULT_CONFIG.maxMaterials, 1, 200),
    maxMaterialChars: intOf(file.maxMaterialChars, DEFAULT_CONFIG.maxMaterialChars, 20, 2000),
    // 目标会话：没配就什么都不投（宁可不动，也不要瞎猜一个会话塞进去）。
    target: {
      sessionId: typeof file.target?.sessionId === 'string'
        ? file.target.sessionId
        : env.DSH_PURPOSE_TARGET ?? ''
    }
  };
}
