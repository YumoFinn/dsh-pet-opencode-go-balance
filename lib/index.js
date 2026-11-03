/**
 * dsh-pet-opencode-go-balance —— 把 OpenCode Go 的三窗口用量接进 dsh-pet 的余额气泡。
 *
 * 背景（两处错位，都在依赖方源码里写死，改配置解决不了）：
 *  1. dsh-pet 的余额按 `agentDefaultModel.currentSelection().provider` 查内置表，
 *     表里只有 `opencode-go`；而 `dsh-opencode-go` 注册的 provider id 是 `dsh-opencode-go`
 *     → 查表失败，气泡显示「当前服务商暂不支持余额查询」。
 *  2. dsh-pet 内置的 `opencode-go` 路由写死凭据 ref `OPENCODE_GO_API_KEY`，
 *     而多账号形态的 key 存在 `DSH_OPENCODE_GO_ACCOUNT_*` 下。
 *
 * 于是走 dsh-pet 官方的**第三方注册口**（`ctx.provide('petApi7340', { balance: { register } })`）：
 * 用 id `dsh-opencode-go` 注册一个 provider，取数交给 dsh-opencode-go 自己提供的
 * `opencodeGoUsage` 服务（同一个数据源、同一套账号与代理设置，不重复实现鉴权与重试），
 * 再映射成 dsh-pet 原生的 `windows` 形态 —— 气泡就渲染成 5h / 周 / 月 三个百分比 + 重置倒计时。
 *
 * 数据映射见 ./windows.js（纯函数，有单测）。
 *
 * 环境变量（仅在没有 `opencodeGoUsage` 服务时的直连兜底路径使用）：
 *  - `DSH_PET_OPENCODE_ACCOUNT_REF`：指定账号凭据 ref，换账号时不必改代码。
 */

import { toWindows } from './windows.js';

export const name = 'dsh-pet-opencode-go-balance';

/** dsh-pet 暴露的 Cordis 服务名（宿主半侧） */
const PET_SERVICE = 'petApi7340';
/** dsh-opencode-go 暴露的用量服务名：优先走它，账号、baseURL、代理、超时都由它负责 */
const USAGE_SERVICE = 'opencodeGoUsage';
/** 要接管的 provider id：必须与 agentDefaultModel 报告的完全一致 */
const PROVIDER_ID = 'dsh-opencode-go';

/** 仅当 `opencodeGoUsage` 服务不存在时的直连兜底 */
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const ACCOUNT_REF_ENV = 'DSH_PET_OPENCODE_ACCOUNT_REF';
const FALLBACK_ACCOUNT_REFS = ['OPENCODE_GO_API_KEY'];
const TIMEOUT_MS = 20_000;
const RETRIES = 2;

/** 等待 dsh-pet 装配完成：2s 一次，最多 60s */
const REGISTER_INTERVAL_MS = 2_000;
const REGISTER_TRIES = 30;

/** 取服务；缺失时返回 undefined（不抛，插件允许对方加载得比我们晚） */
function serviceOf(ctx, id) {
  try {
    return ctx.get(id, false);
  } catch {
    return undefined;
  }
}

/**
 * `credentialRef` 只做「格式校验 + 类型品牌」；拿不到宿主模块时退化成恒等，
 * 校验交给下面的正则（与 dsh-credentials 同一条规则）。
 */
let credentialRef = (value) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value))) {
    throw new TypeError('credential ref 非法：' + value);
  }
  return value;
};
try {
  const credentials = await import('@deepseek-ai/dsh-credentials');
  if (typeof credentials.credentialRef === 'function') credentialRef = credentials.credentialRef;
} catch {
  // 宿主没提供该模块时用内联实现，行为等价
}

/** 按顺序试账号 ref，返回第一个解析到的 key；全空则抛可执行的错误 */
async function resolveKey(ctx) {
  const refs = [process.env[ACCOUNT_REF_ENV]?.trim(), ...FALLBACK_ACCOUNT_REFS].filter(
    (v) => typeof v === 'string' && v.length > 0,
  );
  const credentials = serviceOf(ctx, 'credentials');
  const tried = [];
  for (const ref of [...new Set(refs)]) {
    tried.push(ref);
    try {
      if (credentials) {
        const hit = await credentials.resolve(credentialRef(ref));
        if (hit?.value) return hit.value;
      } else if (process.env[ref]) {
        return process.env[ref];
      }
    } catch {
      // 单个 ref 解析异常不影响继续试下一个
    }
  }
  throw new Error(
    '找不到 OpenCode Go 凭证（试过 ' +
      tried.join(', ') +
      '）；请安装并启用 dsh-opencode-go，或用环境变量 ' +
      ACCOUNT_REF_ENV +
      ' 指定账号 ref',
  );
}

/** 直连兜底：请求用量接口（超时 + 线性退避重试）；非 2xx 与网络错误一律抛错 */
async function requestUsage(key) {
  let last;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: 'Bearer ' + key,
          Accept: 'application/json',
          'User-Agent': 'dsh-pet-opencode-go-balance',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < RETRIES) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw new Error(
    'OpenCode Go 用量接口读取失败：' + (last instanceof Error ? last.message : String(last)),
  );
}

/** 读一次用量：优先用 dsh-opencode-go 的服务，其次才自己直连 */
async function readUsage(ctx) {
  const usageService = serviceOf(ctx, USAGE_SERVICE);
  if (usageService && typeof usageService.read === 'function') return await usageService.read();
  const body = await requestUsage(await resolveKey(ctx));
  return body?.usage;
}

/** 宿主插件主体：等 dsh-pet 的 petApi7340 就绪后注册一个 provider */
export function apply(ctx) {
  const def = {
    id: PROVIDER_ID,
    async fetch() {
      return toWindows(await readUsage(ctx), PROVIDER_ID);
    },
  };

  let registered = false;
  let tries = 0;

  const register = () => {
    if (registered) return true;
    const balance = serviceOf(ctx, PET_SERVICE)?.balance;
    if (!balance || typeof balance.register !== 'function') return false;
    try {
      const dispose = balance.register(def);
      registered = true;
      ctx.logger?.info?.(
        '[dsh-pet-opencode-go-balance] 已接管 OpenCode Go 用量（provider id: ' + PROVIDER_ID + '）',
      );
      try {
        ctx.on?.('dispose', () => {
          try {
            dispose();
          } catch {
            // 注销失败无害
          }
        });
      } catch {
        // 生命周期钩子不可用时不阻塞注册
      }
    } catch (e) {
      // 注册表拒绝（id 冲突等）重试无意义：记一条 warn 就停
      registered = true;
      ctx.logger?.warn?.(
        '[dsh-pet-opencode-go-balance] 注册被拒绝：' +
          (e instanceof Error ? e.message : String(e)),
      );
    }
    return true;
  };

  if (register()) return;

  const timer = setInterval(() => {
    tries += 1;
    if (register() || tries >= REGISTER_TRIES) clearInterval(timer);
  }, REGISTER_INTERVAL_MS);
  timer.unref?.();
}
