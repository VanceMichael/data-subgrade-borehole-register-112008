// 本地应用 HTTP 接口：面向联调暴露同步、缺口、确认、评审、复验能力。
// 只使用 Node 内置库；默认端口 4180，可用 APP_PORT / PORT 覆盖。

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WorkflowError } from './domain.mjs';
import { createStore } from './store.mjs';
import { createUpstream } from './upstream.mjs';
import { syncEngine } from './sync.mjs';
import { createWorkflow } from './workflow.mjs';

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new WorkflowError('BAD_JSON', '请求体不是合法 JSON');
  }
}

export function createApp({ upstreamUrl, clock }) {
  const store = createStore(clock);
  const upstream = createUpstream(upstreamUrl);
  const engine = syncEngine(upstream, store);
  const workflow = createWorkflow(store);

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/health$/, () => ({ status: 'ok' }));
  route('POST', /^\/sync$/, async (req) => {
    const payload = await readJson(req);
    return engine.syncAll({ catalogs: payload.catalogs ?? ['W4'] });
  });
  route('GET', /^\/gaps$/, () => workflow.currentGaps());
  route('GET', /^\/mapping$/, () => workflow.mappingOverview());
  route('GET', /^\/discrepancies$/, () => workflow.evidence().discrepancies);
  route('POST', /^\/mappings\/confirm$/, async (req) => {
    const payload = await readJson(req);
    return workflow.confirmMapping(payload.correspondence, payload.engineer);
  });
  route('GET', /^\/reviews$/, () => [...store.state.reviewSheets.values()].map(redactSnapshot));
  route('POST', /^\/reviews$/, async (req) => {
    const payload = await readJson(req);
    return redactSnapshot(workflow.createReviewSheet(payload));
  });
  route('POST', /^\/reviews\/([\w-]+)\/freeze$/, async (req, _m, id) => {
    const payload = await readJson(req);
    return redactSnapshot(workflow.freezeReviewSheet(id, payload));
  });
  route('GET', /^\/reviews\/([\w-]+)$/, (_req, _m, id) => redactSnapshot(workflow.getReviewSheet(id)));
  route('GET', /^\/reviews\/([\w-]+)\/impact$/, (_req, _m, id) => workflow.impactOnReview(id));
  route('GET', /^\/conditions\/reports$/, () => workflow.reportCompletion());
  route('GET', /^\/conditions\/adoption$/, () => workflow.reviewAdoption());
  route('GET', /^\/intakes\/([\w-]+)\/resplit$/, (_req, _m, id) => workflow.resplitAvailability(id));
  route('GET', /^\/intakes\/([\w-]+)\/retest-queue$/, (_req, _m, id) => workflow.retestQueue(id));
  route('POST', /^\/retest-requests$/, async (req) => workflow.applyRetest(await readJson(req)));
  route('POST', /^\/retest-requests\/([\w-]+)\/withdraw$/, (_req, _m, id) => workflow.withdrawRetest(id));
  route('GET', /^\/reports$/, () => workflow.reportLedger());
  route('GET', /^\/events$/, () => store.events);

  function redactSnapshot(sheet) {
    return sheet; // 快照用于“按当时资料查证”，完整返回
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      const match = routes.find((r) => r.method === request.method && r.pattern.test(url.pathname));
      if (!match) return send(response, 404, { error: '没有这条路径' });
      const captures = url.pathname.match(match.pattern);
      const result = await match.handler(request, captures, ...captures.slice(1));
      return send(response, 200, result);
    } catch (error) {
      if (error instanceof WorkflowError) return send(response, 409, { error: error.message, code: error.code });
      const status = error.status ?? 502;
      return send(response, status, { error: error.message ?? '本地应用出错', code: error.name });
    }
  });

  return { server, store, upstream, engine, workflow };
}

function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.APP_PORT ?? process.env.PORT ?? 4180);
  const upstreamUrl = process.env.SOURCE_URL ?? 'http://127.0.0.1:4173';
  createApp({ upstreamUrl }).server.listen(port, '127.0.0.1', function () {
    process.stdout.write(`收件流程应用 http://127.0.0.1:${this.address().port} 来源 ${upstreamUrl}\n`);
  });
}
