# Context Governor

一个用于 DeepSeek Harness（DSH）的上下文管理实验插件。它不压缩或改写 DSH 的原始 Session History；它只维护面向下一轮推理的任务状态、阶段状态和经验证的中间产物。

## 核心模型

每个 DSH Session 都有独立工作区：

```text
.context-governor/
└─ sessions/<session-id>/
   ├─ state.json
   ├─ sub_states/
   ├─ artifacts/
   ├─ transition/
   └─ audit/
```

- **State**：任务级唯一事实来源。包括任务目标、任务完成标准、按稳定 `step_id` 排列并通过 `covers` 关联完成标准的计划、用户约束、执行中发现的约束和任务生命周期。
- **SubState**：每个已开始 Step 恰有一份。它记录 Step 完成标准，以及 Completed、Current、Pending 三个 SubStep 区域；Current 可以附带跨 Epoch 的 Continuation 恢复导航。
- **Artifact**：可复用的大型精确中间数据。Artifact 元数据只保存 `contains` 与资源位置；资源文件位于受控的 Session 工作区内，并在使用前重新校验哈希。
- **History**：仍由 DSH 保存的原始会话事件。Governor 只提供当前 Session 的按需读取工具。
- **Audit**：旁路的只读审计记录，不参与任务状态判断。

详细持久化结构见 [`docs/持久化结构.md`](docs/持久化结构.md)，Step 与 SubStep 的统一规划原则见 [`docs/Planning.md`](docs/Planning.md)。

## Epoch 与持久化

Agent 在一个 Epoch 中通过工具产生 Delta。Delta 只保存在内存中，因此常驻 Context 与磁盘上的持久化快照始终一致。

当 Agent 调用 `switch_context` 或 `advance_task_progress` 的 `complete_task` 时，Governor 才将目标快照作为一个可恢复事务提交：

```text
Artifact → SubState → State
```

State 最后写入；下一次访问 Session 时会自动恢复未完成事务。尚未被某个已完成 SubStep 引用的 Artifact 不能提交。

## 主要工具

| 用途 | 工具 |
| --- | --- |
| 初始化 | `initialize_context_state` |
| 记录进度 | `advance_task_progress`（完成的 SubStep、Step 和任务终态）、`record_epoch_continuation`（未完成工作的恢复导航） |
| 调整计划或约束 | `replace_pending_sub_step_plan`、`revise_task_plan`、`record_user_constraint`、`record_discovered_constraint` |
| 管理精确中间数据 | `register_artifact`、`read_artifact` |
| 按需读取状态或 History | `read_sub_state`、`list_recent_tool_results`、`read_prior_epoch_event`、`read_prior_epoch_range` |
| 切换或结束 | `switch_context`、`advance_task_progress` 的 `complete_task` |

`register_artifact` 会同步检查资源路径、格式、哈希和声明字段。它不替 Agent 生成业务结论；Agent 必须在后续 `advance_task_progress` 中用带事件证据的已完成 SubStep 明确引用该 Artifact。

`record_epoch_continuation` 只记录当前未完成 SubStep 如何继续。它引用真实的可变工作文件，不把这些文件标记为已验证 Artifact；后续记录覆盖旧值，SubStep 完成时自动移除。

初始化时，Agent先根据 Mission 和任务完成标准提交完整 Step 计划。每个候选 Step 使用 `inputs + step + result + covers` 明确一个主要阶段；Governor 自动激活第一项，并只持久化 `step_id + step + status + covers`。`revise_task_plan` 只重规划尚未开始的 Pending Step，并保证全部任务标准仍被覆盖。

初始化和进入新 Step 时，Agent还要提交该 Step 的完整验收标准与 SubStep 计划。每个候选 SubStep 用 `inputs + action + result + completion_criteria + covers` 明确一个独立可验证结果；`inputs` 和 `result` 校验后即丢弃，不进入 SubState。完成 Current 后，Governor自动激活第一个 Pending；`replace_pending_sub_step_plan` 只允许整体替换尚未开始的 Pending，不修改 Step 标准、Completed 或 Current。

## 常驻 Context

新 Epoch 注入的信息固定为：

```text
State → 全局 Step 导航 → 当前 Step 的 SubState → 检索策略
```

其它已完成 Step 的详细信息、Artifact 内容和原始 History 都按需读取，不默认复制到上下文中。

## 安装、开发与验证

Governor 目前以 DSH 源码插件方式运行。请将本仓库与 DSH 放在同一父目录下：

```text
workspace/
├─ deepseek-harness/
└─ context-governor/
```

这是当前源码以相对路径引用 DSH 运行时模块所要求的目录布局。

先复制 [`cordis.example.yml`](cordis.example.yml) 为 `cordis.local.yml`，将其中两个绝对路径替换为本机路径。`cordis.local.yml` 已被忽略，不应提交。

以本地补丁启动 DSH：

```powershell
Set-Location <workspace>\deepseek-harness
pnpm dsh web --patch <workspace>\context-governor\cordis.local.yml
```

运行 Governor 的全部测试：

```powershell
Set-Location <workspace>\deepseek-harness
$tests = Get-ChildItem <workspace>\context-governor\tests\*.test.ts | ForEach-Object FullName
node --require <workspace>\context-governor\scripts\tsx-userinfo-fallback.cjs --import tsx/esm --test $tests
```

`scripts/tsx-userinfo-fallback.cjs` 是 Windows 上 `tsx` 启动时偶发 `os.userInfo()` 失败的兼容脚本；不受此问题影响的环境可以省略 `--require` 参数。

## 非目标

- 不读取或共享其它 Session 的工作区或原始事件。
- 不支持旧 State、SubState 或 Artifact 格式的迁移与兼容读取。
- 不在 Epoch 内对尚未提交的 Delta 提供崩溃恢复；当前持久化快照保持不变。
