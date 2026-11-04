import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUARDED_RISK_CLASSES,
  IntentExecutor,
  SAFE_RISK_CLASSES,
  WORKER_DEFAULTS,
  buildWorkerPrompt,
  resolveWorkerConfig,
  shouldExecute
} from '../src/intent-worker.js';

function chosen(over = {}) {
  return {
    id: 'i1',
    text: '把会话日志的解压逻辑整理成一个小模块',
    kind: 'unfinished',
    drive: 'curiosity',
    score: 0.8,
    risk: 0.3,
    riskClass: 'write_workspace',
    ...over
  };
}

test('resolveWorkerConfig 只认已知字段并过滤风险类别', () => {
  const config = resolveWorkerConfig({ maxSteps: 5, timeBoxMs: 30_000, allowedRiskClasses: ['read', '瞎写', 'research'], 乱来: 1 });
  assert.equal(config.maxSteps, 5);
  assert.equal(config.timeBoxMs, 30_000);
  assert.deepEqual(config.allowedRiskClasses, ['read', 'research']);
  assert.equal('乱来' in config, false);
});

test('resolveWorkerConfig 空输入退回默认值', () => {
  const config = resolveWorkerConfig();
  assert.equal(config.maxSteps, WORKER_DEFAULTS.maxSteps);
  assert.deepEqual([...config.allowedRiskClasses], [...WORKER_DEFAULTS.allowedRiskClasses]);
});

test('resolveWorkerConfig 风险类别全是垃圾时退回白名单默认，不会变成空表', () => {
  const config = resolveWorkerConfig({ allowedRiskClasses: ['publish', 'install'] });
  // publish/install 不在已知集合里，过滤后为空 → 退回默认安全集合。
  assert.deepEqual(config.allowedRiskClasses, [...SAFE_RISK_CLASSES]);
});

test('shouldExecute 没有念头就不动', () => {
  assert.equal(shouldExecute(null).execute, false);
  assert.equal(shouldExecute(null).reason, 'no_intention');
});

test('shouldExecute 总闸关了就不动', () => {
  const verdict = shouldExecute(chosen(), { workerConfig: { ...WORKER_DEFAULTS, enabled: false } });
  assert.equal(verdict.execute, false);
  assert.equal(verdict.reason, 'worker_disabled');
});

test('shouldExecute 分数不够高不动', () => {
  const verdict = shouldExecute(chosen({ score: 0.5 }), { workerConfig: { ...WORKER_DEFAULTS, enabled: true } });
  assert.equal(verdict.execute, false);
  assert.match(verdict.reason, /^below_autonomous/);
});

test('shouldExecute 风险过高不动', () => {
  const verdict = shouldExecute(chosen({ risk: 0.85, riskClass: 'write_outside' }), {
    workerConfig: { ...WORKER_DEFAULTS, enabled: true }
  });
  assert.equal(verdict.execute, false);
  assert.match(verdict.reason, /^risk_too_high/);
});

test('shouldExecute 风险类别不在白名单不动', () => {
  const verdict = shouldExecute(chosen({ risk: 0.7, riskClass: 'publish' }), {
    workerConfig: { ...WORKER_DEFAULTS, enabled: true }
  });
  assert.equal(verdict.execute, false);
  assert.ok(/risk_class_not_allowed|risk_too_high/.test(verdict.reason));
});

test('shouldExecute 三项都过才动手', () => {
  const verdict = shouldExecute(chosen(), { workerConfig: { ...WORKER_DEFAULTS, enabled: true } });
  assert.equal(verdict.execute, true);
  assert.equal(verdict.reason, 'autonomous');
});

test('shouldExecute 守卫类风险永远不放行', () => {
  for (const riskClass of GUARDED_RISK_CLASSES) {
    // 就算配置里显式写了，resolveWorkerConfig 也会把它过滤掉。
    const config = resolveWorkerConfig({ enabled: true, allowedRiskClasses: [...SAFE_RISK_CLASSES, riskClass] });
    assert.equal(config.allowedRiskClasses.includes(riskClass), false, `${riskClass} 不该留在白名单里`);
    const verdict = shouldExecute(chosen({ risk: 0.1, riskClass }), { workerConfig: config });
    assert.equal(verdict.execute, false, `${riskClass} 不该被放行`);
  }
});

test('buildWorkerPrompt 把三条硬约束写进正文', () => {
  const prompt = buildWorkerPrompt(chosen(), { maxSteps: 7, workspaceRoot: '/tmp/ws' });
  assert.match(prompt, /只做这一件事/);
  assert.match(prompt, /不对外发任何东西/);
  assert.match(prompt, /最多 7 步/);
  assert.match(prompt, /\/tmp\/ws/);
  assert.match(prompt, /不要给任何人发消息汇报/);
});

test('buildWorkerPrompt 带上念头本身，别让 worker 自己猜', () => {
  const prompt = buildWorkerPrompt(chosen());
  assert.match(prompt, /把会话日志的解压逻辑整理成一个小模块/);
  assert.match(prompt, /unfinished/);
  assert.match(prompt, /0.8/);
});

test('IntentExecutor 没有 createWorker 时拒跑', async () => {
  const executor = new IntentExecutor({});
  const outcome = await executor.run(chosen(), { workerConfig: { ...WORKER_DEFAULTS, enabled: true } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.skipped, true);
  assert.equal(outcome.reason, 'no_executor');
});

test('IntentExecutor 成功时返回 ok 与耗时', async () => {
  let received = null;
  const executor = new IntentExecutor({
    createWorker: async (job) => {
      received = job;
      return { text: '整理完了', steps: 4 };
    }
  });
  const outcome = await executor.run(chosen(), { workerConfig: { ...WORKER_DEFAULTS, enabled: true } });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result, '整理完了');
  assert.equal(received.maxSteps, WORKER_DEFAULTS.maxSteps);
});

test('IntentExecutor 抛错也只记账，不往外冒异常', async () => {
  const executor = new IntentExecutor({
    createWorker: async () => {
      throw new Error('模型不可用');
    }
  });
  const outcome = await executor.run(chosen(), { workerConfig: { ...WORKER_DEFAULTS, enabled: true } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, '模型不可用');
});

test('IntentExecutor 跑的时候 worker_busy 挡住并发', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const executor = new IntentExecutor({
    createWorker: async () => {
      await gate;
      return { text: 'done' };
    }
  });
  const running = executor.run(chosen(), { workerConfig: { ...WORKER_DEFAULTS, enabled: true } });
  const second = executor.canExecute(chosen(), { workerConfig: { ...WORKER_DEFAULTS, enabled: true } });
  assert.equal(second.execute, false);
  assert.equal(second.reason, 'worker_busy');
  release();
  await running;
});
