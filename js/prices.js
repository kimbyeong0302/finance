// 시세 따라잡기 — 공공데이터포털 「금융위원회_주식시세정보」 getStockPriceInfo
// 무료·일 1회 갱신. 기준일 다음 영업일 오후 1시 이후 반영되므로 최신 점은 항상 전 영업일 종가.
// 브라우저에서 직접 호출이 CORS로 막히면 오류를 돌려주고, 화면에서는 평가액 수동 입력으로 대체한다.
import { db, getSetting, setSetting } from './db.js';
import { addDays, compactDate, todayStr } from './util.js';

const ENDPOINT = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';

function toDash(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// 한 종목의 [from, to] 구간 종가. 반환: [{ code, date, close, name }]
export async function fetchCloses(apiKey, code, from, to) {
  const out = [];
  for (let page = 1; page < 20; page++) {
    const params = new URLSearchParams({
      resultType: 'json',
      numOfRows: '500',
      pageNo: String(page),
      likeSrtnCd: code,
      beginBasDt: compactDate(from),
      endBasDt: compactDate(addDays(to, 1)), // endBasDt는 '미만' 조건
    });
    // 공공데이터포털 키는 이미 인코딩된 형태(Encoding 키)로 받는 경우가 많아 그대로 붙인다
    const key = /%[0-9A-Fa-f]{2}/.test(apiKey) ? apiKey : encodeURIComponent(apiKey);
    const res = await fetch(`${ENDPOINT}?serviceKey=${key}&${params}`);
    if (!res.ok) throw new Error(`시세 API 응답 오류 (${res.status})`);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // 키 오류 등은 XML로 돌아온다
      const msg = text.match(/<returnAuthMsg>([^<]+)/)?.[1] || text.match(/<resultMsg>([^<]+)/)?.[1];
      throw new Error(`시세 API 오류: ${msg || '알 수 없는 응답'}`);
    }
    const header = json?.response?.header;
    if (header && header.resultCode !== '00') throw new Error(`시세 API 오류: ${header.resultMsg}`);
    const body = json?.response?.body;
    let items = body?.items?.item || [];
    if (!Array.isArray(items)) items = [items];
    for (const it of items) {
      if (it.srtnCd !== code) continue; // likeSrtnCd는 부분 일치라 정확히 거른다
      out.push({ code, date: toDash(it.basDt), close: Number(it.clpr), name: it.itmsNm });
    }
    const total = Number(body?.totalCount || 0);
    if (page * 500 >= total) break;
  }
  return out;
}

// 앱을 열 때: 종목마다 마지막으로 저장된 날짜 다음날부터 오늘까지 한꺼번에 받아 저장
export async function catchUpPrices(today = todayStr()) {
  const apiKey = await getSetting('apiKey');
  if (!apiKey) return { skipped: 'noKey' };
  const holdings = (await db.holdings.toArray()).filter((h) => h.code);
  if (!holdings.length) return { skipped: 'noHoldings' };

  const firstDate = new Map();
  for (const h of holdings) {
    if (!firstDate.has(h.code) || h.date < firstDate.get(h.code)) firstDate.set(h.code, h.date);
  }
  let added = 0;
  const errors = [];
  for (const [code, first] of firstDate) {
    const last = await db.prices.where('code').equals(code).reverse().sortBy('date');
    const from = last.length ? addDays(last[0].date, 1) : first;
    if (from > today) continue;
    try {
      const rows = await fetchCloses(apiKey, code, from, today);
      if (rows.length) {
        await db.prices.bulkPut(rows.map(({ code: c, date, close }) => ({ code: c, date, close })));
        added += rows.length;
        const name = rows[rows.length - 1].name;
        if (name) await db.holdings.where('code').equals(code).modify((h) => { if (!h.name) h.name = name; });
      }
    } catch (e) {
      errors.push({ code, message: corsHint(e) });
    }
  }
  if (!errors.length) await setSetting('lastPriceUpdate', today);
  return { added, errors };
}

function corsHint(e) {
  // fetch가 네트워크 단계에서 실패하면 TypeError — 브라우저에서는 대개 CORS 차단
  if (e instanceof TypeError) return '브라우저에서 시세 API 호출이 막혔습니다(CORS 또는 네트워크). 평가액을 직접 입력해 주세요.';
  return e.message;
}
