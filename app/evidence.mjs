// 证据读取模型：把外业台账、收件链、分样、报告和勘察计划逐项对齐。
// 这是业务规则最密集的一层，输入全部来自 store 的快照，本身不做写入。

import {
  ItemStatus,
  MappingStatus,
  canResplit,
  confirmationKey,
  correspondenceId,
  effectiveReports,
  inside,
  intervalLabel,
  isUsableMapping,
  planRetestQueue,
  reportState,
  resolveSample,
  sampleKey,
} from './domain.mjs';

export const GapReason = Object.freeze({
  SEAL_MISMATCH: 'SEAL_MISMATCH', // 封签不符，留在差异
  AMBIGUOUS_MAPPING: 'AMBIGUOUS_MAPPING', // 改线后一对多，未经确认
  MAPPING_CONFLICT: 'MAPPING_CONFLICT', // 多个对应关系同时被确认
  OUTSIDE_CORRESPONDENCE: 'OUTSIDE_CORRESPONDENCE', // 样本不在任何对应范围/深度内
  LEDGER_INCOMPLETE: 'LEDGER_INCOMPLETE', // 台账短页，不能宣称齐全
  RECEIVED_NO_REPORT: 'RECEIVED_NO_REPORT', // 已接收未出结果
  REPORT_LOST: 'REPORT_LOST', // 报告被撤销/替代，证据失效
  SPLIT_VOID: 'SPLIT_VOID', // 支撑分样已作废
  MATERIAL_EXHAUSTED: 'MATERIAL_EXHAUSTED', // 净重耗尽，必须重取
  NOT_DELIVERED: 'NOT_DELIVERED', // 外业有记录但无收件，或无样本覆盖
  SOURCE_CORRECTED: 'SOURCE_CORRECTED', // 实验室更正了父样来源，原收件链断开
});

const REASON_TEXT = {
  SEAL_MISMATCH: '封签与外业记录不符，试样留在差异中',
  AMBIGUOUS_MAPPING: '改线后桩号与地面点一对多，需工程师按路线版本确认',
  MAPPING_CONFLICT: '同一旧样本的多个对应关系均被确认，资料冲突',
  OUTSIDE_CORRESPONDENCE: '样本里程或深度落在对应表范围之外，不可挪用',
  LEDGER_INCOMPLETE: '外业台账缺页或加载失败，整批不得视为齐全',
  RECEIVED_NO_REPORT: '实验室已接收，尚无该检验类型的结果',
  REPORT_LOST: '支撑评审的报告已被撤销或替代',
  SPLIT_VOID: '支撑该结果的分样已被实验室作废',
  MATERIAL_EXHAUSTED: '认可净重已耗尽且复验份额不足，必须重取',
  NOT_DELIVERED: '该地面点/深度还没有送样',
  SOURCE_CORRECTED: '实验室更正了父样来源，原收件链已断开',
};

export const explainReason = (reason) => REASON_TEXT[reason] ?? reason;

export function buildEvidenceIndex(store) {
  const { plan, correspondences, fieldByKey, intakes, intakeByRef, splits, reports, sections, confirmations } =
    store.state;
  const effective = effectiveReports([...reports.values()]);
  const effectiveById = new Map(effective.map((r) => [r.id, r]));

  const fieldEntries = [...fieldByKey.values()];
  const rejectedByRef = new Map(
    [...intakes.values()].filter((i) => i.accepted === false).map((i) => [i.refKey, i]),
  );
  const resolvedField = fieldEntries.map((entry) => {
    const resolution = plan
      ? resolveSample(entry, plan.alignment, plan, correspondences, confirmations)
      : { status: MappingStatus.NONE, point: null, matches: [] };
    const refKey = sampleKey(entry);
    const intakeId = intakeByRef.get(refKey) ?? null;
    const intake = intakeId ? intakes.get(intakeId) : (rejectedByRef.get(refKey) ?? null);
    return { entry, refKey, resolution, intakeId, intake };
  });

  const discrepancies = [];

  // 封签不符：实验室拒收的试样没有收件编号，进差异
  for (const row of intakes.values()) {
    if (row.accepted === false) {
      const field = fieldEntries.find((e) => sampleKey(e) === row.refKey);
      discrepancies.push({
        type: GapReason.SEAL_MISMATCH,
        intake: row.intake,
        reference: row.reference,
        expectedSeal: field?.seal ?? null,
        labSeal: row.seal ?? null,
        message: explainReason(GapReason.SEAL_MISMATCH),
      });
    }
  }

  // 孤儿收件：实验室有收件但外业台账找不到来源页
  for (const row of intakes.values()) {
    if (!fieldByKey.has(row.refKey)) {
      discrepancies.push({
        type: 'ORPHAN_INTAKE',
        intake: row.intake,
        reference: row.reference,
        message: '实验室收件在外业台账中没有来源记录',
      });
    }
  }

  // 同主键外业条目内容不一致（重复加载且数据不同）
  for (const key of store.state.fieldConflictKeys) {
    discrepancies.push({ type: 'FIELD_CONFLICT', reference: key.split('|'), message: '同一外业条码出现内容不一致的重复记录' });
  }

  // 分样指向不存在的父样
  for (const split of splits.values()) {
    if (!intakes.has(split.parent)) {
      discrepancies.push({ type: 'ORPHAN_SPLIT', split: split.id, parent: split.parent, message: '分样的父样收件编号不存在' });
    }
  }

  // 报告引用未知分样
  for (const report of reports.values()) {
    if (!splits.has(report.sample)) {
      discrepancies.push({ type: 'ORPHAN_REPORT', report: report.id, sample: report.sample, message: '报告引用的分样不存在' });
    }
  }

  function splitsOf(intakeId) {
    return [...splits.values()].filter((s) => s.parent === intakeId);
  }

  function reportsOf(splitId) {
    return [...reports.values()].filter((r) => r.sample === splitId);
  }

  // 各收件编号的净重账面：实验室认可净重为唯一口径
  function accountFor(intakeRow) {
    const children = splitsOf(intakeRow.intake);
    const confirmedGrams = children.filter((s) => s.voided !== true).reduce((sum, s) => sum + s.grams, 0);
    const orders = store.listRetestOrders().filter((o) => o.intake === intakeRow.intake);
    const queue = planRetestQueue(intakeRow.availableGrams, orders);
    return {
      intake: intakeRow.intake,
      reference: intakeRow.reference,
      availableGrams: intakeRow.availableGrams, // 已扣除实验室确认分出的量
      confirmedSplitGrams: confirmedGrams,
      reservedGrams: queue.reserved, // 待领工单已占用
      freeAfterReservations: queue.freeAfterReservations,
      queue: queue.queue,
      issued: queue.issued,
      withdrawn: queue.withdrawn,
    };
  }

  const accounts = [...intakes.values()].filter((i) => i.accepted !== false).map(accountFor);
  const accountByIntake = new Map(accounts.map((a) => [a.intake, a]));

  // 针对计划中的一个（地面点、深度区间、检验类型）逐项交卷
  function evaluateItem(requirement, testType) {
    const reasons = [];
    const evidence = [];
    const sectionIncomplete = [...sections.values()].some((s) => !s.complete);
    if (sectionIncomplete) reasons.push(GapReason.LEDGER_INCOMPLETE);

    // 候选外业样本：对应到该地面点，且样本深度落在本层区间（左闭右开）
    const candidates = resolvedField.filter(
      (r) => r.resolution.point === requirement.point
        && isUsableMapping(r.resolution)
        && inside(r.entry.depth, requirement.fromDepth, requirement.toDepth),
    );
    // 同时记录“想对应但没对应上”的样本，用于原因解释。
    // 未确认的挪用悬而未决：只要某条候选对应关系指向本点，且该关系可复用深度
    // 与本层区间相交，就必须在本层暴露为冲突，而不是让计划静默退回未送样。
    const blocked = resolvedField.filter(
      (r) => !isUsableMapping(r.resolution)
        && (r.resolution.matches ?? []).some(
          (m) => m.point === requirement.point
            && m.maxDepth > requirement.fromDepth
            && m.minDepth < requirement.toDepth,
        ),
    );
    for (const b of blocked) {
      if (b.resolution.status === MappingStatus.AMBIGUOUS) reasons.push(GapReason.AMBIGUOUS_MAPPING);
      else if (b.resolution.status === MappingStatus.CONFLICT) reasons.push(GapReason.MAPPING_CONFLICT);
      else if (b.resolution.status === MappingStatus.NONE) reasons.push(GapReason.OUTSIDE_CORRESPONDENCE);
    }
    // 样本已被（工程师或源端）确认到另一个点，但其候选对应关系里仍有一条
    // 指向本点且未确认——本点的挪用悬而未决，必须暴露为冲突，不能静默成未送样
    const unconfirmedAlternatives = resolvedField.filter(
      (r) => isUsableMapping(r.resolution) && r.resolution.point !== requirement.point
        && (r.resolution.matches ?? []).some(
          (m) => m.point === requirement.point
            && m.confirmed !== true
            && !confirmations.has(confirmationKey(m))
            && m.maxDepth > requirement.fromDepth
            && m.minDepth < requirement.toDepth,
        ),
    );
    if (unconfirmedAlternatives.length > 0) reasons.push(GapReason.AMBIGUOUS_MAPPING);

    let acceptedIntake = null;
    let anySealMismatch = false;
    let anyLostReport = false;
    let anyVoidSplit = false;
    let anyCandidate = false;

    for (const candidate of candidates) {
      anyCandidate = true;
      if (!candidate.intake) {
        reasons.push(GapReason.NOT_DELIVERED);
        continue;
      }
      if (candidate.intake.accepted === false) {
        anySealMismatch = true;
        reasons.push(GapReason.SEAL_MISMATCH);
        continue;
      }
      // 实验室更正父样来源后，收件编号虽在，但已不再指向本外业样本
      if (candidate.intake.refKey !== candidate.refKey) {
        reasons.push('SOURCE_CORRECTED');
        anyLostReport = true;
        continue;
      }
      acceptedIntake = candidate.intake;
      for (const split of splitsOf(candidate.intakeId)) {
        for (const report of reportsOf(split.id)) {
          if (report.type !== testType) continue;
          const state = reportState(report, [...reports.values()]);
          const record = {
            report: report.id,
            state,
            split: split.id,
            splitVoided: split.voided === true,
            replaces: report.replaces ?? null,
            withdrawn: report.withdrawn === true,
            value: report.value ?? null,
            recordedAt: report.recordedAt ?? null,
            trace: traceOf(candidate, split, report),
          };
          evidence.push(record);
          if (state !== 'EFFECTIVE') anyLostReport = true;
          if (split.voided === true) anyVoidSplit = true;
        }
      }
    }

    const validEvidence = evidence.filter((e) => e.state === 'EFFECTIVE' && !e.splitVoided);
    const hasAcceptedMaterial = acceptedIntake !== null;
    const account = acceptedIntake ? accountByIntake.get(acceptedIntake.intake) : null;
    const materialLeft = account ? account.freeAfterReservations > 0 : false;

    let status;
    if (validEvidence.length > 0) {
      status = ItemStatus.VERIFIED;
    } else if (anySealMismatch) {
      status = ItemStatus.CONFLICT;
    } else if (reasons.includes(GapReason.AMBIGUOUS_MAPPING) || reasons.includes(GapReason.MAPPING_CONFLICT)) {
      status = ItemStatus.CONFLICT;
    } else if (anyLostReport || anyVoidSplit) {
      if (anyVoidSplit) reasons.push(GapReason.SPLIT_VOID);
      reasons.push(GapReason.REPORT_LOST);
      // 证据已失：retestable=true 时可走现有样品复验，否则必须重取
      status = ItemStatus.REDRILL;
      if (!materialLeft) reasons.push(GapReason.MATERIAL_EXHAUSTED);
    } else if (hasAcceptedMaterial) {
      reasons.push(GapReason.RECEIVED_NO_REPORT);
      status = ItemStatus.RECEIVED_PENDING;
    } else if (anyCandidate) {
      // 有样本走到该点/层但没形成有效收件（封签拒收、来源被更正等），属于资料冲突
      status = ItemStatus.CONFLICT;
    } else if (reasons.includes(GapReason.AMBIGUOUS_MAPPING) || reasons.includes(GapReason.MAPPING_CONFLICT)) {
      // 存在指向本点但未确认的挪用关系，补勘人员必须先解决歧义
      status = ItemStatus.CONFLICT;
    } else {
      if (!reasons.includes(GapReason.LEDGER_INCOMPLETE)) reasons.push(GapReason.NOT_DELIVERED);
      status = sectionIncomplete ? ItemStatus.CONFLICT : ItemStatus.NOT_DELIVERED;
    }

    return {
      point: requirement.point,
      depth: { from: requirement.fromDepth, to: requirement.toDepth, label: intervalLabel(requirement.fromDepth, requirement.toDepth) },
      test: testType,
      status,
      reasons: [...new Set(reasons)],
      reasonText: [...new Set(reasons)].map(explainReason),
      evidence,
      validEvidence: validEvidence.map((e) => e.report),
      retestable: hasAcceptedMaterial && materialLeft,
    };
  }

  function traceOf(candidate, split, report) {
    const { entry, resolution, intakeId } = candidate;
    return {
      field: { contractor: entry.contractor, lot: entry.lot, barcode: entry.barcode, bore: entry.bore,
        alignment: entry.alignment, chainage: entry.chainage, depth: entry.depth, seal: entry.seal,
        recordedAt: entry.recordedAt ?? null },
      mapping: {
        status: resolution.status,
        point: resolution.point,
        via: (resolution.matches ?? []).map(correspondenceId),
        confirmed: resolution.status === MappingStatus.CONFIRMED,
      },
      intake: intakeId,
      split: split.id,
      report: report.id,
    };
  }

  function evaluatePlan() {
    if (!plan) return { alignment: null, items: [], complete: false };
    const items = [];
    for (const requirement of plan.requirements ?? []) {
      for (const testType of requirement.tests ?? []) {
        items.push(evaluateItem(requirement, testType));
      }
    }
    const sectionIncomplete = [...sections.values()].some((s) => !s.complete);
    const complete = sectionIncomplete === false
      && items.every((i) => i.status === ItemStatus.VERIFIED);
    return {
      alignment: plan.alignment,
      evaluatedAt: new Date().toISOString(),
      sectionIncomplete,
      complete,
      items,
      discrepancies,
    };
  }

  // 评审单快照：冻结后即使上游撤销报告，也能按当时看到的资料查证
  function reviewSnapshot(notes = '') {
    const gap = evaluatePlan();
    const adopted = [];
    for (const item of gap.items) {
      for (const record of item.evidence.filter((e) => e.state === 'EFFECTIVE' && !e.splitVoided)) {
        adopted.push({ point: item.point, depth: item.depth, test: item.test, ...record });
      }
    }
    return {
      route: structuredClone(plan),
      confirmations: [...confirmations],
      correspondences: structuredClone(correspondences),
      sections: [...sections.values()].map((s) => ({
        catalog: s.catalog,
        complete: s.complete,
        pages: [...s.pages.keys()].sort((a, b) => a - b),
        lastError: s.lastError,
        entries: [...s.pages.values()].flatMap((p) => p.entries ?? []),
      })),
      intakeChain: [...intakes.values()].map((i) => ({
        intake: i.intake,
        reference: i.reference,
        accepted: i.accepted !== false,
        seal: i.seal ?? null,
        availableGrams: i.availableGrams,
        splits: splitsOf(i.intake).map((s) => ({ ...s })),
      })),
      accounts: structuredClone(accounts),
      reports: structuredClone([...reports.values()]),
      effectiveReportIds: [...effectiveById.keys()],
      gaps: gap,
      adopted,
      discrepancies: structuredClone(discrepancies),
      notes,
    };
  }

  return {
    resolvedField,
    discrepancies,
    accounts,
    accountByIntake,
    evaluatePlan,
    evaluateItem,
    reviewSnapshot,
    effectiveReports: effective,
  };
}
