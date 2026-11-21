// 应用服务：工程人员确认、评审单冻结、补勘复验申请，以及三个独立的完成条件查询。

import {
  ItemStatus,
  MappingStatus,
  WorkflowError,
  canResplit,
  confirmationKey,
  correspondenceId,
  effectiveReports,
  planRetestQueue,
  reportState,
} from './domain.mjs';
import { buildEvidenceIndex } from './evidence.mjs';

export function createWorkflow(store, idFactory) {
  const nextId = (prefix) => (idFactory ? idFactory(prefix) : `${prefix}-${crypto.randomUUID()}`);

  function evidence() {
    return buildEvidenceIndex(store);
  }

  // ---- 工程师确认歧义对应关系；确认只适用于所注明的路线版本 ----
  function confirmMapping(correspondence, engineer) {
    if (!store.state.plan || correspondence.new !== store.state.plan.alignment) {
      throw new WorkflowError('VERSION_MISMATCH', '确认的路线版本与当前版本不一致，确认不适用', {
        confirmedFor: correspondence.new, current: store.state.plan?.alignment ?? null,
      });
    }
    const known = store.state.correspondences.find((c) => correspondenceId(c) === correspondenceId(correspondence));
    if (!known) throw new WorkflowError('UNKNOWN_CORRESPONDENCE', '对应表中没有这条关系');
    const key = confirmationKey(known);
    const created = !store.state.confirmations.has(key);
    store.state.confirmations.add(key);
    if (created) {
      store.append('mapping.confirmed', { key, correspondence: known, engineer: engineer ?? null });
    }
    return { key, correspondence: known, scope: known.new };
  }

  function isConfirmed(correspondence) {
    return store.state.confirmations.has(confirmationKey(correspondence));
  }

  // ---- 缺口查询：还未送样 / 已接收未出结果 / 资料冲突 / 必须重取 ----
  function currentGaps() {
    const index = evidence();
    const snapshot = index.evaluatePlan();
    store.recordGapSnapshot(snapshot);
    const buckets = {
      NOT_DELIVERED: [],
      RECEIVED_PENDING: [],
      CONFLICT: [],
      REDRILL: [],
      VERIFIED: [],
    };
    for (const item of snapshot.items) buckets[item.status].push(item);
    return { ...snapshot, buckets };
  }

  // ---- 评审单：冻结带来源页、路线版本和收件链的快照 ----
  function createReviewSheet({ notes = '' } = {}) {
    const id = nextId('RV');
    const snapshot = evidence().reviewSnapshot(notes);
    const sheet = {
      id,
      status: 'DRAFT',
      createdAt: new Date().toISOString(),
      frozenAt: null,
      eventSeq: store.events.length,
      snapshot,
      adoptedIds: snapshot.adopted.map((a) => a.report),
    };
    store.saveReviewSheet(sheet);
    store.append('review.created', { id });
    return sheet;
  }

  function freezeReviewSheet(id, { notes } = {}) {
    const sheet = store.state.reviewSheets.get(id);
    if (!sheet) throw new WorkflowError('UNKNOWN_REVIEW', '评审单不存在');
    if (sheet.status === 'FROZEN') throw new WorkflowError('ALREADY_FROZEN', '评审单已冻结，不能重复冻结或改写');
    const fresh = evidence().reviewSnapshot(notes ?? sheet.snapshot.notes);
    sheet.snapshot = fresh;
    sheet.adoptedIds = fresh.adopted.map((a) => a.report);
    sheet.status = 'FROZEN';
    sheet.frozenAt = new Date().toISOString();
    sheet.eventSeq = store.events.length;
    store.saveReviewSheet(sheet);
    store.append('review.frozen', { id, adopted: sheet.adoptedIds });
    return sheet;
  }

  function getReviewSheet(id) {
    const sheet = store.state.reviewSheets.get(id);
    if (!sheet) throw new WorkflowError('UNKNOWN_REVIEW', '评审单不存在');
    return sheet;
  }

  // 冻结之后上游发生的证据失效：旧版评审单仍可查证，但后续决策必须看到
  function impactOnReview(id) {
    const sheet = getReviewSheet(id);
    const laterEvents = store.events
      .filter((e) => e.seq > sheet.eventSeq && ['report.evidence-lost', 'intake.source-corrected', 'split.voided'].includes(e.type));
    const adoptedSet = new Set(sheet.adoptedIds);
    const impacting = [];
    for (const event of laterEvents) {
      if (event.type === 'report.evidence-lost' && adoptedSet.has(event.payload.id)) {
        impacting.push(event);
      } else if (event.type !== 'report.evidence-lost') {
        impacting.push(event);
      }
    }
    return {
      reviewId: id,
      frozen: sheet.status === 'FROZEN',
      snapshotStillValid: true, // 快照本身永不变写
      lostAdoptedReports: impacting.filter((e) => e.type === 'report.evidence-lost').map((e) => e.payload),
      otherEvents: impacting.filter((e) => e.type !== 'report.evidence-lost').map((e) => ({ type: e.type, payload: e.payload })),
      pendingDecisionsMustReflect: impacting.length > 0,
    };
  }

  // ---- 三个独立条件：报告验毕 / 评审采信 / 可再分样 ----
  function reportCompletion() {
    const gaps = currentGaps();
    const items = gaps.items;
    const done = items.filter((i) => i.status === ItemStatus.VERIFIED);
    return {
      condition: '报告验毕',
      satisfied: items.length > 0 && items.every((i) => i.status === ItemStatus.VERIFIED),
      total: items.length,
      verified: done.length,
      pending: items.filter((i) => i.status !== ItemStatus.VERIFIED).map(stub),
    };
  }

  function reviewAdoption() {
    const sheets = [...store.state.reviewSheets.values()];
    const frozen = sheets.filter((s) => s.status === 'FROZEN');
    // 评审采信要求：存在已冻结评审单，且其采信的报告在当下仍然有效
    const results = frozen.map((sheet) => {
      const effective = new Set(effectiveReports([...store.state.reports.values()]).map((r) => r.id));
      const adopted = sheet.adoptedIds;
      const stillEffective = adopted.filter((id) => effective.has(id));
      return {
        reviewId: sheet.id,
        frozenAt: sheet.frozenAt,
        adopted: adopted,
        stillEffective,
        intact: adopted.length > 0 && stillEffective.length === adopted.length,
      };
    });
    return {
      condition: '评审采信',
      satisfied: results.some((r) => r.intact),
      sheets: results,
    };
  }

  // ---- 复验申请（补勘人员）----
  function applyRetest({ intake, grams, reason, idempotencyKey, requestedBy = '补勘人员' }) {
    const parent = store.state.intakes.get(intake);
    if (!parent) throw new WorkflowError('UNKNOWN_INTAKE', '收件编号不存在');
    if (parent.accepted === false) throw new WorkflowError('INTAKE_REJECTED', '封签不符的试样在差异中，不能申请复验');
    if (!Number.isFinite(grams) || grams <= 0) throw new WorkflowError('BAD_GRAMS', '申请净重必须为正数');

    if (idempotencyKey) {
      const dup = [...store.state.retestOrders.values()].find((o) => o.idempotencyKey === idempotencyKey);
      if (dup) return { order: dup, duplicated: true };
    }

    const order = {
      id: nextId('W'),
      origin: 'local',
      intake,
      grams,
      reason: reason ?? '',
      requestedBy,
      status: 'requested',
      receivedAt: new Date().toISOString(),
      idempotencyKey: idempotencyKey ?? null,
    };
    store.saveLocalRetestOrder(order);
    store.append('retest.requested', { id: order.id, intake, grams });
    return { order, duplicated: false };
  }

  // 撤回：只有未领样的工单可撤；撤回释放未领样的占用；实验室已确认分出的量不返还账面
  function withdrawRetest(id) {
    const order = store.state.retestOrders.get(id);
    if (!order) throw new WorkflowError('UNKNOWN_ORDER', '复验工单不存在');
    if (order.status === 'withdrawn') return { order, alreadyWithdrawn: true };
    if (order.status === 'issued') {
      throw new WorkflowError('ALREADY_ISSUED', '实验室已确认分出的量不能返还到账面，工单不可撤回', { split: order.split ?? null });
    }
    order.status = 'withdrawn';
    order.withdrawnAt = new Date().toISOString();
    store.append('retest.withdrawn', { id, releasedGrams: order.grams });
    return { order, alreadyWithdrawn: false };
  }

  function retestQueue(intake) {
    const parent = store.state.intakes.get(intake);
    if (!parent) throw new WorkflowError('UNKNOWN_INTAKE', '收件编号不存在');
    const orders = store.listRetestOrders().filter((o) => o.intake === intake);
    const plan = planRetestQueue(parent.availableGrams, orders);
    return { ...plan, resplit: (grams) => canResplit(plan, grams) };
  }

  // 可再分样条件：独立于报告与评审，只看留足占用后的认可净重
  function resplitAvailability(intake) {
    const plan = retestQueue(intake);
    return {
      condition: '可再分样',
      intake,
      availableGrams: plan.availableGrams,
      reservedGrams: plan.reserved,
      freeAfterReservations: plan.freeAfterReservations,
      queue: plan.queue.map(({ id, grams, feasible, blocked }) => ({ id, grams, feasible, blocked })),
      canResplit: (grams) => canResplit(plan, grams),
    };
  }

  function reportLedger() {
    return [...store.state.reports.values()].map((r) => ({
      id: r.id,
      sample: r.sample,
      type: r.type,
      state: reportState(r, [...store.state.reports.values()]),
      replaces: r.replaces ?? null,
      withdrawn: r.withdrawn === true,
    }));
  }

  function mappingOverview() {
    const index = evidence();
    return index.resolvedField.map(({ entry, resolution, intakeId }) => ({
      sample: { contractor: entry.contractor, lot: entry.lot, barcode: entry.barcode,
        alignment: entry.alignment, chainage: entry.chainage, depth: entry.depth, bore: entry.bore },
      status: resolution.status,
      point: resolution.point,
      intake: intakeId,
      candidateCorrespondences: (resolution.matches ?? []).map((c) => ({
        id: correspondenceId(c),
        point: c.point,
        range: `[${c.start},${c.end})`,
        depth: `[${c.minDepth},${c.maxDepth})`,
        confirmedAtSource: c.confirmed === true,
        confirmedLocally: isConfirmed(c),
      })),
    }));
  }

  return {
    confirmMapping,
    isConfirmed,
    currentGaps,
    createReviewSheet,
    freezeReviewSheet,
    getReviewSheet,
    impactOnReview,
    reportCompletion,
    reviewAdoption,
    applyRetest,
    withdrawRetest,
    retestQueue,
    resplitAvailability,
    reportLedger,
    mappingOverview,
    evidence,
  };
}

const stub = (item) => ({
  point: item.point, depth: item.depth.label, test: item.test,
  status: item.status, reasons: item.reasons,
});

// 供外部测试/演示直接判定一个解析状态是否可用
export { MappingStatus };
