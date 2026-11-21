// 纯领域规则：不碰 HTTP、不碰存储，全部可独立单测。
// 深度单位米，区间一律左闭右开 [from, to)。

export class WorkflowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    Object.assign(this, details);
  }
}

// 交卷/缺口四分类 + 已验
export const ItemStatus = Object.freeze({
  VERIFIED: 'VERIFIED', // 已有有效报告覆盖
  RECEIVED_PENDING: 'RECEIVED_PENDING', // 已接收未出结果
  CONFLICT: 'CONFLICT', // 资料冲突（封签、歧义、证据失效、台账缺页等）
  REDRILL: 'REDRILL', // 必须重取
  NOT_DELIVERED: 'NOT_DELIVERED', // 还未送样
});

// 样本对应到新路线地面点的解析结果
export const MappingStatus = Object.freeze({
  DIRECT: 'DIRECT', // 同版本按桩号直接对应
  UNIQUE: 'UNIQUE', // 跨版本且范围+深度唯一对应，可直接挪用
  CONFIRMED: 'CONFIRMED', // 歧义经工程师按版本确认
  AMBIGUOUS: 'AMBIGUOUS', // 一对多，未经确认
  CONFLICT: 'CONFLICT', // 多个对应关系均被确认，无法取舍
  NONE: 'NONE', // 无对应表覆盖
  UNPLANNED: 'UNPLANNED', // 现版本计划里找不到该桩号的地面点
});

const USABLE = new Set([MappingStatus.DIRECT, MappingStatus.UNIQUE, MappingStatus.CONFIRMED]);

export const isUsableMapping = (resolution) => USABLE.has(resolution.status);

// 外业条码只在承包方+送样批次内唯一，三元组才是样本身份
export const sampleKey = (ref) => `${ref.contractor}|${ref.lot}|${ref.barcode}`;

export const refToKey = (reference) => `${reference[0]}|${reference[1]}|${reference[2]}`;

// 左闭右开
export const inside = (point, from, to) => point >= from && point < to;

export const intervalLabel = (from, to) => `[${from},${to})`;

// 对应表条目无业务主键，按内容生成确定性标识
export function correspondenceId(c) {
  return `${c.old}->${c.new}|${c.start}-${c.end}|d${c.minDepth}-${c.maxDepth}|${c.point}`;
}

// 确认只适用于所注明的路线版本：标识里带新版本号
export const confirmationKey = (correspondence) =>
  `${correspondenceId(correspondence)}@${correspondence.new}`;

/**
 * 解析一个外业样本在目标路线版本下对应哪个地面点。
 * 里程区间与土层深度区间同时约束，任一不落区间即不可挪用。
 */
export function resolveSample(sample, targetAlignment, plan, correspondences, localConfirmations = new Set()) {
  if (sample.alignment === targetAlignment) {
    const point = Object.entries(plan.points).find(([, chainage]) => chainage === sample.chainage)?.[0];
    return point
      ? { status: MappingStatus.DIRECT, point, matches: [] }
      : { status: MappingStatus.UNPLANNED, point: null, matches: [] };
  }

  const matches = correspondences.filter((c) =>
    c.old === sample.alignment
    && c.new === targetAlignment
    && inside(sample.chainage, c.start, c.end)
    && inside(sample.depth, c.minDepth, c.maxDepth));

  if (matches.length === 0) return { status: MappingStatus.NONE, point: null, matches: [] };

  const confirmed = matches.filter((c) => c.confirmed === true || localConfirmations.has(confirmationKey(c)));

  if (matches.length === 1) {
    return {
      status: confirmed.length === 1 ? MappingStatus.CONFIRMED : MappingStatus.UNIQUE,
      point: matches[0].point,
      matches,
    };
  }
  // 一对多：只有工程师恰好确认其中一条时才能定案
  if (confirmed.length === 1) {
    return { status: MappingStatus.CONFIRMED, point: confirmed[0].point, matches, resolvedBy: confirmed[0] };
  }
  if (confirmed.length > 1) {
    return { status: MappingStatus.CONFLICT, point: null, matches, reason: '同一样本的多个对应关系均被确认' };
  }
  return { status: MappingStatus.AMBIGUOUS, point: null, matches };
}

/**
 * 报告有效性：
 * - withdrawn 的报告永不生效；
 * - 被其他报告 replaces 的报告即告失效（替代件自身若被撤销，证据链仍然断档，
 *   直到出现新的有效报告，见 Z1 -> Z4(withdrawn) -> Z5 的演练剧本）。
 */
export function effectiveReports(reports) {
  const replaced = new Set(reports.filter((r) => r.replaces).map((r) => r.replaces));
  return reports.filter((r) => r.withdrawn !== true && !replaced.has(r.id));
}

export function reportState(report, allReports) {
  if (report.withdrawn === true) return 'WITHDRAWN';
  if (allReports.some((r) => r.replaces === report.id)) return 'SUPERSEDED';
  return 'EFFECTIVE';
}

/**
 * 复验工单排队：按实验室受理时间、工单号顺序处理；同一工单号只计一次。
 * 账面 availableGrams 已扣除实验室确认分出的量；待领工单逐单占用，
 * 任一单余额不足即阻塞，其后工单不能跳过它先领。
 */
export function planRetestQueue(availableGrams, orders) {
  const seen = new Set();
  const pending = [];
  const issued = [];
  const withdrawn = [];
  for (const order of orders) {
    if (seen.has(order.id)) continue; // 同一工单多次受理只计一次
    seen.add(order.id);
    if (order.status === 'withdrawn') withdrawn.push(order);
    else if (order.status === 'issued') issued.push(order);
    else pending.push(order);
  }
  pending.sort((a, b) => {
    // 实验室已受理的源端工单优先；本地补勘申请尚未被受理，排在其后
    const aLocal = a.origin === 'local' ? 1 : 0;
    const bLocal = b.origin === 'local' ? 1 : 0;
    if (aLocal !== bLocal) return aLocal - bLocal;
    const ta = String(a.receivedAt ?? '');
    const tb = String(b.receivedAt ?? '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
  });

  let reserved = 0;
  const queue = pending.map((order) => {
    // 逐单试算：余额够就占用，不够就阻塞；
    // 前单撤回会释放占用，后单在重算时自然获得份额，因此不做永久阻塞传递
    const feasible = availableGrams - reserved >= order.grams;
    const entry = { ...order, feasible, blocked: !feasible };
    if (feasible) reserved += order.grams;
    return entry;
  });

  return {
    availableGrams,
    reserved,
    freeAfterReservations: availableGrams - reserved,
    queue,
    issued,
    withdrawn,
  };
}

// 可再分样：留足全部已占用净重后仍够本次申请
export const canResplit = (plan, grams) =>
  plan.freeAfterReservations >= grams && grams > 0;
