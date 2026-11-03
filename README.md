# dsh-purpose

给 DSH agent 装一个「目的机制」：不是等着被叫，而是自己攒素材、自己提目标、自己打分，够了才开口。

这个名字对得上它做的事——不是定时器，是**先有目的，才决定要不要说话**。

```
素材收集 → 信号汇总 → 目标假设 → 打分 → 选一条 → 投递 → 按反馈调权重
```

## 跟 dsh-proactive 的区别

| | dsh-proactive | dsh-purpose |
|---|---|---|
| 什么时候醒 | 你设的闹钟（cron / 间隔） | 自己算的间隔（40~150 分钟随机） |
| 醒来说什么 | 一句固定提示，让它自己看 | 一段带素材和打分的提示，说明"为什么现在找你" |
| 说不说 | 模型自己决定 | 先过阈值，不够就直接沉默，连醒都不醒 |
| 会不会重复 | 不管 | 同类目标冷却 6 小时 + 文本相似度去重 |
| 有没有反馈 | 没有 | 每类目标记置信度，被冷落的降权 |

两个不能一起开——会互相抢唤醒、把同一个会话挤成两班倒。

## 安装

```bash
cd ~/.dsh/profiles/desktop
"<dsh 内置 node>" "<dsh 内置 pnpm>" add dsh-purpose
```

装完两件事：

1. 往 `package.json` 的 `dsh.profile.bundles` 里加 `"dsh-purpose"`（`pnpm add` 只改 `dependencies`，不改 bundles）
2. 整个 DSH 退出重开（插件不是热载的）

**Windows 暂不支持**：本版按 POSIX 写路径与进程管理，`apply()` 在 win32 上会直接抛错退出，不会半死不活地跑。

## 配置

`<dataDir>/config.json`，缺省 `dataDir = $DSH_HOME/purpose`（没设 `DSH_HOME` 时是 `~/.dsh/purpose`）。

```json
{
  "enabled": true,
  "minGapSeconds": 2400,
  "maxGapSeconds": 9000,
  "quietHours": { "start": "07:00", "end": "17:00", "timeZone": "" },
  "maxDeliveriesPerDay": 12,
  "maxWakeupsPerHour": 6,
  "scoreThreshold": 0.42,
  "target": { "sessionId": "" }
}
```

- `target.sessionId` **必须填**，否则它哪也不发（宁可不动，也不要瞎猜一个会话塞进去）
- `quietHours.timeZone` 留空 = 用本机时区偏移
- `scoreThreshold` 是最关键的一个旋钮：调高会变得更安静，调低会变得更啰嗦

环境变量优先于文件：`DSH_PURPOSE_ENABLED`、`DSH_PURPOSE_MIN_GAP`、`DSH_PURPOSE_MAX_GAP`、`DSH_PURPOSE_QUIET_START`、`DSH_PURPOSE_QUIET_END`、`DSH_PURPOSE_TARGET`、`DSH_PURPOSE_DATA_DIR`。

## 数据文件

都在 `dataDir` 下：

- `state.json` — 快照：下次评估时间、今天发了几条、冷却表、每类置信度
- `goals.jsonl` — 目标假设流水，append-only；每条含 kind / 分数 / 理由 / 素材 id
- `runs.jsonl` — 每次评估的结论流水，append-only；含沉默理由（`below_threshold(0.31<0.42)` 这种）
- `thoughts.jsonl` — 可选，你自己往里写想说的话，会被当成素材

想看"为什么它没说话"，grep `runs.jsonl` 就行——每个沉默都有 reason。

## 五个假设

每次评估最多提五类目标，各算一个分：

| kind | 什么时候提 | 大致逻辑 |
|---|---|---|
| `follow_up_user` | 主人有消息且沉默久了 | 越久越紧迫，对方语气越强价值越高 |
| `group_thread` | 最近有群消息 | 群的风险最高（可能打扰无关的人） |
| `external_share` | 有外部素材 | 看到的新闻/视频，攒够几条才值得说 |
| `own_thought` | 有 `thoughts.jsonl` 条目 | 我自己的想说的 |
| `active_topic_advance` | 有挂着没聊完的话题 | 推进一个已经开始的话题 |

分数：`value*0.42 + urgency*0.33 - risk*0.30`，再乘一个由历史置信度决定的小系数（0.5 时不缩放）。权重写死在 `src/score.js` 的 `WEIGHTS` 里，不开放配置——改行为请改 `confidence` 的 reward / penalty，别动权重。

## 四个工具

装上之后模型能自己用：

- `purpose_status` — 看当前节奏（下次什么时候、今天发了几条、各类置信度）
- `purpose_goals` — 看最近提过哪些假设、多少分、为什么没发
- `purpose_reclaim` — 这一轮不打算开口，记下理由安静收手
- `purpose_settings` — 改间隔 / 阈值 / 日上限 / 安静时段

## 反馈调整

`confirmed` / `rejected` 的加减在 `src/engine.js` 的 `feedback()`，规则：正面 +0.18、负面 -0.28、沉默不惩罚（沉默本来就占了大多数）。惩罚比奖励重，是因为乱说话比少说话更烦人。

## 测试

```bash
node --test test/
```

35 个用例，覆盖打分、去重、冷却、日/小时配额、安静时段、配置兜底、投递失败回退。

## 许可

MIT

## 已知限制

- **没有做「读懂回复」的那一半**：投递之后，判断主人是正面还是负面回应，本版靠 `purpose_reclaim` 与沉默流水间接推断，没有 surfcore 那种逐轮扫回复更新 `confirmed`/`rejected` 的闭环。`feedback()` 已经写好但还没接上扫描器。
- **素材只读会话日志**：B 站/网页那类外部素材要调用方通过 `external` 传进来，插件不会自己去抓。
- **没有 Web 面板**：只有四个工具和三个 JSONL 文件，看状态走 `purpose_status` 或直接读盘。
