import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSettlement, finalBudget } from '../js/settle.js';

test('플러스면 전부 저축', () => {
  const s = computeSettlement([{ categoryId: 1, final: 100000 }, { categoryId: 2, final: 50000 }], { 1: 70000, 2: 60000 });
  assert.equal(s.net, 30000 - 10000);
  assert.deepEqual(s.cuts, {});
});

test('설계 문서 예: 3만 부족, 교통비 3만·외식비 2만 초과 → 18,000 / 12,000 감액', () => {
  // 식비 2만 남음, 교통비 3만 초과, 외식비 2만 초과 → 2만 − 5만 = −3만
  const s = computeSettlement(
    [{ categoryId: 1, final: 100000 }, { categoryId: 2, final: 50000 }, { categoryId: 3, final: 50000 }],
    { 1: 80000, 2: 80000, 3: 70000 },
  );
  assert.equal(s.net, -30000);
  assert.deepEqual(s.cuts, { 2: 18000, 3: 12000 });
});

test('반올림 오차는 합계가 맞게', () => {
  const s = computeSettlement(
    [{ categoryId: 1, final: 0 }, { categoryId: 2, final: 0 }, { categoryId: 3, final: 0 }],
    { 1: 10000, 2: 10000, 3: 10000 },
  );
  const sum = Object.values(s.cuts).reduce((a, b) => a + b, 0);
  assert.equal(sum, 30000);
  assert.deepEqual(s.cuts, { 1: 10000, 2: 10000, 3: 10000 });
  const odd = computeSettlement([{ categoryId: 1, final: 0 }, { categoryId: 2, final: 0 }], { 1: 1, 2: 2 });
  assert.equal(Object.values(odd.cuts).reduce((a, b) => a + b, 0), 3);
});

test('감액은 0 아래로 내려가지 않음', () => {
  assert.equal(finalBudget(10000, 30000), 0);
  assert.equal(finalBudget(50000, 18000), 32000);
});
