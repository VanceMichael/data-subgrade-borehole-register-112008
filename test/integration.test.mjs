import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { createApp } from '../app/server.mjs';
import { ItemStatus, MappingStatus } from '../app/domain.mjs';

async function harness() {
  const source = createSource();
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceUrl = `http://127.0.0.1:${source.address().port}`;

  const app = createApp({ upstreamUrl: sourceUrl });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    assert.ok(response.ok, `${method} ${path} -> ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const clock = async (step) => {
    const response = await fetch(`${sourceUrl}/_source_clock?step=${step}`, { method: 'PUT' });
    assert.equal(response.status, 200);
  };

  return {
    sourceUrl, base, call, clock,
    close: () => {
      source.close();
      app.server.close();
    },
  };
}

test('端到端：survey 收件交卷、封签差异与复验占用', async () => {
  const { call, close } = await harness();
  try {
    const summary = await call('POST', '/sync', { catalogs: ['W4'] });
    assert.equal(summary.field[0].complete, true);
    assert.deepEqual(summary.field[0].pages, [1, 2]);

    const gaps = await call('GET', '/gaps');
    assert.equal(gaps.alignment, 'R1');
    assert.equal(gaps.complete, true);
    assert.equal(gaps.items.length, 3);
    assert.ok(gaps.items.every((i) => i.status === ItemStatus.VERIFIED));
    assert.deepEqual(gaps.items.map((i) => i.validEvidence).flat().sort(), ['Z1', 'Z2', 'Z3']);

    const discrepancies = await call('GET', '/discrepancies');
    const seal = discrepancies.find((d) => d.type === 'SEAL_MISMATCH');
    assert.equal(seal.intake, 'L3');
    assert.equal(seal.expectedSeal, 'X1');
    assert.equal(seal.labSeal, 'X9');

    const queue = await call('GET', '/intakes/L1/retest-queue');
    assert.equal(queue.availableGrams, 320);
    assert.equal(queue.reserved, 200);
    assert.equal(queue.queue.find((q) => q.id === 'W-2').blocked, true);

    const reportCondition = await call('GET', '/conditions/reports');
    assert.equal(reportCondition.satisfied, true);
  } finally {
    close();
  }
});

test('端到端：incomplete 缺页让整批证据不再看起来齐全', async () => {
  const { call, clock, close } = await harness();
  try {
    await call('POST', '/sync', {});
    await clock('incomplete');
    const summary = await call('POST', '/sync', {});
    assert.equal(summary.field[0].complete, false);
    assert.ok(summary.field[0].errors.some((e) => e.page === 2 && e.status === 503));
    const gaps = await call('GET', '/gaps');
    assert.equal(gaps.sectionIncomplete, true);
    assert.equal(gaps.complete, false);
  } finally {
    close();
  }
});

test('端到端：报告被替代且撤销 -> 证据失效，冻结评审单仍可查证', async () => {
  const { call, clock, close } = await harness();
  try {
    // 先在 survey 阶段同步并冻结评审单，采信当时有效的 Z1/Z2/Z3
    await call('POST', '/sync', {});
    const review = await call('POST', '/reviews', { notes: '改报告前的评审' });
    await call('POST', `/reviews/${review.id}/freeze`, {});
    assert.deepEqual((await call('GET', `/reviews/${review.id}`)).adoptedIds.sort(), ['Z1', 'Z2', 'Z3']);

    await clock('lab-revision');
    await call('POST', '/sync', {});

    const ledger = await call('GET', '/reports');
    const z1 = ledger.find((r) => r.id === 'Z1');
    assert.equal(z1.state, 'SUPERSEDED');
    const z4 = ledger.find((r) => r.id === 'Z4');
    assert.equal(z4.state, 'WITHDRAWN');

    const gaps = await call('GET', '/gaps');
    const salt = gaps.items.find((i) => i.test === 'salt');
    assert.equal(salt.status, ItemStatus.REDRILL);
    assert.ok(salt.reasons.includes('REPORT_LOST'));

    const impact = await call('GET', `/reviews/${review.id}/impact`);
    assert.ok(impact.lostAdoptedReports.some((e) => e.id === 'Z1'));
    assert.equal(impact.pendingDecisionsMustReflect, true);
    const frozen = await call('GET', `/reviews/${review.id}`);
    assert.deepEqual(frozen.adoptedIds.sort(), ['Z1', 'Z2', 'Z3']);
    assert.equal(frozen.status, 'FROZEN');

    const events = await call('GET', '/events');
    assert.ok(events.some((e) => e.type === 'report.evidence-lost' && e.payload.id === 'Z1'));
  } finally {
    close();
  }
});

test('端到端：改线后旧桩号一对多 -> 歧义冲突，确认只认路线版本', async () => {
  const { call, clock, close } = await harness();
  try {
    await call('POST', '/sync', {}); // 先建立收件链与报告
    await clock('realignment');
    await call('POST', '/sync', {});
    const mapping = await call('GET', '/mapping');
    const t17 = mapping.find((m) => m.sample.barcode === 'T17' && m.sample.contractor === 'D1');
    assert.equal(t17.status, MappingStatus.AMBIGUOUS);
    assert.equal(t17.candidateCorrespondences.length, 2);
    const t28 = mapping.find((m) => m.sample.barcode === 'T28');
    assert.equal(t28.status, MappingStatus.NONE);

    const gaps = await call('GET', '/gaps');
    assert.equal(gaps.alignment, 'R2');
    const p3Salt = gaps.items.find((i) => i.point === 'P3' && i.test === 'salt');
    assert.equal(p3Salt.status, ItemStatus.CONFLICT);
    assert.ok(p3Salt.reasons.includes('AMBIGUOUS_MAPPING'));
    // 深度 5.6 的 T28 没有对应表覆盖 [5,7)
    const p3Upper = gaps.items.find((i) => i.point === 'P3' && i.depth.label === '[5,7)');
    assert.equal(p3Upper.status, ItemStatus.NOT_DELIVERED);
  } finally {
    close();
  }
});

test('端到端：return 确认到达后恢复交卷，工单撤回/领样与新报告恢复证据', async () => {
  const { call, clock, close } = await harness();
  try {
    await call('POST', '/sync', {}); // 先建立 survey 收件链与报告
    await clock('return');
    await call('POST', '/sync', {});

    const mapping = await call('GET', '/mapping');
    const t17 = mapping.find((m) => m.sample.barcode === 'T17' && m.sample.contractor === 'D1');
    assert.equal(t17.status, MappingStatus.CONFIRMED);
    assert.equal(t17.point, 'P3');

    const gaps = await call('GET', '/gaps');
    const p3Salt = gaps.items.find((i) => i.point === 'P3' && i.test === 'salt');
    assert.equal(p3Salt.status, ItemStatus.VERIFIED);
    assert.deepEqual(p3Salt.validEvidence, ['Z5']); // Z1 失效链后由 Q4 的 Z5 恢复
    const p3Moisture = gaps.items.find((i) => i.point === 'P3' && i.test === 'moisture' && i.depth.label === '[2,5)');
    assert.equal(p3Moisture.status, ItemStatus.VERIFIED);
    // P4 的对应关系仍未确认
    const p4 = gaps.items.find((i) => i.point === 'P4');
    assert.equal(p4.status, ItemStatus.CONFLICT);
    // P3 [5,7) 仍无样本覆盖
    const upper = gaps.items.find((i) => i.point === 'P3' && i.depth.label === '[5,7)');
    assert.equal(upper.status, ItemStatus.NOT_DELIVERED);
    assert.equal(gaps.complete, false);

    const queue = await call('GET', '/intakes/L1/retest-queue');
    assert.equal(queue.availableGrams, 180); // Q4 的 140g 已从账面扣除
    assert.equal(queue.reserved, 0); // W-1 撤回释放、W-2 已领样
    assert.equal(queue.issued[0].id, 'W-2');
    assert.equal(queue.withdrawn[0].id, 'W-1');

    const events = await call('GET', '/events');
    assert.ok(events.some((e) => e.type === 'report.evidence-restored' && e.payload.id === 'Z5'));

    const discrepancies = await call('GET', '/discrepancies');
    assert.ok(discrepancies.some((d) => d.type === 'SEAL_MISMATCH' && d.intake === 'L3'));
  } finally {
    close();
  }
});

test('端到端：本地工程师确认与源端确认等效，且仅作用于注明版本', async () => {
  const { call, clock, close } = await harness();
  try {
    // 先在 survey 同步收件链与报告，再推进到改线阶段做本地确认
    await call('POST', '/sync', {});
    await clock('realignment');
    await call('POST', '/sync', {});
    const before = await call('GET', '/mapping');
    const ambiguous = before.find((m) => m.sample.barcode === 'T17' && m.sample.contractor === 'D1');
    assert.equal(ambiguous.status, MappingStatus.AMBIGUOUS);
    const correspondence = {
      old: 'R1', new: 'R2', start: 2340, end: 2370, minDepth: 2, maxDepth: 5, point: 'P3', confirmed: false,
    };
    const confirmed = await call('POST', '/mappings/confirm', { correspondence, engineer: '工程师乙' });
    assert.equal(confirmed.scope, 'R2');

    const gaps = await call('GET', '/gaps');
    const p3Salt = gaps.items.find((i) => i.point === 'P3' && i.test === 'salt');
    // 歧义消除后不再是资料冲突；但 realignment 阶段盐份报告仍在失效链上，
    // 只能推进为可复验的重取，不能让被撤销的报告复活
    assert.equal(p3Salt.status, ItemStatus.REDRILL);
    assert.ok(p3Salt.reasons.includes('REPORT_LOST'));
    assert.equal(p3Salt.retestable, true);
  } finally {
    close();
  }
});

test('端到端：补勘人员可申请复验，重复申请不额外占用', async () => {
  const { call, clock, close } = await harness();
  try {
    await clock('survey');
    await call('POST', '/sync', {});
    const first = await call('POST', '/retest-requests', { intake: 'L1', grams: 40, idempotencyKey: 'idem-1', reason: '补勘' });
    const second = await call('POST', '/retest-requests', { intake: 'L1', grams: 40, idempotencyKey: 'idem-1', reason: '补勘' });
    assert.equal(first.order.id, second.order.id);
    assert.equal(second.duplicated, true);
    const queue = await call('GET', '/intakes/L1/retest-queue');
    assert.equal(queue.reserved, 200 + 40);
    // 撤回本地申请释放
    await call('POST', `/retest-requests/${first.order.id}/withdraw`, {});
    const after = await call('GET', '/intakes/L1/retest-queue');
    assert.equal(after.reserved, 200);
  } finally {
    close();
  }
});
