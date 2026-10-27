# Step 验收标准与 SubStep 规划顺序

## 目标顺序

任务初始化时，Agent 根据用户要求确定 Mission、任务级验收标准和主要 Step；不预先猜测每个 Step 所依赖的外部系统细节。

每次进入一个 Step（包括首个 Step）后，按以下顺序工作：

1. 明确当前 Step 的目标，以及它覆盖的任务级验收标准。
2. 判断完成标准是否依赖尚未确认的环境、数据结构、业务规则或现有状态。只在有必要时，先进行有边界的勘察；已有可靠证据足够时直接复用，不重复查询。
3. Agent 根据用户要求、相关规范和勘察所得的直接证据，确认当前 Step 的 `step_completion_criteria`。字段存在或名称相似本身不足以推断业务义务；证据不足的内容不能写成已确认的标准。
4. 以已经确认的标准反推当前 Step 的 SubStep，检查每条标准均被覆盖，再开始执行。Governor 负责结构校验，不代替 Agent 判断业务含义。
5. 执行期间每次成功更新 State／SubState 都立即原子落盘；Artifact 与其生产 SubStep 同次提交。切换 Context 时从最新持久化快照重新加载。

简写为：

```text
初始化任务级计划
→ 进入当前 Step
→ 必要时勘察并确认依据
→ 确定该 Step 的验收标准
→ 规划 SubStep
→ 执行与验证
→ 进入下一 Step，重复上述过程
```

## 例子

任务要求找出符合条件的新客户、同步到 BigQuery，并发送欢迎邮件。任务级计划可以先包含“识别客户”“同步客户”“发送欢迎邮件”等 Step，而不预设 BigQuery 中每个字段的含义。

进入“发送欢迎邮件”Step 时，Agent 先查阅相关资料和系统状态。如果有直接依据确认“发信后还必须更新并回读 CRM 的发送状态”，再确定该 Step 的标准：

```json
{
  "step_completion_criteria": [
    "全部目标客户收到符合模板的欢迎邮件。",
    "发信后，BigQuery 中目标客户的发送状态和日期已更新，并经回读确认。"
  ],
  "sub_steps": [
    { "action": "发送欢迎邮件并核对发送结果。", "covers_criterion_indexes": [0] },
    { "action": "更新并回读 BigQuery 中的发送状态。", "covers_criterion_indexes": [1] }
  ]
}
```

这里仅展示规划关系，省略正式工具参数中的其他字段。若没有证据证明 BigQuery 状态属于任务要求，不能仅凭 `welcome_email_sent`、`welcome_email_date` 两个字段的存在添加第二条标准。

## 当前实现与所需调整

当前初始化与 Step 推进只激活 Step，允许尚无 SubState；完成必要勘察后用 `plan_current_step` 提交标准和详细计划。`revise_substep` 每次调整一个待执行 SubStep；标准修订使用 `replan_step_criteria`，与受影响的计划操作一起提交。

已落实的目标顺序将“进入 Step”与“提交该 Step 的标准和 SubStep 计划”分开：

1. 初始化或推进时只激活 Step，不要求提交尚无依据的完整 Step 计划。
2. 允许当前 Step 在规划前有一个明确的未规划状态；该状态可读取必要资料，但不能推进 SubStep 或宣称 Step 已完成。不要用虚构的验收标准或勘察 SubStep 填补空位。
3. 在勘察完成后，由 Agent 一次提交该 Step 的 `step_completion_criteria` 和覆盖它们的 SubStep 计划；沿用现有的规划校验及 ID 分配。
4. 让未规划状态和已规划状态都能安全跨 Epoch 切换、持久化及重新加载；不新增一份重复保存验收标准的权威数据。
5. 执行中通过单项操作调整 Pending SubStep；证据改变标准时，通过验收标准工具将标准和受影响的计划修改一次提交。

## 验证重点

- 首个 Step 和后续 Step 都能先勘察、再提交标准及 SubStep 计划。
- 未规划 Step 无法调用进度完成操作；规划提交后，每条 Step 标准都被 SubStep 覆盖。
- 勘察所得但缺少依据的推断不会自动成为验收标准。
- Epoch 切换前后，当前 Step 的规划状态、已确认标准及执行进度一致。
- 已有的 SubStep 推进、Pending SubStep 重规划、Artifact 和任务终态流程不回归。
