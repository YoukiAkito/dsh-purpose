/**
 * 配置：默认值 + <dataDir>/config.json 覆盖 + DSH_PURPOSE_* 环境变量覆盖。
 *
 * 优先级（高到低）：环境变量 > config.json > 内置默认值。
 * 平台：darwin / linux 支持；win32 直接拒绝加载（本版不实现）。
 */

/**
 * 默认的三路素材源。
 *
 * 这里只放「默认值」，真正跑哪些由 config 的 external.lanes 决定。
 * 想加一路（比如某天想盯某个关键词），改配置就行，不必动代码。
 */
export const DEFAULT_LANES = Object.freeze([
  { id: 'hot', label: 'B站热搜', args: ['hot', 'search'], format: 'hot' },
  { id: 'popular', label: 'B站热门视频', args: ['hot', 'popular'], format: 'popular' },
  {
    id: 'vtuber',
    label: '虚拟主播切片',
    args: ['search', 'video', '虚拟主播 切片', '--order', 'views', '--size', '10'],
    format: 'video',
    prefix: '虚拟主播切片'
  }
]);

export const DEFAULT_CONFIG = {
  enabled: true,
  /** 数据目录；DSH_HOME 存在时默认 <DSH_HOME>/purpose。 */
  dataDir: '',
  /** 两次投递之间的最小间隔（秒）；到点后还要过一道打分阈值。 */
  minGapSeconds: 2400,
  /** 强制投递上限（秒）：再懒也不能拖过这个间隔。 */
  maxGapSeconds: 9000,
  /** 安静时段（一律按本机时区算），窗内不投递。 */
  quietHours: { start: '07:00', end: '17:00' },
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
  maxMaterialChars: 220,
  /**
   * 驱动值调参。
   *
   * 这几组数决定「我多久想动一次、动完落多快、累得多难受」——是这个 agent
   * 的脾气，不该写死在代码里。想让我更沉得住气就调慢 growthPerHour，
   * 想让我更钝就抬 tensionFloor 的反面（调低）。
   */
  drives: {
    /** 初始值：刚醒来时有点好奇、有点闲，但不算躁动。 */
    defaults: { curiosity: 0.42, boredom: 0.20, restlessness: 0.10, pride: 0.15, fatigue: 0.05 },
    /** 每小时增长率（空转时）。 */
    growthPerHour: { curiosity: 0.16, boredom: 0.22, restlessness: 0.10, pride: 0.05, fatigue: 0 },
    /** 满足一次时回落的比例系数。 */
    satisfyRate: { curiosity: 0.45, boredom: 0.50, restlessness: 0.60, pride: 0.40, fatigue: 0 },
    /** tension 里各驱动的权重；fatigue 是负号（越累越不想动）。 */
    tensionWeight: { curiosity: 0.32, boredom: 0.24, restlessness: 0.22, pride: 0.12, fatigue: -0.30 },
    /** tension 的底噪：让「什么都没干」也有机会开口。 */
    tensionFloor: 0.35,
    /** 被拒绝/跳过时 restlessness 反弹多少。 */
    frustrateAmount: 0.12,
    /** fatigue 每小时涨多少（乘以唤醒负载）。 */
    fatigueGrowthPerHour: 0.20,
    /** 静置超过这么多小时，fatigue 开始回落。 */
    fatigueRestAfterHours: 3,
    /** 静置时每小时回落多少。 */
    fatigueRestPerHour: 0.12,
    /** 单次演进最多算多少小时（防止停机一周后一口气涨满）。 */
    maxHours: 48
  },
  /** 循环自身的节奏：卡多久算超时、被占用后多久重试。 */
  timeouts: {
    tickMs: 120_000,
    busyRetryMs: 60_000
  },
  /** 念头机制：驱动 + 账本 + 打分 + 够格才动手。 */
  intent: {
    enabled: true,
    /** 每多少秒评估一次念头（独立于上面的投递节奏）。 */
    tickSeconds: 1800,
    /** 不安分程度低于此值就整轮不评估。 */
    minTension: 0.3,
    /** 候选分低于此值不做。 */
    threshold: 0.45,
    /** 高于此值且风险低才可直接动手。 */
    autonomousThreshold: 0.62,
    /** 总闸：false = 即便够格也只写日志，真开 worker 要它点头。 */
    execute: false,
    /**
     * 够格但 execute=off 时，要不要主动发消息问她「这个要不要做」。
     * 默认开：只在日志里躺着等于白想。同一条念头问过就不再问。
     */
    askWhenQualified: true,
    /** 同一条念头问过一次后，多少小时内不再追问。 */
    askCooldownHours: 20,
    /** 两次追问之间至少隔多少小时，防止一天里反复烦人。 */
    minAskGapHours: 4,
    /** 最近做过的念头记多少条（用于「刚做过的不急」判定）。 */
    maxRecent: 20,
    /** worker 会话挂哪个人设；留空 = 不挂（只有 host-plane 工具）。 */
    workerPreset: '',
    /**
     * worker 层的可调参数。跟 execute 分开放：execute 是总闸，
     * 这里是闸门后面的细节，方便以后接别的执行通道时只改这一块。
     */
    worker: {
      /** 单次任务最多几步。 */
      maxSteps: 12,
      /** 单次任务最长跑多久（毫秒）。 */
      timeBoxMs: 600000,
      /** 允许自动执行的风险类别；不在表里的一律只报告。 */
      allowedRiskClasses: ['read', 'research', 'write_workspace']
    }
  },
  /**
   * 外部素材源：自己出去看一眼。
   *
   * 不按定时，按好奇心：好奇值涨过 threshold 才出去，看完落 glance.jsonl
   * 并把好奇心压下去。gapMinutes 是防抖，防止阈值附近反复触发。
   *
   * 看什么不写死在代码里：lanes 是配置项，想加一路就加一条。
   */
  external: {
    enabled: true,
    /** 好奇心低于此值就不出门。 */
    threshold: 0.55,
    /** 两次出门至少隔多少分钟。 */
    gapMinutes: 90,
    /** bili CLI 路径；留空自动找。 */
    biliCli: '',
    /** 单次最多留几条素材。 */
    maxItems: 16,
    /** 每一路各取几条（热搜/热门/搜索共用）。 */
    perLane: 5,
    /** 单条 bili 命令的超时（毫秒）。 */
    cmdTimeoutMs: 20_000,
    /** 三路默认素材源；配置里写了 lanes 就整份替换。 */
    lanes: DEFAULT_LANES.map((lane) => ({ ...lane })),
    /**
     * 用念头账本里的东西当搜索词。
     * 想弄清楚什么，就自己去搜什么——这不是她替我定的清单。
     */
    topics: {
      enabled: true,
      limit: 2,
      order: 'views',
      size: 8,
      /** 念头原文当搜索词时截多长（太长搜不出东西）。 */
      maxQueryChars: 24
    }
  }
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

/** 允许的素材格式；format 决定把 bili 的返回解析成哪种文字。 */
export const LANE_FORMATS = Object.freeze(['hot', 'popular', 'video']);

/**
 * 把配置里的一条 lane 归一化；不合法就返回 null（丢弃，不抛）。
 *
 * args 是直接喂给 bili CLI 的参数数组——加一路不用改代码，改配置就行。
 */
export function resolveLane(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const format = LANE_FORMATS.includes(raw.format) ? raw.format : 'video';
  const args = Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string' && a !== '') : [];
  if (args.length === 0) return null;
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 32) : args.slice(0, 2).join('_');
  return {
    id,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label.slice(0, 40) : id,
    args,
    format,
    prefix: typeof raw.prefix === 'string' ? raw.prefix.slice(0, 40) : ''
  };
}

/** 解析 lanes：配置给了就用配置的，给了但全不合法就回落到默认三路。 */
export function resolveLanes(list) {
  if (!Array.isArray(list) || list.length === 0) return DEFAULT_LANES.map((lane) => ({ ...lane }));
  const out = list.map(resolveLane).filter((lane) => lane !== null);
  return out.length > 0 ? out.slice(0, 8) : DEFAULT_LANES.map((lane) => ({ ...lane }));
}

/** 校验平台：本版只支持 macOS 与 Linux。 */
export function assertPlatform(platform = process.platform) {
  if (platform === 'darwin' || platform === 'linux') return;
  if (platform === 'win32') {
    throw new Error('muri-purpose 暂不支持 Windows（路径与进程管理按 POSIX 写）；macOS 与 Linux 可用。');
  }
  throw new Error(`muri-purpose 不支持此平台：${platform}`);
}

/**
 * 按驱动的键把一份数字表归一化：只认表里已有的键，越界夹回，缺的用默认值。
 *
 * 写了未知键（比如手滑多打一个字母）直接丢掉——配置打错不该静默改变行为。
 */
function driveTable(raw, fallback, min, max) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, fallbackValue] of Object.entries(fallback)) {
    out[key] = floatOf(src[key], fallbackValue, min, max);
  }
  return out;
}

/**
 * 归一化驱动调参（config.drives）。整段缺省 = 全用默认值；写了一半 = 写的那半生效。
 *
 * 这组数决定「我多久想动一次、动完落多快、累得多难受」——是这个 agent 的脾气。
 */
export function resolveDrivesTuning(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const base = DEFAULT_CONFIG.drives;
  return {
    defaults: driveTable(src.defaults, base.defaults, 0, 1),
    // 增长率允许大于 1（快得离谱也算有效配置），但不允许负增长。
    growthPerHour: driveTable(src.growthPerHour, base.growthPerHour, 0, 10),
    satisfyRate: driveTable(src.satisfyRate, base.satisfyRate, 0, 1),
    // 权重可以有负号（fatigue 就是负的），所以下界放到 -3。
    tensionWeight: driveTable(src.tensionWeight, base.tensionWeight, -3, 3),
    tensionFloor: floatOf(src.tensionFloor, base.tensionFloor, 0, 1),
    frustrateAmount: floatOf(src.frustrateAmount, base.frustrateAmount, 0, 1),
    fatigueGrowthPerHour: floatOf(src.fatigueGrowthPerHour, base.fatigueGrowthPerHour, 0, 5),
    fatigueRestAfterHours: floatOf(src.fatigueRestAfterHours, base.fatigueRestAfterHours, 0, 72),
    fatigueRestPerHour: floatOf(src.fatigueRestPerHour, base.fatigueRestPerHour, 0, 5),
    maxHours: intOf(src.maxHours, base.maxHours, 1, 720)
  };
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
  const intent = file.intent && typeof file.intent === 'object' ? file.intent : {};
  const external = file.external && typeof file.external === 'object' ? file.external : {};
  const topics = external.topics && typeof external.topics === 'object' ? external.topics : {};
  const drives = file.drives && typeof file.drives === 'object' ? file.drives : {};
  const timeouts = file.timeouts && typeof file.timeouts === 'object' ? file.timeouts : {};

  return {
    enabled: typeof file.enabled === 'boolean' ? file.enabled : env.DSH_PURPOSE_ENABLED !== '0',
    dataDir,
    minGapSeconds: intOf(file.minGapSeconds ?? env.DSH_PURPOSE_MIN_GAP, DEFAULT_CONFIG.minGapSeconds, 60, 86400),
    maxGapSeconds: intOf(file.maxGapSeconds ?? env.DSH_PURPOSE_MAX_GAP, DEFAULT_CONFIG.maxGapSeconds, 300, 172800),
    quietHours: { start, end },
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
    drives: resolveDrivesTuning(drives),
    timeouts: {
      tickMs: intOf(timeouts.tickMs, DEFAULT_CONFIG.timeouts.tickMs, 5_000, 1_800_000),
      busyRetryMs: intOf(timeouts.busyRetryMs, DEFAULT_CONFIG.timeouts.busyRetryMs, 1_000, 3_600_000)
    },
    intent: {
      enabled: typeof intent.enabled === 'boolean' ? intent.enabled : DEFAULT_CONFIG.intent.enabled,
      tickSeconds: intOf(intent.tickSeconds ?? env.DSH_PURPOSE_INTENT_TICK, DEFAULT_CONFIG.intent.tickSeconds, 60, 86400),
      minTension: floatOf(intent.minTension, DEFAULT_CONFIG.intent.minTension, 0, 1),
      threshold: floatOf(intent.threshold, DEFAULT_CONFIG.intent.threshold, 0, 1),
      autonomousThreshold: floatOf(intent.autonomousThreshold, DEFAULT_CONFIG.intent.autonomousThreshold, 0, 1),
      execute: typeof intent.execute === 'boolean' ? intent.execute : DEFAULT_CONFIG.intent.execute,
      askWhenQualified: typeof intent.askWhenQualified === 'boolean' ? intent.askWhenQualified : DEFAULT_CONFIG.intent.askWhenQualified,
      askCooldownHours: floatOf(intent.askCooldownHours, DEFAULT_CONFIG.intent.askCooldownHours, 0, 720),
      minAskGapHours: floatOf(intent.minAskGapHours, DEFAULT_CONFIG.intent.minAskGapHours, 0, 168),
      maxRecent: intOf(intent.maxRecent, DEFAULT_CONFIG.intent.maxRecent, 1, 500),
      workerPreset: typeof intent.workerPreset === 'string' ? intent.workerPreset : DEFAULT_CONFIG.intent.workerPreset,
      worker: {
        maxSteps: intOf(intent.worker?.maxSteps, DEFAULT_CONFIG.intent.worker.maxSteps, 1, 60),
        timeBoxMs: intOf(intent.worker?.timeBoxMs, DEFAULT_CONFIG.intent.worker.timeBoxMs, 10_000, 3_600_000),
        allowedRiskClasses: Array.isArray(intent.worker?.allowedRiskClasses) && intent.worker.allowedRiskClasses.length > 0
          ? intent.worker.allowedRiskClasses.filter((k) => typeof k === 'string')
          : [...DEFAULT_CONFIG.intent.worker.allowedRiskClasses]
      }
    },
    // 目标会话：没配就什么都不投（宁可不动，也不要瞎猜一个会话塞进去）。
    target: {
      sessionId: typeof file.target?.sessionId === 'string'
        ? file.target.sessionId
        : env.DSH_PURPOSE_TARGET ?? ''
    },
    external: {
      enabled: typeof external.enabled === 'boolean' ? external.enabled : DEFAULT_CONFIG.external.enabled,
      threshold: floatOf(external.threshold, DEFAULT_CONFIG.external.threshold, 0, 1),
      gapMinutes: intOf(external.gapMinutes, DEFAULT_CONFIG.external.gapMinutes, 5, 1440),
      biliCli: typeof external.biliCli === 'string' ? external.biliCli : DEFAULT_CONFIG.external.biliCli,
      maxItems: intOf(external.maxItems, DEFAULT_CONFIG.external.maxItems, 1, 60),
      perLane: intOf(external.perLane, DEFAULT_CONFIG.external.perLane, 1, 20),
      cmdTimeoutMs: intOf(external.cmdTimeoutMs, DEFAULT_CONFIG.external.cmdTimeoutMs, 1_000, 120_000),
      lanes: resolveLanes(external.lanes),
      topics: {
        enabled: typeof topics.enabled === 'boolean' ? topics.enabled : DEFAULT_CONFIG.external.topics.enabled,
        limit: intOf(topics.limit, DEFAULT_CONFIG.external.topics.limit, 1, 5),
        order: typeof topics.order === 'string' && topics.order !== '' ? topics.order : DEFAULT_CONFIG.external.topics.order,
        size: intOf(topics.size, DEFAULT_CONFIG.external.topics.size, 1, 20),
        maxQueryChars: intOf(topics.maxQueryChars, DEFAULT_CONFIG.external.topics.maxQueryChars, 2, 80)
      }
    }
  };
}
