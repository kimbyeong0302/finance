// 시세 따라잡기 — 시장별로 두 API를 쓴다. 모든 시세는 IndexedDB에 날짜별로 쌓는다.
//
// 국내: 공공데이터포털 「금융위원회_주식시세정보」 getStockPriceInfo
//   무료·일 1회 갱신. 기준일 다음 영업일 오후 1시 이후 반영되므로 최신 점은 항상 전 영업일 종가.
// 미국: Alpha Vantage TIME_SERIES_DAILY, 환율은 FX_DAILY (USD→KRW)
//   무료 키는 하루 25회·분당 5회, 일별 시세는 최근 100거래일(compact)까지.
//   종목당 하루 1회만 부르고(이미 오늘 받은 종목은 건너뜀), 호출 사이 12초 간격.
//
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

// ───────── 국내 ─────────

// 종목마다 마지막으로 저장된 날짜 다음날부터 오늘까지 한꺼번에 받아 저장
async function catchUpKR(apiKey, holdings, today) {
  const firstDate = firstDates(holdings);
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
        await fillName(code, rows[rows.length - 1].name);
      }
    } catch (e) {
      errors.push({ code, message: corsHint(e) });
    }
  }
  if (!errors.length) await setSetting('lastPriceUpdate_KR', today);
  return { added, errors };
}

// ───────── 미국 + 환율 ─────────

const AV_ENDPOINT = 'https://www.alphavantage.co/query';
const AV_GAP_MS = 12000;

async function fetchAV(apiKey, params) {
  const res = await fetch(`${AV_ENDPOINT}?${new URLSearchParams({ ...params, apikey: apiKey })}`);
  if (!res.ok) throw new Error(`Alpha Vantage 응답 오류 (${res.status})`);
  const json = await res.json();
  if (json['Error Message']) throw new Error(`Alpha Vantage: 종목을 찾을 수 없습니다 (${params.symbol || params.to_symbol})`);
  // 호출 한도 초과·키 문제는 Note / Information으로 온다
  const limit = json.Note || json.Information;
  if (limit) {
    const err = new Error(`Alpha Vantage 호출 한도 또는 키 문제: ${limit}`);
    err.stop = true;
    throw err;
  }
  return json;
}

// 미국 종목 일별 종가 (최근 100거래일). 반환: [{ code, date, close }]
export async function fetchDailyUS(apiKey, symbol, from) {
  const json = await fetchAV(apiKey, { function: 'TIME_SERIES_DAILY', symbol, outputsize: 'compact' });
  const series = json['Time Series (Daily)'] || {};
  return Object.entries(series)
    .filter(([date]) => date >= from)
    .map(([date, v]) => ({ code: symbol, date, close: Number(v['4. close']) }))
    .filter((r) => Number.isFinite(r.close));
}

// USD/KRW 일별 환율. 반환: [{ date, rate }]
export async function fetchFxUSDKRW(apiKey) {
  const json = await fetchAV(apiKey, { function: 'FX_DAILY', from_symbol: 'USD', to_symbol: 'KRW', outputsize: 'compact' });
  const series = json['Time Series FX (Daily)'] || {};
  return Object.entries(series)
    .map(([date, v]) => ({ date, rate: Number(v['4. close']) }))
    .filter((r) => Number.isFinite(r.rate));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function catchUpUS(apiKey, holdings, today, onProgress) {
  const fetched = (await getSetting('usFetched')) || {}; // { 티커: 마지막으로 받은 날 }
  const firstDate = firstDates(holdings);
  const jobs = [];
  if ((await getSetting('fxFetched')) !== today) jobs.push({ kind: 'fx' });
  for (const [code, first] of firstDate) if (fetched[code] !== today) jobs.push({ kind: 'stock', code, first });

  let added = 0;
  const errors = [];
  for (const [i, job] of jobs.entries()) {
    if (i > 0) await sleep(AV_GAP_MS); // 분당 5회 제한
    onProgress?.(`미국 시세 받는 중 (${i + 1}/${jobs.length})…`);
    try {
      if (job.kind === 'fx') {
        const rows = await fetchFxUSDKRW(apiKey);
        if (rows.length) await db.fxRates.bulkPut(rows);
        await setSetting('fxFetched', today);
      } else {
        const rows = await fetchDailyUS(apiKey, job.code, job.first);
        if (rows.length) {
          await db.prices.bulkPut(rows);
          added += rows.length;
        }
        fetched[job.code] = today;
        await setSetting('usFetched', fetched);
      }
    } catch (e) {
      errors.push({ code: job.kind === 'fx' ? 'USD/KRW' : job.code, message: corsHint(e) });
      if (e.stop || e instanceof TypeError) break; // 한도 초과·CORS면 나머지도 실패하므로 멈춘다
    }
  }
  if (!errors.length) await setSetting('lastPriceUpdate_US', today);
  return { added, errors, calls: jobs.length };
}

// ───────── 앱을 열 때 ─────────

let running = null;

// 반환: { added, errors: [{ code, message }], skipped: ['noKR', 'noUS', 'noHoldings', …] }
export function catchUpPrices(today = todayStr(), { onProgress } = {}) {
  if (!running) running = doCatchUp(today, onProgress).finally(() => { running = null; });
  return running;
}

async function doCatchUp(today, onProgress) {
  const holdings = await db.holdings.toArray();
  const kr = holdings.filter((h) => h.market === 'KR' || (!h.market && /^\d{6}$/.test(h.code || '')));
  const us = holdings.filter((h) => h.market === 'US');
  const result = { added: 0, errors: [], skipped: [] };
  if (!kr.length && !us.length) { result.skipped.push('noHoldings'); return result; }

  const krKey = await getSetting('apiKey');
  if (kr.length && !krKey) result.skipped.push('noKRKey');
  if (kr.length && krKey) {
    onProgress?.('국내 시세 받는 중…');
    const r = await catchUpKR(krKey, kr, today);
    result.added += r.added;
    result.errors.push(...r.errors);
  }

  const avKey = await getSetting('avKey');
  if (us.length && !avKey) result.skipped.push('noUSKey');
  if (us.length && avKey) {
    const r = await catchUpUS(avKey, us, today, onProgress);
    result.added += r.added;
    result.errors.push(...r.errors);
    if (!r.calls) result.skipped.push('usDoneToday');
  }
  return result;
}

function firstDates(holdings) {
  const first = new Map();
  for (const h of holdings) {
    if (!first.has(h.code) || h.date < first.get(h.code)) first.set(h.code, h.date);
  }
  return first;
}

async function fillName(code, name) {
  if (name) await db.holdings.where('code').equals(code).modify((h) => { if (!h.name) h.name = name; });
}

function corsHint(e) {
  // fetch가 네트워크 단계에서 실패하면 TypeError — 브라우저에서는 대개 CORS 차단
  if (e instanceof TypeError) return '브라우저에서 시세 API 호출이 막혔습니다(CORS 또는 네트워크). 평가액을 직접 입력해 주세요.';
  return e.message;
}

// 매수 시 환율 기본값: 저장된 환율 중 그 날짜 이하 가장 최근 값
export async function fxOn(date) {
  const row = await db.fxRates.where('date').belowOrEqual(date).last();
  return row ? row.rate : null;
}
