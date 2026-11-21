// 合成上游 HTTP 适配器：把外业台账、路线服务、实验室接口拉到本地。
// 所有解析错误都转成结构化结果，不抛出让流程中断——缺一页不能让整批看起来齐全。

export class UpstreamError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'UpstreamError';
    Object.assign(this, details);
  }
}

export function createUpstream(baseUrl, fetcher = fetch) {
  async function getJson(path) {
    let response;
    try {
      response = await fetcher(new URL(path, baseUrl));
    } catch (cause) {
      throw new UpstreamError(`来源不可达: ${path}`, { path, cause: String(cause) });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new UpstreamError(`来源返回 ${response.status}: ${path}`, { path, status: response.status, body: text });
    }
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new UpstreamError(`来源响应不是 JSON: ${path}`, { path, cause: String(cause), body: text });
    }
  }

  /**
   * 按 next 链逐页拉取标段台账。
   * - 任一页失败即停止，section 保持不完整，已取页保留；
   * - 重复页码（重复加载）只记录 duplicate，不重复计入；
   * - next 成环时主动截断，避免死循环。
   */
  async function fetchFieldSection(catalog, startPage = 1) {
    const pages = [];
    const errors = [];
    const seenPages = new Set();
    let pageNo = startPage;
    let guard = 0;

    while (pageNo != null) {
      guard += 1;
      if (guard > 1000) {
        errors.push({ page: pageNo, message: '分页链成环，已截断' });
        break;
      }
      if (seenPages.has(pageNo)) {
        errors.push({ page: pageNo, message: '分页重复加载，已忽略' });
        break;
      }
      seenPages.add(pageNo);
      const path = `/field/${catalog}?page=${pageNo}`;
      try {
        const page = await getJson(path);
        if (!Array.isArray(page.entries)) throw new UpstreamError('外业页缺少 entries', { path });
        pages.push({ pageNo, page });
        if (page.next == null) break;
        const nextNo = Number(new URL(page.next, 'http://local').searchParams.get('page'));
        if (!Number.isInteger(nextNo) || nextNo <= pageNo) {
          errors.push({ page: pageNo, message: 'next 分页非法，按缺页处理' });
          break;
        }
        pageNo = nextNo;
      } catch (error) {
        errors.push({ page: pageNo, message: error.message, status: error.status ?? null });
        break;
      }
    }

    return { catalog, pages, errors, complete: errors.length === 0 };
  }

  return {
    baseUrl,
    getJson,
    fetchFieldSection,
    async health() {
      return getJson('/health');
    },
    async route() {
      const [current, correspondences] = await Promise.all([
        getJson('/route/current'),
        getJson('/route/correspondences'),
      ]);
      return { current, correspondences };
    },
    async lab() {
      const [intake, splits, reports, retestRequests] = await Promise.all([
        getJson('/lab/intake'),
        getJson('/lab/splits'),
        getJson('/lab/reports'),
        getJson('/lab/retest-requests'),
      ]);
      return { intake, splits, reports, retestRequests };
    },
  };
}
