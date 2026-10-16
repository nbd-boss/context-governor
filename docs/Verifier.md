# LOCA Verifier 接入原则

## 结论

Context Governor 不负责判断业务任务是否完成，LOCA-bench 也不需要为适配 DSH 而被修改。

每个 LOCA 任务族应使用它已经提供的官方 Verifier 和对应的 Ground Truth。`loca-dsh-adapter` 只负责根据当前任务定义找到并调用正确的 Verifier。

```text
当前 LOCA Task Definition
        ↓
任务族 / env_class
        ↓
Adapter 路由到该任务族的官方 Verifier
        ↓
传入该任务的 Agent Workspace 与 Ground Truth Workspace
        ↓
保存 LOCA 返回的 accuracy 与 feedback
```

## 职责边界

| 组件 | 职责 |
| --- | --- |
| LOCA-bench | 定义任务、生成 Ground Truth、提供任务族自己的验收逻辑。 |
| loca-dsh-adapter | 读取任务定义，路由并调用 LOCA 官方 Verifier，原样记录结果。 |
| DeepSeek Harness | 执行 Agent 与工具调用。 |
| Context Governor | 管理 Agent 的上下文、State、SubState 和 Artifact；不参与业务验收。 |

因此，Adapter 不应重写任何任务族的业务验证逻辑，也不应把一个任务族的 Verifier 用于其他任务族。

## 例子

```text
任务：ExcelMarketResearch
Agent 产物：一个 Excel 文件

正确流程：
Adapter → 调用 ExcelMarketResearch 在 LOCA 中已有的官方 Verifier
        → 用该任务自己的 Ground Truth 检查 Excel 内容
```

以下做法是错误的：

```text
任务：ExcelMarketResearch
Adapter → 调用 CanvasListTest 的 Verifier
        → 查找 quiz_info.csv 与 assignment_info.csv
        → 即使 Excel 任务实际完成，也会被误判失败
```

## 实现要求

1. Adapter 从当前任务定义读取任务族或 `env_class`。
2. Adapter 为该定义解析 LOCA 自带的官方验证入口。
3. Adapter 将当前运行的 Agent Workspace 与同一任务实例的 Ground Truth Workspace 传入该入口。
4. Adapter 保存官方 Verifier 返回的 `accuracy`、`feedback` 及必要的执行错误信息。
5. 无法解析或运行官方 Verifier 时，结果必须明确标记为评测基础设施错误，不能伪装成任务失败。

同一任务族在不同 seed 或 16K / 32K / 64K 规模下可以拥有不同的任务数据和 Ground Truth；但 Governor 与 baseline 在同一个“任务族 + seed + 规模”条件下，必须使用完全相同的冻结实例与官方 Verifier。

## Governor 的 Context 检查策略

LOCA 官方 Verifier 负责全量验证业务结果；它不判断 Context 切换是否合理。对 Governor 本身采用两层检查。

### 全量自动检查

每一个启用 Governor 的运行均应自动检查以下结构性不变量：

- 没有意外触发 DSH 原生压缩；
- State、SubState 与 Artifact 元数据可以解析；
- Artifact 引用的资源存在且可读取；
- State 与 SubState 的引用关系有效；
- Epoch 切换后，新窗口可以读取最新持久化状态；
- 不存在不允许的跨 Session 读取。

这些检查必须覆盖全部运行，不能依赖人工抽样。

### 分层人工抽查

Context 总结、切换时机和回查选择属于语义质量，适合从完整 Trace 中抽样审阅。抽样应覆盖不同类型的运行，而不是完全随机抽取：

- 没有切换 Context 的短任务；
- 仅切换一次的任务；
- 多次切换并回查 Artifact 的长任务；
- 16K、32K、64K 三种规模；
- 成功与失败任务；
- Token 或工具调用明显偏高的异常运行。

例如，只审阅一次完成且没有切换的任务，无法证明跨 Epoch 机制正确；而审阅一个发生三次切换、写入并回查 Artifact 的任务，可以核对 State、SubState、Artifact 与下一 Epoch 的上下文是否衔接一致。
