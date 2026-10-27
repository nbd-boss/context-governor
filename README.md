# Context Governor

Context Governor 是用于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的上下文管理实验插件。它通过显式任务状态、执行进度和按需回查，让 Agent 在更换上下文窗口后继续长任务。

Governor 管理上下文与状态一致性，DSH 提供运行时，Agent 判断并执行业务任务。插件可以脱离 Benchmark 和实验 Adapter 独立使用。

## 工作方式

一个上下文窗口称为 **Epoch**。Agent 在窗口内执行任务，并通过 Governor 工具保存进度；切换时，从最新状态重新构建上下文。

```text
用户任务 → 初始化 State → 按需勘察当前 Step → 规划 SubStep → 执行并保存进度
                                                           │
                        需要更换窗口：保存交接 → switch_context
                                                           │
                             新 Epoch 加载最新状态，继续执行
```

新 Epoch 默认加载：

```text
State（任务目标、全部 Step 计划、约束）
+ 当前 Step 的 SubState（完成标准、已完成/当前/待执行 SubStep、Continuation）
+ Artifact 导航与通用 Guidance
+ 最近一次切换的辅助说明（如有）
```

其他 Step 的详细状态、Artifact 资源和原始 History 按需读取。Governor 会重建模型可见的上下文，但不压缩或改写 DSH 保存的原始 Session History。

## 核心概念

| 概念 | 保存什么 | 作用 |
| --- | --- | --- |
| **State** | Mission、任务完成标准、Step 计划、约束和生命周期 | 保留任务全局方向 |
| **SubState** | 一个 Step 的完成标准及已完成、当前、待执行 SubStep | 保留具体执行进度；完成必要勘察后才创建 |
| **Continuation** | 当前未完成 SubStep 的进度、工作文件和恢复动作 | 跨窗口继续未完成的工作 |
| **Artifact** | 精确中间产物的摘要、内容说明与不可变资源引用 | 避免重新查询或计算已有结果 |
| **History** | DSH 保存的原始会话事件 | 回查结论和操作的原始依据 |
| **Audit** | 上下文构建、切换和读取等管理记录 | 供开发者检查，不作为任务完成依据 |

Governor 校验结构、引用、资源和状态一致性；业务结论及证据是否充分，仍由 Agent 判断。Artifact 登记成功也不等于业务结果已经被自动证明正确。

## 接入 DSH

### 1. 准备源码与运行环境

当前以源码插件方式加载，两个仓库需要放在同一父目录，因为插件使用相对路径引用 DSH 模块：

```text
workspace/
├─ deepseek-harness/
└─ context-governor/
```

先按照 DSH 文档安装依赖并配置模型。本插件当前已适配并完成离线验证的 DSH 提交为 [`22ddee3`](https://github.com/deepseek-ai/deepseek-harness/commit/22ddee3792402c3e70ec5f86a63c3e3e895a2f60)；升级 DSH 后需重新检查兼容性。

### 2. 配置加载补丁

复制 [`cordis.example.yml`](cordis.example.yml) 为 `cordis.local.yml`，替换插件入口和状态存储目录的两个绝对路径。本机配置文件已被 Git 忽略。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用插件 |
| `switchThresholdRatio` | `0.80` | 完整 Context 占模型窗口的比例达到该值时，进入收尾模式 |
| `workspaceDirectory` | `.context-governor` | 各 Session 管理文件的存储根目录 |

该补丁只负责加载 Governor。请检查所用 DSH profile，避免同时启用 `compaction-basic` 等另一套会替换可见上下文的策略。

### 3. 启动

以下是 Windows PowerShell 示例；按实际位置修改 `$workspace`：

```powershell
$workspace = 'E:\context'
Set-Location "$workspace\deepseek-harness"
pnpm dsh web --patch "$workspace\context-governor\cordis.local.yml"
```

使用新 Session 发送正常任务即可。插件会要求 Agent 先初始化 State，再执行任务工具；用户不需要手写 State JSON。

## 进度、切换与停止

- **保存进度**：每次成功更新 State 或 SubState 都立即持久化并递增 `state.revision`。窗口内保留原来的常驻基线，最新状态由工具返回；新 Epoch 再加载最新持久化快照。
- **切换窗口**：Agent 可主动调用 `switch_context`。默认达到模型窗口的 80% 后进入收尾模式，停止扩大任务工作，保存已有成果与交接后切换；不按固定工具名阻拦交接。
- **等待输入**：`record_continuation` 的 `save` 保存进度后继续执行；`wait_for_input` 保存阻碍与恢复条件后结束当前回合，任务仍为 `active`。工具要求已有 Current SubStep；没有时应直接说明阻碍，不制造计划或文件。
- **完成任务**：只有必需结果全部满足，才通过 `advance_task_progress` 的 `complete_task` 分支完成。该分支要求有效任务标准全部被证据覆盖并声明为 `met`；调查结束、异常已报告或没有可执行动作，都不自动等于完成。

`switch_context.reason` 会作为辅助 `switch_note` 进入新窗口，但不覆盖或自动合并到 State、SubState 或 Continuation。正式恢复以这些状态为准。

Governor 不设置独立的常驻 Context token 预算，也不为满足固定额度截断状态。窗口压力来自 DSH 的完整 Context token 估算；模型请求重试、输出截断后的续跑由 DSH／调用端负责。

## 工具入口

| 操作 | 工具 |
| --- | --- |
| 初始化与规划当前 Step | `initialize_context_state`、`plan_current_step` |
| 推进已完成工作 | `advance_task_progress` |
| 保存未完成工作的交接 | `record_continuation` |
| 调整尚未开始的计划 | `revise_step`、`revise_substep` |
| 修订标准与受影响计划 | `replan_task_criteria`、`replan_step_criteria` |
| 记录用户要求与已确认的运行约束 | `record_user_constraint`、`record_discovered_constraint` |
| 登记与读取中间产物 | `register_artifact`、`read_artifact` |
| 回查其他 Step 或历史证据 | `read_sub_state`、`list_recent_tool_results`、`read_prior_epoch_range` |
| 开启新 Epoch | `switch_context` |

计划工具使用稳定 ID，只允许普通修订修改 Pending 项；验收标准与受影响计划在同一事务中更新。约束新增和替代均由 Agent 明确提交，不自动从报错推导业务规则。

History 读取返回 DSH 保存的事件表示，大型结果可能只有预览和外置文件引用。需要完整内容时，由 Agent 使用运行时已授权的读取能力访问；回读事件或切换窗口不会恢复被省略的内容。

策略正文统一维护在 [`src/agent-guidance.ts`](src/agent-guidance.ts)，README 不重复定义工具参数或执行策略。

## 数据存储与恢复

每个 Session 使用独立管理目录：

```text
.context-governor/
└─ sessions/<session-id>/
   ├─ state.json
   ├─ sub_states/<step-id>.json
   ├─ artifacts/
   ├─ transition/
   └─ audit/
```

`workspaceDirectory` 决定管理文件的位置。Artifact 和 Continuation 引用的业务文件必须位于 DSH Session 的 `header.cwd` 范围内，使用真实绝对路径；不能根据管理目录猜测项目位置。

State/SubState 更新通过可恢复事务提交，顺序为 `Artifact → SubState → State`，State 最后写入。下次访问时恢复未完成事务，未变化的文件不重写。

Artifact 登记后先暂存；只有已完成 SubStep 明确以 `produced` 引用它，才随进度一起提交。结束 Step、完成任务或切换前必须完成已登记产物的交接。资源文件登记后不可改写，后续读取会重新校验哈希；未完成的可变工作文件应通过 Continuation 交接。

## 开发与验证

在 DSH 目录运行全部 Governor 测试：

```powershell
$workspace = 'E:\context'
Set-Location "$workspace\deepseek-harness"
$tests = Get-ChildItem -LiteralPath "$workspace\context-governor\tests" -Filter '*.test.ts' -File |
    ForEach-Object FullName
node --require "$workspace\context-governor\scripts\tsx-userinfo-fallback.cjs" --import tsx/esm --test $tests
```

`tsx-userinfo-fallback.cjs` 处理 Windows 上偶发的 `os.userInfo()` 启动错误；不受影响的环境可以省略 `--require`。离线测试通过不代表真实业务任务一定正确，仍需实际运行验证。

<details>
<summary>可选：配置 DSH 的模型请求重试</summary>

这是 DSH 的运行时配置，不是 Governor 的安装要求、配置项或依赖。若希望非法工具参数 JSON 也能触发重试，可将以下条目加入本机 DSH 加载补丁；示例适用于内置 DeepSeek API-key Provider：

```yaml
- id: llm-retry
  disabled: false
- id: llm-deepseek
  config:
    retryPolicy:
      mode: normal
      maxRetries: 3
      retryableCodes:
        - EMPTY_RESPONSE
        - RATE_LIMIT
        - SERVER
        - TIMEOUT
        - TRANSPORT
        - MALFORMED_RESPONSE
```

`maxRetries: 3` 表示首次请求之外最多再试三次，不重放已成功执行的工具。现有重试不把解析错误或失败输出反馈给模型，因此不保证恢复成功；额外请求可能产生费用。Governor 不自行调用模型修复 JSON，也不自动修复损坏的 State 文件。

</details>

## 更多文档与当前限制

| 文档 | 内容 |
| --- | --- |
| [持久化结构](docs/持久化结构.md) | State、SubState、Artifact 的职责与示例 |
| [Planning](docs/Planning.md) | Step/SubStep 划分、覆盖关系与计划调整 |
| [验证计划](docs/验证计划.md) | 固定测试集、验证指标、官方验收与 Context 抽查 |

当前不共享其他 Session 的工作区或原始事件，不提供旧 State/SubState/Artifact 格式迁移，也不为尚未通过工具提交的 Agent 草稿或暂存 Artifact 提供崩溃恢复。
