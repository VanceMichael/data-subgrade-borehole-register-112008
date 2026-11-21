import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItemStatus } from '../app/domain.mjs';
import { createStore } from '../app/store.mjs';
import { syncEngine } from '../app/sync.mjs';
import { createWorkflow } from '../app/workflow.mjs';
import { createUpstream } from '../app/upstream.mjs';

const PLAN = {
  alignment: 'R1',
  points: { P1: 2350 },
  requirements: [{ point: 'P1', fromDepth: 2, toDepth: 5, tests: ['salt'] }],
};
const FIELD = {
  catalog: 'F1', next: null,
  entries: [
    { contractor: 'D1', lot: 'S1', barcode: 'T17', alignment: 'R1', chainage: 2350, bore: 'K1', depth: 3.1, seal: 'A6' },
  ],
};
const INTAKE = [{ intake: 'L1', reference: ['D1', 'S1', 'T17'], accepted: true, seal: 'A6', availableGrams: 300 }];
const SPLITS = [{ id: 'Q1', parent: 'L1', grams: 100 }];
const REPORTS = [{ id: 'Z1', sample: 'Q1', type: 'salt', value: 0.8, recordedAt: 't1' }];

function makeUpstream(overrides = {}) {
  const data = { plan: PLAN, field: FIELD, intake: INTAKE, splits: SPLITS, reports: REPORTS, retest: [], ...overrides };
  const fetcher = async (url) => {
    const u = new URL(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
    if (u.pathname.startsWith('/field/')) return json(data.field);
    if (u.pathname === '/route/current') return json(data.plan);
    if (u.pathname === '/route/correspondences') return json([]);
    if (u.pathname === '/lab/intake') return json(data.intake);
    if (u.pathname === '/lab/splits') return json(data.splits);
    if (u.pathname === '/lab/reports') return json(data.reports);
    if (u.pathname === '/lab/retest-requests') return json(data.retest);
    return json({}, 404);
  };
  return createUpstream('http://fake', fetcher);
}

async function setup(overrides = {}) {
  const store = createStore();
  const engine = syncEngine(makeUpstream(overrides), store);
  await engine.syncAll({ catalogs: ['W4'] });
  return { store, engine, workflow: createWorkflow(store) };
}

test('重复采集：同一外业条目重复同步不新增样本、不额外占用复验份额', async () => {
  const real = await setup();
  await real.engine.syncAll({ catalogs: ['W4'] });
  await real.engine.syncAll({ catalogs: ['W4'] });
  assert.equal(real.store.state.fieldByKey.size, 1);
  const apply = () => real.workflow.applyRetest({ intake: 'L1', grams: 50, idempotencyKey: 'k' });
  const first = apply();
  const second = apply();
  assert.equal(first.order.id, second.order.id);
  assert.equal(real.workflow.retestQueue('L1').reserved, 50);
});

test('重复采集不能替换已签出（冻结）的结果', async () => {
  const { store, engine, workflow } = await setup();
  const sheet = workflow.createReviewSheet();
  workflow.freezeReviewSheet(sheet.id);
  const adoptedBefore = [...workflow.getReviewSheet(sheet.id).adoptedIds];

  // 外业补交一条“重复采集”：同桩号同深度的新条码，带新报告
  const field2 = {
    catalog: 'F1', next: null,
    entries: [
      ...FIELD.entries,
      { contractor: 'D1', lot: 'S1', barcode: 'T18', alignment: 'R1', chainage: 2350, bore: 'K1', depth: 3.1, seal: 'A7' },
    ],
  };
  const engine2 = syncEngine(makeUpstream({
    field: field2,
    intake: [...INTAKE, { intake: 'L9', reference: ['D1', 'S1', 'T18'], accepted: true, seal: 'A7', availableGrams: 200 }],
    splits: [...SPLITS, { id: 'Q9', parent: 'L9', grams: 80 }],
    reports: [...REPORTS, { id: 'Z9', sample: 'Q9', type: 'salt', value: 0.9, recordedAt: 't2' }],
  }), store);
  await engine2.syncAll({ catalogs: ['W4'] });

  // 冻结快照里的采信结果不变
  assert.deepEqual(workflow.getReviewSheet(sheet.id).adoptedIds, adoptedBefore);
  // 当前评估两条证据并列，原报告仍然有效，不被替换
  const gaps = workflow.currentGaps();
  const item = gaps.items[0];
  assert.equal(item.status, ItemStatus.VERIFIED);
  assert.ok(item.validEvidence.includes('Z1'));
  assert.ok(item.validEvidence.includes('Z9'));
  assert.equal(item.evidence.find((e) => e.report === 'Z1').state, 'EFFECTIVE');
});

test('三个条件互相独立：报告验毕不等于评审采信，也不等于可再分样', async () => {
  const { workflow } = await setup({
    intake: [{ ...INTAKE[0], availableGrams: 0 }],
  });
  const reports = workflow.reportCompletion();
  assert.equal(reports.satisfied, true); // 报告都回来了
  const adoption = workflow.reviewAdoption();
  assert.equal(adoption.satisfied, false); // 还没有冻结评审单
  const resplit = workflow.resplitAvailability('L1');
  assert.equal(resplit.canResplit(1), false); // 净重为零，不能再分样
  // 冻结并采信后，报告条件与采信条件同时成立，但可再分样仍为否
  const sheet = workflow.createReviewSheet();
  workflow.freezeReviewSheet(sheet.id);
  assert.equal(workflow.reviewAdoption().satisfied, true);
  assert.equal(workflow.reportCompletion().satisfied, true);
  assert.equal(workflow.resplitAvailability('L1').freeAfterReservations, 0);
});

test('复验申请被拒场景：封签拒收试样不能申请复验', async () => {
  const { workflow } = await setup({
    intake: [{ ...INTAKE[0], accepted: false, seal: 'BAD', availableGrams: 0 }],
  });
  assert.throws(() => workflow.applyRetest({ intake: 'L1', grams: 10 }), (e) => e.code === 'INTAKE_REJECTED');
});

test('深度边界：样本恰好落在区间右端点不算本层证据', async () => {
  const { workflow } = await setup({
    plan: {
      alignment: 'R1', points: { P1: 2350 },
      requirements: [
        { point: 'P1', fromDepth: 2, toDepth: 5, tests: ['salt'] },
        { point: 'P1', fromDepth: 5, toDepth: 7, tests: ['salt'] },
      ],
    },
    field: { catalog: 'F1', next: null, entries: [{ ...FIELD.entries[0], depth: 5 }] },
  });
  const gaps = workflow.currentGaps();
  const upper = gaps.items.find((i) => i.depth.label === '[5,7)');
  const lower = gaps.items.find((i) => i.depth.label === '[2,5)');
  assert.equal(upper.status, ItemStatus.VERIFIED); // 5 属于 [5,7)
  assert.equal(lower.status, ItemStatus.NOT_DELIVERED); // 5 不属于 [2,5)
});
