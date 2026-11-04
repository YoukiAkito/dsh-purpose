/**
 * 面向模型的工具。
 *
 *   purpose_status    看一眼目的机制现在什么状态（下次评估、今天发了几条、各类置信度）
 *   purpose_goals     看最近提过哪些目标假设、分数多少、为什么没发
 *   purpose_reclaim   这一轮不打算开口 —— 记下理由，安静收手
 *   purpose_settings  改运行参数（间隔、阈值、日上限、安静时段）
 *
 * 这些工具注册在每个 root agent 的 scope 上，跟 dsh-proactive 一致。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_CONFIG } from './config.js';
import { toIso } from './util.js';

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true }
  }
};

function renderValue(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function internalError() {
  return { code: 'internal', message: '这个工具只能在它所属的 agent 回合里调用。' };
}

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', required: true },
    nextAt: { type: 'string', required: true },
    deliveredToday: { type: 'integer', required: true },
    maxDeliveriesPerDay: { type: 'integer', required: true },
    wakeupsLastHour: { type: 'integer', required: true },
    maxWakeupsPerHour: { type: 'integer', required: true },
    gapSeconds: { type: 'string', required: true },
    scoreThreshold: { type: 'number', required: true },
    quietHours: { type: 'string', required: true },
    coolingCount: { type: 'integer', required: true },
    kinds: { type: 'string', required: true },
    intentTension: { type: 'number', required: true },
    intentDrives: { type: 'string', required: true },
    openIntentions: { type: 'integer', required: true },
    intentNextAt: { type: 'string', required: true }
  }
};

/**
 * @param {object} agentCtx  agent 作用域上下文（有 tools.register）
 * @param {object} agent     所属 agent
 * @param {object} service   插件服务对象，需提供
 *   - state()                        → 状态快照
 *   - goals(limit)                   → 最近目标假设
 *   - reclaim(reason)                → 记一次"这次不说"
 *   - patchConfig(patch)             → 改配置，返回新的生效配置
 */
export function registerPurposeTools(agentCtx, agent, service) {
  const disposers = [];

  const add = (definition) => {
    disposers.push(agentCtx.tools.register(definition));
  };

  add(defineTool({
    name: 'purpose_status',
    description: '看一眼目的机制现在的状态：下次评估时间、今天已经开口几次、冷却中的目标数、各类目标的置信度。不是每次都要看，想确认自己在不在正常节奏里时用。',
    parameters: {},
    output: {
      schema: { oneOf: [STATUS_SCHEMA, ERROR_SCHEMA] },
      render: renderValue
    },
    async execute(_args, exec) {
      if (exec.agent !== agent) return internalError();
      return service.state();
    },
    presentCall: () => ({ type: 'text', text: '看目的机制状态' })
  }));

  add(defineTool({
    name: 'purpose_goals',
    description: '看最近提出过哪些目标假设、各自多少分、最后有没有开口。用来回顾"为什么那几次没说话"。',
    parameters: {
      limit: { type: 'integer', description: '返回几条，默认 10，上限 50。' }
    },
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            goals: { type: 'string', required: true }
          }
        }, ERROR_SCHEMA]
      },
      render: renderValue
    },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const raw = Number(args['limit'] ?? 10);
      const limit = Number.isFinite(raw) ? Math.min(50, Math.max(1, Math.trunc(raw))) : 10;
      return { goals: JSON.stringify(service.goals(limit)) };
    },
    presentCall: () => ({ type: 'text', text: '看最近的目标假设' })
  }));

  add(defineTool({
    name: 'purpose_reclaim',
    description: '这一轮被叫起来之后，看过素材发现自己没什么想说的 —— 用这个记下理由，然后安静收手。别用它逃工作量，只在真的没必要开口时用。',
    parameters: {
      reason: { type: 'string', required: true, description: '一句话说明为什么这次不说，会记进流水。' }
    },
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            reclaimed: { type: 'boolean', required: true, const: true },
            reason: { type: 'string', required: true }
          }
        }, ERROR_SCHEMA]
      },
      render: renderValue
    },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const reason = typeof args['reason'] === 'string' ? args['reason'].trim() : '';
      if (reason === '') {
        return { code: 'invalid_args', message: 'reason 不能为空，写一句为什么这次不说。' };
      }
      service.reclaim(reason);
      return { reclaimed: true, reason };
    },
    presentCall: () => ({ type: 'text', text: '这次不开口' })
  }));

  add(defineTool({
    name: 'purpose_settings',
    description: '改目的机制的运行参数。只传要改的字段，其余保持不变。改完立刻生效并落盘。',    parameters: {
      enabled: { type: 'boolean', description: '总开关。' },
      min_gap_minutes: { type: 'integer', description: '两次评估的最小间隔（分钟）。' },
      max_gap_minutes: { type: 'integer', description: '两次评估的最大间隔（分钟）。' },
      score_threshold: { type: 'number', description: '低于这个分数就不开口，0~1。' },
      max_deliveries_per_day: { type: 'integer', description: '每天最多主动开口几条。' },
      max_wakeups_per_hour: { type: 'integer', description: '每小时内最多评估几次。' },
      quiet_start: { type: 'string', description: '安静时段开始 HH:MM。' },
      quiet_end: { type: 'string', description: '安静时段结束 HH:MM。' }
    },
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true, const: true },
            enabled: { type: 'boolean', required: true },
            gapSeconds: { type: 'string', required: true },
            scoreThreshold: { type: 'number', required: true },
            maxDeliveriesPerDay: { type: 'integer', required: true },
            maxWakeupsPerHour: { type: 'integer', required: true },
            quietHours: { type: 'string', required: true }
          }
        }, ERROR_SCHEMA]
      },
      render: renderValue
    },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const patch = {};
      if (typeof args['enabled'] === 'boolean') patch.enabled = args['enabled'];
      if (Number.isFinite(args['min_gap_minutes'])) patch.minGapSeconds = Math.max(1, Math.trunc(args['min_gap_minutes'])) * 60;
      if (Number.isFinite(args['max_gap_minutes'])) patch.maxGapSeconds = Math.max(1, Math.trunc(args['max_gap_minutes'])) * 60;
      if (Number.isFinite(args['score_threshold'])) patch.scoreThreshold = Math.min(1, Math.max(0, args['score_threshold']));
      if (Number.isFinite(args['max_deliveries_per_day'])) patch.maxDeliveriesPerDay = Math.max(0, Math.trunc(args['max_deliveries_per_day']));
      if (Number.isFinite(args['max_wakeups_per_hour'])) patch.maxWakeupsPerHour = Math.max(1, Math.trunc(args['max_wakeups_per_hour']));
      if (typeof args['quiet_start'] === 'string' && args['quiet_start'] !== '') patch.quietStart = args['quiet_start'];
      if (typeof args['quiet_end'] === 'string' && args['quiet_end'] !== '') patch.quietEnd = args['quiet_end'];
      try {
        return service.patchConfig(patch);
      } catch (error) {
        return { code: 'invalid_args', message: error instanceof Error ? error.message : String(error) };
      }
    },
    presentCall: () => ({ type: 'text', text: '改目的机制设置' })
  }));

  add(defineTool({
    name: 'purpose_intentions',
    description: '看念头账本：我自己攒下的"想做什么"。用它回顾这段时间在想什么、哪些一直没动。',
    parameters: {
      status: { type: 'string', description: '只看某个状态：open / doing / done / dropped。默认 open。' },
      kind: { type: 'string', description: '只看某种：question / unfinished / whim / wish。' },
      limit: { type: 'integer', description: '返回几条，默认 10，上限 50。' }
    },
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            items: { type: 'string', required: true }
          }
        }, ERROR_SCHEMA]
      },
      render: renderValue
    },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const status = typeof args['status'] === 'string' && args['status'] !== '' ? args['status'] : 'open';
      const kind = typeof args['kind'] === 'string' && args['kind'] !== '' ? args['kind'] : '';
      const raw = Number(args['limit'] ?? 10);
      const limit = Number.isFinite(raw) ? Math.min(50, Math.max(1, Math.trunc(raw))) : 10;
      const items = service.intentions({ status, kind, limit });
      return { count: items.length, items: JSON.stringify(items) };
    },
    presentCall: () => ({ type: 'text', text: '看念头账本' })
  }));

  add(defineTool({
    name: 'purpose_note',
    description: '往念头账本里记一条"我想做什么"。这是给我自己用的，不是给她汇报——想到什么就记，别为了凑数写。已经在账本上的相似念头会被合并，不会重复。',
    parameters: {
      text: { type: 'string', required: true, description: '一句话说清想做什么，别写成任务清单。' },
      kind: {
        type: 'string',
        description: 'question=想弄明白的，unfinished=做了一半的，whim=一闪而过先记着，wish=想要但暂时做不到的。默认 whim。'
      },
      drive: { type: 'string', description: '这条念头是被哪种劲儿顶上来的：curiosity / boredom / restlessness / pride。可省略。' },
      weight: { type: 'number', description: '重要性 0~1，默认 0.5。拿不准就省略。' },
      note: { type: 'string', description: '补一句为什么记它，可省略。' }
    },
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true, const: true },
            id: { type: 'string', required: true },
            merged: { type: 'boolean', required: true },
            message: { type: 'string', required: true }
          }
        }, ERROR_SCHEMA]
      },
      render: renderValue
    },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      const text = typeof args['text'] === 'string' ? args['text'].trim() : '';
      if (text === '') {
        return { code: 'invalid_args', message: 'text 不能为空，一句话说清想做什么。' };
      }
      try {
        const result = service.noteIntention({
          text,
          kind: typeof args['kind'] === 'string' ? args['kind'] : 'whim',
          drive: typeof args['drive'] === 'string' ? args['drive'] : '',
          weight: Number.isFinite(args['weight']) ? args['weight'] : 0.5,
          note: typeof args['note'] === 'string' ? args['note'] : ''
        });
        return {
          ok: true,
          id: result.row.id,
          merged: result.merged,
          message: result.merged ? '账本里已有相似的念头，合并了。' : '记下了。'
        };
      } catch (error) {
        return { code: 'invalid_args', message: error instanceof Error ? error.message : String(error) };
      }
    },
    presentCall: () => ({ type: 'text', text: '记一条念头' })
  }));

  add(defineTool({
    name: 'purpose_runs',
    description: '看念头动过手之后的记录：哪条念头、什么时候、跑了多久、成没成。只在想看"我真的动过什么手"时用。',
    parameters: {
      limit: { type: 'integer', description: '看最近几条，默认 10，最多 200。' }
    },
    output: {
      schema: {
        oneOf: [{
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            items: { type: 'string', required: true }
          }
        }, ERROR_SCHEMA]
      },
      render: renderValue
    },
    async execute(args, exec) {
      if (exec.agent !== agent) return internalError();
      if (typeof service.runs !== 'function') {
        return { code: 'unavailable', message: '这个版本没有记录执行结果。' };
      }
      const limit = Number.isFinite(args['limit']) ? args['limit'] : 10;
      let rows;
      try {
        rows = service.runs(limit);
      } catch (error) {
        return { code: 'invalid_args', message: error instanceof Error ? error.message : String(error) };
      }
      const items = rows.map((row) => {
        const head = `${row.at ?? ''} ${row.kind ?? ''} ${String(row.text ?? '').slice(0, 40)}`;
        const tail = `${row.ok === true ? '成' : '败'} ${row.tookMs ?? 0}ms${row.error !== undefined ? ` / ${row.error}` : ''}`;
        return `${head} → ${tail}`;
      }).join('\n');
      return { count: rows.length, items: items === '' ? '（还没动过手）' : items };
    },
    presentCall: () => ({ type: 'text', text: '看执行记录' })
  }));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 单个工具注销失败不该影响其它工具的清理。
      }
    }
  };
}

/** 默认配置的快照（给外部/测试用）。 */
export function defaultConfigView() {
  const config = DEFAULT_CONFIG;
  return {
    enabled: config.enabled,
    gapSeconds: `${config.minGapSeconds}~${config.maxGapSeconds}`,
    scoreThreshold: config.scoreThreshold,
    maxDeliveriesPerDay: config.maxDeliveriesPerDay,
    maxWakeupsPerHour: config.maxWakeupsPerHour,
    quietHours: `${config.quietHours.start}-${config.quietHours.end}`,
    now: toIso(Date.now())
  };
}
