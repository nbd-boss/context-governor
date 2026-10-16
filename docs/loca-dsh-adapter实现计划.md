# LOCA–DSH Adapter 实现计划

本文定义 `E:\context\loca-dsh-adapter` 为 Context Governor 运行 LOCA-bench 验证计划所需的实验适配层，并固定其实现边界和推进顺序。

## 1. 目标与边界

Adapter 的职责是把 LOCA-bench 提供的任务环境接入 DSH，并在每次运行后收集可复核的评测证据。

```text
LOCA-bench
  任务环境、Mock MCP、最终 evaluator
        ↓
loca-dsh-adapter
  测试集选择、MCP 桥接、运行控制、证据收集、结构验证
        ↓
DSH + Context Governor
  正常执行任务
```

必须遵守以下边界：

```text
- 不修改 LOCA-bench 的任务、Mock MCP、环境生成或 evaluator。
- 不向 Context Governor 写入任何仅为 LOCA 服务的实验逻辑。
- Governor 不应知道自己正在参加哪一轮 Benchmark。
- Adapter 不实现 Governor 的 State、规划、Artifact、Epoch 或 History 领域规则；
  它只读取这些持久化结果并按验证计划检查。
- 每个实验运行必须可独立复核、可重放，并能与 baseline 在同一环境下公平比较。
```

## 2. 已冻结的实验对象

测试集定义以 [验证计划.md](验证计划.md) 为权威来源：

```text
15 个 LOCA 任务族
× seed {42, 456, 2024}
× 环境规模 {16K, 32K, 64K}
= 135 个 Governor 运行条件
```

同一组 135 个条件必须再以 DSH 原生上下文管理方式运行一次，形成 135 个 baseline 条件。完整对照实验共 270 次运行。

`16K`、`32K`、`64K` 是 LOCA 环境数据规模，不是模型 API 上下文窗口上限。模型、模型窗口、DSH revision、Governor revision 和 Adapter revision 必须在一次实验批次开始前固定并记录。

## 3. Adapter 的最终职责

每个运行条件都应由 Adapter 完成以下流程：

```text
读取固定测试集条目
→ 构造对应 LOCA 环境与冻结 Fixture
→ 按环境声明桥接所需 Mock MCP 到 DSH
→ 以 Governor on 或 baseline 模式启动 DSH 会话
→ 收集最终输出、原始轨迹、LOCA evaluator 结果
→ 读取 Governor 持久化工作区并执行结构验证
→ 写入统一的运行摘要与可审查证据包
```

Adapter 的输出只能是实验结果和验证结论；不得修改任务输出、替 Agent 完成任务，或为提高得分修改 Governor 的行为。

## 4. 分阶段实现

### P1. 固定测试集 Manifest 与批量展开（已完成）

在 Adapter 内维护一个不可由单次运行临时改变的测试集 manifest。它至少表达：

```json
{
  "suite": "governor-accuracy-45x3",
  "task_families": "all",
  "seeds": [42, 456, 2024],
  "context_scales_k": [16, 32, 64],
  "modes": ["governor", "baseline"]
}
```

批量展开器根据 LOCA 配置文件生成稳定的运行 ID，例如：

```text
CanvasListTestS2LEnv-seed42-32k-governor
CanvasListTestS2LEnv-seed42-32k-baseline
```

验收条件：

```text
- 恰好展开 135 个 Governor 条件和 135 个 baseline 条件。
- 每个任务族恰好包含 seed 42、456、2024。
- 每个实例恰好包含 16K、32K、64K。
- 运行 ID、config-index、seed 和规模之间可双向追溯。
```

### P2. Fixture 冻结与实验身份记录（已完成）

每个运行应使用与其任务、seed、规模唯一对应的 Fixture；同一条件的 Governor 与 baseline 必须复用同一份冻结数据。由于 16K、32K、64K 是不同的 LOCA 数据环境，本轮需要冻结 `15 × 3 × 3 = 135` 份 Fixture，而不是只冻结 45 份。

Adapter 在运行开始前记录：

```text
任务族、config-index、seed、LOCA 环境规模
Fixture 绝对路径、内容哈希
模型与模型窗口
DSH、Governor、Adapter 的版本或 Git revision
运行模式：governor / baseline
```

验收条件：同一条件的两个模式使用相同 Fixture 哈希；任何版本或 Fixture 缺失均使该运行标记为不可比较，而不是静默继续。

Adapter 还必须校验 LOCA 在任务声明中明确列出的只读 Fixture 输入（例如 `data_dir`）存在，避免 Windows 上环境初始化半途失败后，把只有日志文件的目录冻结成可运行 Fixture。`memory_file_path` 是允许 MCP 在首次使用时创建的可变存储，不作为生成前置条件。已有的旧 Fixture 不进行就地修补；应使用新目录重新生成。

当前有效的完整 Fixture 集位于 `E:\context\adapter-fixtures\governor-accuracy-45x3-v2`，包含 135 份经生成后复核的 Fixture 及其总 manifest。旧 `v1` 保留作排障证据，不参与实验。

### P2.5. LOCA 官方 Verifier 路由（已完成）

Adapter 不重写任何任务族的业务验收规则。每次运行结束后，它从当前 LOCA 配置读取 `env_class`，并解析该任务族已有的官方验证入口：

```text
env_class
→ 任务族目录
→ LOCA 的 check_local() 或 evaluation/main.py
→ 当前 Agent Workspace + 同一 Fixture 的 Ground Truth Workspace
→ accuracy 与 feedback
```

不同任务族的 Verifier 参数存在少量接口差异；这些差异仅由 Adapter 的调用路由处理，不能在 Adapter 内复制或替代 LOCA 的业务判断。官方 Verifier 无法解析或启动时，结果写为 `verifier_error` 且 `accuracy: null`，不得伪装成 Agent 任务失败。

验收条件：Canvas 的 `check_local()` 与非 Canvas 的 `evaluation/main.py` 都可由同一 Adapter 入口调用；Verifier 使用的 Agent Workspace 与 Ground Truth Workspace 必须属于当前同一个任务实例。

### P3. LOCA Mock MCP 桥接（已完成）

Adapter 根据 LOCA 配置中声明的 MCP 服务器，为 DSH 注册等价工具。实现顺序按覆盖测试集的收益推进：

```text
第一批：Canvas、Memory、Filesystem、Claim Done（已有能力，需回归验证）
第二批：Email、Excel、Google Sheet、Calendar
第三批：WooCommerce、Google Cloud、Snowflake、PDF Tools
第四批：Terminal、Python Execute
```

其中 Terminal 与 Python Execute 必须限定在该次 LOCA Agent Workspace 中执行，不能将任意宿主机能力暴露给任务。每个 MCP 桥接应独立于 Governor，并有针对输入、输出和副作用的适配测试。

Terminal 与 Python Execute 采用 Adapter 内的 Docker 隔离执行器：

```text
Agent MCP 调用
→ Adapter 的本地 MCP 进程
→ docker run（短生命周期）
→ 仅挂载本次 Agent Workspace 到 /workspace
```

容器使用 Adapter 自己构建并记录镜像 ID 的三个固定镜像：执行镜像、Excel MCP 镜像、PDF MCP 镜像。Excel 与 PDF 分开，是因为所选 PDF 服务依赖 MCP 1.x，而 Excel 依赖 MCP 2.x。每次执行禁用网络、移除 Linux capabilities、启用只读根文件系统和受限 tmpfs，并限制 CPU、内存、进程数与超时；不挂载 Docker socket、Fixture、ground truth 或其他宿主机目录。PDF 的临时目录固定在 Agent Workspace 内。Agent 只能通过该容器读写自己的 Workspace。批量运行前 Adapter 仅执行 `docker image inspect`，镜像不存在或 Docker 不可用时，两种模式都标为 `unsupported_environment`，不会隐式拉取镜像或启动模型。

当前已接入 Canvas、Memory、Filesystem、Claim Done、Email、Calendar、Google Sheet、Google Cloud、Snowflake、WooCommerce、Terminal、Python Execute、Excel 与 PDF Tools。Mock 数据服务仅接收本次冻结 Fixture 内的绝对数据目录，不获得通用宿主机读取权限；四类执行类工具均通过容器化 MCP 桥接。三份固定镜像已构建，Excel 与 PDF 的 DSH ACP dry-run 均已完成 MCP 同步验证；没有发送模型提示。

批量运行器在 Agent 启动前按任务声明预检 MCP 能力；不支持的两侧运行都会写入 `unsupported-environment.json`，并在 `batch-run.json` 中标为 `unsupported_environment`。它们不调用模型、不创建 DSH Session，也不进入 Governor / baseline 的指标对照。

验收条件：15 个任务族所声明的 MCP 都能被 Adapter 映射；不支持的 MCP 必须在运行前明确报为 `unsupported environment`，不得在 Agent 执行中静默缺失。

### P4. 统一运行控制（已实现，待真实批量运行）

批量运行器应支持单条件、单任务族、单规模和完整套件四种范围，并为每次运行创建独立目录。建议目录结构：

```text
adapter-runs/
  governor-accuracy-45x3-<batch-id>/
    manifest.json
    CanvasListTestS2LEnv-seed42-32k-governor/
      run.json
      fixture.json
      evaluation.json
      session/
      governor-verification.json
      review-bundle.json
```

每个运行条件必须成对支持以下两种模式：

```text
governor
→ 启动同一 DSH，并加载 Context Governor 插件；
→ 为该次运行指定独立的 Governor Session Workspace。

baseline
→ 启动同一 DSH，但不加载 Context Governor 插件；
→ 不创建、不读取 State、SubState、Artifact、Audit 或 Governor History Index；
→ 使用 DSH 原生的上下文构建、压缩或截断行为，不模拟 Governor。
```

两种模式只能在上下文管理机制上不同。Adapter 必须确保下列条件完全一致：

```text
LOCA 任务族、config-index、seed、环境规模与 Fixture 哈希
模型、模型参数、模型 API 上下文窗口
DSH revision、MCP 工具集合、工具 Schema 与工具返回内容
Agent Workspace、运行时限与基础设施失败处理规则
```

例如 `CanvasListTestS2LEnv / seed 42 / 32K` 必须产生一对可比较的运行：

```text
CanvasListTestS2LEnv-seed42-32k-governor
CanvasListTestS2LEnv-seed42-32k-baseline
```

对照时只允许比较上述完全配对的运行；任何环境、Fixture、模型或工具契约不一致的结果必须标记为 `not_comparable`。

验收条件：任一运行失败不会污染其他运行目录；运行器能明确区分任务失败、基础设施失败和不支持环境。

### P5. Governor 结构验证与 `governor-verification.json`（已实现，待套件运行复核）

LOCA evaluator 只验证最终任务输出。Adapter 需只读检查 Governor 工作区，并生成 `governor-verification.json`，至少包含：

```text
LOCA：evaluation.status、accuracy、feedback
生命周期：lifecycle.status、State revision、Step/SubStep 数量
Epoch：Epoch 数、切换次数、Continuation 次数、压力、切换原因
Artifact：数量、资源存在性、绝对路径、哈希、引用完整性、跨 Session 检查
持久化：State/SubState/Artifact/Audit 的引用关系、Delta 边界、Audit 顺序
工具：调用总数、成功数、Schema 失败数及失败分类
```

验证器只检查已定义的结构与不变量；它不重新推断业务事实，也不替代 Agent 对 Artifact 内容的判断。

验收条件：能自动标出跨 Session 引用、缺失资源、哈希不匹配、非法状态引用、未完成生命周期、Audit 缺失和边界提交异常。

### P6. 可审查证据包（已实现，待套件运行复核）

部分目标不能仅由 JSON 结构判断，例如任务完成标准是否被错误缩小、Artifact 的 `key_facts` 是否忠实概括数据、一次工具调用是否真正支持后续结论。

Adapter 应为每次运行输出紧凑的只读 `review-bundle.json`：

```text
原始任务要求
State 中的任务完成标准与 Step 摘要
每个 SubState 的已完成、当前和待执行 SubStep 摘要
Artifact 的 key_facts、资源摘要与引用关系
工具调用概要与失败概要
LOCA evaluator 结果
```

证据包引用原始 trace、资源和 Governor 工作区，不复制大段 History。它用于按固定抽样规则做语义核验，而不是供 Adapter 生成或修正 Agent 结论。

验收条件：审查者能不阅读整份 trace 即定位任一 Step、SubStep、Artifact 和工具调用的原始证据。

### P7. 汇总与对照报告（已完成）

批次完成后，Adapter 基于每个运行目录的机器可读结果生成汇总。报告至少按任务族、seed、规模和模式展示：

```text
有效运行数、基础设施失败数、任务成功率
生命周期与持久化不变量失败数
Artifact 完整性失败数、工具调用成功率、Schema 成功率
Epoch、切换、Continuation、Artifact 与检索读取数
token、耗时、工具调用总数（观察项）
```

对比 Governor 与 baseline 时，必须仅比较 Fixture 哈希、模型与窗口均一致的配对运行；不可比较的运行单独列出。

Adapter 已提供离线 `report-suite` 命令。它读取既有 `batch-run.json` 及每个运行目录中的 `run.json`、`evaluation.json`、`governor-verification.json`，输出 `suite-summary.json` 与 `suite-report.md`。报告明确区分“环境一致配对”和“可进行结果对比的配对”：若一侧没有完成 LOCA evaluator（例如基础设施失败或预算耗尽），即使 Fixture 与窗口相同，也不会被计入结果对比。

## 5. 推荐实施顺序

```text
P1 测试集 Manifest
→ P2 Fixture 冻结
→ P4 单条件运行目录与模式一致性
→ P5 Governor 结构验证
→ P6 审查证据包
→ P3 按任务族逐步扩展 MCP 桥接
→ P7 完整套件汇总与 Governor / baseline 对照
```

在 P3 覆盖全部 MCP 前，可使用当前已支持的 Canvas 任务进行冒烟验证；这类结果只能证明对应链路可运行，不能替代 135 条件的完整正确性结论。

## 6. 完成定义

Adapter 实现完成不等于 Governor 得分通过。Adapter 完成的定义是：

```text
- 能无修改 LOCA-bench、无实验逻辑侵入 Governor 地运行 45×3 固定条件；
- 能在完全相同的条件下运行 Governor 与 baseline；
- 能保存可复现的环境身份、输出、轨迹和评测证据；
- 能自动检查 Governor 的结构性不变量并导出审查证据包；
- 能生成可按任务族、规模、模式比较的汇总结果。
```
