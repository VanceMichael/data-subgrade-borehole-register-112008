// 进程内登记处：保存同步得到的源端资料、本地决策（确认/工单/评审单）与事件日志。
// 源端记录按业务主键 upsert；本地产生的记录归 local 命名空间，不被同步覆盖。

function keyOfField(entry) {
  return `${entry.contractor}|${entry.lot}|${entry.barcode}`;
}

export function createStore(clock = () => new Date().toISOString()) {
  const state = {
    sections: new Map(), // 外业台账按标段（catalog）分页组装
    fieldByKey: new Map(), // 三元组 -> 最新外业条目（重复加载不重复计数）
    fieldConflictKeys: new Set(), // 同主键但内容不一致
    plan: null, // 当前路线版本
    correspondences: [],
    intakes: new Map(), // 收件编号 -> 实验室收件记录
    intakeByRef: new Map(), // 三元组 -> 收件编号
    splits: new Map(), // 分样号 -> 分样
    reports: new Map(), // 报告号 -> 报告
    retestOrders: new Map(), // 工单号 -> 工单（含源端与本地申请）
    confirmations: new Set(), // 工程师确认（键内含路线版本）
    reviewSheets: new Map(), // 评审单号 -> 评审单
    gaps: null, // 最近一次缺口评估快照
    syncs: [],
  };

  const events = [];
  const seq = { n: 0 };

  function append(type, payload) {
    seq.n += 1;
    const event = { seq: seq.n, at: clock(), type, payload: structuredClone(payload) };
    events.push(event);
    return event;
  }

  function ensureSection(catalog) {
    if (!state.sections.has(catalog)) {
      state.sections.set(catalog, {
        catalog,
        pages: new Map(), // 页码 -> 原始页（含条目）
        complete: false,
        lastError: null,
        nextPage: 1,
      });
    }
    return state.sections.get(catalog);
  }

  function upsertFieldEntry(entry, catalog) {
    const key = keyOfField(entry);
    const existing = state.fieldByKey.get(key);
    if (existing) {
      // 重复加载同一外业条目：幂等；内容不同则留痕但不制造第二条
      const fingerprint = JSON.stringify(existing.entry);
      if (fingerprint !== JSON.stringify(entry)) state.fieldConflictKeys.add(key);
      existing.catalogs.add(catalog);
      return existing;
    }
    const wrapped = { ...entry, key, catalogs: new Set([catalog]) };
    state.fieldByKey.set(key, wrapped);
    return wrapped;
  }

  function savePage(catalog, pageNo, page) {
    const section = ensureSection(catalog);
    section.pages.set(pageNo, structuredClone(page));
    section.lastError = null;
    for (const entry of page.entries ?? []) upsertFieldEntry(entry, catalog);
    if (page.next == null) section.complete = true;
    section.nextPage = page.next ? Number(new URL(page.next, 'http://local').searchParams.get('page')) : null;
    return section;
  }

  function markPageFailure(catalog, pageNo, error) {
    const section = ensureSection(catalog);
    section.lastError = { page: pageNo, ...error };
    section.complete = false;
    append('section.page-failed', { catalog, page: pageNo, error });
  }

  function setPlan(plan) {
    state.plan = structuredClone(plan);
  }

  function setCorrespondences(rows) {
    state.correspondences = structuredClone(rows);
  }

  function upsertIntake(row) {
    const refKey = `${row.reference[0]}|${row.reference[1]}|${row.reference[2]}`;
    const previous = state.intakes.get(row.intake);
    state.intakes.set(row.intake, { ...previous, ...structuredClone(row), refKey });
    if (row.accepted) {
      state.intakeByRef.set(refKey, row.intake);
    } else {
      // 封签不符被拒收：没有可用收件编号，不得建立映射
      state.intakeByRef.delete(refKey);
    }
    return { previous: previous ?? null, current: state.intakes.get(row.intake) };
  }

  function upsertSplit(row) {
    const previous = state.splits.get(row.id);
    state.splits.set(row.id, { ...previous, ...structuredClone(row) });
    return { previous: previous ?? null, current: state.splits.get(row.id) };
  }

  function upsertReport(row) {
    const previous = state.reports.get(row.id);
    state.reports.set(row.id, { ...previous, ...structuredClone(row) });
    return { previous: previous ?? null, current: state.reports.get(row.id) };
  }

  function upsertRetestOrder(row) {
    const previous = state.retestOrders.get(row.id);
    // 源端状态优先：本地申请已被实验室受理/撤回时，以源端为准
    const merged = previous ? { ...previous, ...structuredClone(row) } : { ...structuredClone(row), origin: 'source' };
    state.retestOrders.set(row.id, merged);
    return { previous: previous ?? null, current: merged };
  }

  function listRetestOrders() {
    return [...state.retestOrders.values()].map((o) => ({ ...o }));
  }

  function saveLocalRetestOrder(order) {
    state.retestOrders.set(order.id, order);
  }

  function saveReviewSheet(sheet) {
    state.reviewSheets.set(sheet.id, sheet);
  }

  function recordGapSnapshot(snapshot) {
    state.gaps = snapshot;
  }

  function recordSync(summary) {
    state.syncs.push(summary);
  }

  return {
    state,
    events,
    append,
    ensureSection,
    savePage,
    markPageFailure,
    upsertFieldEntry,
    setPlan,
    setCorrespondences,
    upsertIntake,
    upsertSplit,
    upsertReport,
    upsertRetestOrder,
    listRetestOrders,
    saveLocalRetestOrder,
    saveReviewSheet,
    recordGapSnapshot,
    recordSync,
  };
}
