// DB 위에서 돌아가는 장부 로직: 월 예산 만들기, 월말 정산, 잔액 계산
import { db, getSetting, setSetting } from './db.js';
import { computeSettlement, finalBudget } from './settle.js';
import { addMonths, lastDayOfMonth, todayStr, ymOf } from './util.js';

export async function activeCategories() {
  const all = await db.categories.orderBy('order').toArray();
  return all.filter((c) => !c.archived);
}

// 그 달 예산 행이 없는 항목은 기본 예산으로 만든다.
export async function ensureMonth(ym) {
  const cats = await activeCategories();
  const rows = await db.monthlyBudgets.where('ym').equals(ym).toArray();
  const have = new Set(rows.map((r) => r.categoryId));
  const add = cats
    .filter((c) => !have.has(c.id))
    .map((c) => ({ ym, categoryId: c.id, base: c.budget, cut: 0, final: c.budget }));
  if (add.length) await db.monthlyBudgets.bulkPut(add);
  return [...rows, ...add];
}

export async function spentByCategory(ym) {
  const list = await db.expenses.where('ym').equals(ym).toArray();
  const spent = {};
  for (const e of list) spent[e.categoryId] = (spent[e.categoryId] || 0) + e.amount;
  return spent;
}

// 이번 달 화면용: 항목별 { category, base, cut, final, used, left }
export async function monthView(ym) {
  const cats = await activeCategories();
  const rows = await ensureMonth(ym);
  const byCat = new Map(rows.map((r) => [r.categoryId, r]));
  const spent = await spentByCategory(ym);
  return cats.map((c) => {
    const r = byCat.get(c.id);
    const used = spent[c.id] || 0;
    return { category: c, base: r.base, cut: r.cut, final: r.final, used, left: r.final - used };
  });
}

export async function previewSettlement(ym) {
  const cats = new Set((await activeCategories()).map((c) => c.id));
  const rows = (await ensureMonth(ym)).filter((r) => cats.has(r.categoryId));
  return computeSettlement(rows, await spentByCategory(ym));
}

// 아직 정산 안 된 지난달들을 오래된 순서로 정산한다. 달마다 한 번만 (settlements에 기록).
// 반환: 이번 실행에서 처리한 정산 결과 목록
export async function runPendingSettlements(today = todayStr()) {
  const thisYm = ymOf(today);
  let startYm = await getSetting('startYm');
  if (!startYm) {
    await setSetting('startYm', thisYm);
    return [];
  }
  const results = [];
  for (let ym = startYm; ym < thisYm; ym = addMonths(ym, 1)) {
    if (await db.settlements.get(ym)) continue;
    const result = await settleMonth(ym);
    if (result) results.push(result);
  }
  return results;
}

async function settleMonth(ym) {
  const nextYm = addMonths(ym, 1);
  return db.transaction('rw', [db.categories, db.monthlyBudgets, db.expenses, db.savings, db.settlements], async () => {
    if (await db.settlements.get(ym)) return null; // 다른 탭에서 이미 처리
    const s = await previewSettlement(ym);
    if (s.net > 0) {
      await db.savings.add({ date: lastDayOfMonth(ym), amount: s.net, type: 'settle', memo: `${ym} 정산` });
    }
    if (s.net < 0) {
      const next = await ensureMonth(nextYm);
      for (const r of next) {
        const cut = s.cuts[r.categoryId] || 0;
        if (!cut) continue;
        await db.monthlyBudgets.put({ ...r, cut: r.cut + cut, final: finalBudget(r.base, r.cut + cut) });
      }
    }
    const record = { ym, amount: s.net, cuts: s.cuts, processedAt: new Date().toISOString() };
    await db.settlements.put(record);
    return record;
  });
}

export async function savingsBalance() {
  const list = await db.savings.toArray();
  return list.reduce((s, x) => s + x.amount, 0);
}

// 설정에서 항목 예산을 바꾸면 이번 달 예산에도 바로 반영 (감액분은 유지)
export async function updateCategoryBudget(categoryId, budget, ym) {
  const r = await db.monthlyBudgets.get([ym, categoryId]);
  if (r) await db.monthlyBudgets.put({ ...r, base: budget, final: finalBudget(budget, r.cut) });
}

// 항목별 자주 쓴 금액 상위 3개 (최근 100건 기준)
export async function frequentAmounts(categoryId) {
  const list = await db.expenses.where('categoryId').equals(categoryId).reverse().sortBy('id');
  const count = new Map();
  for (const e of list.slice(0, 100)) count.set(e.amount, (count.get(e.amount) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, 3).map(([a]) => a);
}
