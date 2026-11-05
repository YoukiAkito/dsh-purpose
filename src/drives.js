/**
 * 驱动值：五个会涨会落的量，用来决定"现在想不想做点什么"。
 *
 * 设计要点：
 *   · 驱动只影响「要不要开一个自己的回合」，绝不直接触发对外动作。
 *   · 涨得慢、落得快：空转时向上饱和逼近 1，被满足时按比例回落。
 *   · fatigue 反向：醒得越频繁涨得越快，静置时回落。
 *
 * 详细取舍见 docs/DESIGN-DRIVES-AND-INTENTIONS.md。
 */

/** 五个驱动及其含义，字符串值同时用作念头账本里的 drive 字段。 */
export const DRIVES = Object.freeze(['curiosity', 'boredom', 'restlessness', 'pride', 'fatigue']);

export const DRIVE_LABELS = Object.freeze({
  curiosity: '好奇',
  boredom: '无聊',
  restlessness: '躁动',
  pride: '想被看见',
  fatigue: '疲'
});

/** 初始值：刚醒来时有点好奇、有点闲，但不算躁动。 */
export const DEFAULT_DRIVES = Object.freeze({
  curiosity: 0.42,
  boredom: 0.20,
  restlessness: 0.10,
  pride: 0.15,
  fatigue: 0.05
});

/** 每小时增长率（空转时）。curiosity 涨得最快，pride 最慢。 */
export const GROWTH_PER_HOUR = Object.freeze({
  curiosity: 0.16,
  boredom: 0.22,
  restlessness: 0.10,
  pride: 0.05,
  fatigue: 0.0
});

/** 满足一次时回落的比例系数。 */
export const SATISFY_RATE = Object.freeze({
  curiosity: 0.45,
  boredom: 0.50,
  restlessness: 0.60,
  pride: 0.40,
  fatigue: 0.0
});

/** tension 里各驱动的权重；fatigue 是负号（越累越不想动）。 */
export const TENSION_WEIGHT = Object.freeze({
  curiosity: 0.32,
  boredom: 0.24,
  restlessness: 0.22,
  pride: 0.12,
  fatigue: -0.30
});

/**
 * 默认调参。上面的常量是它的初值；真正跑的时候由 config.drives 覆盖。
 *
 * 每一项都能改，是因为「涨多快、落多快、累得多难受」是这个 agent 的性格，
 * 不该由我替使用者定死——她要是觉得我太躁，改配置就行。
 */
export const DEFAULT_DRIVE_TUNING = Object.freeze({
  defaults: DEFAULT_DRIVES,
  growthPerHour: GROWTH_PER_HOUR,
  satisfyRate: SATISFY_RATE,
  tensionWeight: TENSION_WEIGHT,
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
});

const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

/** 归一化：缺字段补默认值，越界夹回 0..1，未知键丢弃。 */
export function normalizeDrives(input, tuning = DEFAULT_DRIVE_TUNING) {
  const src = input && typeof input === 'object' ? input : {};
  const base = tuning?.defaults ?? DEFAULT_DRIVES;
  const out = {};
  for (const key of DRIVES) {
    const fallback = Number.isFinite(base?.[key]) ? base[key] : DEFAULT_DRIVES[key];
    out[key] = clamp01(typeof src[key] === 'number' ? src[key] : fallback);
  }
  return out;
}

/**
 * 按流逝时间推进驱动值。
 *
 * 空转公式：drive += growth * hours * (1 - drive)
 *   —— 越接近 1 涨得越慢，永远不会溢出。
 *
 * fatigue 单独处理：小时 budget 用得越满涨得越快，静置超过 3 小时开始回落。
 *
 * @param {object} drives  当前值
 * @param {object} opts
 * @param {number} opts.hoursSince      距上次演进多少小时
 * @param {number} [opts.wakeupsLastHour]  最近一小时醒了几次，用于 fatigue
 * @param {number} [opts.maxWakeupsPerHour]
 */
export function evolveDrives(drives, { hoursSince = 0, wakeupsLastHour = 0, maxWakeupsPerHour = 6, tuning = DEFAULT_DRIVE_TUNING } = {}) {
  const t = tuning ?? DEFAULT_DRIVE_TUNING;
  const cur = normalizeDrives(drives, t);
  const growth = t.growthPerHour ?? GROWTH_PER_HOUR;
  const maxHours = Number.isFinite(t.maxHours) ? t.maxHours : DEFAULT_DRIVE_TUNING.maxHours;
  const hours = Math.max(0, Math.min(maxHours, Number(hoursSince) || 0));
  const out = { ...cur };
  for (const key of DRIVES) {
    if (key === 'fatigue') continue;
    const rate = Number.isFinite(growth?.[key]) ? growth[key] : GROWTH_PER_HOUR[key];
    out[key] = clamp01(cur[key] + rate * hours * (1 - cur[key]));
  }
  // fatigue：醒得密就涨，静置久了落。
  const load = maxWakeupsPerHour > 0 ? Math.min(1, wakeupsLastHour / maxWakeupsPerHour) : 0;
  const growthRate = Number.isFinite(t.fatigueGrowthPerHour) ? t.fatigueGrowthPerHour : DEFAULT_DRIVE_TUNING.fatigueGrowthPerHour;
  const restAfter = Number.isFinite(t.fatigueRestAfterHours) ? t.fatigueRestAfterHours : DEFAULT_DRIVE_TUNING.fatigueRestAfterHours;
  const restRate = Number.isFinite(t.fatigueRestPerHour) ? t.fatigueRestPerHour : DEFAULT_DRIVE_TUNING.fatigueRestPerHour;
  const fatigueGrowth = growthRate * hours * load;
  const fatigueRest = hours > restAfter ? restRate * (hours - restAfter) : 0;
  out.fatigue = clamp01(cur.fatigue + fatigueGrowth - fatigueRest);
  return out;
}

/**
 * 满足某个驱动：按 SATISFY_RATE 回落。
 * fatigue 不走这条（它靠静置落）。
 */
export function satisfyDrive(drives, drive, strength = 1, tuning = DEFAULT_DRIVE_TUNING) {
  const t = tuning ?? DEFAULT_DRIVE_TUNING;
  const cur = normalizeDrives(drives, t);
  if (!DRIVES.includes(drive) || drive === 'fatigue') return cur;
  const rates = t.satisfyRate ?? SATISFY_RATE;
  const base = Number.isFinite(rates?.[drive]) ? rates[drive] : SATISFY_RATE[drive];
  const rate = base * Math.max(0, Math.min(2, Number(strength) || 1));
  return { ...cur, [drive]: clamp01(cur[drive] * (1 - rate)) };
}

/** 被拒绝/被跳过：restlessness 反弹一点，其余不动。 */
export function frustrateDrives(drives, amount, tuning = DEFAULT_DRIVE_TUNING) {
  const t = tuning ?? DEFAULT_DRIVE_TUNING;
  const cur = normalizeDrives(drives, t);
  const delta = Number.isFinite(amount) ? amount
    : (Number.isFinite(t.frustrateAmount) ? t.frustrateAmount : DEFAULT_DRIVE_TUNING.frustrateAmount);
  return { ...cur, restlessness: clamp01(cur.restlessness + delta) };
}

/**
 * 总的"不安分"程度。低于阈值就整轮不评估，省一次唤醒。
 * fatigue 权重是负的，累了就会把 tension 压下去。
 */
export function tensionOf(drives, tuning = DEFAULT_DRIVE_TUNING) {
  const t = tuning ?? DEFAULT_DRIVE_TUNING;
  const cur = normalizeDrives(drives, t);
  const weights = t.tensionWeight ?? TENSION_WEIGHT;
  const floor = Number.isFinite(t.tensionFloor) ? t.tensionFloor : DEFAULT_DRIVE_TUNING.tensionFloor;
  let sum = 0;
  for (const key of DRIVES) {
    const w = Number.isFinite(weights?.[key]) ? weights[key] : TENSION_WEIGHT[key];
    sum += w * cur[key];
  }
  return Math.max(0, Math.min(1, sum + floor)); // 底噪，让正常状态也有机会
}

/** 便于日志：把驱动值渲染成一行紧凑文本。 */
export function describeDrives(drives) {
  const cur = normalizeDrives(drives);
  return DRIVES.map((k) => `${DRIVE_LABELS[k]}${cur[k].toFixed(2)}`).join(' ');
}
