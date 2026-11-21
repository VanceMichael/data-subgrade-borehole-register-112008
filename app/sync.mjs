// 同步引擎：把上游快照落到本地登记处，并识别“资料发生了什么变化”。
// 重点是证据失效事件——报告被撤销/替代、父样来源被更正、分样作废，
// 都必须立刻反映到待签评审与补勘决策上（冻结评审单不受影响，靠快照留存）。

import { effectiveReports } from './domain.mjs';

export function syncEngine(upstream, store) {
  function effectiveIds() {
    return new Set(effectiveReports([...store.state.reports.values()]).map((r) => r.id));
  }

  async function syncField(catalogs) {
    const result = [];
    for (const catalog of catalogs) {
      const fetched = await upstream.fetchFieldSection(catalog);
      for (const { pageNo, page } of fetched.pages) store.savePage(catalog, pageNo, page);
      for (const error of fetched.errors) store.markPageFailure(catalog, error.page, error);
      result.push({
        catalog,
        complete: fetched.complete,
        pages: fetched.pages.map((p) => p.pageNo),
        errors: fetched.errors,
        entries: [...store.state.fieldByKey.values()].filter((e) => e.catalogs.has(catalog)).length,
      });
    }
    return result;
  }

  function syncRoute(route) {
    const previousAlignment = store.state.plan?.alignment ?? null;
    store.setPlan(route.current);
    store.setCorrespondences(route.correspondences);
    if (previousAlignment && previousAlignment !== route.current.alignment) {
      store.append('route.alignment-changed', { from: previousAlignment, to: route.current.alignment });
    }
    return { alignment: route.current.alignment, correspondences: route.correspondences.length };
  }

  function syncLab(lab) {
    const beforeEffective = effectiveIds();

    const intakeChanges = lab.intake.map((row) => {
      const { previous, current } = store.upsertIntake(row);
      // 实验室更正父样来源：同一收件编号指向了不同的承包方/批次/条码
      if (previous && JSON.stringify(previous.reference) !== JSON.stringify(current.reference)) {
        store.append('intake.source-corrected', {
          intake: current.intake, from: previous.reference, to: current.reference,
        });
      }
      return current;
    });

    for (const row of lab.splits) {
      const { previous, current } = store.upsertSplit(row);
      if (current.voided === true && previous?.voided !== true) {
        store.append('split.voided', { id: current.id, parent: current.parent, grams: current.grams });
      }
    }
    // 源端不再列出的分样也视为实验室作废（“作废以实验室为准”）
    const liveSplitIds = new Set(lab.splits.map((s) => s.id));
    for (const [id, split] of store.state.splits) {
      if (!liveSplitIds.has(id) && split.voided !== true) {
        store.upsertSplit({ ...split, voided: true });
        store.append('split.voided', { id, parent: split.parent, grams: split.grams, reason: '实验室清单已移除' });
      }
    }

    for (const row of lab.reports) store.upsertReport(row);
    for (const row of lab.retestRequests) store.upsertRetestOrder(row);

    // 证据失效：此前有效、现在被撤销或替代
    const lost = [];
    const afterEffective = effectiveIds();
    for (const id of beforeEffective) {
      if (!afterEffective.has(id)) {
        const report = store.state.reports.get(id);
        const reason = report?.withdrawn ? 'WITHDRAWN' : 'SUPERSEDED';
        const event = store.append('report.evidence-lost', {
          id, sample: report?.sample ?? null, type: report?.type ?? null, reason,
        });
        lost.push(event);
      }
    }
    // 新出现的有效报告（可能恢复此前断档的证据）
    const restored = [...afterEffective].filter((id) => !beforeEffective.has(id));
    for (const id of restored) {
      store.append('report.evidence-restored', { id, report: store.state.reports.get(id) });
    }

    return {
      intake: intakeChanges.length,
      splits: lab.splits.length,
      reports: lab.reports.length,
      retestRequests: lab.retestRequests.length,
      evidenceLost: lost.map((e) => e.payload),
      evidenceRestored: restored,
    };
  }

  async function syncAll(options = {}) {
    const catalogs = options.catalogs ?? ['W4'];
    const startedAt = new Date().toISOString();
    const [field, route, lab] = await Promise.all([
      syncField(catalogs),
      upstream.route().then(syncRoute),
      upstream.lab().then(syncLab),
    ]);
    const summary = { startedAt, finishedAt: new Date().toISOString(), field, route, lab };
    store.recordSync(summary);
    return summary;
  }

  return { syncAll, syncField, syncRoute, syncLab };
}
