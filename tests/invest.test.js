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

import { marketOf, costKRW } from '../js/invest.js';

test('시장 자동 구분', () => {
  assert.equal(marketOf('005930'), 'KR');
  assert.equal(marketOf('aapl'), 'US');
  assert.equal(marketOf('BRK.B'), 'US');
  assert.equal(marketOf(''), 'NONE');
  assert.equal(marketOf('12345'), null);
  assert.equal(marketOf('삼성'), null);
});

test('미국 주식: 원금은 매수 시 환율, 평가액은 그날 환율', () => {
  const us = { code: 'AAPL', qty: 2, price: 100, date: '2026-10-01', currency: 'USD', fx: 1300 };
  assert.equal(costKRW(us), 260000);
  const s = buildSeries(
    [us],
    [{ code: 'AAPL', date: '2026-10-01', close: 100 }, { code: 'AAPL', date: '2026-10-02', close: 110 }],
    [],
    '2026-10-03',
    [{ date: '2026-10-01', rate: 1300 }, { date: '2026-10-02', rate: 1400 }],
  );
  assert.deepEqual(s.map((p) => [p.date, p.principal, p.value]), [
    ['2026-10-01', 260000, 260000],
    ['2026-10-02', 260000, 308000],
    ['2026-10-03', 260000, 308000],
  ]);
});

test('환율 데이터가 없으면 매수 시 환율로 평가', () => {
  const s = buildSeries([{ code: 'MSFT', qty: 1, price: 400, date: '2026-10-01', currency: 'USD', fx: 1350 }],
    [{ code: 'MSFT', date: '2026-10-01', close: 410 }], [], '2026-10-01');
  assert.equal(s[0].value, 410 * 1350);
});

import { buildStockSeries } from '../js/invest.js';

test('종목별: 같은 종목은 합치고 평균 매수가·현재가·수익률', () => {
  const r = buildStockSeries(
    [
      { id: 1, code: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', qty: 10, price: 60000, date: '2026-10-01', fx: 1 },
      { id: 2, code: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', qty: 10, price: 70000, date: '2026-10-03', fx: 1 },
      { id: 3, code: 'AAPL', name: 'AAPL', market: 'US', currency: 'USD', qty: 1, price: 100, date: '2026-10-02', fx: 1300 },
    ],
    [{ code: '005930', date: '2026-10-02', close: 66000 }, { code: 'AAPL', date: '2026-10-02', close: 110 }],
    '2026-10-03',
    [{ date: '2026-10-02', rate: 1400 }],
  );
  assert.deepEqual(r.dates, ['2026-10-01', '2026-10-02', '2026-10-03']);
  const sam = r.stocks.find((s) => s.code === '005930');
  assert.equal(sam.qty, 20);
  assert.equal(sam.avgPrice, 65000);
  assert.equal(sam.lastClose, 66000);
  assert.deepEqual(sam.series, [600000, 660000, 1320000]);
  assert.equal(sam.rate, (1320000 - 1300000) / 1300000 * 100);
  const aapl = r.stocks.find((s) => s.code === 'AAPL');
  assert.deepEqual(aapl.series, [null, 154000, 154000]);
  assert.equal(aapl.principal, 130000);
});
