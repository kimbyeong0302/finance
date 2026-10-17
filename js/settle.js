// 월말 정산 계산 (순수 함수 — DB와 화면을 모른다)
//
// 정산 금액 = Σ 남은 금액 − Σ 초과 금액
//  플러스 → 전부 저축으로
//  마이너스 → 저축은 그대로, 부족분을 초과 항목들의 다음 달 예산에서 초과 금액 비율대로 감액

// budgets: [{ categoryId, final }], spent: { [categoryId]: 지출 합계 }
export function computeSettlement(budgets, spent) {
  const rows = budgets.map((b) => {
    const used = spent[b.categoryId] || 0;
    const left = b.final - used;
    return { categoryId: b.categoryId, final: b.final, used, remain: Math.max(0, left), over: Math.max(0, -left) };
  });
  const totalRemain = rows.reduce((s, r) => s + r.remain, 0);
  const totalOver = rows.reduce((s, r) => s + r.over, 0);
  const net = totalRemain - totalOver;
  const cuts = net < 0 ? distributeCuts(-net, rows) : {};
  return { net, totalRemain, totalOver, rows, cuts };
}

// 부족분을 초과 금액 비율로 나눈다. 원 단위로 반올림하고, 반올림 오차는 가장 많이 초과한 항목이 진다.
export function distributeCuts(shortage, rows) {
  const overRows = rows.filter((r) => r.over > 0);
  const totalOver = overRows.reduce((s, r) => s + r.over, 0);
  const cuts = {};
  if (!totalOver || shortage <= 0) return cuts;
  let assigned = 0;
  for (const r of overRows) {
    cuts[r.categoryId] = Math.floor((shortage * r.over) / totalOver);
    assigned += cuts[r.categoryId];
  }
  const biggest = overRows.reduce((a, b) => (b.over > a.over ? b : a));
  cuts[biggest.categoryId] += shortage - assigned;
  return cuts;
}

// 다음 달 예산 = 기본 예산 − 감액분 (0 아래로는 내려가지 않음)
export function finalBudget(base, cut) {
  return Math.max(0, base - cut);
}

// 총 예산을 바꾸면 지금 배분 비율대로 항목에 나눈다.
// 총액이 천 원 단위면 항목도 천 원 단위로 맞추고, 남는 차이는 가장 큰 항목이 가진다.
// budgets: [{ id, budget }] → { [id]: 새 예산 }
export function distributeTotal(budgets, total) {
  const result = {};
  if (!budgets.length) return result;
  const current = budgets.reduce((s, b) => s + (b.budget || 0), 0);
  const unit = total % 1000 === 0 ? 1000 : 1;
  let assigned = 0;
  for (const b of budgets) {
    const share = current > 0 ? (b.budget || 0) / current : 1 / budgets.length;
    result[b.id] = Math.floor((total * share) / unit) * unit;
    assigned += result[b.id];
  }
  const biggest = budgets.reduce((a, b) => (current > 0 ? (b.budget > a.budget ? b : a) : a));
  result[biggest.id] += total - assigned;
  return result;
}
