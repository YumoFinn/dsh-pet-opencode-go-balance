/**
 * OpenCode Go 用量 → dsh-pet 的 `windows` 展示形态。
 *
 * 纯函数、零依赖：不 import 任何宿主包，方便用 `node --test` 直接覆盖。
 *
 * 契约来源（两边的真实实现，不是猜的）：
 *  - 输入：`dsh-opencode-go` 的 `opencodeGoUsage.read()` 结果（或 `/v1/usage` 的 `usage` 字段），
 *    形如 `{ rolling|weekly|monthly: { status, percent, resetsAt } }`；
 *  - 输出：dsh-pet `WindowsUsage`（`shape: 'windows'`），字段 `monthly` 必填、
 *    `rolling/weekly` 可缺省，`*CapUsd` 由服务商常量带出（与 dsh-pet 内置 `QUOTA_USD` 一致）。
 *
 * 失败一律 `throw`：dsh-pet 会把异常统一落成 `fetch-error` 气泡，绝不伪造 0 余额。
 */

/** 各窗口满额度（USD）—— Go 套餐的业务常量，接口不回报，与 dsh-pet 内置口径一致 */
export const CAP_USD = { rolling: 12, weekly: 30, monthly: 60 };

/** 滚动窗时长（展示名）：Go 是 5 小时 */
export const ROLLING_LABEL = '5h';

/** 三个窗口，顺序即展示优先级 */
const WINDOWS = ['rolling', 'weekly', 'monthly'];

/** 重置时间 → ISO 字符串；缺失/占位值返回 undefined（按「无重置时间」处理） */
function isoTime(value, what) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error('dsh-pet-opencode-go-balance: 非法重置时间 ' + what);
    return new Date(ms).toISOString();
  }
  // 数字时间戳：秒级 < 1e12，毫秒级 >= 1e12；
  // 0 / 负数 / NaN 在报文里都是占位值（不是 1970 年重置），按「无重置时间」处理
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  throw new Error('dsh-pet-opencode-go-balance: 非法重置时间 ' + what);
}

/** 已用百分比：接受数字；非法 → throw（数据异常要暴露，不能静默当 0） */
function percentOf(row, what) {
  const raw = row?.percent;
  const n = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(n)) {
    throw new Error('dsh-pet-opencode-go-balance: 非法用量字段 ' + what + '.percent');
  }
  // 下界取 0（负数无意义），上界不夹：超额时如实报 >100%，由展示层决定怎么说话
  return Math.max(0, n);
}

/**
 * 把 `usage` 对象映射成 dsh-pet 的 `BalanceSuccess`。
 *
 * @param usage - 用量对象（整体缺失/不是对象 → throw）
 * @param provider - 命中的 provider id，原样回填（dsh-pet 用它区分服务商）
 * @returns `{ ok: true, provider, shape: 'windows', data }`
 */
export function toWindows(usage, provider) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new Error('dsh-pet-opencode-go-balance: 响应缺少 usage 对象');
  }
  const data = {};
  for (const key of WINDOWS) {
    const row = usage[key];
    if (!row || typeof row !== 'object') {
      // 月度是底线（dsh-pet 的 WindowsUsage 要求它必有）；滚动/周缺省 = 该窗口不存在
      if (key === 'monthly') throw new Error('dsh-pet-opencode-go-balance: 响应缺少月度窗口');
      continue;
    }
    data[key] = percentOf(row, key);
    data[key + 'CapUsd'] = CAP_USD[key];
    const reset = isoTime(row.resetsAt, key + '.resetsAt');
    if (reset !== undefined) data[key + 'ResetsAt'] = reset;
  }
  data.rollingLabel = ROLLING_LABEL;
  return { ok: true, provider, shape: 'windows', data };
}
