import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, name } from '../lib/index.js';

const USAGE = {
  rolling: { status: 'ok', percent: 42, resetsAt: '2026-11-03T20:00:00Z' },
  weekly: { status: 'ok', percent: 61, resetsAt: '2026-11-08T00:00:00Z' },
  monthly: { status: 'ok', percent: 18, resetsAt: '2026-12-01T00:00:00Z' },
};

/** 造一个够用的宿主 ctx：只实现插件会碰到的 get / logger / on */
function fakeCtx({ pet = true, usage = true, credentials } = {}) {
  const registered = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    on() {},
    get(id) {
      if (id === 'petApi7340') {
        return pet
          ? {
              balance: {
                register(def) {
                  registered.push(def);
                  return () => {};
                },
              },
            }
          : undefined;
      }
      if (id === 'opencodeGoUsage') return usage ? { read: async () => structuredClone(USAGE) } : undefined;
      if (id === 'credentials') return credentials;
      return undefined;
    },
  };
  return { ctx, registered };
}

test('包名与 provider id 对齐 dsh-opencode-go', () => {
  assert.equal(name, 'dsh-pet-opencode-go-balance');

  const { ctx, registered } = fakeCtx();
  apply(ctx);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, 'dsh-opencode-go');
});

test('fetch 从 opencodeGoUsage 服务取数并映射成 windows 形态', async () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx);

  const out = await registered[0].fetch({ provider: 'dsh-opencode-go' });

  assert.equal(out.ok, true);
  assert.equal(out.shape, 'windows');
  assert.equal(out.provider, 'dsh-opencode-go');
  assert.equal(out.data.rolling, 42);
  assert.equal(out.data.rollingLabel, '5h');
});

test('没有用量服务时直连兜底，走环境变量里的 key', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return {
      ok: true,
      status: 200,
      json: async () => ({ usage: structuredClone(USAGE) }),
    };
  };
  process.env.OPENCODE_GO_API_KEY = 'test-key';
  try {
    const { ctx, registered } = fakeCtx({ usage: false });
    apply(ctx);

    const out = await registered[0].fetch({ provider: 'dsh-opencode-go' });

    assert.equal(out.data.monthly, 18);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/usage$/);
    assert.equal(calls[0].auth, 'Bearer test-key');
  } finally {
    globalThis.fetch = original;
    delete process.env.OPENCODE_GO_API_KEY;
  }
});

test('既没有服务也没有凭据时抛可执行的错误', async () => {
  const { ctx, registered } = fakeCtx({ usage: false });
  apply(ctx);

  await assert.rejects(
    () => registered[0].fetch({ provider: 'dsh-opencode-go' }),
    /找不到 OpenCode Go 凭证/,
  );
});

test('dsh-pet 尚未装配时不注册、也不抛错', () => {
  const { ctx, registered } = fakeCtx({ pet: false });

  assert.doesNotThrow(() => apply(ctx));
  assert.equal(registered.length, 0);
});
