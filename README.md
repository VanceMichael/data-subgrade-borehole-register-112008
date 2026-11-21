# 岩土补勘样本的现场移交与入库判定

这里是可离线启动的合成上游，所有编号、时间和凭据都用于联调。

## 本地运行

使用 Node.js 22.23.4。项目只使用随 Node.js 提供的运行库。

```sh
npm start
npm test
```

不同终端分别启动服务和执行独立来源测试。默认地址为 `http://127.0.0.1:4173`，可通过 `SOURCE_PORT` 设置端口，也接受通用的 `PORT`，同时设置时以 `SOURCE_PORT` 为准。`GET /health` 用于确认来源服务已就绪。来源使用进程内演练时钟，启动时处于 `survey`。用 `PUT /_source_clock?step=incomplete` 推进到下一阶段，`GET /_source_calls` 查看本实例收到的业务请求。可查阶段为 `survey`、`incomplete`、`lab-revision`、`realignment`、`return`。重启服务会重置时钟和请求记录。预置的源端回执按演练阶段出现，和本地应用是否已处理某次回执是两回事。
`npm test` 核对可访问的上游响应和合成资料。

## 来源约定

外业页 `/field/W4?page=1` 返回 `next` 和标段版本。标段改线后复用 `/field/W4` 路径，外业原记录仍写各自采样时的版本。路线计划见 `/route/current`，对应表见 `/route/correspondences`。对应区间 [start,end) 同时约束旧桩号和深度，`confirmed` 表示工程师对指定路线版本的现场确认。
实验室 `/lab/intake` 的 `reference` 按承包方、送样批号和外业条码指认，条码字面仅为打印值。`/lab/splits` 中 `grams` 是认可净重，父样登记 `availableGrams` 不含已分样部分，作废以实验室为准。`/lab/reports` 中 `sample` 引用分样号，`replaces` 为替代的报告，`withdrawn` 为作废。接口返回当下所知的记录，`recordedAt` 可定位补交版本。
`/lab/retest-requests` 提供待办工单和实验室领样状态。待占用的工单以实验室受理时间、工单号顺序处理，同一工单多次受理也只计算一次。已领样重量已从父样现有净重扣除。

# 收件流程应用（`app/`）

应用把合成标段页面、实验室接口和路线对应表接成一条可追溯的收件链：外业来源页 → 收件编号 → 父子分样 → 报告 → 评审单。纯领域规则在 `app/domain.mjs`，证据判定在 `app/evidence.mjs`，均不依赖 HTTP，可直接单测。

```sh
npm start          # 终端 A：合成来源（默认 4173）
npm run app        # 终端 B：收件应用（默认 4180，SOURCE_URL 指来源）
npm run demo       # 单进程内联调五个演练阶段
npm test           # 领域/工作流单测 + 五阶段端到端测试 + 来源测试
```

## 关键判定口径

- **样本身份**：外业条码只在承包方+送样批次内唯一，内部以 `承包方|批次|条码` 三元组为键；同名钻孔、同面条码不构成同一证据。
- **改线挪用**：里程区间与土层深度区间同时约束（均左闭右开 `[from,to)`）。范围和深度唯一对应可直接挪用；一对多为歧义，需工程师确认，确认键内含新版本号，只对所注明路线版本生效。旧桩号、同名钻孔或一条正常读数本身都不足以证明新线路该深度已验。
- **台账完整性**：外业页按 `next` 链组装，短页、503、重复页或成环都让标段保持不完整，缺口评估统一带 `LEDGER_INCOMPLETE`，整批不得宣称齐全；恢复后重新同步即可。
- **逐项交卷**：按勘察计划的（地面点、深度区间、检验类型）逐行判定，点样只按深度落入的区间归层，结果不能移给相邻层。缺口四分类：`NOT_DELIVERED` / `RECEIVED_PENDING` / `CONFLICT` / `REDRILL`，另有 `VERIFIED`。
- **收件与封签**：只有实验室确认接收才有收件编号；封签不符的试样进差异（`SEAL_MISMATCH`），不建立可用收件映射。
- **净重账面**：以实验室认可净重为唯一口径。待领工单按受理时间、工单号排队逐单占用，余额不足即阻塞；本地补勘申请排在实验室已受理工单之后。同一样本可被两张工单引用，留足全部已占用净重才能再领。撤回只对未领样工单生效并释放占用；已确认分出的量不返还账面。
- **报告链**：`withdrawn` 永不生效；被 `replaces` 的报告即失效，替代件自身被撤销也不恢复原件，直到出现新的有效报告（演练中的 Z1 → Z4(撤销) → Z5）。兄弟分样作废不连带失效已采用的其他报告。
- **评审单**：冻结时固化来源页、路线版本、确认关系与完整收件链快照。之后报告撤销/父样来源更正只影响后续待签与补勘决策（`/reviews/:id/impact`、事件日志），旧版评审单仍按当时资料查证。
- **三个独立条件**：报告验毕（`/conditions/reports`）、评审采信（`/conditions/adoption`）、可再分样（`/intakes/:id/resplit`）各自判定，互不替代。

## HTTP 接口（默认 4180）

| 方法与路径 | 用途 |
| --- | --- |
| `POST /sync` | 从来源同步外业台账、路线、实验室全量资料，返回变化摘要 |
| `GET /gaps` | 当前路线版本逐点逐层逐检验的缺口、原因与证据链 |
| `GET /mapping` | 每个外业样本到现版本地面点的对应状态与候选对应关系 |
| `GET /discrepancies` | 封签不符、孤儿收件/分样/报告、外业重复冲突等差异 |
| `POST /mappings/confirm` | 工程师确认歧义对应（体里带完整对应关系，版本不符即拒绝） |
| `POST /reviews` · `POST /reviews/:id/freeze` · `GET /reviews/:id` | 评审单起草、冻结、查快照 |
| `GET /reviews/:id/impact` | 冻结后影响该评审单的证据失效事件 |
| `GET /conditions/reports` · `/conditions/adoption` | 报告验毕、评审采信两个独立条件 |
| `POST /retest-requests` | 补勘人员申请现有样品复验（支持 `idempotencyKey`） |
| `POST /retest-requests/:id/withdraw` | 撤回未领样工单；已领样返回 409 |
| `GET /intakes/:id/retest-queue` · `/resplit` | 工单排队占用与可再分样净重 |
| `GET /reports` · `GET /events` | 报告有效性台账、领域事件日志 |

