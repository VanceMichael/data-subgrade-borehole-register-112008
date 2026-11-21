import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ItemStatus,
  MappingStatus,
  canResplit,
  confirmationKey,
  correspondenceId,
  effectiveReports,
  inside,
  planRetestQueue,
  reportState,
  resolveSample,
  sampleKey,
} from '../app/domain.mjs';

const planR2 = {
  alignment: 'R2',
  points: { P3: 2310, P4: 2380 },
  requirements: [],
};
const planR1 = { alignment: 'R1', points: { P1: 2350 }, requirements: [] };

const cP3 = { old: 'R1', new: 'R2', start: 2340, end: 2370, minDepth: 2, maxDepth: 5, point: 'P3', confirmed: false };
const cP4 = { old: 'R1', new: 'R2', start: 2340, end: 2360, minDepth: 3, maxDepth: 5, point: 'P4', confirmed: false };
const correspondences = [cP3, cP4];

const sampleT17 = { contractor: 'D1', lot: 'S1', barcode: 'T17', alignment: 'R1', chainage: 2350, depth: 3.1 };
const sampleT28 = { contractor: 'D1', lot: 'S1', barcode: 'T28', alignment: 'R1', chainage: 2350, depth: 5.6 };

test('左闭右开：边界值落在正确一侧', () => {
  assert.equal(inside(2, 2, 5), true); // 左闭
  assert.equal(inside(5, 2, 5), false); // 右开
  assert.equal(inside(3.1, 2, 5), true);
});

test('条码身份仅在承包方+批次内唯一：三元组区分同名条码/同名钻孔', () => {
  assert.notEqual(sampleKey({ contractor: 'D1', lot: 'S1', barcode: 'T17' }),
    sampleKey({ contractor: 'D2', lot: 'S9', barcode: 'T17' }));
});

test('改线后同一样本命中多条对应关系 -> 歧义，不能自动挪用', () => {
  const r = resolveSample(sampleT17, 'R2', planR2, correspondences);
  assert.equal(r.status, MappingStatus.AMBIGUOUS);
  assert.equal(r.point, null);
  assert.equal(r.matches.length, 2);
});

test('工程师确认歧义关系后可定案，且确认绑定路线版本', () => {
  const confirmations = new Set([confirmationKey(cP3)]);
  const r = resolveSample(sampleT17, 'R2', planR2, correspondences, confirmations);
  assert.equal(r.status, MappingStatus.CONFIRMED);
  assert.equal(r.point, 'P3');
  // 同一确认对 R3 不生效
  const r3 = resolveSample(sampleT17, 'R3', { ...planR2, alignment: 'R3' },
    correspondences.map((c) => ({ ...c, new: 'R3' })), confirmations);
  assert.notEqual(r3.status, MappingStatus.CONFIRMED);
});

test('多条对应关系都被确认 -> 资料冲突，仍不可挪用', () => {
  const confirmations = new Set([confirmationKey(cP3), confirmationKey(cP4)]);
  const r = resolveSample(sampleT17, 'R2', planR2, correspondences, confirmations);
  assert.equal(r.status, MappingStatus.CONFLICT);
  assert.equal(r.point, null);
});

test('深度超出对应表可复用深度 -> 不可挪用（旧桩号+正常读数不足以证明新线路该深度已验）', () => {
  const r = resolveSample(sampleT28, 'R2', planR2, correspondences);
  assert.equal(r.status, MappingStatus.NONE);
});

test('里程超出对应区间同样不可挪用', () => {
  const far = { ...sampleT17, chainage: 2380 };
  const r = resolveSample(far, 'R2', planR2, correspondences);
  assert.equal(r.status, MappingStatus.NONE);
});

test('同版本按桩号直接对应到地面点', () => {
  const r = resolveSample({ alignment: 'R1', chainage: 2350, depth: 3.1 }, 'R1', planR1, []);
  assert.equal(r.status, MappingStatus.DIRECT);
  assert.equal(r.point, 'P1');
});

test('唯一对应（范围+深度都唯一）可直接挪用', () => {
  const r = resolveSample({ ...sampleT17, chainage: 2365 }, 'R2', planR2, correspondences);
  assert.equal(r.status, MappingStatus.UNIQUE);
  assert.equal(r.point, 'P3');
});

test('报告链：被替代即失效；替代件被撤销也不恢复原件，直到出现新有效报告', () => {
  const z1 = { id: 'Z1', sample: 'Q1', type: 'salt' };
  const z4 = { id: 'Z4', sample: 'Q1', type: 'salt', replaces: 'Z1', withdrawn: true };
  const z5 = { id: 'Z5', sample: 'Q4', type: 'salt' };
  assert.deepEqual(effectiveReports([z1, z4]).map((r) => r.id), []);
  assert.equal(reportState(z1, [z1, z4]), 'SUPERSEDED');
  assert.equal(reportState(z4, [z1, z4]), 'WITHDRAWN');
  assert.deepEqual(effectiveReports([z1, z4, z5]).map((r) => r.id), ['Z5']);
});

test('复验工单按受理时间顺序占用，余额不足即阻塞且不可跳过', () => {
  const orders = [
    { id: 'W-2', intake: 'L1', grams: 140, status: 'requested', receivedAt: '2026-12-03T10:20:00Z' },
    { id: 'W-1', intake: 'L1', grams: 200, status: 'requested', receivedAt: '2026-12-03T10:15:00Z' },
  ];
  const plan = planRetestQueue(320, orders);
  assert.deepEqual(plan.queue.map((q) => q.id), ['W-1', 'W-2']);
  assert.equal(plan.queue[0].feasible, true);
  assert.equal(plan.queue[1].feasible, false); // 320-200=120 < 140
  assert.equal(plan.reserved, 200);
  assert.equal(canResplit(plan, 120), true);
  assert.equal(canResplit(plan, 121), false);
});

test('同一工单号多次受理只计算一次', () => {
  const orders = [
    { id: 'W-1', grams: 200, status: 'requested', receivedAt: 't1' },
    { id: 'W-1', grams: 200, status: 'requested', receivedAt: 't1' },
  ];
  const plan = planRetestQueue(320, orders);
  assert.equal(plan.queue.length, 1);
  assert.equal(plan.reserved, 200);
});

test('已领样工单不再参与占用计算（实验室已从净重扣除）', () => {
  const orders = [
    { id: 'W-1', grams: 200, status: 'issued', receivedAt: 't1', split: 'Q4' },
    { id: 'W-2', grams: 140, status: 'requested', receivedAt: 't2' },
  ];
  const plan = planRetestQueue(180, orders);
  assert.equal(plan.queue.length, 1);
  assert.equal(plan.queue[0].feasible, true); // 账面 180 已扣 Q4
});

test('本地补勘申请排在实验室已受理工单之后，受理时间不插队', () => {
  const orders = [
    { id: 'LOCAL-1', grams: 10, status: 'requested', receivedAt: '2026-01-01T00:00:00Z', origin: 'local' },
    { id: 'W-9', grams: 10, status: 'requested', receivedAt: '2026-12-01T00:00:00Z', origin: 'source' },
  ];
  const plan = planRetestQueue(100, orders);
  assert.deepEqual(plan.queue.map((q) => q.id), ['W-9', 'LOCAL-1']);
});

test('对应表确定性标识与确认键包含新版本号', () => {
  assert.ok(correspondenceId(cP3).includes('R1->R2'));
  assert.ok(confirmationKey(cP3).endsWith('@R2'));
});

void ItemStatus;
