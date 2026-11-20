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
