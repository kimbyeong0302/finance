// 투자 그래프 계산 (순수 함수)
// 평가액 = Σ(보유 수량 × 해당일 종가). 그날 종가가 없으면 가장 최근 종가, 그것도 없으면 매수 단가.
// 수동 평가액(시세 API를 못 쓸 때)이 있는 날은 그 값을 그대로 쓴다.

// holdings: [{ code, qty, price, date }]
// prices:   [{ code, date, close }]
// manual:   [{ date, value }]
// 반환: [{ date, principal, value }] 날짜순
export function buildSeries(holdings, prices, manual = [], today) {
  if (!holdings.length && !manual.length) return [];
  const firstHolding = holdings.reduce((m, h) => (h.date < m ? h.date : m), '9999-12-31');
  const dates = new Set();
  for (const h of holdings) dates.add(h.date);
  for (const p of prices) if (p.date >= firstHolding) dates.add(p.date);
  for (const v of manual) dates.add(v.date);
  if (today && holdings.length) dates.add(today);
  const sorted = [...dates].sort();

  const byCode = new Map();
  for (const p of [...prices].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (!byCode.has(p.code)) byCode.set(p.code, []);
    byCode.get(p.code).push(p);
  }
  const manualByDate = new Map(manual.map((v) => [v.date, v.value]));

  const priceDates = new Set(prices.map((p) => p.date));
  let lastManual = null; // { value, principal } — 그 뒤로 시세가 없으면 이 값을 이어 쓴다
  return sorted.map((date) => {
    const owned = holdings.filter((h) => h.date <= date);
    const principal = owned.reduce((s, h) => s + h.qty * h.price, 0);
    let value;
    if (manualByDate.has(date)) {
      value = manualByDate.get(date);
      lastManual = { value, principal };
    } else if (priceDates.has(date) || !lastManual) {
      value = owned.reduce((s, h) => s + h.qty * (closeOn(byCode.get(h.code), date) ?? h.price), 0);
      lastManual = null;
    } else {
      // 수동 입력 이후 시세가 없는 날: 수동 평가액 + 그 뒤 늘어난 원금
      value = lastManual.value + (principal - lastManual.principal);
    }
    return { date, principal, value };
  });
}

// 그 날짜 이하에서 가장 최근 종가
function closeOn(list, date) {
  if (!list) return null;
  let found = null;
  for (const p of list) {
    if (p.date <= date) found = p.close;
    else break;
  }
  return found;
}

export function latestPoint(series) {
  return series.length ? series[series.length - 1] : { principal: 0, value: 0 };
}
