import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseDateToken, parseEntry, parseLine } from '../js/parse.js';

const cats = [
  { id: 1, name: '식비', aliases: ['밥', '커피'] },
  { id: 2, name: '교통비', aliases: [] },
  { id: 3, name: '교육', aliases: [] },
  { id: 4, name: '생활', aliases: [] },
];
const today = '2026-10-16';

test('금액 표기', () => {
  assert.equal(parseAmount('12000'), 12000);
  assert.equal(parseAmount('12,000'), 12000);
  assert.equal(parseAmount('12000원'), 12000);
  assert.equal(parseAmount('1.2만'), 12000);
  assert.equal(parseAmount('1만2천'), 12000);
  assert.equal(parseAmount('1만2000'), 12000);
  assert.equal(parseAmount('3천원'), 3000);
  assert.equal(parseAmount('2천1만'), null);
  assert.equal(parseAmount('식비'), null);
  assert.equal(parseAmount('0'), null);
});

test('날짜 단어', () => {
  assert.equal(parseDateToken('어제', today), '2026-10-15');
  assert.equal(parseDateToken('그제', today), '2026-10-14');
  assert.equal(parseDateToken('10/14', today), '2026-10-14');
  assert.equal(parseDateToken('12/30', today), '2025-12-30'); // 미래면 작년
  assert.equal(parseDateToken('2/30', today), null);
  assert.equal(parseDateToken('점심', today), null);
});

test('기본 형식과 순서 자유', () => {
  for (const s of ['식비 12000', '12000 식비', '식비 점심 12000']) {
    const e = parseEntry(s, cats, today);
    assert.equal(e.status, 'ok', s);
    assert.equal(e.categoryId, 1);
    assert.equal(e.amount, 12000);
  }
  const e = parseEntry('식비 점심 12000', cats, today);
  assert.equal(e.memo, '점심');
});

test('메모와 날짜', () => {
  const e = parseEntry('교통비 1500 버스 어제', cats, today);
  assert.deepEqual([e.categoryId, e.amount, e.date, e.memo], [2, 1500, '2026-10-15', '버스']);
});

test('별칭과 앞부분 일치', () => {
  assert.equal(parseEntry('커피 4500', cats, today).categoryId, 1);
  assert.equal(parseEntry('밥 9000', cats, today).categoryId, 1);
  assert.equal(parseEntry('생 3000', cats, today).categoryId, 4);
  assert.equal(parseEntry('커피4500', cats, today).amount, 4500);
});

test('겹치거나 못 찾으면 고르게 한다', () => {
  const amb = parseEntry('교 1500', cats, today);
  assert.equal(amb.status, 'ambiguous');
  assert.deepEqual(amb.candidates.sort(), [2, 3]);
  const none = parseEntry('주차 3000', cats, today);
  assert.equal(none.status, 'noCategory');
  assert.equal(none.memo, '주차');
  assert.equal(parseEntry('식비', cats, today).status, 'noAmount');
});

test('여러 건 한 번에 — 천 단위 쉼표는 금액', () => {
  const list = parseLine('식비 12,000, 교통비 1500\n밥 1만', cats, today);
  assert.deepEqual(list.map((e) => [e.categoryId, e.amount]), [[1, 12000], [2, 1500], [1, 10000]]);
});

test('10.14는 날짜', () => {
  const e = parseEntry('식비 10.14 8000', cats, today);
  assert.deepEqual([e.date, e.amount], ['2026-10-14', 8000]);
});

test('이름이 별칭보다 우선 — 별칭 단어는 메모로 남는다', () => {
  const withAlias = [{ id: 2, name: '교통비', aliases: ['버스'] }];
  const e = parseEntry('교 1500 버스', withAlias, today);
  assert.deepEqual([e.categoryId, e.memo], [2, '버스']);
  assert.equal(parseEntry('버스 1500', withAlias, today).categoryId, 2);
});

test('수입: "수입" 단어나 + 금액이면 항목 없이 수입으로', () => {
  const a = parseEntry('수입 50000 보너스', cats, today);
  assert.deepEqual([a.kind, a.amount, a.memo, a.status], ['income', 50000, '보너스', 'ok']);
  const b = parseEntry('+3만 환급 어제', cats, today);
  assert.deepEqual([b.kind, b.amount, b.memo, b.date], ['income', 30000, '환급', '2026-10-15']);
  assert.equal(parseEntry('식비 12000', cats, today).kind, 'expense');
  assert.equal(parseEntry('수입 보너스', cats, today).status, 'noAmount');
});
