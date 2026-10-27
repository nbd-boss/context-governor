# Step 先勘察、后规划：实现与验证清单

依据：[Step规划计划.md](./Step规划计划.md)。只改 Governor，不修改 LOCA-bench 或实验 Adapter。Agent 判断业务含义；Governor 验证结构、身份、覆盖与持久化，不自动编造验收标准。

## 目标流程

```text
初始化任务级计划（首个 Step 为 in_progress，但无 SubState）
→ 必要时勘察
→ plan_current_step：一次提交该 Step 的验收标准与 SubStep 计划
→ 执行、验证、advance_task_progress
→ 激活下一 Step，但不预建其 SubState
→ 重复
```

有可靠依据时可直接规划，无须为了形式勘察。当前 Step 是否已有 SubState 是“待规划／已规划”的唯一状态判断；不另设布尔字段或空 SubState。

## 已落实

- [x] Workspace 契约允许唯一的 `in_progress` Step 暂无 SubState；`done` 必须有已完成 SubState，`pending` 不得有 SubState。
- [x] `initialize_context_state` 只提交 Mission、任务级计划及用户约束；`advance_step` 只激活下一 Step，不预建计划。
- [x] `plan_current_step` 仅为当前尚未规划的 Step 创建完整 SubState，并检验所有 Step 标准被 SubStep 覆盖。
- [x] SubState 以所属 `step_id` 为唯一身份，持久化为 `sub_states/<step_id>.json`；SubStep 只用 `covers` 引用 Step 标准，不再重复保存自己的 `completion_criteria`。
- [x] 每次成功修改 State 或 SubState 立即产生一个 `state.revision`，经可恢复事务原子落盘。`switch_context` 先将 `new_discovered_constraints` 中需要新增或替代的已确认约束一次提交（每项必填 `replaces`），再从最新快照开启新 Epoch；空列表不写状态，未变化文件不重写。旧 `EpochDeltaBuffer` 已删除。
- [x] Artifact 先暂存，只在已完成 SubStep 以 `produced` 引用它时同次提交；Continuation 更新也立即落盘。
- [x] 常驻 Context 在 Step 尚未规划时明确提示按需勘察；Epoch 内后续工具返回的新 revision 优先于 Epoch 起始快照。
- [x] 每次 `switch_context.reason` 都作为独立运行时 `switch_note` 进入下一 Epoch，已有 SubState／Continuation 时也保留；仅作辅助说明，不自动修改持久化状态。尚无 Continuation 时保留必要恢复线索，正式恢复仍以当前状态和 Continuation 为准；不新增持久化字段，收尾模式仍禁止创建计划。
- [x] 删除独立的常驻 token 预算；完整 Context 按模型窗口比例判断压力，默认 80%。常驻 token 计数只用于审计，Governor 与 Adapter 的相关配置同步移除。
- [x] `replan_task_criteria` 与 `replan_step_criteria` 将“旧标准标记 superseded、新标准追加、受影响 Pending 项的 changes 及 covers 更新”作为一次提交，复用 `revise_step`／`revise_substep` 的内部单项操作函数。旧标准原文及下标／ID、已完成 Step/SubStep 与证据均保留。
- [x] 单元测试覆盖初始化、规划、推进、即时落盘、stale revision、原子写入恢复、两级验收标准重规划、历史引用及 Artifact 同次提交；Governor 全量单元测试通过。

## 仍需验证

- [ ] 在真实 DSH/LOCA 失败案例上定向回归：确认 Agent 会在必要勘察后提交正确 Step 标准，并在新证据改变标准时主动调用对应重规划工具。以 LOCA 官方 Verifier 和持久化轨迹共同判断，不仅看工具调用成功。
- [ ] 观察更长任务中被替代的标准是否使常驻 Context 增大；若出现实际预算问题，再优化运行时视图，不提前加入截断机制。

## 不变量

- 任务级标准仅在 State 中；Step 级标准仅在对应 SubState 中。旧标准不覆盖或重排，避免旧 `covers` 指向新含义。
- 完成记录不可回写。新标准若旧成果无法满足，必须安排尚未执行的纠偏 Step/SubStep。
- Governor 验证引用与覆盖，不验证业务断言真假；工具需要当前 Session 的事件证据，Agent 对证据语义负责。
- 状态变更成功返回时已经落盘；写入中断由 `transition` 事务恢复。Agent 尚未通过工具提交的思考或草稿不属于可恢复状态。
