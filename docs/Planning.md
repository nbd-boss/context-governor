# Planning 规划模块

## 1. 目标

Planning 模块统一管理两种不同层级的任务规划：

```text
Mission
→ Step Planner
→ Task Plan

当前 Step
→ SubStep Planner
→ 当前 Step 的 SubState
```

两种规划共用“从父级验收标准反推所需结果”的基本方法，但具有不同的粒度、生命周期和持久化位置。

Planning 模块不执行任务、不查询业务系统，也不直接读写持久化文件。具体业务划分由 Agent 完成，Governor 只负责确定性的结构校验、ID 分配和状态构造。

## 2. 职责边界

整体职责分为三部分：

```text
Agent
负责理解权威任务输入，并提出验收标准和业务规划

Planning 模块
负责提供统一规划方法、接收规划结果并执行确定性结构校验

Governor
负责分配 ID、构造 State / SubState、推进生命周期并持久化
```

固定规则无法完整判断任意业务任务的合理粒度。因此：

```text
粒度的业务判断
= Agent 根据统一规划指导完成

输入作用域、覆盖关系、数据结构和生命周期
= Governor 通过代码保证
```

Governor 不根据关键词、工具调用次数、文件数量或固定条目数量判断 Step 和 SubStep。

## 3. 统一 Planning Core

### 3.1 公共规划方法

Step 和 SubStep 都遵循同一个结果优先过程：

1. 读取父级目标和全部父级验收标准。
2. 从验收标准反推必须产生的独立、可验证结果。
3. 为每个结果识别概念输入和一项主要工作。
4. 一个独立结果形成一个候选规划项。
5. 多个输入只有在共同产生同一个结果且共享验证边界时才放在一起。
6. 如果一个结果实际包含多个可以分别保存、验证或复用的输出，则继续拆分。
7. 检查所有父级验收标准是否均被覆盖。
8. 删除无关、重复或不能支持任何验收标准的规划项。
9. 根据依赖关系排列执行顺序。

规划时使用 `inputs + 主要工作 + result` 帮助 Agent 明确边界：Step Planner 使用 `step` 表达主要工作，SubStep Planner 使用 `action`。`inputs` 和 `result` 不作为持久化状态的重复权威源。

### 3.2 公共确定性校验

Planning Core 只负责可以由代码可靠判断的内容：

- 父级验收标准非空；
- 规划项非空；
- 每个覆盖引用有效且不重复；
- 每条父级验收标准至少被一个规划项覆盖；
- 每个规划项至少覆盖一条父级验收标准。

`step`、`action` 和 `result` 等层级专属字段，分别由 Step Planner 和 SubStep Planner 校验，不进入公共层。SubStep 不另存一份验收标准；它通过 `covers` 引用 Step 标准。

这些检查只能避免结构性缺漏或明显多余项，不能证明业务语义一定正确。

### 3.3 不由公共层处理的内容

公共层不负责：

- 判断一个结果在业务上应当属于 Step 还是 SubStep；
- 决定任务需要多少个 Step 或 SubStep；
- 根据 token、文件数或工具调用数强制拆分；
- 执行任务或验证业务结果；
- 直接构造或写入 State、SubState、Artifact；
- 修改运行中的状态机。

## 4. Step Planner

### 4.1 输入和输出

Step Planner 面向整个任务：

```text
输入：Mission + 整个任务的验收标准
输出：有序的 Step 划分
```

任务验收标准由 Agent 根据以下权威信息提出：

- 用户原始要求；
- 用户明确约束；
- 用户指定的计划、规范、模板或验收命令；
- 已确认且影响执行方式的运行约束；运行障碍不自动豁免用户要求或降低完成标准。

Step Planner 不读取 Benchmark Ground Truth 或评测器隐藏答案。

### 4.2 Step 的粒度

Step 表示整个任务中的主要阶段或里程碑：

- 完成后会改变整个任务所处的阶段；
- 可以包含多个彼此相关的独立成果；
- 可以跨越多个 Context Epoch；
- 应当形成可确认的阶段性结果；
- 不应细化为一次工具调用、一次文件读取或一个局部操作。

例如：

```text
Mission：修复 timeout 重试导致的重复扣款并完成回归验证

Step 1：建立重复扣款的可复现基线
Step 2：定位重试链路的根因
Step 3：实现幂等键传递修复
Step 4：补充并运行回归测试
```

### 4.3 Step 独有规则

Step Planner 还需要：

1. 保证划分覆盖整个任务，而不是只覆盖当前可见操作；
2. 按主要业务依赖排列 Step；
3. 避免把同一个任务阶段拆成多个只有执行方式不同的 Step；
4. 避免把可以独立验收的主要阶段合并为一个过大的 Step；
5. 生成相对稳定的 Task Plan，运行中只在任务范围或已知事实发生实质变化时调整 Pending Step。

Step Planner 的规划草稿使用任务级完成标准，以及每个 Step 的 `inputs + step + result + covers`。其中 `inputs` 和 `result` 只存在于规划期；State 的 `task_plan` 只持久化一次任务级完成标准，以及每个 Step 的 `step_id + step + status + covers`。

任务级完成标准保留原文和数组位置，`covers` 使用其下标，不另设 TaskCriterion ID。有依据的修订通过 `replan_task_criteria` 标记旧下标失效并追加新标准，同时调整受影响的 Pending Step；不能直接覆盖或重排旧标准。

## 5. SubStep Planner

### 5.1 输入和输出

SubStep Planner 只面向当前 Step：

```text
输入：当前 Step + 对应的 step_completion_criteria
输出：当前 Step 的最终 SubStep 划分
```

`step_completion_criteria` 由 Agent 根据权威任务输入、当前 Step、任务约束和相关规范提出。它描述可观察的完成结果，不描述具体执行方法。

进入每个 Step（包括第一个）时，顺序固定为：

```text
激活 Step，此时可以尚无 SubState
→ 读取该 Step 覆盖的有效任务级标准
→ 判断是否需要勘察；只补充影响标准或下一动作的必要证据
→ 确定有依据的 step_completion_criteria
→ plan_current_step：一次提交标准及覆盖它们的完整 SubStep 计划
→ 执行、验证并推进；下一 Step 重复该流程
```

已有充分证据时直接规划，不为形式重复勘察。仅凭字段存在或名称相似，不能添加新的业务义务；也不能为了结束调查或绕过障碍而虚构标准。未规划状态由“当前 Step 尚无 SubState”表示，不另设状态字段或空 SubState；此时不能完成 SubStep 或 Step，但可以保存辅助切换说明后更换 Epoch。

例如，先规划“定位重试根因”这个 Step，进入后再读取相关代码、确认调用边界及所需证据，然后提交其标准和 SubStep。初始化任务时不要求预先猜测这些实现细节。

### 5.2 SubStep 的粒度

SubStep 表示当前 Step 内一个独立、可验证、可复用的业务成果：

- 通常可以在一个 Context Epoch 中推进或完成；
- 完成后不一定改变整个任务所处的 Step；
- 应产生后续工作可以直接使用的结论或结果；
- 不能只是一次工具调用或没有独立结果的操作；
- 不按任意固定条目数、文件数或调用次数拆分。

调查或准备工作只有产生独立可验证、后续需要复用的结果时才单列 SubStep；否则属于产出目标结果的 SubStep 内部动作。不能为了单列调查而虚构 Step 完成标准。

例如，当前 Step 为“定位重试链路的根因”时，可以规划为：

```text
SubStep 1：确认 retry() 到 create_charge() 的调用边界
SubStep 2：确认 idempotency key 的生成位置
SubStep 3：综合调用链和 key 生成行为确认根因
```

### 5.3 规划提交示例

SubStep 规划提交使用：

```json
{
  "step_completion_criteria": [
    "retry() 到 create_charge() 的调用边界已确认。",
    "idempotency key 的生成位置已确认。",
    "根因具有代码或测试证据。"
  ],
  "sub_steps": [
    {
      "inputs": ["支付重试入口", "扣款调用实现"],
      "action": "追踪 retry() 到 create_charge() 的调用链。",
      "result": "已确认的重试调用边界",
      "covers_criterion_indexes": [0]
    },
    {
      "inputs": ["扣款调用实现", "idempotency key 生成逻辑"],
      "action": "确认 idempotency key 的准确生成位置。",
      "result": "已确认的 key 生成边界",
      "covers_criterion_indexes": [1]
    },
    {
      "inputs": ["已确认的重试调用边界", "已确认的 key 生成边界"],
      "action": "结合调用链和 key 生成行为确认重复扣款根因。",
      "result": "具有证据的重复扣款根因",
      "covers_criterion_indexes": [2]
    }
  ]
}
```

其中 `inputs` 和 `result` 是规划期字段；`action` 应描述可观察的成果。`covers_criterion_indexes` 使用本次 `step_completion_criteria` 的从零开始的下标；Governor 建立 SubState 时才分配稳定的 Criterion ID。后续替换 Pending SubStep 使用 `covers_criterion_ids` 引用 SubState 中已有的 ID。Governor 校验后丢弃 `inputs` 和 `result`，不复制到 SubState。

## 6. 两种 Planner 的明确区别

| 维度 | Step Planner | SubStep Planner |
|---|---|---|
| 父级范围 | 整个 Mission | 当前 Step |
| 依据 | 任务级验收标准 | Step 完成标准 |
| 规划结果 | 主要阶段或里程碑 | 具体可验证业务成果 |
| 时间跨度 | 可以跨多个 Epoch | 通常适合在一个 Epoch 内推进 |
| 稳定性 | 相对稳定 | Pending 可随执行事实调整 |
| 持久化位置 | State / Task Plan | 当前 Step 的 SubState |
| 完成影响 | 改变整体任务阶段 | 推进当前 Step 内部进度 |

因此，两种 Planner 不能通过同一个通用 Schema 强行统一，也不能只用不同名称包装同一套状态逻辑。

## 7. 运行期调整

### 7.1 Step 调整

Step 是任务级结构，调整条件应比 SubStep 更严格。只有当用户要求、任务范围或已确认事实使原 Task Plan 不再完整或不再成立时，才调整尚未开始的 Step。

Agent 使用 `revise_step` 每次提交一个 `add / update / delete` 操作。新增由 Governor 分配 ID 并追加到 Pending 末尾；修改保留原 ID 和位置；删除只移除指定 Pending 项。每次检查任务标准仍完整覆盖，成功后立即持久化并递增 revision。

Step 与 SubStep 使用不同工具和领域契约，共享 `pending-edit.ts` 的单项列表操作及 Planning Core 校验，不共享生命周期推进。复杂调整先确定目标计划和调用顺序，再逐次提交，必要时先新增承接工作再删除旧项。

### 7.2 Pending SubStep 调整

SubStep 运行时遵循：

```text
completed_sub_steps
= 已完成事实，不可修改

current_sub_step
= 当前执行身份，不由 Pending 重规划修改

pending_sub_steps
= 尚未开始的计划，可以逐项新增、修改、删除
```

执行方法发生变化，但 Current SubStep 的目标与完成标准不变时，不需要重规划。

Agent 使用 `revise_substep` 每次调整一个 Pending SubStep。已有项保留 ID 和位置，新增项追加并分配新 ID，删除不影响 Completed 和 Current。每次普通调用都校验覆盖并持久化；只变更执行方法而不变更计划内容时，不需要调用。

验收标准发生变化时，使用对应 criteria replan 工具提交标准修订和 `changes` 操作数组。它复用相同的单项修改函数，全部操作在内存完成后校验最终覆盖并一次提交。分配计数随计划持久化，删除和重启都不复用旧 ID。

### 7.3 标准修订与完成记录

| 层级 | 标准正文的唯一位置 | 修订工具 |
| --- | --- | --- |
| 任务 | State 的 `task_plan.completion_criteria` | `replan_task_criteria` |
| Step | 对应 SubState 的 `step_completion_criteria` | `replan_step_criteria` |

旧标准不覆盖或重排：任务级保留旧下标，Step 级保留旧 Criterion ID，通过停用旧标准并追加新标准修订。两种工具复用普通计划调整的内部单项操作，标准和受影响的 Pending 计划在一次事务中提交，不通过多次嵌套工具调用制造中间状态。

已完成 Step/SubStep 和证据记录保留。新标准如果现有成果不能满足，应安排尚未执行的纠偏工作；不能改写完成记录来声称新要求已满足。修订必须有用户要求、规范或新证据支持，不能因为结果暂时做不到就降低标准。

### 7.4 提交与跨窗口恢复

每次成功的 State/SubState 变更都会立即持久化并增加一个 revision，过时 revision 被拒绝。注册的 Artifact 在完成 SubStep 建立 `produced` 引用时同次提交；未完成工作由 Continuation 保存恢复导航。

当前 Epoch 保留起始基线，以后续工具返回的最新状态为准；切换从最新持久化快照加载。切换说明只提供辅助线索，不覆盖正式状态。事务恢复和资源边界以[持久化结构](持久化结构.md)为准。

## 8. 代码边界

保持小而清晰的模块边界：

```text
src/planning/planning-core.ts
  公共规划契约与覆盖校验纯函数

src/planning/pending-edit.ts
  公共单项新增／修改／删除与 Pending 保护

src/planning/step-plan.ts
  Step 规划独有契约、Task Plan 构造与任务标准修订

src/planning/sub-step-plan.ts
  SubStep 规划独有契约和 SubState 构造

src/agent-guidance.ts
  模型可见规划规则的单一权威来源

src/tools/
  负责调用对应 Planner，不复制规划规则

持久化层
  只保存 Planner 已验证并由应用层构造的正式状态
```

不建立过度泛化的 `GenericPlanner<T>`。公共层只提取真正相同且能够稳定复用的纯逻辑，例如：

```text
validatePlanningCriteria(...)
validateIndexedCovers(...)
requireCompleteCoverage(...)
```

Step 和 SubStep 的 Tool Schema、ID、状态推进和持久化契约分别实现。

## 9. 实现原则

1. 规划规则保持单一权威来源，不在多个 Tool Description 中复制。
2. 语义规划由 Agent 完成，确定性结构校验由 Governor 完成。
3. 公共层只抽取稳定共性，不掩盖 Step 与 SubStep 的层级差异。
4. 不通过业务关键词、固定数量或测试案例特例控制粒度。
5. 不保存规划过程和临时原子结构，只保存后续运行需要的正式状态。
6. 不增加第二次模型验证或后台 SubAgent；如果实验显示语义规划仍不稳定，再单独评估。
7. 当前实现、Schema 与测试以仓库中的 `src/`、`tests/` 和 [README](../README.md) 为准；本文只说明规划思想与职责边界。
