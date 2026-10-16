// 날짜·숫자 공통 함수. 날짜는 모두 기기 현지 시간 기준 'YYYY-MM-DD' 문자열로 다룬다.

const pad = (n) => String(n).padStart(2, '0');

export function dateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayStr(now = new Date()) {
  return dateStr(now);
}

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

// 'YYYY-MM'
export function ymOf(s) {
  return s.slice(0, 7);
}

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function lastDayOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return dateStr(new Date(y, m, 0));
}

export function isLastDayOfMonth(s) {
  return lastDayOfMonth(ymOf(s)) === s;
}

export function compactDate(s) {
  return s.replaceAll('-', '');
}

export function won(n) {
  return `${Math.round(n).toLocaleString('ko-KR')}원`;
}

export function num(n) {
  return Math.round(n).toLocaleString('ko-KR');
}

export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${y}년 ${m}월`;
}

export function dayLabel(s, today = todayStr()) {
  if (s === today) return '오늘';
  if (s === addDays(today, -1)) return '어제';
  if (s === addDays(today, -2)) return '그제';
  const [, m, d] = s.split('-').map(Number);
  return `${m}/${d}`;
}
