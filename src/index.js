/**
 * dsh-purpose —— 目的机制插件。
 *
 * 跟 dsh-proactive 的区别：
 *   dsh-proactive  按你设定的闹钟醒来，醒来后自己看要不要说话
 *   dsh-purpose    自己攒素材、自己提目标假设、自己打分，够了才叫醒自己
 *
 * 一次 tick 的流程见 engine.js。这里的职责只有四件：
 *   1. 读配置、建 store、起定时器
 *   2. 到点时把 tick 跑起来（同一时刻只跑一个，跑完再排下一次）
 *   3. tick 决定要开口 → 把 prompt 投进目标会话，让它当一轮用户输入
 *   4. 把 purpose_* 四个工具挂到每个 root agent 上
 *
 * 平台：darwin / linux。win32 在 apply 里直接抛错（本版不实现）。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, isInQuietHours, localZoneOffsetMinutes, parseClock, resolveLane } from './config.js';
import { PurposeStore } from './store.js';
import { tick as runTick, nextGapMs } from './engine.js';
import { registerPurposeTools } from './tools.js';
import { IntentRuntime } from './intent-runtime.js';
import { IntentExecutor, resolveWorkerConfig, buildAskPrompt } from './intent-worker.js';
import { describeDrives } from './drives.js';
import { findBiliCli, glance, shouldGlance, recordGlance, lastGlanceAt, topicQueries } from './glance.js';
import { materializeSessionLog, resolveSessionLog } from './sessionlog.js';
import { readJson, readJsonl, writeJsonAtomic, toIso } from './util.js';

export const name = 'dsh-purpose';
export const inject = ['agents', 'tools', 'sessionPersistence'];

/** 单次 tick 最多跑多久、被占用后多久重试的兜底值（config.timeouts 可覆盖）。 */
const DEFAULT_TICK_TIMEOUT_MS = 120_000;
const DEFAULT_BUSY_RETRY_MS = 60_000;

export async function apply(ctx) {
  const log = (level, message) => {
    const fn = ctx.logger?.[level];
    if (typeof fn === 'function') fn.call(ctx.logger, `[dsh-purpose] ${message}`);
  };

  let config;
  try {
    if (!existsSync(join(process.env.DSH_HOME ?? `${process.env.HOME ?? '.'}/.dsh`, 'purpose'))) {
      // 目录不存在不致命，下面会建。
    }
    const base = resolveConfig({ platform: process.platform });
    const file = readJson(join(base.dataDir, 'config.json'), {}, (error) => {
      log('warn', `config.json 读取失败，用默认值：${error.message}`);
    });
    config = resolveConfig({ platform: process.platform, file: file ?? {} });
  } catch (error) {
    log('error', error instanceof Error ? error.message : String(error));
    return async () => undefined;
  }

  if (!config.enabled) {
    log('info', 'disabled by config.');
    return async () => undefined;
  }

  mkdirSync(config.dataDir, { recursive: true });
  const store = new PurposeStore(config.dataDir).load(log);
  const intent = new IntentRuntime(config.dataDir, {
    tuning: config.drives,
    maxRecent: config.intent.maxRecent,
    askCooldownHours: config.intent.askCooldownHours,
    minAskGapHours: config.intent.minAskGapHours
  });
  intent.load(log);
  /** 下一次念头评估的时刻（毫秒）；null = 未安排。 */
  let intentNextAt = null;

  /** 外部素材：出去的记录落在 glance.jsonl，用它算上次出门是多久前。 */
  const glancePath = join(config.dataDir, 'glance.jsonl');
  const biliCli = findBiliCli({ DSH_PURPOSE_BILI: config.external.biliCli });

  /** 循环节奏：卡多久算超时、被占用后多久重试。 */
  const tickTimeoutMs = Number.isFinite(config.timeouts?.tickMs) ? config.timeouts.tickMs : DEFAULT_TICK_TIMEOUT_MS;
  const busyRetryMs = Number.isFinite(config.timeouts?.busyRetryMs) ? config.timeouts.busyRetryMs : DEFAULT_BUSY_RETRY_MS;

  // 目标会话：config.json 里的 target.sessionId 优先，否则用当前 root agent。
  const targetSessionId = typeof config.target?.sessionId === 'string' ? config.target.sessionId : '';

  /** 状态快照给 purpose_status 用。 */
  const stateView = () => {
    const kinds = Object.entries(store.state.kinds)
      .map(([kind, stat]) => `${kind}:${(stat?.confidence ?? 0.5).toFixed(2)}`)
      .join(' ');
    const iv = intent.view();
    return {
      enabled: config.enabled,
      nextAt: store.state.nextAt === '' ? '（未安排）' : store.state.nextAt,
      deliveredToday: store.state.day === todayKey() ? store.state.deliveredToday : 0,
      maxDeliveriesPerDay: config.maxDeliveriesPerDay,
      wakeupsLastHour: store.wakeupsLastHour(Date.now()),
      maxWakeupsPerHour: config.maxWakeupsPerHour,
      gapSeconds: `${config.minGapSeconds}~${config.maxGapSeconds}`,
      scoreThreshold: config.scoreThreshold,
      quietHours: `${config.quietHours.start}-${config.quietHours.end}`,
      coolingCount: store.coolingMap().size,
      kinds: kinds === '' ? '（还没有历史）' : kinds,
      intentTension: iv.tension,
      intentDrives: describeDrives(iv.drives),
      openIntentions: iv.openIntentions,
      intentAskedAt: iv.lastAskAt === '' ? '（还没问过）' : iv.lastAskAt,
      intentNextAt: intentNextAt === null ? '（未安排）' : toIso(intentNextAt)
    };
  };

  /** 改配置：写回 config.json 并热更新内存里的 config。 */
  const patchConfig = (patch) => {
    if (patch.quietStart !== undefined) parseClock(patch.quietStart, 'start');
    if (patch.quietEnd !== undefined) parseClock(patch.quietEnd, 'end');
    const next = {
      ...config,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.minGapSeconds !== undefined ? { minGapSeconds: patch.minGapSeconds } : {}),
      ...(patch.maxGapSeconds !== undefined ? { maxGapSeconds: patch.maxGapSeconds } : {}),
      ...(patch.scoreThreshold !== undefined ? { scoreThreshold: patch.scoreThreshold } : {}),
      ...(patch.maxDeliveriesPerDay !== undefined ? { maxDeliveriesPerDay: patch.maxDeliveriesPerDay } : {}),
      ...(patch.maxWakeupsPerHour !== undefined ? { maxWakeupsPerHour: patch.maxWakeupsPerHour } : {})
    };
    if (patch.quietStart !== undefined || patch.quietEnd !== undefined) {
      next.quietHours = {
        ...config.quietHours,
        start: patch.quietStart ?? config.quietHours.start,
        end: patch.quietEnd ?? config.quietHours.end
      };
    }
    // 看什么：加一路 / 减一路。加的那一路就是「搜这个关键词」。
    if (Array.isArray(patch.watchAdd) && patch.watchAdd.length > 0) {
      const lanes = [...next.external.lanes];
      for (const raw of patch.watchAdd) {
        const keyword = String(raw ?? '').trim();
        if (keyword === '') continue;
        if (lanes.some((lane) => lane.id === `kw:${keyword}`)) continue;
        if (lanes.length >= 8) break;
        const lane = resolveLane({
          id: `kw:${keyword}`,
          label: `搜 ${keyword}`,
          args: ['search', 'video', keyword, '--order', 'views', '--size', '10'],
          format: 'video',
          prefix: `搜「${keyword}」`
        });
        if (lane !== null) lanes.push(lane);
      }
      next.external = { ...next.external, lanes };
    }
    if (Array.isArray(patch.watchRemove) && patch.watchRemove.length > 0) {
      const drop = new Set(patch.watchRemove.map((id) => String(id ?? '').trim()).filter((id) => id !== ''));
      next.external = {
        ...next.external,
        lanes: next.external.lanes.filter((lane) => !drop.has(lane.id) && !drop.has(lane.label))
      };
    }
    if (patch.topicsEnabled !== undefined) {
      next.external = { ...next.external, topics: { ...next.external.topics, enabled: patch.topicsEnabled } };
    }
    writeJsonAtomic(join(config.dataDir, 'config.json'), serializable(next));
    config = next;
    log('info', `配置已更新：间隔 ${next.minGapSeconds}~${next.maxGapSeconds}s、阈值 ${next.scoreThreshold}、每日 ${next.maxDeliveriesPerDay} 条、安静时段 ${next.quietHours.start}-${next.quietHours.end}`);
    return {
      ok: true,
      enabled: next.enabled,
      gapSeconds: `${next.minGapSeconds}~${next.maxGapSeconds}`,
      scoreThreshold: next.scoreThreshold,
      maxDeliveriesPerDay: next.maxDeliveriesPerDay,
      maxWakeupsPerHour: next.maxWakeupsPerHour,
      quietHours: `${next.quietHours.start}-${next.quietHours.end}`,
      watchLanes: next.external.lanes.map((lane) => lane.id).join(' '),
      topicsEnabled: next.external.topics.enabled
    };
  };

  /** 这一轮我不说：记一笔，间隔顺延。 */
  const reclaim = (reason) => {
    store.recordRun({ decision: 'silent', reason: `agent_reclaim: ${reason}` });
    store.state.nextAt = toIso(Date.now() + nextGapMs(config));
    store.persist();
    log('info', `本轮不开口：${reason}`);
  };

  /**
   * 把 prompt 投进目标会话。
   *
   * 复用 dsh-proactive 的做法：live agent 直接 followup；冷会话先 resume，
   * resume 时必须把会话自己的 preset mount 回去，否则 agent 只剩 host-plane
   * 工具（bash/read 全报 unknown tool）。
   */
  const deliver = async ({ prompt }) => {
    const sessionId = targetSessionId;
    if (sessionId === '') {
      log('warn', '没有配置 target.sessionId，跳过投递');
      return 'failed';
    }
    const live = ctx.agents.get(sessionId);
    let handle = null;
    let agent = live;
    let composed = false;
    if (agent === undefined) {
      const presets = ctx.get('agentPresets', false);
      const resolvePreset = () => {
        const session = agent?.session;
        if (session === undefined) return undefined;
        const events = Array.isArray(session.events) ? session.events : typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index];
          if (event?.type === 'agent-preset/selected') return event.data?.agentPreset;
        }
        return session.header?.agentPreset;
      };
      handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        setup: async (agentCtx, resumed) => {
          agent = resumed;
          composed = true;
          if (presets === undefined || typeof presets.mount !== 'function') return;
          const presetId = resolvePreset();
          if (presetId !== undefined) await presets.mount(agentCtx, presetId);
        }
      });
      agent = handle?.agent ?? agent;
    }
    if (agent === undefined) {
      log('warn', `无法获得会话 ${sessionId} 的 agent`);
      return 'failed';
    }

    const message = { role: 'user', content: [{ type: 'text', text: prompt }] };
    let claimed = false;
    try {
      claimed = await agent.runMaintenance(() => {
        agent.followup(message);
        return Promise.resolve(true);
      });
    } catch (error) {
      log('warn', `投递被拒（可能正忙）：${error instanceof Error ? error.message : String(error)}`);
      claimed = false;
    }
    if (!claimed) {
      if (handle !== null) {
        try {
          handle.dispose?.();
        } catch {
          // 释放失败不影响后续重试。
        }
      }
      return 'silent';
    }
    try {
      await agent.whenIdle();
    } catch (error) {
      log('warn', `等待回合结束失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (handle !== null) {
      try {
        handle.dispose?.();
      } catch {
        // 同上。
      }
    }
    return 'sent';
  };

  let timer = null;
  let stopped = false;
  let running = false;

  const schedule = (delayMs) => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    const wait = Math.max(1_000, Math.min(2_147_483_647, Math.round(delayMs)));
    timer = setTimeout(() => {
      timer = null;
      void loop();
    }, wait);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const loop = async () => {
    if (stopped || running) return;
    running = true;
    try {
      // 出门看一眼：不看闹钟，看好奇心涨到哪儿了。
      // 看完把好奇心压下去，省得下一个 tick 又想出去。
      // 安静时段不出门：素材回来也会被 tick 的安静闸门丢掉，白跑一趟还白降好奇心。
      let external = [];
      if (config.external.enabled && biliCli !== '') {
        try {
          intent.advanceDrives(Date.now());
          const zone = Number.isFinite(config.quietHours.timeZone) && config.quietHours.timeZone !== ''
            ? config.quietHours.timeZone
            : localZoneOffsetMinutes(Date.now());
          const verdict = isInQuietHours(Date.now(), config, zone)
            ? { glance: false, reason: 'quiet_hours' }
            : shouldGlance(intent.state.drives, {
              lastGlanceAt: lastGlanceAt(glancePath),
              now: Date.now(),
              threshold: config.external.threshold,
              gapMs: config.external.gapMinutes * 60_000
            });
          if (verdict.glance) {
            // 看什么：配置里的 lanes + 我自己想弄明白的问题（从念头账本里取）。
            const queries = config.external.topics.enabled
              ? topicQueries(intent.ledger.open(Date.now()), {
                limit: config.external.topics.limit,
                maxChars: config.external.topics.maxQueryChars
              })
              : [];
            const seen = await glance({
              cli: biliCli,
              log,
              lanes: config.external.lanes,
              topics: { queries, order: config.external.topics.order, size: config.external.topics.size },
              maxItems: config.external.maxItems,
              perLane: config.external.perLane,
              cmdTimeoutMs: config.external.cmdTimeoutMs
            });
            external = seen.materials;
            recordGlance(glancePath, { materials: seen.materials, sources: seen.sources, at: Date.now() });
            if (seen.materials.length > 0) {
              intent.satisfy('curiosity', 1);
              intent.persist();
              log('info', `[glance] 出去看了一眼：${seen.sources.join('+')}，${seen.materials.length} 条`);
            }
          } else {
            log('info', `[glance] 没出去：${verdict.reason}`);
          }
        } catch (error) {
          log('warn', `[glance] 出门失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const result = await withTimeout(runTick({
        store,
        config,
        deliver,
        log,
        sessionLogPath: sessionLogPathOf(ctx, targetSessionId, join(config.dataDir, 'logcache'), log),
        thoughtsPath: join(config.dataDir, 'thoughts.jsonl'),
        external
      }), tickTimeoutMs);
      if (result?.nextAt !== undefined) store.state.nextAt = result.nextAt;
      const nextAtMs = Date.parse(store.state.nextAt);
      const delay = Number.isFinite(nextAtMs) ? nextAtMs - Date.now() : nextGapMs(config);
      log('info', `tick → ${result?.decision ?? 'unknown'}${result?.reason !== undefined ? `(${result.reason})` : ''}，下次 ${store.state.nextAt || toIso(Date.now() + delay)}`);
      schedule(delay);
    } catch (error) {
      log('warn', `tick 失败：${error instanceof Error ? error.message : String(error)}`);
      schedule(busyRetryMs);
    } finally {
      running = false;
      store.persist();
    }
  };

  // 注册工具：每个 root agent 一次（含之后才出现的）。
  const registered = new WeakSet();
  const service = {
    state: stateView,
    goals: (limit) => store.recentGoals(limit),
    reclaim,
    patchConfig,
    intentions: ({ status = 'open', kind = '', limit = 10 } = {}) => {
      const now = Date.now();
      const all = intent.ledger.all();
      return all
        .filter((r) => (status === 'all' ? true : r.status === status))
        .filter((r) => (kind === '' ? true : r.kind === kind))
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          text: r.text,
          drive: r.drive,
          weight: r.weight,
          value: Number(intent.ledger.valueOf(r, now).toFixed(3)),
          createdAt: toIso(r.createdAt),
          lastTouchedAt: toIso(r.lastTouchedAt),
          attempts: r.attempts
        }))
        .slice(0, limit);
    },
    noteIntention: (input) => {
      const result = intent.ledger.add(input);
      log('info', `[念头] 记下：${input.text.slice(0, 40)}${result.merged ? '（合并）' : ''}`);
      return result;
    },
    /** 看念头动过手之后的记录（最近 N 条，倒序）。文件不存在就是空。 */
    runs: (limit = 10) => {
      const rows = readJsonl(join(config.dataDir, 'intent-runs.jsonl'), Math.max(1, Math.min(200, Number(limit) || 10)));
      return rows.reverse();
    }
  };
  const registerOne = (agent) => {
    if (registered.has(agent)) return;
    if (!ctx.agents.roots().includes(agent)) return;
    registered.add(agent);
    try {
      registerPurposeTools(agent.ctx, agent, service);
    } catch (error) {
      log('warn', `注册工具失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const stopCreated = ctx.on('agent/created', ({ agent }) => {
    registerOne(agent);
    return undefined;
  });
  for (const existing of ctx.agents.roots()) registerOne(existing);

  // 排第一次：如果 state 里已有 nextAt 就用它，否则按 firstDelay 起算。
  const parsed = Date.parse(store.state.nextAt);
  const firstDelay = Number.isFinite(parsed)
    ? Math.max(1_000, parsed - Date.now())
    : config.firstDelaySeconds * 1000;
  store.state.nextAt = toIso(Date.now() + firstDelay);
  store.persist();
  log('info', `started: dataDir=${config.dataDir} target=${targetSessionId || '（未配置）'} gap=${config.minGapSeconds}~${config.maxGapSeconds}s quiet=${config.quietHours.start}-${config.quietHours.end}`);
  schedule(firstDelay);

  // ── 念头机制：驱动 + 账本 + 打分，够了才动手。
  //
  // 两层闸门：
  //   1. config.intent.execute —— 总闸，默认 false，只有沫沫点头才开
  //   2. intent-worker.js 里的 shouldExecute —— 分数要过自主阈值、风险类别要在白名单里
  // 任何一边不放行，都只写日志、报告，不动手。
  const workerConfig = resolveWorkerConfig(config.intent.worker);

  /**
   * 开一个独立会话干活。
   *
   * 用 ctx.agents.create 而不是往当前会话塞 followup：worker 有自己的一次性会话，
   * 干完就 dispose，不污染主对话，也不会把结果当成用户消息发出去。
   *
   * 拿不到默认模型就直接失败——宁可这次不动手，也不要瞎猜一个模型名。
   */
  const createWorker = async ({ prompt, maxSteps, timeBoxMs }) => {
    const defaultModel = ctx.get('agentDefaultModel', false);
    const selection = typeof defaultModel?.currentSelection === 'function'
      ? defaultModel.currentSelection()
      : undefined;
    if (selection === undefined || selection === null || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
      throw new Error('拿不到默认模型选择，跳过这次动手');
    }

    const presets = ctx.get('agentPresets', false);
    const handle = await ctx.agents.create({
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {})
      },
      setup: async (agentCtx) => {
        // 跟主会话一样：不 mount preset 就只有 host-plane 工具，read/write 全报 unknown。
        if (presets === undefined || typeof presets.mount !== 'function') return;
        if (typeof config.intent.workerPreset === 'string' && config.intent.workerPreset !== '') {
          await presets.mount(agentCtx, config.intent.workerPreset);
        }
      },
      meta: { origin: 'dsh-purpose', maxSteps }
    });

    try {
      handle.agent.followup({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin:dsh-purpose' }
      });
      const timer = setTimeout(() => {
        try {
          handle.agent.cancel?.('time-box');
        } catch {
          // 取消失败无所谓，下面 whenIdle 会等它自己停。
        }
      }, Math.max(10_000, Number(timeBoxMs) || 600_000));
      if (typeof timer.unref === 'function') timer.unref();
      try {
        await handle.agent.whenIdle();
      } finally {
        clearTimeout(timer);
      }
      return { text: '', steps: 0 };
    } finally {
      try {
        handle.dispose?.();
      } catch {
        // 释放失败不影响记账。
      }
    }
  };

  const executor = new IntentExecutor({
    createWorker,
    runsPath: join(config.dataDir, 'intent-runs.jsonl'),
    log
  });

  /** 念头评估的定时器与串行锁（跟投递心跳那套分开，互不阻塞）。 */
  let intentTimer = null;
  let intentRunning = false;

  const intentTick = async () => {
    if (stopped || intentRunning) return;
    intentRunning = true;
    try {
      const result = intent.evaluate({
        config: {
          minTension: config.intent.minTension,
          intentThreshold: config.intent.threshold,
          intentAutonomousThreshold: config.intent.autonomousThreshold
        },
        log,
        wakeupsLastHour: store.wakeupsLastHour(Date.now()),
        maxWakeupsPerHour: config.maxWakeupsPerHour
      });

      // 分数够格了，分三种情况：
      //   1. 总闸开着 + 风险低 → 直接开工
      //   2. 总闸开着但风险高 → 不自己动手，改成问她（并说明可能后果）
      //   3. 总闸关着 → 问她
      const qualified = result?.decision === 'act' && result.chosen !== null;
      let ran = false;
      if (qualified && config.intent.execute) {
        const verdict = executor.canExecute(result.chosen, {
          workerConfig,
          autonomousThreshold: config.intent.autonomousThreshold
        });
        if (verdict.execute) {
          ran = true;
          const outcome = await executor.run(result.chosen, {
            workerConfig,
            autonomousThreshold: config.intent.autonomousThreshold,
            workspaceRoot: process.cwd()
          });
          intent.settle(result, outcome);
          log('info', `[念头] ${outcome.ok === true ? '做完' : '没做成'}：${result.chosen.text.slice(0, 30)}`);
        } else {
          // 风险太高或类别不在白名单：不是压下去，是拿去问她。
          log('info', `[念头] 够格但不能自己动手（${verdict.reason}），改成问她`);
        }
      }
      if (qualified && !ran && (config.intent.askWhenQualified || config.intent.execute)) {
        // 够格但不自己动手：不发呆在日志里，直接开口问她一句要不要做。
        // 同一条念头问过就不再问，两次追问之间也隔着 MIN_ASK_GAP_HOURS。
        const gate = intent.shouldAsk(result);
        if (gate.ask) {
          const outcome = await deliver({ prompt: buildAskPrompt(result.chosen) });
          if (outcome === 'sent') {
            intent.markAsked(result.chosen.id);
            log('info', `[念头] 够格，已开口问：${result.chosen.text.slice(0, 30)}`);
          } else {
            log('warn', `[念头] 够格，但没问出去（${outcome}）：${result.chosen.text.slice(0, 30)}`);
          }
        } else {
          log('info', `[念头] 够格但暂不追问（${gate.reason}）：${result.chosen.text.slice(0, 30)}`);
        }
      }
    } catch (error) {
      log('warn', `念头评估失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      intentRunning = false;
      if (!stopped && config.intent.enabled) {
        intentNextAt = Date.now() + config.intent.tickSeconds * 1000;
        intentTimer = setTimeout(() => {
          intentTimer = null;
          void intentTick();
        }, config.intent.tickSeconds * 1000);
        if (typeof intentTimer.unref === 'function') intentTimer.unref();
      }
    }
  };
  if (config.intent.enabled) {
    intentNextAt = Date.now() + config.intent.tickSeconds * 1000;
    intentTimer = setTimeout(() => {
      intentTimer = null;
      void intentTick();
    }, config.intent.tickSeconds * 1000);
    if (typeof intentTimer.unref === 'function') intentTimer.unref();
    log('info', `念头机制已启动：每 ${config.intent.tickSeconds}s 评估一次，execute=${config.intent.execute ? 'on' : 'off（只记日志）'}`);
  }

  return async () => {
    stopped = true;
    stopCreated();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (intentTimer !== null) {
      clearTimeout(intentTimer);
      intentTimer = null;
    }
    store.persist();
    log('info', 'stopped.');
  };
}

/** 给 tick 加超时，避免某个 suspend 挂死整个循环。 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tick 超过 ${ms}ms 未完成`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * 目标会话的日志路径，**返回能直接读的明文 jsonl**（能取到就取，取不到返回空串）。
 *
 * persistence.pathOf 给的是 `.jsonl.zstd`，本机 node 24 有 zstdDecompressSync，
 * 解压到 <dataDir>/logcache/<sessionId>.jsonl 后复用 60 秒。
 */
function sessionLogPathOf(ctx, sessionId, cacheDir, log = () => undefined) {
  if (sessionId === '') return '';
  const home = process.env.DSH_HOME ?? `${process.env.HOME ?? '.'}/.dsh`;
  const persistence = ctx.get('sessionPersistence', false);
  if (persistence !== undefined && typeof persistence.pathOf === 'function') {
    try {
      const path = persistence.pathOf(sessionId);
      if (typeof path === 'string' && path !== '') return materializeSessionLog(path, cacheDir, { log });
    } catch {
      // 忽略：退回下面的兜底路径。
    }
  }
  return resolveSessionLog(home, sessionId, cacheDir, { log });
}

function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 落盘前去掉运行时字段（config 里可能有 quietHours 之外的东西）。 */
function serializable(config) {
  return {
    enabled: config.enabled,
    minGapSeconds: config.minGapSeconds,
    maxGapSeconds: config.maxGapSeconds,
    quietHours: config.quietHours,
    maxDeliveriesPerDay: config.maxDeliveriesPerDay,
    maxWakeupsPerHour: config.maxWakeupsPerHour,
    scoreThreshold: config.scoreThreshold,
    dedupeSimilarity: config.dedupeSimilarity,
    maxAttemptsPerGoal: config.maxAttemptsPerGoal,
    goalCooldownSeconds: config.goalCooldownSeconds,
    materialWindowHours: config.materialWindowHours,
    firstDelaySeconds: config.firstDelaySeconds,
    confidence: config.confidence,
    maxMaterials: config.maxMaterials,
    maxMaterialChars: config.maxMaterialChars,
    // 驱动调参与循环节奏同理：漏掉就会被一次 patchConfig 抹回默认。
    drives: config.drives,
    timeouts: config.timeouts,
    intent: config.intent,
    // 外部素材源也要落盘：patchConfig 会整份重写 config.json，
    // 漏掉这一段等于「改一次设置就把 lanes 抹回默认」。
    external: config.external,
    target: { sessionId: config.target?.sessionId ?? '' }
  };
}
