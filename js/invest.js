// 투자 그래프 계산 (순수 함수). 모든 금액은 원화 기준.
// 원금   = Σ(수량 × 매수 단가 × 매수 시 환율)          — 국내 주식은 환율 1
// 평가액 = Σ(수량 × 해당일 종가 × 해당일 환율)
//  그날 종가가 없으면 가장 최근 종가, 그것도 없으면 매수 단가.
//  그날 환율이 없으면 가장 최근 환율, 그것도 없으면 매수 시 환율.
// 수동 평가액(시세 API를 못 쓸 때)이 있는 날은 그 값을 그대로 쓴다.

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

export function costKRW(h) {
  return h.qty * h.price * (h.currency === 'USD' ? (h.fx || 0) : 1);
}

// holdings: [{ code, qty, price, date, currency, fx }]
// prices:   [{ code, date, close }]   — 현지 통화
// manual:   [{ date, value }]
// fxRates:  [{ date, rate }]          — USD/KRW
// 반환: [{ date, principal, value }] 날짜순
export function buildSeries(holdings, prices, manual = [], today, fxRates = []) {
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
    byCode.get(p.code).push({ date: p.date, v: p.close });
  }
  const fxList = [...fxRates].sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => ({ date: r.date, v: r.rate }));
  const manualByDate = new Map(manual.map((v) => [v.date, v.value]));

  const valueOn = (h, date) => {
    const close = latestOn(byCode.get(h.code), date) ?? h.price;
    if (h.currency !== 'USD') return h.qty * close;
    const fx = latestOn(fxList, date) ?? h.fx ?? 0;
    return h.qty * close * fx;
  };

  const priceDates = new Set(prices.map((p) => p.date));
  let lastManual = null; // { value, principal } — 그 뒤로 시세가 없으면 이 값을 이어 쓴다
  return sorted.map((date) => {
    const owned = holdings.filter((h) => h.date <= date);
    const principal = owned.reduce((s, h) => s + costKRW(h), 0);
    let value;
    if (manualByDate.has(date)) {
      value = manualByDate.get(date);
      lastManual = { value, principal };
    } else if (priceDates.has(date) || !lastManual) {
      value = owned.reduce((s, h) => s + valueOn(h, date), 0);
      lastManual = null;
    } else {
      // 수동 입력 이후 시세가 없는 날: 수동 평가액 + 그 뒤 늘어난 원금
      value = lastManual.value + (principal - lastManual.principal);
    }
    return { date, principal, value };
  });
}

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

// 종목별 꺾은선과 표. 같은 종목코드의 여러 매수 건은 한 종목으로 합친다.
// 반환: { dates: [...], stocks: [{ key, code, name, market, currency, qty, avgPrice, lastClose, lastDate,
//                                  principal, value, gain, rate, series: [원화 평가액 | null] }] }
export function buildStockSeries(holdings, prices, today, fxRates = []) {
  if (!holdings.length) return { dates: [], stocks: [] };
  const groups = new Map();
  for (const h of holdings) {
    const key = h.code ? h.code : `id:${h.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  const firstHolding = holdings.reduce((m, h) => (h.date < m ? h.date : m), '9999-12-31');
  const dates = new Set(holdings.map((h) => h.date));
  for (const p of prices) if (p.date >= firstHolding && groups.has(p.code)) dates.add(p.date);
  if (today) dates.add(today);
  const sorted = [...dates].sort();

  const byCode = new Map();
  for (const p of [...prices].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (!byCode.has(p.code)) byCode.set(p.code, []);
    byCode.get(p.code).push({ date: p.date, v: p.close });
  }
  const fxList = [...fxRates].sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => ({ date: r.date, v: r.rate }));

  const stocks = [...groups.entries()].map(([key, lots]) => {
    const first = lots[0];
    const usd = first.currency === 'USD';
    const qty = lots.reduce((s, h) => s + h.qty, 0);
    const avgPrice = qty ? lots.reduce((s, h) => s + h.qty * h.price, 0) / qty : 0;
    const closes = byCode.get(first.code) || [];
    const series = sorted.map((date) => {
      const owned = lots.filter((h) => h.date <= date);
      if (!owned.length) return null;
      return owned.reduce((s, h) => {
        const close = latestOn(closes, date) ?? h.price;
        const fx = usd ? (latestOn(fxList, date) ?? h.fx ?? 0) : 1;
        return s + h.qty * close * fx;
      }, 0);
    });
    const lastPrice = closes.length ? closes[closes.length - 1] : null;
    const principal = lots.reduce((s, h) => s + costKRW(h), 0);
    const value = series[series.length - 1] ?? 0;
    return {
      key,
      code: first.code || '',
      name: first.name || first.code || '직접 평가 자산',
      market: first.market || (first.code ? 'KR' : 'NONE'),
      currency: first.currency || 'KRW',
      qty,
      avgPrice,
      lastClose: lastPrice ? lastPrice.v : null,
      lastDate: lastPrice ? lastPrice.date : null,
      principal,
      value,
      gain: value - principal,
      rate: principal ? ((value - principal) / principal) * 100 : 0,
      series,
    };
  });
  stocks.sort((a, b) => b.value - a.value);
  return { dates: sorted, stocks };
}

export function latestPoint(series) {
  return series.length ? series[series.length - 1] : { principal: 0, value: 0 };
}
