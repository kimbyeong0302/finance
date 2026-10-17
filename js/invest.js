// 투자 계산 (순수 함수). 모든 금액은 원화 기준.
//
// 종목마다 매수·매도를 날짜순 사건으로 보고 보유 상태(수량, 원가)를 따라간다.
//  매수: 수량 += q, 원가 += q × 단가 × 매수 시 환율
//  매도: 평균단가법 — 팔린 비율만큼 원가를 덜어낸다 (평균 매수가는 그대로)
//        실현손익 = 매도 금액(q × 매도가 × 매도 시 환율) − 덜어낸 원가
// 원금   = 남은 원가 합계
// 평가액 = Σ(남은 수량 × 그날 종가 × 그날 환율)
//  그날 종가가 없으면 가장 최근 종가, 그것도 없으면 평균 매수가.
//  그날 환율이 없으면 가장 최근 환율, 그것도 없으면 평균 매수 환율.
// 수동 평가액(시세 API를 못 쓸 때)이 있는 날은 전체 평가액에 그 값을 그대로 쓴다.

// 종목코드로 시장 구분: 6자리 숫자 → 국내, 영문 티커 → 미국, 비어 있으면 직접 평가 자산
export function marketOf(code) {
  const c = (code || '').trim().toUpperCase();
  if (!c) return 'NONE';
  if (/^\d{6}$/.test(c)) return 'KR';
  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(c)) return 'US';
  return null; // 알 수 없는 형식
}

export function currencyOf(market) {
  return market === 'US' ? 'USD' : 'KRW';
}

const isUSD = (h) => h.currency === 'USD';

export function costKRW(h) {
  return h.qty * h.price * (isUSD(h) ? (h.fx || 0) : 1);
}

// 같은 종목을 묶는 열쇠: 종목코드, 코드가 없는 직접 평가 자산은 매수 기록마다 따로
export function holdingKey(h) {
  return h.code ? h.code : `id:${h.id}`;
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

// 날짜순 목록에서 그 날짜 이하의 가장 최근 값
function latestOn(list, date) {
  if (!list) return null;
  let found = null;
  for (const p of list) {
    if (p.date <= date) found = p.v;
    else break;
  }
  return found;
}

// 한 종목의 매수·매도 사건을 따라가며 사건 후 상태를 남긴다.
// 같은 날 매수와 매도가 있으면 매수를 먼저 반영한다.
function walkPositions(lots, sales) {
  const events = [
    ...lots.map((h) => ({ date: h.date, buy: h })),
    ...sales.map((s) => ({ date: s.date, sell: s })),
  ].sort((a, b) => byDate(a, b) || (a.buy ? -1 : 1) - (b.buy ? -1 : 1));
  let qty = 0;
  let costLocal = 0;
  let costKrw = 0;
  const snapshots = []; // { date, qty, costLocal, costKrw } — 그날 마지막 상태
  const soldInfo = new Map(); // sale.id → { basis, proceeds, realized, short }
  for (const e of events) {
    if (e.buy) {
      qty += e.buy.qty;
      costLocal += e.buy.qty * e.buy.price;
      costKrw += costKRW(e.buy);
    } else {
      const s = e.sell;
      const q = Math.min(s.qty, qty);
      const ratio = qty > 0 ? q / qty : 0;
      const basis = costKrw * ratio;
      const proceeds = s.qty * s.price * (s.currency === 'USD' ? (s.fx || 0) : 1);
      soldInfo.set(s.id, { basis, proceeds, realized: proceeds - basis, short: s.qty - q });
      costLocal -= costLocal * ratio;
      costKrw -= basis;
      qty -= q;
      if (qty < 1e-9) { qty = 0; costLocal = 0; costKrw = 0; }
    }
    const last = snapshots[snapshots.length - 1];
    const snap = { date: e.date, qty, costLocal, costKrw };
    if (last && last.date === e.date) snapshots[snapshots.length - 1] = snap;
    else snapshots.push(snap);
  }
  return { snapshots, soldInfo };
}

function positionOn(snapshots, date) {
  let found = null;
  for (const s of snapshots) {
    if (s.date <= date) found = s;
    else break;
  }
  return found;
}

// 전체 계산.
// holdings: [{ id, code, name, market, currency, qty, price, date, fx }]
// sales:    [{ id, key, code, date, qty, price, currency, fx, toSavings }]
// prices:   [{ code, date, close }]  — 현지 통화
// manual:   [{ date, value }]
// fxRates:  [{ date, rate }]         — USD/KRW
export function computePortfolio({ holdings = [], sales = [], prices = [], manual = [], fxRates = [], today } = {}) {
  const groups = new Map();
  for (const h of holdings) {
    const key = holdingKey(h);
    if (!groups.has(key)) groups.set(key, { lots: [], sales: [] });
    groups.get(key).lots.push(h);
  }
  for (const s of sales) if (groups.has(s.key)) groups.get(s.key).sales.push(s);

  const firstHolding = holdings.reduce((m, h) => (h.date < m ? h.date : m), '9999-12-31');
  const dates = new Set();
  for (const h of holdings) dates.add(h.date);
  for (const s of sales) dates.add(s.date);
  for (const p of prices) if (p.date >= firstHolding && groups.has(p.code)) dates.add(p.date);
  for (const v of manual) dates.add(v.date);
  if (today && holdings.length) dates.add(today);
  const sorted = [...dates].sort();

  const closesByCode = new Map();
  for (const p of [...prices].sort(byDate)) {
    if (!closesByCode.has(p.code)) closesByCode.set(p.code, []);
    closesByCode.get(p.code).push({ date: p.date, v: p.close });
  }
  const fxList = [...fxRates].sort(byDate).map((r) => ({ date: r.date, v: r.rate }));

  const enrichedSales = [];
  const stocks = [...groups.entries()].map(([key, g]) => {
    const lots = [...g.lots].sort(byDate);
    const first = lots[0];
    const usd = isUSD(first);
    const { snapshots, soldInfo } = walkPositions(lots, g.sales);
    const closes = closesByCode.get(first.code) || [];
    const saleDates = new Set(g.sales.map((s) => s.date));

    const parts = sorted.map((date) => {
      const pos = positionOn(snapshots, date);
      if (!pos) return null;
      if (!pos.qty) return { principal: 0, value: 0, sold: saleDates.has(date) };
      const avgLocal = pos.costLocal / pos.qty;
      const close = latestOn(closes, date) ?? avgLocal;
      const fx = usd ? (latestOn(fxList, date) ?? (pos.costLocal ? pos.costKrw / pos.costLocal : 0)) : 1;
      return { principal: pos.costKrw, value: pos.qty * close * fx };
    });

    for (const s of g.sales) enrichedSales.push({ ...s, name: first.name || first.code, ...soldInfo.get(s.id) });
    const realized = g.sales.reduce((sum, s) => sum + (soldInfo.get(s.id)?.realized || 0), 0);
    const now = snapshots[snapshots.length - 1];
    const lastPrice = closes.length ? closes[closes.length - 1] : null;
    const value = parts[parts.length - 1]?.value ?? 0;
    const principal = now.costKrw;
    return {
      key,
      code: first.code || '',
      name: first.name || first.code || '직접 평가 자산',
      market: first.market || (first.code ? 'KR' : 'NONE'),
      currency: first.currency || 'KRW',
      qty: now.qty,
      avgPrice: now.qty ? now.costLocal / now.qty : 0,
      lastClose: lastPrice ? lastPrice.v : null,
      lastDate: lastPrice ? lastPrice.date : null,
      principal,
      value,
      gain: value - principal,
      rate: principal ? ((value - principal) / principal) * 100 : 0,
      realized,
      // 그래프: 사기 전과 전량 매도한 뒤(매도한 날 제외)는 비운다
      series: parts.map((p) => (p && (p.value || p.principal || p.sold) ? p.value : null)),
      parts,
    };
  });

  // 전체 원금·평가액
  const manualByDate = new Map(manual.map((v) => [v.date, v.value]));
  const priceDates = new Set(prices.map((p) => p.date));
  let lastManual = null; // { value, principal } — 그 뒤로 시세가 없으면 이 값을 이어 쓴다
  const total = (holdings.length || manual.length) ? sorted.map((date, i) => {
    let principal = 0;
    let computed = 0;
    for (const st of stocks) {
      const p = st.parts[i];
      if (p) { principal += p.principal; computed += p.value; }
    }
    let value;
    if (manualByDate.has(date)) {
      value = manualByDate.get(date);
      lastManual = { value, principal };
    } else if (priceDates.has(date) || !lastManual) {
      value = computed;
      lastManual = null;
    } else {
      // 수동 입력 이후 시세가 없는 날: 수동 평가액 + 그 뒤 늘어난(줄어든) 원금
      value = lastManual.value + (principal - lastManual.principal);
    }
    return { date, principal, value };
  }) : [];

  for (const st of stocks) delete st.parts;
  stocks.sort((a, b) => b.value - a.value || b.realized - a.realized);
  enrichedSales.sort((a, b) => byDate(b, a) || b.id - a.id);
  const realized = enrichedSales.reduce((s, x) => s + (x.realized || 0), 0);
  return { dates: sorted, total, stocks, sales: enrichedSales, realized };
}

// 그날 그 종목을 몇 주 갖고 있었나 (매도 수량 확인용)
export function heldQtyOn(holdings, sales, key, date, excludeSaleId = null) {
  const lots = holdings.filter((h) => holdingKey(h) === key);
  const ss = sales.filter((s) => s.key === key && s.id !== excludeSaleId);
  const { snapshots } = walkPositions(lots, ss);
  return positionOn(snapshots, date)?.qty ?? 0;
}

// 예전 호출 형태 유지
export function buildSeries(holdings, prices, manual = [], today, fxRates = [], sales = []) {
  return computePortfolio({ holdings, sales, prices, manual, fxRates, today }).total;
}

export function buildStockSeries(holdings, prices, today, fxRates = [], sales = []) {
  const r = computePortfolio({ holdings, sales, prices, fxRates, today });
  return { dates: r.dates, stocks: r.stocks };
}

export function latestPoint(series) {
  return series.length ? series[series.length - 1] : { principal: 0, value: 0 };
}
