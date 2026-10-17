// 한 줄 입력 파서 — 기기 안에서 규칙 기반으로만 처리한다.
// 예: "식비 12000", "12000 식비", "교통 1500 버스", "커피 1.2만 어제", "식비 12000, 교통 1500"

import { addDays, dateStr, todayStr } from './util.js';

const UNITS = { 만: 10000, 천: 1000, 백: 100 };

// 금액 토큰 → 숫자. 금액이 아니면 null.
// 12000 / 12,000 / 12000원 / 1.2만 / 1만2천 / 1만2000 / 3천 / 5백원
export function parseAmount(token) {
  let s = token.replace(/,/g, '').replace(/원$/, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const v = Number(s);
    return v > 0 && Number.isFinite(v) ? Math.round(v) : null;
  }
  if (!/^[\d.만천백]+$/.test(s) || !/^\d/.test(s)) return null;
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(만|천|백)?/g;
  let consumed = 0;
  let lastUnit = Infinity;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index !== consumed || m[0] === '') return null;
    consumed += m[0].length;
    const unit = m[2] ? UNITS[m[2]] : 1;
    // 단위는 큰 것부터 내려와야 한다 (1만2천 O, 2천1만 X)
    if (unit >= lastUnit) return null;
    lastUnit = unit;
    total += Number(m[1]) * unit;
  }
  if (consumed !== s.length) return null;
  total = Math.round(total);
  return total > 0 ? total : null;
}

// 날짜 토큰 → 'YYYY-MM-DD'. 날짜가 아니면 null.
export function parseDateToken(token, today = todayStr()) {
  if (token === '오늘') return today;
  if (token === '어제') return addDays(today, -1);
  if (token === '그제' || token === '그저께') return addDays(today, -2);
  let m = token.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = token.match(/^(\d{1,2})[/.](\d{1,2})$/) || token.match(/^(\d{1,2})월(\d{1,2})일$/);
  if (m) {
    const ty = Number(today.slice(0, 4));
    let d = validDate(ty, +m[1], +m[2]);
    // 미래 날짜면 작년으로 본다 (1월에 "12/30" 입력)
    if (d && d > today) d = validDate(ty - 1, +m[1], +m[2]);
    return d;
  }
  return null;
}

function validDate(y, mo, d) {
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dateStr(dt);
}

// 단어 하나가 가리키는 항목들을 우선순위별로.
// 1 이름과 같음 · 2 이름의 앞부분 · 3 별칭과 같음 · 4 별칭의 앞부분
function matchTiers(word, categories) {
  const w = word.toLowerCase();
  const tiers = [[], [], [], []];
  for (const c of categories) {
    const name = c.name.toLowerCase();
    const aliases = (c.aliases || []).map((x) => x.toLowerCase()).filter(Boolean);
    if (name === w) tiers[0].push(c);
    else if (name.startsWith(w)) tiers[1].push(c);
    else if (aliases.includes(w)) tiers[2].push(c);
    else if (aliases.some((a) => a.startsWith(w))) tiers[3].push(c);
  }
  return tiers;
}

// "커피4500" 처럼 붙여 쓴 토큰을 단어 + 금액으로 나눈다.
function splitGlued(token) {
  const m = token.match(/^([^\d]+?)(\d[\d,.]*(?:[만천백]\d*)*원?)$/);
  if (m && parseAmount(m[2]) !== null) return [m[1], m[2]];
  return [token];
}

// 한 건 해석.
// 반환: { raw, amount, date, categoryId, candidates, memo, status }
// status: 'ok' | 'noAmount' | 'noCategory' | 'ambiguous'
export function parseEntry(text, categories, today = todayStr()) {
  const raw = text.trim();
  const tokens = raw.split(/\s+/).filter(Boolean).flatMap(splitGlued);
  let amount = null;
  let date = today;
  let income = false; // "수입 50000 보너스" 또는 "+50000 보너스" → 저축에 더하는 수입
  const words = [];
  for (const t of tokens) {
    if (t === '수입' || t === '+') { income = true; continue; } // "+3만"은 "+"와 "3만"으로 나뉘어 들어온다
    if (amount === null && t.startsWith('+') && parseAmount(t.slice(1)) !== null) {
      income = true;
      amount = parseAmount(t.slice(1));
      continue;
    }
    // 날짜를 먼저 본다: "10.14"는 금액 10원이 아니라 10월 14일
    const d = parseDateToken(t, today);
    if (d) { date = d; continue; }
    if (amount === null) {
      const a = parseAmount(t);
      if (a !== null) { amount = a; continue; }
    }
    words.push(t);
  }

  if (income) {
    return { raw, kind: 'income', amount, date, categoryId: null, candidates: [], memo: words.join(' '), status: amount === null ? 'noAmount' : 'ok' };
  }

  const active = categories.filter((c) => !c.archived);
  let categoryId = null;
  let candidates = [];
  let usedIndex = -1;

  // 우선순위가 높은 단계부터, 같은 단계에서는 앞쪽 단어부터.
  // "교 1500 버스"(버스 = 교통비 별칭)에서 항목은 "교", 메모는 "버스"가 된다.
  const tiersByWord = words.map((w) => matchTiers(w, active));
  for (let t = 0; t < 4 && usedIndex < 0; t++) {
    for (let i = 0; i < words.length; i++) {
      const hits = tiersByWord[i][t];
      if (!hits.length) continue;
      if (hits.length === 1) categoryId = hits[0].id;
      else candidates = hits;
      usedIndex = i;
      break;
    }
  }

  const memo = words.filter((_, i) => i !== usedIndex).join(' ');
  let status = 'ok';
  if (amount === null) status = 'noAmount';
  else if (categoryId === null) status = candidates.length > 1 ? 'ambiguous' : 'noCategory';
  if (status === 'noCategory') candidates = active;

  return { raw, kind: 'expense', amount, date, categoryId, candidates: candidates.map((c) => c.id), memo, status };
}

// 여러 건: 쉼표나 줄바꿈으로 구분. 단 "12,000" 같은 천 단위 쉼표는 금액으로 둔다.
export function splitEntries(text) {
  return text
    .split(/\n|,(?!\d{3}(?:\D|$))/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseLine(text, categories, today = todayStr()) {
  return splitEntries(text).map((t) => parseEntry(t, categories, today));
}
