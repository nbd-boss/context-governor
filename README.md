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
- **SubState**：Step 完成必要勘察并调用 `plan_current_step` 后才创建。它记录该 Step 的完成标准，以及 Completed、Current、Pending 三个 SubStep 区域；Current 可以附带跨 Epoch 的 Continuation 恢复导航。
- **Artifact**：可复用的大型精确中间数据。Artifact 元数据只保存 `contains` 与资源位置；资源文件位于受控的 Session 工作区内，并在使用前重新校验哈希。
- **History**：仍由 DSH 保存的原始会话事件。Governor 只提供当前 Session 的按需读取工具。
- **Audit**：旁路的只读审计记录，不参与任务状态判断。

`workspaceDirectory` 只指定上述管理文件的存储位置。Artifact 和 Continuation 的资源文件范围来自各自 DSH Session 的 `header.cwd`，与管理文件目录无关；缺少有效 Session 工作目录时，不推测或放宽资源范围。

详细持久化结构见 [`docs/持久化结构.md`](docs/持久化结构.md)，Step 与 SubStep 的统一规划原则见 [`docs/Planning.md`](docs/Planning.md)，整体正确性验证策略见 [`docs/验证计划.md`](docs/验证计划.md)。

## Epoch 与持久化

每次成功的 State 或 SubState 更新都会立即产生一个新的 `state.revision`，并将目标快照作为可恢复事务提交：

```text
Artifact → SubState → State
```

State 最后写入；下一次访问 Session 时会自动恢复未完成事务。Artifact 先暂存，只有被某个已完成 SubStep 标记为 `produced` 时，才与该 SubStep 一起提交。`switch_context` 必填 `new_discovered_constraints`：交接需要新增或替代的已确认约束，无变更则传 `[]`。非空列表复用约束校验和事务，全部通过后一次提交、增加一个 revision，再开启新 Epoch；校验或持久化失败不切换，空列表不写状态。未变化的 SubState/Artifact 不重写；Epoch 内旧的常驻快照由各工具返回的最新 revision 取代。

每条有效运行时约束有 Governor 分配的 `constraint_id`；State 的 `next_constraint_number` 只递增，避免复用已替代 ID。`record_discovered_constraint` 与切换列表的每项都必填 `replaces`：`[]` 新增独立约束，填写调用前有效的约束 ID 则在同一事务中移除它们并加入新约束。State 只保留有效条目，`replaces` 仅是命令参数，旧内容和替代依据保留在原始工具调用 History 中。同批多项可以共同替代一个旧条目，但不能引用本批尚未提交的新 ID；不存在或已失效的 ID 会令整批失败。Agent 判断语义冲突和证据是否充分，Governor 不自动比较自然语言或强制证据事件类型。

## 主要工具

| 用途 | 工具 |
| --- | --- |
| 初始化与当前 Step 规划 | `initialize_context_state`、`plan_current_step` |
| 记录进度 | `advance_task_progress`（完成的 SubStep、Step 和任务终态）、`record_continuation`（未完成工作的恢复导航） |
| 调整计划、标准或约束 | `revise_step`、`revise_substep`、`replan_task_criteria`、`replan_step_criteria`、`record_user_constraint`、`record_discovered_constraint` |
| 管理精确中间数据 | `register_artifact`、`read_artifact` |
| 按需读取状态或 History | `read_sub_state`、`list_recent_tool_results`、`read_prior_epoch_range`（起止 ID 相同时读取单事件） |
| 切换或结束 | `switch_context`、`advance_task_progress` 的 `complete_task` |

`register_artifact` 会同步检查资源路径、格式、哈希和声明字段。它不替 Agent 生成业务结论；Agent 必须在后续 `advance_task_progress` 中用带事件证据的已完成 SubStep 明确引用该 Artifact。

结束 Step、完成任务或切换 Epoch 前，所有已注册 Artifact 都必须完成上述交接。缺少引用或来源证据时，工具返回具体 ID，保持当前 Step、SubStep 和 revision 不变，Agent 可补齐后重试。

`advance_task_progress` 只有 `complete_task` 分支额外要求 `transition.task_criteria_check`：按 State 的 `task_plan.completion_criteria` 原始下标逐项提交 `criterion_index`、`outcome`（`met`、`unmet`、`unverified`）和非空 `source_events`，排除 `superseded_criteria`。必须完整覆盖所有有效标准，且全部为 `met`，才允许终态提交；普通推进分支不接受该参数。校验在事务提交前执行，拒绝不会推进 SubStep、改变 revision 或结束任务。该参数只随原始工具调用保留在 History，不新增 State/SubState 字段。Governor 检查结构、覆盖和引用，不自动证明业务证据语义；完成调查、生成报告或说明异常不能替代必需结果。

常驻 Context 和 `read_sub_state` 的运行时视图通过 `artifact_catalog` 展示引用到的 Artifact 摘要，每个 ID 只展开一次；SubStep 的 `artifact_refs` 保留 ID 和关系。目录不持久化，不影响 Agent 显式调用 `read_artifact` 读取具体内容。

`record_continuation` 必填 `operation`：`save` 保存当前未完成 SubStep 的恢复导航，不结束回合、不自动切换 Epoch；`wait_for_input` 保存未完成结果、所需外部输入和恢复动作后，通过 DSH 结束当前回合，Step 仍为 `in_progress`，任务仍为 `active`，不标记完成。Agent 应在停止调用前向用户说明阻碍；获得新输入后先确认恢复条件满足，不能仅因收到“继续”就视为解除阻碍。

Continuation 仍只保存 `progress`、`working_resources` 和 `resume_from`，不持久化 `operation` 或新增等待状态。`save` 要求至少一个真实可变工作文件；`wait_for_input` 可以传 `working_resources: []` 保存纯文本交接，不必制造文件。有文件时仍按 Session 工作目录校验真实绝对路径，不把它们标记为已验证 Artifact。成功修改立即落盘并增加 revision；等待操作可复用完全相同的已落盘说明，不重复写入。校验或持久化失败不结束回合；后续记录覆盖旧值，SubStep 完成时自动移除。工具仍要求已有 Current SubStep，尚无 SubState 时不要为了停止而创建虚假计划。

验收标准更新与普通计划更新共享内部计划构建函数；标准和受影响的 Pending 计划在同一次事务中落盘，不通过嵌套工具调用分别提交。审计由 Governor 持续记录到各 Session 的 `audit/`，供实验脚本或开发者读取，不向 Agent 暴露审计读取工具。

初始化时，Agent先根据 Mission 和任务完成标准提交完整 Step 计划。每个候选 Step 使用 `inputs + step + result + covers` 明确一个主要阶段；Governor 自动激活第一项，每项只持久化 `step_id + step + status + covers`。`revise_step` 每次新增、修改或删除一个 Pending Step，其他项保持原样。

进入新 Step 时，Governor 先只激活该 Step；Agent 按需勘察，再通过 `plan_current_step` 提交完整验收标准与 SubStep 计划。新规划中每个候选 SubStep 用 `inputs + action + result + covers_criterion_indexes` 明确一个独立可验证结果；数字是该规划的 `step_completion_criteria` 数组下标。`inputs` 和 `result` 校验后即丢弃，SubState 以所属 `step_id` 为唯一身份，Governor 为 Step 标准分配稳定 Criterion ID。普通 Pending SubStep 调整使用 `revise_substep`。若标准本身需要变更，对应 criteria replan 工具接收 `changes` 数组，使用相同的单项操作在内存中调整受影响工作，并在同次提交中更新标准和覆盖关系。

### 单项计划调整

两个工具都接收 `expected_state_revision` 和一个 `change` 对象。`revise_substep` 还需所属 `step_id` 与 `expected_current_sub_step_id`。Schema 分别限定三种操作：

- `add`：提交规划字段，不传目标 ID；Governor 分配新 ID并追加到 Pending 末尾。
- `update`：提交已有 Pending ID 和完整规划字段，保留 ID 和位置。
- `delete`：只提交已有 Pending ID，删除计划条目，不删除业务文件或 History。

例如删除一个已被其他工作承接的 Pending Step：

```json
{
  "expected_state_revision": 6,
  "change": { "operation": "delete", "step_id": "step-000003" }
}
```

新增／修改 Step 的规划字段是 `inputs + step + result + covers`；SubStep 是 `inputs + action + result + covers_criterion_ids`。验收标准更新中的 SubStep 操作使用 `covers_criterion_indexes`，下标指向已有标准和追加标准合成后的数组。Done、Current／In-progress 不可修改；未知 ID 报错，不自动新增。

拆分或合并前，Agent 先确定目标计划和调用顺序，必要时先新增承接工作，再缩减或删除旧项。每次普通调用都校验完整覆盖并落盘，返回完整 State、当前 SubState 和最新 revision。验收标准工具的 `changes` 则全部完成后只提交一次，允许其内部草稿短暂不完整。

Task Plan 的 `next_step_number` 和每个 SubState 的 `next_sub_step_number` 保存分配进度，删除或重启后不复用旧 ID。它们由 Governor 管理，无需 Agent 填写。开发阶段不兼容旧格式，请使用新 Session 测试。

## 常驻 Context

新 Epoch 注入的信息固定为：

```text
State（含全部 Step 导航）→ 当前 Step 的 SubState → 检索策略
```

直接通过 State 中的 `step_id` 按需读取其它 Step 的 SubState，不再重复注入已完成 Step 的导航副本。Artifact 内容和原始 History 也按需读取。

通用执行策略由 `src/agent-guidance.ts` 统一维护：精确数据优先程序直传，模型在脚本或写入参数中重填或重新编码源值仍算转写。重建任务在现有 Step 完成标准中明确所需源字段及关系的保真要求，并在后续计算、筛选或外部写入前按来源核对；实体角色、关系方向及覆盖范围不能只凭记录数、内部统计或下游回读验证。完成总结及事件引用如实说明实际核对范围，抽查不扩大为全量验证；已有充分有效的比较证据可复用，不为收尾重复查询。不增加持久化字段、工具或业务验证器，具体语义核对仍由 Agent 执行。勘察在已有足够依据确定标准与下一动作时结束；交接保留相关失败尝试及其条件，后续优先沿已确认路径推进，不在条件未变时重复失败尝试，也不把未验证进度自动视为已验证结果。

`decision_checks` 要求证据足以支持所采用的具体结论，而非仅存在相关观测；提交前区分请求或预期、实际观测和未验证推断，不把局部成功推广到未经测试的条件。已确认的运行边界进入约束，普通任务事实进入 SubState 总结或按需注册 Artifact，猜测和待验证恢复路线留在 History/Continuation。新增或替代约束前，Agent 比较当前有效条目及同批候选的适用条件和行为要求；充分新证据推翻旧条目时显式填写 `replaces`，否则保留未决，不把相反要求同时确认为有效。确认限制后及时调用记录工具，切换时通过 `new_discovered_constraints` 交接遗漏，收尾模式同样适用。Governor 根据调用环境定位执行历史，只检查事件引用格式和存在性，不验证跨 Session 归属、事件类型或证据语义。单次超时不自动成为永久限制，也不证明操作已停止；恢复动作必须有依据。策略正文以 `src/agent-guidance.ts` 为唯一运行时来源，不自动从报错提取业务结论或增加验证调用。

Governor 不设置独立的常驻 Context token 预算，也不为满足固定额度截断状态；常驻消息的 token 估算只用于审计。窗口压力按 DSH 提供的完整 Context token 估算与当前配置的模型窗口比较，默认在 80% 进入收尾模式：停止扩大工作，但允许保存成果和交接后切换。Agent 也可以提前切换。收尾边界由统一 Guidance 提示，不按工具名拦截；Agent 根据实际能力选择保存已有进度所需的读取、写入或脚本工具，不借此收集新业务输入。DSH 的权限与沙箱控制不变，Governor 的初始化和状态一致性检查也保留。

每个 Epoch 只注入一次压力提醒。仅在模型自然结束、但尚未切换或完成任务时，Governor 在当前回合内提醒一次；再次自然结束仍未完成交接便返回明确错误，任务保持 `active`。`max_tokens` 截断和仍在推进的工具调用不计为拒绝交接，不触发这项纠正或报错。Governor 不设置单次输出额度，也不负责截断后的模型重试或续跑；这些由 DSH／正式调用端处理。模型请求失败后不通过 idle 事件自动续跑，DSH 会将真实错误传给调用端。

每次切换都将 `switch_context.reason` 作为独立运行时字段 `switch_note` 带入新 Epoch，并保留在 Epoch 审计中，不论是否已有 SubState 或 Continuation。reason 简要解释切换原因，仅补充尚未保存在恢复状态中的必要信息，不复制整份进度；没有 Continuation 时保留必要恢复线索，尚无 SubState 时包括勘察结论、相关失败条件、已有文件位置、未决问题和下一动作。它不新增持久化状态字段，不覆盖或自动合并到 State/SubState/Continuation，不表示完成或验证通过。冲突时先核实证据，不能仅凭说明改写状态。新窗口只携带最近一次切换说明，不累积旧说明；已有 Continuation 仍是当前 SubStep 的正式恢复导航。

### History 与运行时读取能力

Agent 自行判断何时以及回查哪些证据；Governor 只提供状态、索引、通用检索指导和当前 Session 的小型只读事件入口，不代做业务查询或执行。事件读取复用 DSH 的 Session API，不另建原始日志副本、解压器或业务解析器。DSH 的完整会话检索工具是可选能力，不作为 Governor 的必需依赖；有合适的原生 History 或文件读取入口时可由 Agent 使用，不要求为某个任务族配置专用工具。

History 事件可能只含大型工具结果的预览和外置文件引用；回读事件不等于读取该文件。需要完整内容时，Agent 使用运行时已授权的通用读取能力访问引用；若文件不可访问，应如实保留访问障碍并选择其它授权路径或较小范围查询，不能把预览当作完整数据，也不能通过重复回读、换 Epoch 或开放整个宿主机规避问题。文件的可达性由 DSH／部署接入负责，Governor 不猜测实验目录或宿主机路径。

## 安装、开发与验证

Governor 目前以 DSH 源码插件方式运行。请将本仓库与 DSH 放在同一父目录下：

```text
workspace/
├─ deepseek-harness/
└─ context-governor/
```

这是当前源码以相对路径引用 DSH 运行时模块所要求的目录布局。

当前接入已在 DSH `master` 提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` 上完成离线验证。消息来源由 Governor 声明为 `context-governor`；History 导航读取新版工具消息的 `toolCallId` 与 `isError`，不保留旧 `plugin` 来源或嵌套 `tool-result` 的适配分支。测试辅助工具从 DSH 的 `test-support/tool-testkit` 引入，不属于插件运行依赖。升级后的真实任务效果仍需使用新 Session 做实验验证。

先复制 [`cordis.example.yml`](cordis.example.yml) 为 `cordis.local.yml`，将其中两个绝对路径替换为本机路径。`cordis.local.yml` 已被忽略，不应提交。

以本地补丁启动 DSH：

```powershell
Set-Location <workspace>\deepseek-harness
pnpm dsh web --patch <workspace>\context-governor\cordis.local.yml
```

### DSH 可选的模型请求重试

这不是 Governor 的安装要求、配置项或运行依赖，而是 DSH 提供的通用生成错误恢复能力，使用其它上下文方案时也适用。Governor 不自行调用模型来修复参数 JSON，也不自动修复损坏的 State 文件。

DSH 默认的 normal 重试策略包含空响应、限流、服务端错误、超时和传输错误，但不包含 `MALFORMED_RESPONSE`。若希望非法工具参数 JSON 也有恢复机会，可将以下条目加入本机 DSH profile 补丁，或与本地加载补丁合并；示例适用于 DSH 内置的 DeepSeek API-key Provider 插件 ID：

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

`maxRetries: 3` 表示失败的模型生成步骤在首次请求之外最多再尝试三次，不重放此前已成功执行的工具。DSH 根据同一持久历史重新请求；现有重试不会把解析错误或失败输出反馈给模型，因此不是定向修复提示，也不保证恢复成功。每次重试可能产生额外 API 费用，耗尽后仍会报告失败。配置属于实际使用的 Provider／DSH 部署，不应放进 Governor 的 `config`；对照实验应让两组使用同一策略。

### 本地测试

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
- 不为尚未通过 Governor 工具提交的 Agent 思考或草稿提供崩溃恢复。
