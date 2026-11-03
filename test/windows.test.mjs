import assert from 'node:assert/strict';
import test from 'node:test';

import { CAP_USD, ROLLING_LABEL, toWindows } from '../lib/windows.js';

const USAGE = {
  rolling: { status: 'ok', percent: 42, resetsAt: '2026-11-03T20:00:00Z' },
  weekly: { status: 'ok', percent: 61.5, resetsAt: '2026-11-08T00:00:00Z' },
  monthly: { status: 'ok', percent: 18, resetsAt: '2026-12-01T00:00:00Z' },
};

test('三个窗口完整映射，cap 与标签跟随 dsh-pet 口径', () => {
  const out = toWindows(structuredClone(USAGE), 'dsh-opencode-go');

  assert.deepEqual(out.ok, true);
  assert.equal(out.provider, 'dsh-opencode-go');
  assert.equal(out.shape, 'windows');
  assert.equal(out.data.rolling, 42);
  assert.equal(out.data.rollingCapUsd, CAP_USD.rolling);
  assert.equal(out.data.weekly, 61.5);
  assert.equal(out.data.weeklyCapUsd, CAP_USD.weekly);
  assert.equal(out.data.monthly, 18);
  assert.equal(out.data.monthlyCapUsd, CAP_USD.monthly);
  assert.equal(out.data.rollingLabel, ROLLING_LABEL);
  assert.equal(out.data.rollingResetsAt, '2026-11-03T20:00:00.000Z');
  assert.equal(out.data.monthlyResetsAt, '2026-12-01T00:00:00.000Z');
});

test('缺周窗口时只跳过它，不编造数字', () => {
  const usage = structuredClone(USAGE);
  delete usage.weekly;

  const out = toWindows(usage, 'dsh-opencode-go');

  assert.equal('weekly' in out.data, false);
  assert.equal('weeklyCapUsd' in out.data, false);
  assert.equal(out.data.monthly, 18);
});

test('超额时如实报 >100%，不夹到 100', () => {
  const usage = structuredClone(USAGE);
  usage.monthly.percent = 143.2;

  assert.equal(toWindows(usage, 'p').data.monthly, 143.2);
});

test('负数百分比取下界 0', () => {
  const usage = structuredClone(USAGE);
  usage.rolling.percent = -5;

  assert.equal(toWindows(usage, 'p').data.rolling, 0);
});

test('resetsAt 缺失或占位值时不带该字段', () => {
  const usage = structuredClone(USAGE);
  delete usage.rolling.resetsAt;
  usage.weekly.resetsAt = 0;

  const out = toWindows(usage, 'p');
  assert.equal('rollingResetsAt' in out.data, false);
  assert.equal('weeklyResetsAt' in out.data, false);
  assert.equal(out.data.weekly, 61.5);
});

test('秒级时间戳按秒解释，毫秒级按毫秒解释', () => {
  const seconds = { ...structedWith(1_800_000_000) };

  const out = toWindows(seconds, 'p');
  assert.equal(out.data.rollingResetsAt, new Date(1_800_000_000_000).toISOString());
});

function structedWith(seconds) {
  return {
    rolling: { percent: 1, resetsAt: seconds },
    weekly: { percent: 2, resetsAt: seconds * 1000 },
    monthly: { percent: 3, resetsAt: seconds * 1000 },
  };
}

test('月度缺失 / 用量不是对象 / 百分比非法 一律抛错（不伪造 0 余额）', () => {
  const noMonthly = structuredClone(USAGE);
  delete noMonthly.monthly;
  assert.throws(() => toWindows(noMonthly, 'p'), /缺少月度窗口/);

  assert.throws(() => toWindows(undefined, 'p'), /缺少 usage 对象/);
  assert.throws(() => toWindows([], 'p'), /缺少 usage 对象/);

  const bad = structuredClone(USAGE);
  bad.rolling.percent = 'oops';
  assert.throws(() => toWindows(bad, 'p'), /非法用量字段/);

  const badReset = structuredClone(USAGE);
  badReset.weekly.resetsAt = 'not-a-date';
  assert.throws(() => toWindows(badReset, 'p'), /非法重置时间/);
});
