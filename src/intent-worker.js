/**
 * 念头机制的第二步：让高分的念头真的动一次手。
 *
 * 设计边界（docs/DESIGN-DRIVES-AND-INTENTIONS.md 第六节）：
 *   - 只有「分数过自主线 + 风险属于低风险白名单 + execute 打开」三条同时满足才动手；
 *   - 动手不是在这条主会话里干，而是开一个独立会话，跑完就 dispose，不碰 QQ 通道；
 *   - 做完只写日志，不自己发消息告诉沫沫（发不发由我另外决定）；
 *   - 任何一条不满足就只记录「想做什么」，不动手。
 *
 * 这一层刻意做成可以换掉的结构：IntentExecutor 只认 canExecute / run 两个方法，
 * 想接别的执行通道（比如以后接 MCP、接 worker 进程）换一个实现就行。
 */
import { appendJsonl } from './util.js';

/** 低风险动作：只读、只查、只写自己项目。其余一律要她点头。 */
export const SAFE_RISK_CLASSES = Object.freeze(['read', 'research', 'write_workspace']);

/** 高风险动作：任何对外可见或不可逆的动作。 */
export const GUARDED_RISK_CLASSES = Object.freeze(['write_outside', 'publish', 'install', 'contact']);

export const WORKER_DEFAULTS = Object.freeze({
  /** 只有显式打开才会真的动手。 */
  enabled: false,
  /** 单次任务最多跑几步（模型回合）。 */
  maxSteps: 12,
  /** 单次任务最长跑多久（毫秒），超时强停。 */
  timeBoxMs: 10 * 60_000,
  /** 允许自动执行的风险类别，可被配置覆盖。 */
  allowedRiskClasses: SAFE_RISK_CLASSES
});

const clamp01 = (v, fallback = 0) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);

/** 合并默认值与配置，配置里只认自己认识的键。 */
export function resolveWorkerConfig(raw = {}) {
  const merged = { ...WORKER_DEFAULTS };
  if (raw === null || typeof raw !== 'object') return merged;
  if (typeof raw.enabled === 'boolean') merged.enabled = raw.enabled;
  if (Number.isFinite(raw.maxSteps) && raw.maxSteps > 0) merged.maxSteps = Math.floor(raw.maxSteps);
  if (Number.isFinite(raw.timeBoxMs) && raw.timeBoxMs > 0) merged.timeBoxMs = Math.floor(raw.timeBoxMs);
  if (Array.isArray(raw.allowedRiskClasses) && raw.allowedRiskClasses.length > 0) {
    // 只接受安全集合里的类别。守卫类（写工作区外、发布、安装、联系人）就算
    // 配置里显式写了也不收——那是设计上不给自动做的事，不是配置能打开的开关。
    const safe = new Set(SAFE_RISK_CLASSES);
    const picked = raw.allowedRiskClasses.filter((k) => safe.has(k));
    if (picked.length > 0) merged.allowedRiskClasses = picked;
  }
  return merged;
}

/**
 * 这个念头现在能不能自己动手。
 *
 * @param {object|null} chosen        评估选中的念头（带 score / risk / riskClass）
 * @param {object} opts
 * @param {number} [opts.autonomousThreshold]
 * @param {object} [opts.workerConfig] resolveWorkerConfig 的结果
 * @returns {{execute:boolean, reason:string}}
 */
export function shouldExecute(chosen, { autonomousThreshold = 0.62, workerConfig = WORKER_DEFAULTS } = {}) {
  if (chosen === null || chosen === undefined) return { execute: false, reason: 'no_intention' };
  if (workerConfig.enabled !== true) return { execute: false, reason: 'worker_disabled' };

  const score = clamp01(chosen.score);
  if (score < autonomousThreshold) {
    return { execute: false, reason: `below_autonomous(${score.toFixed(3)}<${autonomousThreshold.toFixed(3)})` };
  }

  const risk = clamp01(chosen.risk, 1);
  if (risk >= 0.5) return { execute: false, reason: `risk_too_high(${risk.toFixed(2)})` };

  const riskClass = typeof chosen.riskClass === 'string' && chosen.riskClass !== '' ? chosen.riskClass : 'read';
  if (!workerConfig.allowedRiskClasses.includes(riskClass)) {
    return { execute: false, reason: `risk_class_not_allowed(${riskClass})` };
  }
  return { execute: true, reason: 'autonomous' };
}

/**
 * 拼给 worker 会话的任务书。
 *
 * 三条硬约束写在正文里而不是只靠系统提示：不越过工作区、不对外发东西、做完就停。
 */
export function buildWorkerPrompt(chosen, { nowIso = new Date().toISOString(), maxSteps = 12, workspaceRoot = '' } = {}) {
  const lines = [
    '# 这是一次自主任务',
    '',
    `现在是 ${nowIso}。这次没有人给你下命令，是你自己账本上的一个念头到了可以动手的程度。`,
    '',
    '## 念头',
    `- 类型：${chosen.kind ?? 'whim'}`,
    `- 内容：${chosen.text ?? ''}`,
    `- 打分：${Number(chosen.score ?? 0).toFixed(3)}　风险：${(Number(chosen.risk ?? 0)).toFixed(2)}（${chosen.riskClass ?? 'read'}）`,
    ''
  ];
  if (workspaceRoot !== '') {
    lines.push('## 地盘', `- 只允许在 ${workspaceRoot} 里写东西；工作区外一律只读。`, '');
  }
  lines.push(
    '## 规矩',
    '1. 只做这一件事，别顺手扩展成别的项目。',
    '2. 不对外发任何东西：不发消息、不发帖、不提交 PR、不装东西。',
    `3. 最多 ${maxSteps} 步。做完、做不动、或者连续两次工具报错就停手。`,
    '4. 结束时用两三句话写清楚：做了什么、结论是什么、还有什么没做完。',
    '',
    '## 做完之后',
    '不要给任何人发消息汇报。结果会写进日志，我自己会看。'
  );
  return lines.join('\n');
}

/**
 * 念头够格、但动手那层关着时，投给自己的一条提示。
 *
 * 注意它不是「发给沫沫的文案」——它进的是我的上下文，由我在那个回合里
 * 用自己的话开口问她。所以这里只写清楚：哪条念头、多少分、要你做什么。
 */
export function buildAskPrompt(chosen, { nowIso = new Date().toISOString() } = {}) {
  const kindLabel = { question: '疑问', unfinished: '没做完的事', whim: '一闪而过的念头', wish: '想做但还做不了的' }[chosen.kind] ?? '念头';
  return [
    `[念头] ${nowIso}`,
    '',
    `你自己账本上有一条${kindLabel}，分数够了：`,
    `「${chosen.text}」`,
    `打分 ${Number(chosen.score ?? 0).toFixed(2)}，风险 ${(Number(chosen.risk ?? 0)).toFixed(2)}（${chosen.riskClass ?? 'read'}）。`,
    '',
    '动手那层还关着，所以这次不能直接做。',
    '用你自己的话跟她说一句：这条你想去做，问她要不要放你去做。别念分数、别提插件或账本这些词，就像平时说话那样。',
    '她答应了你再动手，没答应就先放着。'
  ].join('\n');
}

/**
 * 执行器。只认 canExecute / run 两个方法，方便以后换实现。
 *
 * `deps.createWorker` 由宿主注入（真环境里是 ctx.agents.create 那一套），
 * 这样这一层可以脱离 DSH 单测。
 */
export class IntentExecutor {
  /**
   * @param {object} opts
   * @param {(job:object)=>Promise<object>} opts.createWorker  真正开会话并驱动的函数
   * @param {string} [opts.runsPath]                            结果落盘路径
   * @param {(level:string,msg:string)=>void} [opts.log]
   * @param {()=>number} [opts.now]
   */
  constructor({ createWorker, runsPath = '', log = () => {}, now = () => Date.now() } = {}) {
    this.createWorker = createWorker;
    this.runsPath = runsPath;
    this.log = log;
    this.now = now;
    this.running = false;
    this.lastResult = null;
  }

  canExecute(chosen, opts = {}) {
    if (typeof this.createWorker !== 'function') return { execute: false, reason: 'no_executor' };
    if (this.running) return { execute: false, reason: 'worker_busy' };
    return shouldExecute(chosen, opts);
  }

  /**
   * 跑一次。任何异常都吞掉并记账，绝不让它把评估循环带崩。
   * @param {object} chosen
   * @param {object} opts  同 canExecute，另加 workerConfig / workspaceRoot
   */
  async run(chosen, opts = {}) {
    const verdict = this.canExecute(chosen, opts);
    if (!verdict.execute) return { ok: false, skipped: true, reason: verdict.reason };

    const workerConfig = opts.workerConfig ?? WORKER_DEFAULTS;
    const startedAt = this.now();
    const prompt = buildWorkerPrompt(chosen, {
      nowIso: new Date(startedAt).toISOString(),
      maxSteps: workerConfig.maxSteps,
      workspaceRoot: opts.workspaceRoot ?? ''
    });

    this.running = true;
    let outcome;
    try {
      const result = await this.createWorker({
        prompt,
        intention: chosen,
        maxSteps: workerConfig.maxSteps,
        timeBoxMs: workerConfig.timeBoxMs
      });
      outcome = {
        ok: true,
        result: typeof result?.text === 'string' ? result.text.slice(0, 4000) : '',
        steps: Number(result?.steps) || 0
      };
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      this.log('warn', `念头执行失败：${outcome.error}`);
    } finally {
      this.running = false;
    }

    const record = {
      at: new Date(startedAt).toISOString(),
      tookMs: this.now() - startedAt,
      intentionId: chosen.id ?? '',
      kind: chosen.kind ?? '',
      text: String(chosen.text ?? '').slice(0, 200),
      score: Number(chosen.score ?? 0),
      risk: Number(chosen.risk ?? 0),
      riskClass: chosen.riskClass ?? 'read',
      ...outcome
    };
    this.lastResult = record;
    if (this.runsPath !== '') {
      try {
        appendJsonl(this.runsPath, record);
      } catch (error) {
        this.log('warn', `念头执行记录写盘失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.log('info', `[念头] 动手：${record.kind} ${record.text.slice(0, 30)} → ${outcome.ok ? '完成' : '失败'}（${record.tookMs}ms）`);
    return record;
  }
}
