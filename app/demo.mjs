// 本地联调演示：在进程内同时启动合成来源与收件应用，按演练时钟推进五个阶段，
// 演示收件、改线挪用、复验份额、报告失效/恢复与评审单冻结。

import { once } from 'node:events';
import { createSource } from '../sources/source.mjs';
import { createApp } from './server.mjs';

const line = (title) => process.stdout.write(`\n=== ${title} ===\n`);
const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function main() {
  const source = createSource();
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceUrl = `http://127.0.0.1:${source.address().port}`;

  const app = createApp({ upstreamUrl: sourceUrl });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const appUrl = `http://127.0.0.1:${app.server.address().port}`;

  const call = async (method, path, body) => {
    const response = await fetch(appUrl + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok) throw Object.assign(new Error(json.error ?? '请求失败'), { status: response.status, body: json });
    return json;
  };
  const clock = async (step) => (await fetch(`${sourceUrl}/_source_clock?step=${step}`, { method: 'PUT' })).json();

  // ---- 阶段一 survey：完整台账，逐项交卷 ----
  line('阶段 survey：同步并评估 R1 计划');
  print(await call('POST', '/sync', { catalogs: ['W4'] }));
  let gaps = await call('GET', '/gaps');
  print({ alignment: gaps.alignment, complete: gaps.complete, items: gaps.items.map(simple) });
  print(await call('GET', '/discrepancies'));

  line('复验份额：L1 账面 320g，两张工单按受理顺序占用');
  print(await call('GET', '/intakes/L1/retest-queue'));
  print(await call('POST', '/retest-requests', { intake: 'L1', grams: 90, reason: '补勘复验', idempotencyKey: 'demo-1' }));
  print((await call('GET', '/intakes/L1/resplit')).freeAfterReservations);

  line('冻结评审单 RV-1（采信 Z1/Z2/Z3）');
  const review = await call('POST', '/reviews', { notes: 'R1 评审' });
  print(await call('POST', `/reviews/${review.id}/freeze`, {}));

  // ---- 阶段二 incomplete：台账短页，整批不得宣称齐全 ----
  line('阶段 incomplete：外业第二页 503');
  await clock('incomplete');
  print(await call('POST', '/sync', { catalogs: ['W4'] }));
  gaps = await call('GET', '/gaps');
  print({ sectionIncomplete: gaps.sectionIncomplete, complete: gaps.complete, conflictItems: gaps.buckets.CONFLICT.map(simple) });

  // ---- 阶段三 lab-revision：Z4 替代并撤销 Z1，盐份证据失效 ----
  line('阶段 lab-revision：报告 Z1 被 Z4 替代且 Z4 被撤销');
  await clock('lab-revision');
  await call('POST', '/sync', {});
  print(await call('GET', '/reports'));
  gaps = await call('GET', '/gaps');
  print(gaps.buckets.REDRILL.map(simple));
  print(await call('GET', `/reviews/${review.id}/impact`));
  print({ 冻结快照仍采信: (await call('GET', `/reviews/${review.id}`)).adoptedIds });

  // ---- 阶段四 realignment：改线 R1 -> R2，对应表有歧义 ----
  line('阶段 realignment：新路线 R2，T17 同时命中两条对应关系');
  await clock('realignment');
  await call('POST', '/sync', {});
  print(await call('GET', '/mapping'));
  gaps = await call('GET', '/gaps');
  print({ statuses: gaps.items.map((i) => ({ point: i.point, depth: i.depth.label, test: i.test, status: i.status, reasons: i.reasons })) });

  // ---- 阶段五 return：工程师确认随上游到达，Q4/Z5 恢复盐份，工单领样/撤回 ----
  line('阶段 return：C1 确认、W-1 撤回、W-2 领出 Q4、Z5 恢复证据');
  await clock('return');
  await call('POST', '/sync', {});
  print(await call('GET', '/mapping'));
  gaps = await call('GET', '/gaps');
  print({ complete: gaps.complete, items: gaps.items.map(simple), discrepancies: (await call('GET', '/discrepancies')).length });
  print(await call('GET', '/intakes/L1/retest-queue'));
  print(await call('GET', '/conditions/reports'));
  print(await call('GET', '/events'));

  source.close();
  app.server.close();

  function simple(item) {
    return { point: item.point, depth: item.depth.label, test: item.test, status: item.status,
      reasons: item.reasons, validEvidence: item.validEvidence };
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
