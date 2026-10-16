// IndexedDB (Dexie). 서버 없음 — 모든 데이터는 이 기기 안에만 있다.
/* global Dexie */

export const db = new Dexie('my-finance');

db.version(1).stores({
  // { id, name, budget, color, aliases: [], order, archived }
  categories: '++id, order',
  // { ym, categoryId, base, cut, final }
  monthlyBudgets: '[ym+categoryId], ym, categoryId',
  // { id, date, ym, categoryId, amount, memo }
  expenses: '++id, date, ym, categoryId, [ym+categoryId]',
  // { id, date, amount(+/−), type: 'settle' | 'manual' | 'invest', memo }
  savings: '++id, date, type',
  // { id, code, name, qty, price, date }
  holdings: '++id, code, date',
  // { code, date, close }
  prices: '[code+date], code, date',
  // 시세 API를 못 쓸 때 직접 넣는 평가액 { date, value }
  valuations: 'date',
  // { ym, amount, processedAt, cuts: { [categoryId]: 감액 } }
  settlements: 'ym',
  // { key, value } — savingsLimit, apiKey(금융위), avKey(Alpha Vantage), lastPriceUpdate_KR/_US, startYm …
  settings: 'key',
});

// v2: 미국 주식 — 보유 종목에 시장·통화·매수 시 환율, 환율 표 추가
db.version(2).stores({
  // { id, code, name, market: 'KR' | 'US' | 'NONE', currency: 'KRW' | 'USD', qty, price, date, fx }
  holdings: '++id, code, date, market',
  // { date, rate } — USD/KRW
  fxRates: 'date',
}).upgrade((tx) => tx.table('holdings').toCollection().modify((h) => {
  h.market = h.market || (/^\d{6}$/.test(h.code || '') ? 'KR' : 'NONE');
  h.currency = h.currency || 'KRW';
  h.fx = h.fx || 1;
}));

export const TABLES = ['categories', 'monthlyBudgets', 'expenses', 'savings', 'holdings', 'prices', 'fxRates', 'valuations', 'settlements', 'settings'];

// 백업 파일에 넣지 않는 설정 (API 키)
const SECRET_KEYS = ['apiKey', 'avKey'];

export async function getSetting(key, fallback = null) {
  const row = await db.settings.get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  return db.settings.put({ key, value });
}

// 백업: API 키는 파일에 넣지 않는다 (파일이 밖으로 돌아다닐 수 있으므로)
export async function exportAll() {
  const tables = {};
  for (const t of TABLES) tables[t] = await db[t].toArray();
  tables.settings = tables.settings.filter((s) => !SECRET_KEYS.includes(s.key));
  return { app: 'my-finance', version: 1, exportedAt: new Date().toISOString(), tables };
}

export async function importAll(data) {
  if (!data || data.app !== 'my-finance' || !data.tables) throw new Error('이 앱의 백업 파일이 아닙니다.');
  const secrets = (await db.settings.bulkGet(SECRET_KEYS)).filter(Boolean);
  await db.transaction('rw', TABLES.map((t) => db[t]), async () => {
    for (const t of TABLES) {
      await db[t].clear();
      if (Array.isArray(data.tables[t])) await db[t].bulkPut(data.tables[t]);
    }
    // 이 기기에 있던 API 키는 유지
    if (secrets.length) await db.settings.bulkPut(secrets);
    // 옛 백업(v1)의 보유 종목에는 시장·통화가 없다
    await db.holdings.toCollection().modify((h) => {
      h.market = h.market || (/^\d{6}$/.test(h.code || '') ? 'KR' : 'NONE');
      h.currency = h.currency || 'KRW';
      h.fx = h.fx || 1;
    });
  });
}
