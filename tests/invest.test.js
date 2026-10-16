import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries } from '../js/invest.js';

const holdings = [{ code: 'A', qty: 10, price: 1000, date: '2026-10-01' }];

test('종가로 평가, 빠진 날은 직전 종가', () => {
  const prices = [{ code: 'A', date: '2026-10-01', close: 1100 }, { code: 'A', date: '2026-10-02', close: 1200 }];
  const s = buildSeries(holdings, prices, [], '2026-10-05');
  assert.deepEqual(s.map((p) => [p.date, p.principal, p.value]), [
    ['2026-10-01', 10000, 11000],
    ['2026-10-02', 10000, 12000],
    ['2026-10-05', 10000, 12000],
  ]);
});

test('시세가 없으면 매수 단가, 수동 평가액은 이어서 사용', () => {
  const s = buildSeries(
    [...holdings, { code: '', qty: 1, price: 5000, date: '2026-10-04' }],
    [],
    [{ date: '2026-10-02', value: 13000 }],
    '2026-10-05',
  );
  assert.deepEqual(s.map((p) => [p.date, p.principal, p.value]), [
    ['2026-10-01', 10000, 10000],
    ['2026-10-02', 10000, 13000],
    ['2026-10-04', 15000, 18000],
    ['2026-10-05', 15000, 18000],
  ]);
});
