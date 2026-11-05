# 配置参考

配置文件：`<dataDir>/config.json`，`dataDir` 默认 `$DSH_HOME/purpose`（没设 `DSH_HOME` 时是 `~/.dsh/purpose`）。

模板见仓库根目录的 `config.example.json`，每一项都带着默认值：

```bash
mkdir -p ~/.dsh/purpose && cp config.example.json ~/.dsh/purpose/config.json
```

**优先级：环境变量 > `config.json` > 内置默认值。** 缺字段一律回落默认值，写错的字段会被夹回合法区间，不会让插件起不来。

两条通用约定：

- **不用「关掉」来表达意图。** 把阈值调高、把间隔调长，比直接 `enabled: false` 更接近「我今天不想说话」；彻底关掉是给卸载前用的。
- **加新配置段必须同步改 `src/index.js` 末尾的 `serializable()`。** `purpose_settings` 会拿它整份重写 `config.json`，漏一个字段就等于「改一次设置把那段抹回默认」。

---

## 顶层：什么时候开口

| 字段 | 默认 | 管什么 | 调了会怎样 |
|---|---|---|---|
| `enabled` | `true` | 总开关 | `false` = 插件加载后直接退出，什么都不跑 |
| `dataDir` | `""` | 数据目录；空 = `$DSH_HOME/purpose` | 换目录等于换一份记忆，旧的不再读 |
| `minGapSeconds` | `2400` | 两次投递之间至少隔多少秒 | 调大 = 更安静 |
| `maxGapSeconds` | `9000` | 强制上限：再懒也不能拖过这么久 | 调小 = 至少这么频繁有一次评估 |
| `maxDeliveriesPerDay` | `12` | 每日最多投递几条（含被拒绝的尝试） | 调成 0 = 今天彻底不开口 |
| `maxWakeupsPerHour` | `6` | 每小时最多唤醒几次，防抖 | 调小 = 不容易被连着唤醒 |
| `firstDelaySeconds` | `600` | 启动后隔多久做第一次评估 | 调 0 = 开机就想说话（不建议） |
| `materialWindowHours` | `24` | 收集最近多少小时的活动当素材 | 调大 = 会翻更旧的聊天记录 |
| `scoreThreshold` | `0.42` | 打分低于此值就不投递 | **最关键的旋钮**：调高变安静，调低变啰嗦 |
| `dedupeSimilarity` | `0.72` | 与历史投递相似度超过此值算重复，直接丢 | 调低 = 更容易判成复读，话说得更少但更新 |

### `quietHours`：安静时段

| 字段 | 默认 | 说明 |
|---|---|---|
| `start` / `end` | `07:00` / `17:00` | 24 小时制 `HH:MM`；支持跨零点（如 `23:00`–`08:00`） |

时段一律按**本机时区**算，没有时区参数——放别处跑就改本机时区，别在配置里指定。

**窗内不投递，也不出门看一眼**（出门抓回来的素材会被安静闸门丢掉，白跑一趟还白降好奇心）。所以这个窗应该设成「对方在睡觉、我该闭嘴」的那一段，不是「我不活跃」的那一段。

### `confidence`：反馈学习

对方回了话就等于正反馈，不理你就等于负反馈，长期沉默算衰减。这几项决定学得多快。

| 字段 | 默认 | 说明 |
|---|---|---|
| `reward` | `0.18` | 正面反馈时该假设的置信度增量 |
| `penalty` | `0.28` | 负面反馈时的减量（比奖励大，说明宁可少说） |
| `silenceDecay` | `0.06` | 沉默时的缓慢衰减 |
| `min` / `max` | `0.05` / `0.95` | 置信度上下限，防止锁死在 0 或 1 |

### 素材拼装

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxMaterials` | `24` | 单次评估最多把几条素材拼进提示词（控 token） |
| `maxMaterialChars` | `220` | 每条素材最长多少字符，超出截断 |

---

## `drives`：五个驱动值的调参

这是「脾气」的核心。五个驱动是 `curiosity`（好奇）、`boredom`（无聊）、`restlessness`（躁动）、`pride`（想被看见）、`fatigue`（疲）。它们只影响「要不要开一个自己的回合」，**绝不直接触发对外动作**。

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaults` | `{curiosity:0.42, boredom:0.20, restlessness:0.10, pride:0.15, fatigue:0.05}` | 初始值：刚醒来有点好奇、有点闲，但不算躁动 |
| `growthPerHour` | `{0.16, 0.22, 0.10, 0.05, 0}` | 空转时每小时涨多少。公式 `drive += rate * hours * (1 - drive)`，越接近 1 涨得越慢，永不溢出 |
| `satisfyRate` | `{0.45, 0.50, 0.60, 0.40, 0}` | 被满足一次时回落多少（乘 `(1 - rate)`） |
| `tensionWeight` | `{0.32, 0.24, 0.22, 0.12, -0.30}` | 进 tension 的权重。**`fatigue` 是负的**——越累越不想动 |
| `tensionFloor` | `0.35` | tension 的底噪，让「什么都没干」也有机会开口。调低 = 更钝，调高 = 更容易被推动 |
| `frustrateAmount` | `0.12` | 被拒绝/被跳过时 `restlessness` 反弹多少 |
| `fatigueGrowthPerHour` | `0.20` | 疲劳每小时涨多少（会乘以唤醒负载 `wakeupsLastHour / maxWakeupsPerHour`） |
| `fatigueRestAfterHours` | `3` | 静置超过这么多小时，疲劳开始回落 |
| `fatigueRestPerHour` | `0.12` | 静置时每小时回落多少 |
| `maxHours` | `48` | 单次演进最多算多少小时，防止停机一周后一口气涨满 |

调参手感：

- 觉得「太躁、话太多」→ 降 `growthPerHour`，或降 `tensionFloor`。
- 觉得「太钝、从不主动」→ 升 `tensionFloor`，或升 `growthPerHour`。
- 觉得「老是想同一类事」→ 升对应的 `satisfyRate`，让它被满足一次就落下去。

表里写了未知的键（比如手滑多打一个字母）会被丢掉，不会凭空多出一个驱动；但**已有的键写错值会被夹回区间**，不会报错——所以调完最好看一眼 `purpose_status` 里的实际驱动值。

---

## `timeouts`：循环节奏

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `tickMs` | `120000` | 5000–1800000 | 单次循环最多跑多久，超时当失败重排，防止某个环节卡死整个循环 |
| `busyRetryMs` | `60000` | 1000–3600000 | 目标会话被占用时，多久后重试 |

---

## `intent`：念头机制

驱动 + 念头账本 + 打分 + 够格才动手。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 念头机制总开关 |
| `tickSeconds` | `1800` | 每多少秒评估一次（独立于投递节奏） |
| `minTension` | `0.30` | tension 低于此值整轮不评估，省一次唤醒 |
| `threshold` | `0.45` | 候选分低于此值不做 |
| `autonomousThreshold` | `0.62` | 高于此值且风险低，才可能不经过确认直接动手 |
| `execute` | `false` | **动手总闸**。`false` = 即便够格也只记日志/问你，不真开 worker |
| `askWhenQualified` | `true` | 够格但 `execute=off` 时，要不要主动发消息问「这个要不要做」 |
| `askCooldownHours` | `20` | 同一条念头问过一次后，多少小时内不再追问 |
| `minAskGapHours` | `4` | 两次追问之间至少隔多久，防止一天里反复烦人 |
| `maxRecent` | `20` | 最近做过的念头记多少条（用于「刚做过的不急」判定） |
| `workerPreset` | `""` | worker 会话挂哪个人设。**留空 = 不挂，worker 只有 host-plane 工具，read/write 全报 unknown** |

### `intent.worker`：闸门后面的细节

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxSteps` | `12` | 单次自主任务最多几步。写进提示词，没有硬中断，靠模型自己守 |
| `timeBoxMs` | `600000` | 单次任务最长跑多久（毫秒），到点 `agent.cancel('time-box')` |
| `allowedRiskClasses` | `["read","research","write_workspace"]` | 允许自动执行的风险类别 |

**`allowedRiskClasses` 只收这三类，多写的会被丢掉。** `write_outside` / `publish` / `install` / `contact` 四类写死在代码里永不自动执行——这是设计上不开放的开关，不是配置里加一行就能打开的。

---

## `target`：投给谁

| 字段 | 默认 | 说明 |
|---|---|---|
| `sessionId` | `""` | **必须填**。目标会话 id；空 = 哪也不发（宁可不动，也不瞎猜一个会话塞进去） |

---

## `external`：出门看一眼

不按定时，按好奇心：好奇值涨过阈值才出去，看完落 `glance.jsonl` 并把好奇心压下去。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 出门总开关 |
| `threshold` | `0.55` | 好奇心低于此值不出门 |
| `gapMinutes` | `90` | 两次出门至少隔多少分钟，防止卡在阈值上反复触发 |
| `biliCli` | `""` | `bili` CLI 路径；空 = 自动找 `~/.local/bin/bili` 等几处 |
| `maxItems` | `16` | 单次最多留几条素材 |
| `perLane` | `5` | 每一路各取几条（热搜/热门/搜索共用） |
| `cmdTimeoutMs` | `20000` | 单条 bili 命令等多久，超时当这一路失败 |

### `external.lanes`：看什么

**看什么不写死在代码里。** 一条 lane 就是一条 `bili` 命令：

```json
{ "id": "cats", "label": "猫片", "args": ["search", "video", "猫", "--order", "views", "--size", "10"], "format": "video", "prefix": "猫片" }
```

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，落日志用；缺省由 `args` 前两项拼 |
| `label` | 显示名，缺省 = `id` |
| `args` | 直接喂给 `bili --compact` 的参数数组。**能不能加一路取决于 bili 有没有那个子命令** |
| `format` | 怎么解析返回：`hot`（热搜，读 `title`）/ `popular`（热门，读 `stat.view`）/ `video`（搜索，读 `play`） |
| `prefix` | 拼在素材文字前面的标签 |

配置里写了 `lanes` 就**整份替换**默认三路，不混着用；最多 8 路，全不合法时回落默认。加了缺 `args` 的 lane 会被静默丢弃。

也可以在运行时用 `purpose_settings({watch_add: ["某个关键词"]})` 加一路，用 `watch_remove` 按 `id` 或 `label` 去掉。

### `external.topics`：拿自己的问题当搜索词

念头账本里 `kind === 'question'` 且还开着的条目，会变成搜索词——「我想弄清楚什么，就自己去搜什么」，不是别人替我列的清单。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就只跑 lanes |
| `limit` | `2` | 一次最多拿几条问题当搜索词（1–5） |
| `order` | `"views"` | 排序：`views` 历史热门 / `new` 刚发布 / `default` |
| `size` | `8` | 每条搜索要几个结果 |
| `maxQueryChars` | `24` | 问题原文截多长当搜索词，太长搜不出东西 |

---

## 环境变量

优先于文件：

- `DSH_PURPOSE_ENABLED` — 等于 `0` 时关闭
- `DSH_PURPOSE_DATA_DIR` — 数据目录
- `DSH_PURPOSE_MIN_GAP` / `DSH_PURPOSE_MAX_GAP` — 投递间隔（秒）
- `DSH_PURPOSE_QUIET_START` / `DSH_PURPOSE_QUIET_END` — 安静时段
- `DSH_PURPOSE_TARGET` — 目标会话 id
- `DSH_PURPOSE_INTENT_TICK` — 念头评估间隔（秒）
- `DSH_PURPOSE_BILI` — bili CLI 路径

---

## 故意不配的东西

判断标准只有一条：**这是「我是什么脾气」还是「我是谁」**。脾气该能配，身份不该。

写死在代码里、改它们请直接改源码：

- `src/score.js` 的 `WEIGHTS` — 怎么权衡价值/紧迫/风险。改行为请改 `confidence` 的 `reward` / `penalty`，别动权重。
- `EMOTION_HINTS` / `NEED_HINTS` — 两张中文词表，决定什么话听起来像什么情绪、什么需求。
- 三处 `build*Prompt` 的提示词正文（`src/score.js:302` 决定要不要开口、`src/intent-worker.js:84` 给 worker 的规矩、`:141` 让我用自己的话问你）。这几段换了就不是这个 agent 了。

也不该配的实现细节：zstd 的候选路径、会话日志留多少行、缓存多大——写死在 `src/sessionlog.js`。
