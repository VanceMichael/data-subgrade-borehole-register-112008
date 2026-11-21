import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItemStatus, WorkflowError } from '../app/domain.mjs';
import { createStore } from '../app/store.mjs';
import { syncEngine } from '../app/sync.mjs';
import { createWorkflow } from '../app/workflow.mjs';
import { createUpstream } from '../app/upstream.mjs';

const R1_PLAN = {
  alignment: 'R1',
  points: { P1: 2350, P2: 2490 },
  requirements: [
    { point: 'P1', fromDepth: 2, toDepth: 5, tests: ['salt', 'moisture'] },
    { point: 'P1', fromDepth: 5, toDepth: 7, tests: ['moisture'] },
  ],
};

const FIELD_PAGE_1 = {
  catalog: 'F1', next: '/field/W4?page=2',
  entries: [
    { contractor: 'D1', lot: 'S1', barcode: 'T17', alignment: 'R1', chainage: 2350, bore: 'K1', depth: 3.1, seal: 'A6' },
    { contractor: 'D1', lot: 'S1', barcode: 'T28', alignment: 'R1', chainage: 2350, bore: 'K1', depth: 5.6, seal: 'B7' },
  ],
};
const FIELD_PAGE_2 = {
  catalog: 'F1', next: null,
  entries: [
    { contractor: 'D2', lot: 'S9', barcode: 'T17', alignment: 'R1', chainage: 2490, bore: 'K1', depth: 4.4, seal: 'X1' },
  ],
};

const INTAKE_OK = [
  { intake: 'L1', reference: ['D1', 'S1', 'T17'], accepted: true, seal: 'A6', availableGrams: 320 },
  { intake: 'L2', reference: ['D1', 'S1', 'T28'], accepted: true, seal: 'B7', availableGrams: 200 },
  { intake: 'L3', reference: ['D2', 'S9', 'T17'], accepted: false, seal: 'X9', availableGrams: 0 },
];
const SPLITS_OK = [
  { id: 'Q1', parent: 'L1', grams: 120 },
  { id: 'Q2', parent: 'L1', grams: 60 },
  { id: 'Q3', parent: 'L2', grams: 100 },
];
const REPORTS_OK = [
  { id: 'Z1', sample: 'Q1', type: 'salt', value: 0.8, recordedAt: 't1' },
  { id: 'Z2', sample: 'Q2', type: 'moisture', value: 8.4, recordedAt: 't1' },
  { id: 'Z3', sample: 'Q3', type: 'moisture', value: 9.1, recordedAt: 't1' },
];
const RETEST_OK = [
  { id: 'W-1', intake: 'L1', grams: 200, status: 'requested', receivedAt: '2026-12-03T10:15:00Z' },
  { id: 'W-2', intake: 'L1', grams: 140, status: 'requested', receivedAt: '2026-12-03T10:20:00Z' },
];

function fakeUpstream(overrides = {}) {
  const data = {
    fieldPages: { 1: FIELD_PAGE_1, 2: FIELD_PAGE_2 },
    fieldFail: {},
    plan: R1_PLAN,
    correspondences: [],
    intake: INTAKE_OK,
    splits: SPLITS_OK,
    reports: REPORTS_OK,
    retest: RETEST_OK,
    ...overrides,
  };
  const fetcher = async (url) => {
    const u = new URL(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    if (u.pathname.startsWith('/field/')) {
      const page = Number(u.searchParams.get('page'));
      if (data.fieldFail[page]) return json({ message: '来源暂不可用' }, 503);
      return json(data.fieldPages[page]);
    }
    if (u.pathname === '/route/current') return json(data.plan);
    if (u.pathname === '/route/correspondences') return json(data.correspondences);
    if (u.pathname === '/lab/intake') return json(data.intake);
    if (u.pathname === '/lab/splits') return json(data.splits);
    if (u.pathname === '/lab/reports') return json(data.reports);
    if (u.pathname === '/lab/retest-requests') return json(data.retest);
    return json({ message: 'not found' }, 404);
  };
  return { client: createUpstream('http://fake', fetcher), data };
}

async function syncedStore(overrides = {}) {
  const store = createStore();
  const { client } = fakeUpstream(overrides);
  const engine = syncEngine(client, store);
  await engine.syncAll({ catalogs: ['W4'] });
  return { store, workflow: createWorkflow(store) };
}

test('完整同步后逐项交卷：两层三检验均 VERIFIED，封签不符进差异', async () => {
  const { workflow } = await syncedStore();
  const gaps = workflow.currentGaps();
  assert.equal(gaps.complete, true);
  assert.equal(gaps.items.length, 3);
  assert.ok(gaps.items.every((i) => i.status === ItemStatus.VERIFIED));
  assert.deepEqual(gaps.items.map((i) => i.validEvidence).flat().sort(), ['Z1', 'Z2', 'Z3']);
  assert.ok(gaps.discrepancies.some((d) => d.type === 'SEAL_MISMATCH' && d.intake === 'L3'));
  // 拒收试样没有收件编号映射
  assert.equal(workflow.evidence().resolvedField.find((r) => r.entry.barcode === 'T17' && r.entry.contractor === 'D2').intakeId, null);
});

test('点样按落在区间判断：5.6 只属于 [5,7)，不能把结果移给相邻层', async () => {
  const { workflow } = await syncedStore();
  const gaps = workflow.currentGaps();
  const upper = gaps.items.find((i) => i.depth.label === '[5,7)');
  const lowerMoisture = gaps.items.find((i) => i.depth.label === '[2,5)' && i.test === 'moisture');
  assert.deepEqual(upper.validEvidence, ['Z3']);
  assert.deepEqual(lowerMoisture.validEvidence, ['Z2']);
});

test('台账短页：整批不得宣称齐全，缺口带 LEDGER_INCOMPLETE 原因', async () => {
  const { workflow } = await syncedStore({ fieldFail: { 2: true } });
  const gaps = workflow.currentGaps();
  assert.equal(gaps.sectionIncomplete, true);
  assert.equal(gaps.complete, false);
  assert.ok(gaps.items.every((i) => i.reasons.includes('LEDGER_INCOMPLETE')));
});

test('重复加载外业页不重复计数，同主键内容冲突留差异', async () => {
  const store = createStore();
  const { client } = fakeUpstream();
  const engine = syncEngine(client, store);
  await engine.syncAll({ catalogs: ['W4'] });
  const firstCount = store.state.fieldByKey.size;
  await engine.syncAll({ catalogs: ['W4'] });
  assert.equal(store.state.fieldByKey.size, firstCount);
  // 同三元组但封签变化 -> 冲突留痕，仍只有一条
  store.upsertFieldEntry({ ...FIELD_PAGE_1.entries[0], seal: 'ZZ' }, 'W4');
  assert.equal(store.state.fieldByKey.size, firstCount);
  assert.ok(store.state.fieldConflictKeys.has('D1|S1|T17'));
});

test('复验份额：W-1 先占 200，W-2 因余额不足阻塞', async () => {
  const { workflow } = await syncedStore();
  const queue = workflow.retestQueue('L1');
  assert.equal(queue.reserved, 200);
  assert.equal(queue.queue.find((q) => q.id === 'W-2').blocked, true);
  const avail = workflow.resplitAvailability('L1');
  assert.equal(avail.canResplit(120), true);
  assert.equal(avail.canResplit(121), false);
});

test('撤回未领工单释放占用；已领样工单不可撤回、已分出量不返还', async () => {
  const { workflow } = await syncedStore();
  workflow.withdrawRetest('W-1');
  let queue = workflow.retestQueue('L1');
  // W-1 释放 200 后，W-2 的 140 获得份额并成为唯一占用
  assert.equal(queue.reserved, 140);
  assert.equal(queue.queue.find((q) => q.id === 'W-2').feasible, true);
  assert.equal(queue.withdrawn[0].id, 'W-1');
  // W-2 仍未领样，也可以撤回，撤回后占用清零
  workflow.withdrawRetest('W-2');
  queue = workflow.retestQueue('L1');
  assert.equal(queue.reserved, 0);
  assert.equal(queue.queue.length, 0);
  // 构造一个已领样（实验室已确认分出）的本地工单，撤回必须被拒绝
  const issued = workflow.applyRetest({ intake: 'L1', grams: 10, idempotencyKey: 'k-issued' });
  issued.order.status = 'issued';
  issued.order.split = 'QX';
  let withdrawIssued = null;
  try {
    workflow.withdrawRetest(issued.order.id);
  } catch (error) {
    withdrawIssued = error;
  }
  assert.ok(withdrawIssued, '已领样工单撤回应当抛错');
  assert.equal(withdrawIssued.code, 'ALREADY_ISSUED');
});

test('幂等申请：同一 idempotencyKey 不重复占用；两份不同工单都计入占用', async () => {
  const { workflow, store } = await syncedStore();
  const a = workflow.applyRetest({ intake: 'L1', grams: 50, idempotencyKey: 'same' });
  const b = workflow.applyRetest({ intake: 'L1', grams: 50, idempotencyKey: 'same' });
  assert.equal(a.order.id, b.order.id);
  assert.equal(b.duplicated, true);
  workflow.applyRetest({ intake: 'L1', grams: 30, idempotencyKey: 'other' });
  const queue = workflow.retestQueue('L1');
  assert.equal(queue.reserved, 200 + 50 + 30); // 源端 200 + 本地 50 + 30
  assert.equal(store.state.retestOrders.size, 4); // W-1、W-2 加两条本地（同键去重一条）
});

test('冻结评审单不可改写；证据失效后快照仍可查证，但后续决策反映失效', async () => {
  const store = createStore();
  const { client } = fakeUpstream();
  const engine = syncEngine(client, store);
  await engine.syncAll({ catalogs: ['W4'] });
  const workflow = createWorkflow(store);
  const sheet = workflow.createReviewSheet({ notes: '评审' });
  workflow.freezeReviewSheet(sheet.id);
  assert.deepEqual(sheet.adoptedIds.sort(), ['Z1', 'Z2', 'Z3']);
  // 冻结即终态，再次冻结必须被拒绝
  let frozeAgain = null;
  try {
    workflow.freezeReviewSheet(sheet.id);
  } catch (error) {
    frozeAgain = error;
  }
  assert.ok(frozeAgain, '重复冻结应当抛错');
  assert.equal(frozeAgain.code, 'ALREADY_FROZEN');

  // 实验室撤销 Z1 的替代件场景：Z4 替代 Z1 且自身 withdrawn（经同步引擎产生事件）
  await engine.syncLab({
    intake: INTAKE_OK,
    splits: SPLITS_OK,
    reports: [...REPORTS_OK, { id: 'Z4', sample: 'Q1', type: 'salt', replaces: 'Z1', withdrawn: true, recordedAt: 't2' }],
    retestRequests: RETEST_OK,
  });
  const impact = workflow.impactOnReview(sheet.id);
  assert.ok(impact.lostAdoptedReports.some((e) => e.id === 'Z1'));
  assert.equal(impact.pendingDecisionsMustReflect, true);
  // 冻结快照原样保留
  assert.deepEqual(workflow.getReviewSheet(sheet.id).adoptedIds.sort(), ['Z1', 'Z2', 'Z3']);
  // 当前缺口：盐份变为 REDRILL（有料可复验）
  const gaps = workflow.currentGaps();
  const salt = gaps.items.find((i) => i.test === 'salt');
  assert.equal(salt.status, ItemStatus.REDRILL);
  assert.equal(salt.retestable, true);
  // 评审采信条件已不满足
  assert.equal(workflow.reviewAdoption().satisfied, false);
});

test('兄弟分样作废不使已采用的报告失效；但作废分样自身报告不再支撑交卷', async () => {
  const { store, workflow } = await syncedStore();
  // Q2 作废，Z2 失去支撑；Q1/Z1 不受影响
  store.upsertSplit({ id: 'Q2', parent: 'L1', grams: 60, voided: true });
  const gaps = workflow.currentGaps();
  const moisture = gaps.items.find((i) => i.test === 'moisture' && i.depth.label === '[2,5)');
  assert.equal(moisture.status, ItemStatus.REDRILL);
  assert.ok(moisture.reasons.includes('SPLIT_VOID'));
  const salt = gaps.items.find((i) => i.test === 'salt');
  assert.equal(salt.status, ItemStatus.VERIFIED);
});

test('实验室更正父样来源产生事件并影响后续决策', async () => {
  const store = createStore();
  const upstream = fakeUpstream();
  const engine = syncEngine(upstream.client, store);
  const workflow = createWorkflow(store);
  await engine.syncAll({ catalogs: ['W4'] });
  // 实验室把 L1 的来源指到另一个承包方批次条码
  await engine.syncLab({
    intake: INTAKE_OK.map((i) => i.intake === 'L1'
      ? { ...i, reference: ['D1', 'S1', 'T99'] }
      : i),
    splits: SPLITS_OK,
    reports: REPORTS_OK,
    retestRequests: RETEST_OK,
  });
  assert.ok(store.events.some((e) => e.type === 'intake.source-corrected'));
  const gaps = workflow.currentGaps();
  // 原 T17 不再有收件，盐份/下层湿度退回待送或重取
  const salt = gaps.items.find((i) => i.test === 'salt');
  assert.notEqual(salt.status, ItemStatus.VERIFIED);
});

test('工程师确认绑定当前路线版本，跨版本确认被拒绝', async () => {
  const c = { old: 'R1', new: 'R2', start: 2340, end: 2370, minDepth: 2, maxDepth: 5, point: 'P3', confirmed: false };
  const { store, workflow } = await syncedStore({
    plan: { ...R1_PLAN, alignment: 'R1' },
    correspondences: [c],
  });
  // 当前版本 R1，不能确认 R2 的关系
  assert.throws(() => workflow.confirmMapping({ ...c, new: 'R2' }), (e) => e.code === 'VERSION_MISMATCH');
  store.setPlan({ ...R1_PLAN, alignment: 'R2' });
  const result = workflow.confirmMapping(c, '工程师甲');
  assert.equal(result.scope, 'R2');
  assert.ok(workflow.isConfirmed(c));
});

test('缺口四分类：未送样 / 已接收未出结果 / 冲突 / 必须重取', async () => {
  // 去掉所有报告 -> 已接收未出结果
  const { workflow: w1 } = await syncedStore({ reports: [] });
  const g1 = w1.currentGaps();
  assert.ok(g1.buckets.RECEIVED_PENDING.length >= 2);
  // 净重耗尽 + 证据失效 -> MATERIAL_EXHAUSTED
  const { store, workflow: w2 } = await syncedStore({ intake: [{ ...INTAKE_OK[0], availableGrams: 0 }] });
  store.upsertReport({ id: 'Z4', sample: 'Q1', type: 'salt', replaces: 'Z1', withdrawn: true });
  const salt = w2.currentGaps().items.find((i) => i.test === 'salt');
  assert.equal(salt.status, ItemStatus.REDRILL);
  assert.ok(salt.reasons.includes('MATERIAL_EXHAUSTED'));
  // 封签不符 -> CONFLICT：收件记录保留但被拒收，没有有效报告
  const { workflow: w3 } = await syncedStore({
    intake: [{ ...INTAKE_OK[0], accepted: false, seal: 'BAD' }, INTAKE_OK[1], INTAKE_OK[2]],
    reports: REPORTS_OK.filter((r) => r.sample !== 'Q1'),
    splits: SPLITS_OK.filter((s) => s.parent !== 'L1'),
  });
  const conflict = w3.currentGaps().items.find((i) => i.test === 'salt');
  assert.equal(conflict.status, ItemStatus.CONFLICT);
  assert.ok(conflict.reasons.includes('SEAL_MISMATCH'));
});

test('WorkflowError 携带业务码', () => {
  const e = new WorkflowError('X', 'msg');
  assert.equal(e.code, 'X');
});
