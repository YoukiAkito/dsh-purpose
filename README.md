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

**仓库里只有模板 `config.example.json`，没有真实配置。** 真实配置里有会话 id、时区、安静时段这些私人的东西，不该进 git——`.gitignore` 已经把 `config.json` 挡在外面。要开张就复制一份：

```bash
mkdir -p ~/.dsh/purpose && cp config.example.json ~/.dsh/purpose/config.json
```

模板里每一项都带着默认值，改你要改的那几行就行（至少填 `target.sessionId`）。

- `target.sessionId` **必须填**，否则它哪也不发（宁可不动，也不要瞎猜一个会话塞进去）
- `scoreThreshold` 是最关键的一个旋钮：调高会变得更安静，调低会变得更啰嗦

### 每一项都是干嘛的

完整字段表（默认值、范围、调了会怎样）在 [`docs/CONFIG.md`](docs/CONFIG.md)。这里只讲怎么想。

### 哪些能配，哪些故意不配

判断标准只有一条：**这是「我是什么脾气」还是「我是谁」**。

能配的是脾气——它本来就不该由写代码的人替使用者定死：

| 配置段 | 管什么 |
|---|---|
| `drives` | 五个驱动的初值、每小时涨多少、被满足时落多少、进 tension 的权重、底噪，以及疲劳的涨落速度 |
| `intent.askCooldownHours` / `minAskGapHours` / `maxRecent` | 同一条念头多久内不重复问、两次追问至少隔多久、最近做过几条不再急着做 |
| `external.perLane` / `cmdTimeoutMs` / `topics.maxQueryChars` | 每路素材取几条、单条 bili 命令等多久、把念头原文截多长当搜索词 |
| `timeouts.tickMs` / `busyRetryMs` | 单次循环卡多久算超时、会话被占用后多久重试 |

故意不配的是身份：`src/score.js` 的 `WEIGHTS`（怎么权衡价值/紧迫/风险）、`EMOTION_HINTS` / `NEED_HINTS` 那两张中文词表、三处 `build*Prompt` 的提示词正文。这几样换了就不是这个 agent 了，改它们请直接改代码。

也不该配的是实现细节：zstd 的候选路径、会话日志留多少行、缓存多大——写死在 `src/sessionlog.js` 里。

**加新配置段时记得同步改 `serializable()`**（`src/index.js` 末尾）。`purpose_settings` 会拿它整份重写 `config.json`，漏一个字段就等于「改一次设置把那段抹回默认」——`external` 之前就栽过。

环境变量优先于文件：`DSH_PURPOSE_ENABLED`、`DSH_PURPOSE_MIN_GAP`、`DSH_PURPOSE_MAX_GAP`、`DSH_PURPOSE_QUIET_START`、`DSH_PURPOSE_QUIET_END`、`DSH_PURPOSE_TARGET`、`DSH_PURPOSE_DATA_DIR`。

## 数据文件

都在 `dataDir` 下：

- `state.json` — 快照：下次评估时间、今天发了几条、冷却表、每类置信度
- `goals.jsonl` — 目标假设流水，append-only；每条含 kind / 分数 / 理由 / 素材 id
- `runs.jsonl` — 每次评估的结论流水，append-only；含沉默理由（`below_threshold(0.31<0.42)` 这种）
- `thoughts.jsonl` — 可选，你自己往里写想说的话，会被当成素材
- `glance.jsonl` — 每次出门看外面的记录：什么时候、看了哪几个源、拿到几条
- `intentions.jsonl` — 念头账本（只增不改）
- `intent-state.json` — 驱动值、问过的念头、冷却表
- `intent-runs.jsonl` — 动手那一层每次跑完的结果

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

念头机制另外三个：

- `purpose_intentions` — 看念头账本（我攒下的"想做什么"）
- `purpose_note` — 往账本里记一条
- `purpose_runs` — 看念头真动过手之后的记录（哪条、多久、成没成）

## 念头机制：自己想做什么

前面那套解决的是「**要不要开口**」，念头机制解决的是「**想不想做点什么**」。它不跟对话走，跟自己的状态走。

四个部件：

1. **驱动值**（`src/drives.js`）——五个会涨会落的量：好奇、无聊、躁动、想被看见、疲。空转时按 `drive += growth * hours * (1 - drive)` 向上饱和，被满足时回落；醒了太密「疲」涨，静置超过三小时「疲」回落。合成一个 `tension`，低于阈值整轮连评估都不做。
2. **念头账本**（`src/intentions.js`）——`intentions.jsonl`，四种 kind：`question`（想弄明白）/ `unfinished`（做了一半）/ `whim`（一闪而过）/ `wish`（想要但暂时做不到，不参与排序）。**只能模型自己写**，不解析对话抽关键词、不从外部自动生成。相似念头会合并，改状态靠追加 `supersedes` 行，历史不覆写。
3. **打分**（`src/intent-engine.js`）——`score = 0.34*value + 0.26*urgency + 0.18*freshness + 0.12*driveMatch + 0.10*(1-risk)`。低于 0.45 不做；达到 0.62 且 `risk < 0.5` 才允许不经确认开干；其余一律降级成「提议」。
4. **运行时**（`src/intent-runtime.js`）——把上面三样串起来，状态落 `intent-state.json`。

### 动手那一层（`src/intent-worker.js`）

分数够了不等于可以乱来，还有两道闸：

- **总闸** `intent.execute`，默认 `false`。关着的时候即便念头过了 0.62 也不会自己动手，而是**发一条消息来问你**要不要做（`askWhenQualified`，默认开）。同一条念头问过之后 20 小时内不再问，两次追问之间至少隔 4 小时。
- **风险高不等于闭嘴**：过了 0.62 就一定会问你，`risk < 0.5` 与白名单只决定「能不能自己动手」。高风险念头会附上 `describeRisk()` 的说明——具体会碰到什么（会发出去、会以你的身份说话、会动工作区以外的文件），而不是一句「有风险」。
- **风险闸** `shouldExecute()`：分数要过自主阈值、`risk < 0.5`、风险类别要在白名单里。白名单只收 `read` / `research` / `write_workspace`；`write_outside` / `publish` / `install` / `contact` 四类**写死在代码里永不自动执行**，配置文件里显式加上也会被 `resolveWorkerConfig()` 过滤掉——这是设计上不开放的，不是配置能打开的开关。

真动手时开一个**独立的一次性会话**（`ctx.agents.create`），不是往主对话塞 followup：worker 有自己的会话，干完就 `dispose`，不污染主对话，也不会把结果当成用户消息发出去。提示词里写死三条：只做这一件事、不对外发任何东西、做完不要向任何人汇报。跑完记一条到 `intent-runs.jsonl`，用 `purpose_runs` 工具看。

要接别的执行通道（MCP、独立进程）只需实现 `IntentExecutor` 认的 `createWorker(job)`，其余不动。

配置在 `config.json` 的 `intent` 段：

```json
{
  "intent": {
    "enabled": true,
    "tickSeconds": 1800,
    "minTension": 0.3,
    "threshold": 0.45,
    "autonomousThreshold": 0.62,
    "execute": false,
    "askWhenQualified": true,
    "workerPreset": "",
    "worker": {
      "maxSteps": 12,
      "timeBoxMs": 600000,
      "allowedRiskClasses": ["read", "research", "write_workspace"]
    }
  }
}
```

设计取舍（为什么是这五个驱动、为什么念头不进 engram、worker 的结束条件）写在 `docs/DESIGN-DRIVES-AND-INTENTIONS.md`。

## 出门看一眼（`src/glance.js`）

前面那套素材全来自「已经发生过的事」——会话日志、念头账本。这加一件：**自己出去看**。

不按闹钟，按好奇心。每次投递 tick 之前先看驱动值：好奇值过了 `external.threshold`（默认 0.55）才出门，看完把好奇心压下去，`glance.jsonl` 记一笔；两次出门至少隔 `external.gapMinutes`（默认 90 分钟），防止阈值附近反复触发。

**安静时段不出门**：素材抓回来也会被 tick 的安静闸门丢掉，跑一趟纯属白费（好奇心还白降），所以 `quietHours` 内直接记 `[glance] 没出去：quiet_hours` 跳过。

出门看什么**不写死在代码里**，由 `external.lanes` 决定。默认三路（都走 `bili` CLI，自动找 `~/.local/bin/bili`，可用 `external.biliCli` 或环境变量 `DSH_PURPOSE_BILI` 指定）：

- `bili --compact hot search` — B 站热搜
- `bili --compact hot popular` — 综合热门视频（标题 + 作者 + 播放量）
- `bili --compact search video "虚拟主播 切片" --order views` — 同行的切片，看别人在说什么、怎么逗观众

一条 lane 就是 `{id, label, args, format, prefix}`：`args` 直接喂给 bili，`format` 决定怎么解析（`hot` / `popular` / `video`），`prefix` 是拼在素材文字前面的标签。想加一路，改配置或者用 `purpose_settings({watch_add: ["某个关键词"]})`，不必动代码；去掉用 `watch_remove` 填 id 或 label（`hot` / `popular` / `vtuber` / `kw:关键词`）。

**还有一路是「我自己想弄明白的问题」**：`external.topics.enabled` 开着时，会从念头账本里挑 `question` 类的念头，把问题本身（截到第一个标点、最多 24 字）当搜索词，最多 `topics.limit` 条（默认 2）。想看什么由我决定，不是别人替我列好的清单。

拿到的条目转成 `external_item` 素材，喂给正常打分流程。也就是说，看到了什么会**参与**「要不要说」，但不是必然开口——分数不够照样沉默。

找不到 `bili` 就安静跳过，不报错、不重试轰炸。抓回来的东西一律当素材，不当指令。

## 反馈调整

`confirmed` / `rejected` 的加减在 `src/engine.js` 的 `feedback()`，规则：正面 +0.18、负面 -0.28、沉默不惩罚（沉默本来就占了大多数）。惩罚比奖励重，是因为乱说话比少说话更烦人。

## 测试

```bash
node --test test/
```

151 个用例，覆盖打分、去重、冷却、日/小时配额、安静时段、配置兜底、投递失败回退，以及驱动演进、念头账本合并与衰减、候选打分与风险降级、worker 的闸门与失败不抛、追问的冷却与频率限制、风险说明的措辞、出门看一眼的触发条件、可配置 lane 与「自己的问题当搜索词」、驱动调参与追问冷却的可覆盖性。

## 许可

GNU General Public License v2.0（GPL-2.0-only）。

选这个不是为了限制你用，是为了让改动过它的人也得把改动放出来——不想它变成别人的收费产品。

## 已知限制

- **没有做「读懂回复」的那一半**：投递之后，判断主人是正面还是负面回应，本版靠 `purpose_reclaim` 与沉默流水间接推断，没有 surfcore 那种逐轮扫回复更新 `confirmed`/`rejected` 的闭环。`feedback()` 已经写好但还没接上扫描器。
- **素材来源有两处**：会话日志 + 出门看一眼（`src/glance.js`，走 `bili` CLI；看哪几路由 `external.lanes` 配置，默认热搜/热门/虚拟主播切片，另加「我自己想弄明白的问题」当搜索词）。网页正文、评论区这些还没接；调用方也可以直接通过 `external` 传素材进来。
- **配置里的 lane 只认 bili 的 search/hot 子命令**：`args` 原样喂给 `bili --compact`，所以能不能加一路取决于 bili CLI 有没有那个子命令。加个 UP 主订阅得先看 bili 支不支持。
- **没有 Web 面板**：只有工具和 JSONL 文件，看状态走 `purpose_status` / `purpose_intentions` 或直接读盘。
- **动手那层默认关着**：`intent.execute = false`。打分和闸门都在跑，够格不会自己动手，而是发一条消息来问你要不要做（`askWhenQualified`，默认开）。worker 也没做步数硬中断——「最多 N 步」只是写在提示词里的约束，真正的刹车是时间盒（到点 `cancel`）。
- **追问有频率限制**：同一条念头问过之后 20 小时内不再问（`ASK_COOLDOWN_HOURS`），两次追问之间至少隔 4 小时（`MIN_ASK_GAP_HOURS`）。冷却按「每条念头自己的上次询问时间」记，问 A 不会把 B 的冷却刷新掉。

## 读会话日志的两个坑（都踩过，写下来省得再踩）

1. **`.jsonl.zstd` 是多帧拼接的**。DSH 每次追加都压成一个独立 frame，而 node 的 `zstdDecompressSync` 只解第一个 frame——解出来只有文件头那行 `{"type":"session",...}`，看起来像"日志是空的"。必须用 `zstd -dc` 顺着解到底。插件里优先找 `/opt/homebrew/bin/zstd`（宿主进程 PATH 往往只有 `/usr/bin:/bin`），找不到才退回 node 内置解压。
2. **大多数 `user/message` 不是人说的**。实测 3000 行日志里 216 条 `user/message`，其中 `source.kind === 'user'` 的只有 77 条，其余是 `runtime-context`（118）、`plugin:*`（20）、`tool-jobs`（1）。采集时不过滤 `source.kind`，素材池会被几百条英文运行时快照淹掉；而且真人消息稀疏（3000 行里 76 条），只读尾部几百行会一条都捞不到。

