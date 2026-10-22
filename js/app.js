// 화면과 입력. 핵심 흐름: 예산(줄어드는 막대) → 저축(차오르는 막대) → 투자(불어나는 선)
/* global Chart */
import { db, exportAll, getSetting, importAll, setSetting } from './db.js';
import {
  activeCategories, ensureMonth, frequentAmounts, monthView, previewSettlement,
  runPendingSettlements, savingsBalance, updateCategoryBudget,
} from './ledger.js';
import { parseAmount, parseLine } from './parse.js';
import { catchUpPrices, fxOn, priceStatusList } from './prices.js';
import { isLockEnabled, lockConfig, lockNow, renderLockSettings } from './lock.js';
import { ASSET_TYPES, assetTypeOf, computePortfolio, costKRW, currencyOf, heldQtyOn, holdingKey, latestPoint, marketOf } from './invest.js';
import { addMonths, dayLabel, isLastDayOfMonth, monthLabel, num, todayStr, won, ymOf } from './util.js';

// 앱 버전 — 설정 화면 맨 아래에 보인다 (휴대폰에 새 버전이 들어왔는지 확인용)
export const APP_VERSION = '2026-10-22 · v14';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  categories: [],
  today: todayStr(),
  historyYm: ymOf(todayStr()),
  chart: null,
  stockChart: null,
  lastOpenCheck: 0,
};

const DEFAULT_CATEGORIES = [
  { name: '식비', budget: 400000, color: '#16a34a', aliases: ['밥', '점심', '저녁', '배달'] },
  { name: '카페', budget: 60000, color: '#a16207', aliases: ['커피'] },
  { name: '교통비', budget: 80000, color: '#2563eb', aliases: ['버스', '지하철', '택시'] },
  { name: '생활', budget: 100000, color: '#9333ea', aliases: ['마트', '생필품'] },
  { name: '문화', budget: 50000, color: '#db2777', aliases: ['영화', '책'] },
];

// ───────────────────────── 시작 ─────────────────────────

// 새 버전이 배포되면 받아서 바로 바꿔 끼운다. 앱으로 돌아올 때마다 새 버전이 있는지 확인.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 처음 설치될 때는 새로고침하지 않는다. 잠금 화면이나 입력 중이면 다음에 열 때 적용.
    if (!hadController || reloaded) return;
    if (document.documentElement.classList.contains('locked') || !$('#sheet').hidden) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}

async function init() {
  if (!(await db.categories.count())) {
    await db.categories.bulkAdd(DEFAULT_CATEGORIES.map((c, i) => ({ ...c, order: i, archived: false })));
  }
  bindUI();
  // 잠금이 켜져 있으면 풀기 전까지 아무것도 보이지 않는다 (html.booting)
  if (await isLockEnabled()) await lockNow();
  document.documentElement.classList.remove('booting');
  await onOpen();
  registerServiceWorker();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      state.hiddenAt = Date.now();
      document.documentElement.classList.add('privacy'); // 앱 전환 화면에서 내용 가리기
      return;
    }
    document.documentElement.classList.remove('privacy');
    const { pin, after } = await lockConfig();
    if (pin && after >= 0 && state.hiddenAt && Date.now() - state.hiddenAt >= after * 1000) {
      closeSheet();
      await lockNow();
    }
    if (Date.now() - state.lastOpenCheck > 5 * 60 * 1000) onOpen();
  });
}

// 앱을 열 때마다: 정산 → 화면 → 팝업(정산 결과·월말 예고·저축 한도) → 시세 따라잡기
async function onOpen() {
  state.lastOpenCheck = Date.now();
  state.today = todayStr();
  $('#todayLabel').textContent = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
  const settled = await runPendingSettlements(state.today);
  await ensureMonth(ymOf(state.today));
  await refresh();

  for (const s of settled) await showSettlementResult(s);
  await maybeShowPreview();
  await maybeShowOverflow();

  updatePrices();
}

// 시세 따라잡기 — 미국 종목은 호출 사이 12초 간격이라 뒤에서 천천히 돈다
function updatePrices(opts = {}) {
  const status = $('#priceStatus');
  return catchUpPrices(state.today, { ...opts, onProgress: (t) => { status.textContent = t; } }).then(async (r) => {
    if (r.errors.length) status.textContent = `${r.errors[0].code}: ${r.errors[0].message}${r.errors.length > 1 ? ` (외 ${r.errors.length - 1}건 — 설정에서 확인)` : ''}`;
    else if (r.added) status.textContent = `시세 ${r.added}건 업데이트`;
    else status.textContent = await priceStatusText(r);
    renderInvest();
    renderTotal();
    return r;
  });
}

async function priceStatusText(r) {
  const parts = [];
  if (r.skipped.includes('noKRKey')) parts.push('국내 시세 키 없음');
  if (r.skipped.includes('noUSKey')) parts.push('Alpha Vantage 키 없음');
  if (parts.length) return `${parts.join(' · ')} — 매수 단가·직접 입력 평가액으로 표시합니다.`;
  const kr = await getSetting('lastPriceUpdate_KR');
  const us = await getSetting('lastPriceUpdate_US');
  const done = [kr && `국내 ${dayLabel(kr, state.today)}`, us && `미국 ${dayLabel(us, state.today)}`].filter(Boolean);
  return done.length ? `시세 확인: ${done.join(' · ')}` : '';
}

async function refresh() {
  state.categories = await activeCategories();
  await Promise.all([renderBudget(), renderSavings(), renderInvest()]);
  await renderTotal();
  if (!$('#view-history').hidden) renderHistory();
}

// ───────────────────────── 예산 막대 ─────────────────────────

function barStatus(ratio) {
  if (ratio < 0) return 'over';
  if (ratio >= 0.5) return 'ok';
  if (ratio >= 0.2) return 'warn';
  return 'low';
}

async function renderBudget() {
  const ym = ymOf(state.today);
  const view = await monthView(ym);
  $('#budgetTitle').textContent = `${Number(ym.slice(5))}월 예산`;
  const totalLeft = view.reduce((s, v) => s + v.left, 0);
  const totalFinal = view.reduce((s, v) => s + v.final, 0);
  $('#budgetLeft').textContent = won(totalLeft);
  $('#budgetLeft').classList.toggle('neg', totalLeft < 0);
  $('#budgetOf').textContent = `/ ${won(totalFinal)}`;

  // 흐름 안내: 이번 달 그대로 끝나면 얼마가 저축으로 가는지
  const s = await previewSettlement(ym);
  $('#flowToSaving').innerHTML = s.net >= 0
    ? `지금대로면 월말에 <b>${won(s.net)}</b>이 저축으로`
    : `지금대로면 <b class="neg">${won(-s.net)}</b> 부족 → 다음 달 감액`;

  await renderAllocation();

  const box = $('#budgetBars');
  if (!view.length) {
    box.innerHTML = '<div class="bars-empty">설정에서 예산 항목을 추가하세요.</div>';
    return;
  }
  box.innerHTML = view.map((v) => {
    const over = v.left < 0;
    const ratio = v.final > 0 ? v.left / v.final : (v.used > 0 ? -1 : 0);
    const status = barStatus(over ? -1 : ratio);
    const h = over ? 0 : Math.max(0, Math.min(1, ratio)) * 100;
    const pct = over ? '초과' : `${Math.round(Math.max(0, ratio) * 100)}%`;
    return `
      <button class="bar ${status}" data-cat="${v.category.id}" aria-label="${esc(v.category.name)} 지출 입력">
        <span class="bar-pct">${pct}</span>
        <span class="bar-track">
          <span class="bar-fill" style="height:${h}%"></span>
          ${over ? `<span class="bar-over-text">−${shortWon(-v.left)}</span>` : ''}
        </span>
        <span class="bar-name"><i style="background:${esc(v.category.color)}"></i>${esc(v.category.name)}</span>
        <span class="bar-left">${over ? '−' : ''}${num(Math.abs(v.left))}</span>
        ${v.cut > 0 ? `<span class="bar-cut" title="지난달 초과로 ${num(v.cut)}원 감액">감액 ${shortWon(v.cut)}</span>` : ''}
      </button>`;
  }).join('');
}

// 전체 예산이 항목별로 어떻게 나뉘어 있는지 — 가로 누적 막대 (이번 달 최종 예산 기준)
// 예산 계획: 설정의 총 예산과 항목 예산 (홈에서는 바꾸지 않는다)
// 예상 저축 = 총 예산 − 항목 예산 합계. 총 예산을 정하지 않았으면 null.
async function budgetPlan() {
  const cats = state.categories.length ? state.categories : await activeCategories();
  const allocated = cats.reduce((s, c) => s + (c.budget || 0), 0);
  const total = Number(await getSetting('totalBudget', 0)) || 0;
  return { cats, allocated, total, expected: total ? total - allocated : null };
}

// 총 예산이 항목별로 어떻게 나뉘어 있는지 — 가로 누적 막대. 총 예산이 있으면 남는 몫은 '예상 저축' 칸.
async function renderAllocation() {
  const { cats, allocated, total, expected } = await budgetPlan();
  const box = $('#budgetAlloc');
  const parts = cats.filter((c) => c.budget > 0).map((c) => ({ name: c.name, color: c.color, amount: c.budget }));
  if (expected > 0) parts.push({ name: '예상 저축', color: 'var(--saving)', amount: expected, saving: true });
  box.hidden = !parts.length;
  if (!parts.length) return;
  const base = Math.max(total, allocated);
  $('#allocTotal').textContent = total ? `총 예산 ${won(total)}` : `항목 합계 ${won(allocated)}`;
  const pct = (x) => (x.amount / base) * 100;
  $('#allocBar').innerHTML = parts.map((x) => `
    <span class="${x.saving ? 'alloc-saving' : ''}" style="flex-grow:${x.amount};background:${esc(x.color)}" title="${esc(x.name)} ${won(x.amount)} (${pct(x).toFixed(1)}%)"></span>`).join('');
  $('#allocLegend').innerHTML = parts.map((x) => `
    <span class="${x.saving ? 'alloc-saving-label' : ''}"><i style="background:${esc(x.color)}"></i>${esc(x.name)} <b>${Math.round(pct(x))}%</b></span>`).join('')
    + (expected < 0 ? `<span class="neg">항목 예산이 총 예산보다 ${won(-expected)} 많습니다</span>` : '');
}

// ───────────────────────── 저축 막대 ─────────────────────────

async function renderSavings() {
  const balance = await savingsBalance();
  const ym = ymOf(state.today);
  const incomes = (await db.savings.where('type').equals('income').toArray()).filter((x) => ymOf(x.date) === ym);
  const inc = $('#savingIncome');
  inc.hidden = !incomes.length;
  inc.innerHTML = `이번 달 수입 <b>+${won(incomes.reduce((s, x) => s + x.amount, 0))}</b> <span class="muted">· ${incomes.length}건</span>`;
  const { allocated, total, expected } = await budgetPlan();
  const ex = $('#savingExpected');
  ex.hidden = expected == null;
  if (expected != null) {
    ex.classList.toggle('neg', expected < 0);
    ex.innerHTML = expected >= 0
      ? `<span>이번 달 예상 저축</span><b>${won(expected)}</b><small>총 예산 ${num(total)} − 항목 예산 ${num(allocated)}</small>`
      : `<span>이번 달 예상 저축</span><b>−${won(-expected)}</b><small>항목 예산(${num(allocated)})이 총 예산(${num(total)})보다 많습니다</small>`;
  }
  const limit = Number(await getSetting('savingsLimit', 0)) || 0;
  const fill = $('#savingFill');
  const overEl = $('#savingOver');
  const card = $('#savingCard');
  $('#savingBalance').textContent = won(balance);
  card.classList.remove('deep', 'full', 'overflow');
  if (!limit) {
    fill.style.height = balance > 0 ? '100%' : '0%';
    overEl.style.height = '0';
    $('#savingPct').textContent = '';
    $('#savingMeta').textContent = '설정에서 저축 한도를 정하세요';
    $('#flowToInvest').textContent = '한도를 넘은 저축은 투자로';
    return;
  }
  const ratio = balance / limit;
  const overflow = balance - limit;
  fill.style.height = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  if (ratio >= 1) card.classList.add('full');
  else if (ratio >= 0.8) card.classList.add('deep');
  if (overflow > 0) card.classList.add('overflow');
  // 넘친 부분은 막대 위로 (최대 40px)
  overEl.style.height = overflow > 0 ? `${Math.max(8, Math.min(40, (overflow / limit) * 160))}px` : '0';
  $('#savingPct').textContent = `${Math.round(ratio * 100)}%`;
  $('#savingMeta').textContent = `한도 ${won(limit)}`;
  $('#flowToInvest').innerHTML = overflow > 0
    ? `<b class="purple">${won(overflow)}</b> 초과 — 투자로 옮길 차례`
    : `한도까지 ${won(limit - balance)} 남음 · 넘으면 투자로`;
}

// ───────────────────────── 투자 꺾은선 ─────────────────────────

// 매수·매도·시세·환율·수동 평가액을 모두 모아 계산
async function loadPortfolio() {
  const [holdings, sales, prices, manual, fxRates] = await Promise.all([
    db.holdings.toArray(), db.sales.toArray(), db.prices.toArray(), db.valuations.toArray(), db.fxRates.toArray(),
  ]);
  return { holdings, rawSales: sales, ...computePortfolio({ holdings, sales, prices, manual, fxRates, today: state.today }) };
}

async function investSeries() {
  return (await loadPortfolio()).total;
}

function signedWon(v) {
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v))}원`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function shortWon(v) {
  if (Math.abs(v) >= 1e8) return `${Number((v / 1e8).toFixed(1))}억`;
  if (Math.abs(v) >= 1e6) return `${Math.round(v / 1e4).toLocaleString('ko-KR')}만`;
  if (Math.abs(v) >= 1e4) return `${Number((v / 1e4).toFixed(1))}만`;
  return num(v);
}

// 한국 증시 관례: 상승 빨강, 하락 파랑
function gainText(gain, principal) {
  const pct = principal ? (gain / principal) * 100 : 0;
  const sign = gain > 0 ? '+' : gain < 0 ? '−' : '';
  return `${sign}${num(Math.abs(gain))}원 (${sign}${Math.abs(pct).toFixed(1)}%)`;
}

async function renderInvest() {
  const pf = await loadPortfolio();
  const series = pf.total;
  $('#investEmpty').hidden = series.length > 0;
  $('#investChart').parentElement.hidden = !series.length;
  $('#totalHead').hidden = !series.length;
  renderStocks();
  const last = latestPoint(series);
  const gain = last.value - last.principal;
  $('#investValue').textContent = won(last.value);
  $('#investPrincipal').textContent = series.length ? `원금 ${won(last.principal)}` : '';
  const r = $('#investRealized');
  r.hidden = !pf.sales.length;
  r.innerHTML = `실현손익 <b class="gain ${pf.realized > 0 ? 'up' : pf.realized < 0 ? 'down' : ''}">${signedWon(pf.realized)}</b> · 매도·인출 ${pf.sales.length}건`;
  const g = $('#investGain');
  g.textContent = series.length ? gainText(gain, last.principal) : '';
  g.className = `gain ${gain > 0 ? 'up' : gain < 0 ? 'down' : ''}`;

  const labels = series.map((p) => dayLabel(p.date, '0000-00-00'));
  const valueColor = cssVar('--invest');
  const data = {
    labels,
    datasets: [
      {
        label: '평가액', data: series.map((p) => p.value), borderColor: valueColor, borderWidth: 2.5, tension: 0.3,
        pointRadius: series.length > 30 ? 0 : 3, pointBackgroundColor: valueColor, pointBorderWidth: 0,
        fill: 'origin',
        backgroundColor: (ctx) => {
          const { chart } = ctx;
          if (!chart.chartArea) return 'transparent';
          const grad = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
          grad.addColorStop(0, cssVar('--invest-soft'));
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          return grad;
        },
      },
      { label: '원금', data: series.map((p) => p.principal), borderColor: cssVar('--principal'), borderDash: [5, 4], stepped: true, pointRadius: 0, borderWidth: 1.5, fill: false },
    ],
  };
  if (state.chart) {
    state.chart.data = data;
    state.chart.update();
    return;
  }
  state.chart = new Chart($('#investChart'), {
    type: 'line',
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 4 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar('--ink'), titleColor: cssVar('--ink-on'), bodyColor: cssVar('--ink-on'),
          padding: 10, cornerRadius: 10, displayColors: false,
          callbacks: { label: (c) => `${c.dataset.label} ${won(c.parsed.y)}` },
        },
      },
      scales: {
        x: { border: { display: false }, ticks: { maxTicksLimit: 4, color: cssVar('--muted'), font: { size: 11 } }, grid: { display: false } },
        y: {
          position: 'right', grace: '10%', border: { display: false },
          ticks: { maxTicksLimit: 4, color: cssVar('--muted'), font: { size: 11 }, callback: (v) => shortWon(v) },
          grid: { color: cssVar('--line') },
        },
      },
    },
  });
}

// ───────────────────────── 종목별 꺾은선 + 표 ─────────────────────────

const STOCK_COLORS = ['#3182f6', '#f04452', '#ffb020', '#7048e8', '#00a6b4', '#ff7a1a', '#db2777', '#64748b'];

function priceText(v, currency) {
  if (v == null) return '시세 없음';
  return currency === 'USD' ? `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${num(v)}원`;
}

function rateText(rate) {
  const sign = rate > 0 ? '+' : rate < 0 ? '−' : '';
  return `${sign}${Math.abs(rate).toFixed(1)}%`;
}

const TYPE_COLORS = { stock: 'var(--invest)', cash: '#00a6b4', liquid: '#3182f6', realestate: '#c2410c', other: '#7c3aed' };

function pctLabel(ratio) {
  const v = ratio * 100;
  return v > 0 && v < 1 ? '<1%' : `${Math.round(v)}%`;
}

function stockRowHTML(st, color) {
  const dir = st.gain > 0 ? 'up' : st.gain < 0 ? 'down' : '';
  const rdir = st.realized > 0 ? 'up' : st.realized < 0 ? 'down' : '';
  const isStock = st.assetType === 'stock';
  if (!st.qty) {
    return `
    <div class="stock-row sold" data-stock="${esc(st.key)}" role="button" tabindex="0" aria-label="${esc(st.name)} 기록 보기">
      <i class="stock-dot" style="background:${color}"></i>
      <div class="stock-name"><b>${esc(st.name)}<em class="edit-hint">기록 ›</em></b><span>${isStock && st.code ? esc(st.code) : ASSET_TYPES[st.assetType]} · ${isStock ? '전량 매도' : '전액 인출'}</span></div>
      <div class="stock-value"><span class="muted small">실현손익</span><b class="gain ${rdir}">${signedWon(st.realized)}</b></div>
    </div>`;
  }
  const sub = isStock
    ? [st.code ? `${esc(st.code)} ${st.market === 'US' ? '🇺🇸' : '🇰🇷'}` : '직접 평가', `${Number(st.qty.toFixed(4))}주`].join(' · ')
    : ASSET_TYPES[st.assetType];
  const details = isStock ? `
        <span>매수가 <b>${priceText(st.avgPrice, st.currency)}</b></span>
        <span>현재가 <b>${priceText(st.lastClose, st.currency)}</b>${st.lastDate ? ` <small>${dayLabel(st.lastDate, state.today)}</small>` : ''}</span>` : `
        <span>넣은 금액 <b>${won(st.principal)}</b></span>
        ${st.lastDate ? `<span>가치 갱신 <small>${dayLabel(st.lastDate, state.today)}</small></span>` : ''}`;
  return `
    <div class="stock-row" data-stock="${esc(st.key)}" role="button" tabindex="0" aria-label="${esc(st.name)} 수정">
      <i class="stock-dot" style="background:${color}"></i>
      <div class="stock-name"><b>${esc(st.name)}<em class="edit-hint">편집 ›</em></b><span>${sub}</span></div>
      <div class="stock-value"><b>${num(st.value)}원</b>${isStock || st.gain ? `<span class="gain ${dir}">${rateText(st.rate)}</span>` : ''}</div>
      <div class="stock-prices">${details}
        ${isStock || st.gain ? `<span class="gain ${dir}">${signedWon(st.gain)}</span>` : ''}
        ${st.realized ? `<span class="realized">실현 <b class="gain ${rdir}">${signedWon(st.realized)}</b></span>` : ''}
      </div>
    </div>`;
}

async function renderStocks() {
  const pf = await loadPortfolio();
  const { dates, byType } = pf;
  const all = pf.stocks;
  $('#stockSection').hidden = !all.length;
  if (!all.length) return;
  const stocks = all.filter((st) => st.assetType === 'stock');
  const color = (i) => STOCK_COLORS[i % STOCK_COLORS.length];

  // 자산 구성 막대
  const totalValue = Object.values(byType).reduce((a, v) => a + Math.max(0, v), 0);
  const mix = Object.keys(ASSET_TYPES).filter((t) => byType[t] > 0);
  $('#assetMix').hidden = mix.length < 1 || !totalValue;
  $('#assetMixBar').innerHTML = mix.map((t) => `<span style="flex-grow:${byType[t]};background:${TYPE_COLORS[t]}" title="${ASSET_TYPES[t]} ${won(byType[t])}"></span>`).join('');
  $('#assetMixLegend').innerHTML = mix.map((t) => `<span><i style="background:${TYPE_COLORS[t]}"></i>${ASSET_TYPES[t]} <b>${pctLabel(byType[t] / totalValue)}</b> <small>${shortWon(byType[t])}</small></span>`).join('');

  // 종류별로 묶은 표
  const sections = Object.keys(ASSET_TYPES).map((t) => {
    const items = all.filter((st) => st.assetType === t);
    if (!items.length) return '';
    const sum = items.reduce((a, st) => a + st.value, 0);
    const rows = items.map((st) => stockRowHTML(st, t === 'stock' ? color(stocks.indexOf(st)) : TYPE_COLORS[t])).join('');
    return `<div class="asset-group"><div class="asset-group-head"><span>${ASSET_TYPES[t]}</span><b>${won(sum)}</b></div>${rows}</div>`;
  }).join('');
  $('#stockTable').innerHTML = sections;

  // 종목별 꺾은선은 주식만 (부동산 같은 큰 금액이 주식 선을 눌러 버리지 않게)
  $('#stockChartBox').hidden = !stocks.length;
  if (!stocks.length) return;

  const data = {
    labels: dates.map((d) => dayLabel(d, '0000-00-00')),
    datasets: stocks.map((st, i) => ({
      label: st.name, data: st.series, borderColor: color(i), backgroundColor: color(i),
      borderWidth: 2, tension: 0.3, pointRadius: dates.length > 30 ? 0 : 2, pointBorderWidth: 0, spanGaps: false,
    })),
  };
  if (state.stockChart) {
    state.stockChart.data = data;
    state.stockChart.update();
    return;
  }
  state.stockChart = new Chart($('#stockChart'), {
    type: 'line',
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar('--ink'), titleColor: cssVar('--ink-on'), bodyColor: cssVar('--ink-on'),
          padding: 10, cornerRadius: 10, boxWidth: 8, boxHeight: 8, usePointStyle: true,
          filter: (item) => item.parsed.y != null,
          callbacks: { label: (c) => ` ${c.dataset.label} ${won(c.parsed.y)}` },
        },
      },
      scales: {
        x: { border: { display: false }, ticks: { maxTicksLimit: 4, color: cssVar('--muted'), font: { size: 11 } }, grid: { display: false } },
        y: {
          position: 'right', grace: '10%', border: { display: false },
          ticks: { maxTicksLimit: 4, color: cssVar('--muted'), font: { size: 11 }, callback: (v) => shortWon(v) },
          grid: { color: cssVar('--line') },
        },
      },
    },
  });
}

async function renderTotal() {
  const balance = await savingsBalance();
  const pf = await loadPortfolio();
  const value = latestPoint(pf.total).value;
  const hr = $('#heroRealized');
  hr.hidden = !pf.sales.length;
  if (pf.sales.length) {
    const last = pf.sales[0];
    hr.innerHTML = `투자 매도 실현손익 <b class="gain ${pf.realized > 0 ? 'up' : pf.realized < 0 ? 'down' : ''}">${signedWon(pf.realized)}</b>`
      + `<span class="muted"> · 최근 ${dayLabel(last.date, state.today)} ${esc(last.name)} ${signedWon(last.realized)}</span>`;
  }
  const total = balance + value;
  $('#total').textContent = num(total);
  $('#legendSaving').textContent = won(balance);
  $('#legendInvest').textContent = won(value);
  const share = total > 0 ? Math.max(0, balance) / (Math.max(0, balance) + Math.max(0, value)) : 0.5;
  $('#mixSaving').style.flexGrow = total > 0 ? share : 1;
  $('#mixInvest').style.flexGrow = total > 0 ? 1 - share : 1;
  $('#mix').classList.toggle('empty', total <= 0);
}

// ───────────────────────── 하단 시트 공통 ─────────────────────────

function openSheet(html) {
  const sheet = $('#sheet');
  sheet.innerHTML = `<div class="grip"></div>${html}`;
  sheet.hidden = false;
  $('#backdrop').hidden = false;
  return sheet;
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#backdrop').hidden = true;
  $('#sheet').innerHTML = '';
}

// 금액 입력칸: 숫자만 받아 쉼표를 붙여 보여준다
function bindAmountInput(input, hint) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/[^\d]/g, '');
    input.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
    if (hint) hint.textContent = digits ? koreanAmount(Number(digits)) : '';
  });
}

function readAmount(input) {
  return parseAmount(input.value.replace(/\s/g, '')) || 0;
}

function koreanAmount(n) {
  const man = Math.floor(n / 10000);
  const rest = n % 10000;
  return `${man ? `${man.toLocaleString('ko-KR')}만 ` : ''}${rest ? rest.toLocaleString('ko-KR') : ''}원`.trim();
}

function chipsHTML(selectedId) {
  return state.categories.map((c) => `
    <button class="chip ${c.id === selectedId ? 'selected' : ''}" data-cat="${c.id}" style="--chip:${esc(c.color)}"><i></i>${esc(c.name)}</button>`).join('');
}

// ───────────────────────── 지출 입력 ─────────────────────────
// 목표: 3초 이내, 터치 2~3번. 막대에서 열면 항목이 이미 선택돼 있고, 금액 키패드가 즉시 뜬다.

function openExpenseSheet(categoryId = null) {
  let selected = categoryId;
  const sheet = openSheet(`
    <div class="seg" role="tablist"><button class="on" role="tab" aria-selected="true">지출</button><button role="tab" id="exToIncome">수입</button></div>
    <label class="amount-wrap"><input class="amount-input" id="exAmount" inputmode="numeric" pattern="[0-9]*" placeholder="0" autocomplete="off" enterkeyhint="done"><span>원</span></label>
    <div class="amount-hint" id="exHint"></div>
    <div class="chips" id="exFreq"></div>
    <div class="chips" id="exCats">${chipsHTML(selected)}</div>
    <div class="sheet-row">
      <input type="date" id="exDate" value="${state.today}" max="${state.today}">
      <button class="link" id="exMemoToggle">+ 메모</button>
    </div>
    <input class="memo" id="exMemo" placeholder="메모 (선택)" hidden>
    <button class="save" id="exSave">저장</button>
  `);
  const amount = sheet.querySelector('#exAmount');
  amount.focus(); // 탭 이벤트 안에서 바로 포커스해야 모바일에서 키패드가 뜬다
  sheet.querySelector('#exToIncome').addEventListener('click', () => openIncomeSheet({ amount: readAmount(amount) }));
  bindAmountInput(amount, sheet.querySelector('#exHint'));

  const showFreq = async () => {
    const box = sheet.querySelector('#exFreq');
    if (!selected) { box.innerHTML = ''; return; }
    const list = await frequentAmounts(selected);
    box.innerHTML = list.map((a) => `<button class="chip amount" data-amt="${a}">${num(a)}원</button>`).join('');
  };
  showFreq();

  sheet.querySelector('#exFreq').addEventListener('click', (e) => {
    const b = e.target.closest('[data-amt]');
    if (!b) return;
    amount.value = Number(b.dataset.amt).toLocaleString('ko-KR');
    save();
  });
  sheet.querySelector('#exCats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    selected = Number(b.dataset.cat);
    sheet.querySelectorAll('#exCats .chip').forEach((c) => c.classList.toggle('selected', c === b));
    showFreq();
    // 금액을 이미 넣었다면 항목 탭 한 번으로 저장 (메모를 쓰는 중이면 기다린다)
    if (readAmount(amount) > 0 && sheet.querySelector('#exMemo').hidden) save();
    else amount.focus();
  });
  sheet.querySelector('#exMemoToggle').addEventListener('click', (e) => {
    e.target.hidden = true;
    const m = sheet.querySelector('#exMemo');
    m.hidden = false;
    m.focus();
  });
  amount.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  sheet.querySelector('#exMemo').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  sheet.querySelector('#exSave').addEventListener('click', save);

  let saving = false;
  async function save() {
    const value = readAmount(amount);
    if (!value) { amount.focus(); return; }
    if (!selected) { sheet.querySelector('#exCats').animate([{ opacity: 0.3 }, { opacity: 1 }], 300); return; }
    if (saving) return;
    saving = true;
    const date = sheet.querySelector('#exDate').value || state.today;
    const memo = sheet.querySelector('#exMemo').value.trim();
    const id = await db.expenses.add({ date, ym: ymOf(date), categoryId: selected, amount: value, memo });
    closeSheet();
    await ensureMonth(ymOf(date));
    await refresh();
    const name = state.categories.find((c) => c.id === selected)?.name || '';
    showToast(`${name} ${won(value)} 저장`, async () => { await db.expenses.delete(id); await refresh(); });
  }
}

// ───────────────────────── 수입 입력·수정 ─────────────────────────
// 추가 수입은 저축에 더한다 (저축 기록 type: 'income')

const INCOME_PRESETS = ['보너스', '부수입', '이자', '환급', '용돈'];

function openIncomeSheet({ existing = null, amount: presetAmount = 0 } = {}) {
  const sheet = openSheet(`
    ${existing ? '<h4>수입 수정</h4>' : '<div class="seg" role="tablist"><button role="tab" id="inToExpense">지출</button><button class="on" role="tab" aria-selected="true">수입</button></div>'}
    <label class="amount-wrap income"><span class="sign">+</span><input class="amount-input" id="inAmount" inputmode="numeric" pattern="[0-9]*" placeholder="0" autocomplete="off" enterkeyhint="done"
      value="${existing ? num(existing.amount) : presetAmount ? num(presetAmount) : ''}"><span>원</span></label>
    <div class="amount-hint" id="inHint">저축에 더해집니다</div>
    <div class="chips" id="inPresets">${INCOME_PRESETS.map((t) => `<button class="chip amount" data-memo="${t}">${t}</button>`).join('')}</div>
    <input class="memo" id="inMemo" placeholder="내용 (예: 보너스, 중고 판매)" value="${esc(existing?.memo || '')}">
    <div class="sheet-row"><input type="date" id="inDate" value="${existing?.date || state.today}" max="${state.today}"></div>
    <button class="save" id="inSave">${existing ? '수정 저장' : '저장'}</button>
    ${existing ? '<button class="danger-link" id="inDelete">이 수입 삭제</button>' : ''}
  `);
  const q = (id) => sheet.querySelector(id);
  const amount = q('#inAmount');
  amount.focus();
  bindAmountInput(amount);
  amount.addEventListener('input', () => {
    const v = readAmount(amount);
    q('#inHint').textContent = v ? `${koreanAmount(v)} · 저축에 더해집니다` : '저축에 더해집니다';
  });
  q('#inToExpense')?.addEventListener('click', () => openExpenseSheet());
  q('#inPresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-memo]');
    if (!b) return;
    q('#inMemo').value = b.dataset.memo;
    if (readAmount(amount)) save(); else amount.focus();
  });
  const save = async () => {
    const value = readAmount(amount);
    if (!value) { amount.focus(); return; }
    const row = { date: q('#inDate').value || state.today, amount: value, type: 'income', memo: q('#inMemo').value.trim() };
    if (existing) {
      await db.savings.put({ ...row, id: existing.id });
      closeSheet();
      await refresh();
      showToast(`수입 수정 · +${won(value)}`, async () => { await db.savings.put(existing); await refresh(); });
    } else {
      const id = await db.savings.add(row);
      closeSheet();
      await refresh();
      showToast(`수입 +${won(value)} → 저축`, async () => { await db.savings.delete(id); await refresh(); });
    }
    await maybeShowOverflow();
  };
  amount.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  q('#inMemo').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  q('#inSave').addEventListener('click', save);
  q('#inDelete')?.addEventListener('click', async () => {
    const ok = await showModal(`이 수입을 삭제할까요?\n${existing.date} · +${won(existing.amount)}${existing.memo ? ` · ${existing.memo}` : ''}`, [{ key: 'no', label: '취소' }, { key: 'yes', label: '삭제', primary: true }]);
    if (ok !== 'yes') return;
    await db.savings.delete(existing.id);
    closeSheet();
    await refresh();
    showToast('수입 삭제', async () => { await db.savings.put(existing); await refresh(); });
  });
}

// ───────────────────────── 한 줄 입력 ─────────────────────────

function catName(id) {
  return state.categories.find((c) => c.id === id)?.name || '?';
}

function describe(e) {
  if (e.kind === 'income' && e.status === 'ok') {
    const rest = [dayLabel(e.date, state.today), e.memo].filter(Boolean).map(esc).join(' · ');
    return `<div class="pv"><span class="pv-tag" style="--chip:var(--saving)">수입</span><b>+${won(e.amount)}</b><span class="pv-rest">${rest} → 저축</span></div>`;
  }
  if (e.status === 'noAmount') return `<div class="pv bad"><span class="pv-tag">?</span>금액을 찾지 못했어요 · “${esc(e.raw)}”</div>`;
  const ok = e.status === 'ok';
  const cat = ok ? state.categories.find((c) => c.id === e.categoryId) : null;
  const tag = ok ? `<span class="pv-tag" style="--chip:${esc(cat?.color)}">${esc(cat?.name)}</span>`
    : `<span class="pv-tag warn">${e.status === 'ambiguous' ? esc(e.candidates.map(catName).join('/')) : '항목?'}</span>`;
  const rest = [dayLabel(e.date, state.today), e.memo].filter(Boolean).map(esc).join(' · ');
  return `<div class="pv ${ok ? '' : 'bad'}">${tag}<b>${won(e.amount)}</b><span class="pv-rest">${rest}</span></div>`;
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight}px`;
}

function onQuickInput() {
  const t = $('#quickInput');
  autoGrow(t);
  $('#quickPick').hidden = true;
  const entries = parseLine(t.value, state.categories, state.today);
  $('#quickPreview').innerHTML = entries.map(describe).join('');
}

async function submitQuick() {
  const t = $('#quickInput');
  const entries = parseLine(t.value, state.categories, state.today);
  if (!entries.length) return;
  if (entries.some((e) => e.status === 'noAmount')) { onQuickInput(); return; }

  // 항목을 못 찾았거나 겹치면 저장하지 않고 항목 버튼을 띄운다 — 한 건씩 차례로
  for (const e of entries) {
    if (e.status === 'ok' || e.kind === 'income') continue;
    const picked = await pickCategory(e);
    if (picked == null) return; // 입력을 고치면 취소
    e.categoryId = picked;
    e.status = 'ok';
    $('#quickPreview').innerHTML = entries.map(describe).join('');
  }

  const spend = entries.filter((e) => e.kind !== 'income');
  const incomes = entries.filter((e) => e.kind === 'income');
  const ids = spend.length ? await db.expenses.bulkAdd(
    spend.map((e) => ({ date: e.date, ym: ymOf(e.date), categoryId: e.categoryId, amount: e.amount, memo: e.memo })),
    { allKeys: true },
  ) : [];
  const incomeIds = incomes.length ? await db.savings.bulkAdd(
    incomes.map((e) => ({ date: e.date, amount: e.amount, type: 'income', memo: e.memo })),
    { allKeys: true },
  ) : [];
  for (const ym of new Set(spend.map((e) => ymOf(e.date)))) await ensureMonth(ym);
  t.value = '';
  autoGrow(t);
  $('#quickPreview').innerHTML = '';
  t.blur();
  await refresh();
  const total = spend.reduce((s, e) => s + e.amount, 0);
  const incomeTotal = incomes.reduce((s, e) => s + e.amount, 0);
  const parts = [];
  if (spend.length) parts.push(spend.length === 1 ? `${catName(spend[0].categoryId)} ${won(total)}` : `지출 ${spend.length}건 ${won(total)}`);
  if (incomes.length) parts.push(`수입 +${won(incomeTotal)}`);
  showToast(`${parts.join(' · ')} 저장`, async () => {
    await db.expenses.bulkDelete(ids);
    await db.savings.bulkDelete(incomeIds);
    await refresh();
  });
  if (incomes.length) await maybeShowOverflow();
}

function pickCategory(entry) {
  return new Promise((resolve) => {
    const box = $('#quickPick');
    const ids = entry.candidates.length ? entry.candidates : state.categories.map((c) => c.id);
    box.innerHTML = `
      <p>“${esc(entry.raw)}” — 어느 항목인가요?</p>
      <div class="chips">${state.categories.filter((c) => ids.includes(c.id)).map((c) => `
        <button class="chip" data-cat="${c.id}" style="--chip:${esc(c.color)}">${esc(c.name)}</button>`).join('')}</div>`;
    box.hidden = false;
    const onClick = (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      cleanup();
      resolve(Number(b.dataset.cat));
    };
    const onEdit = () => { cleanup(); resolve(null); };
    function cleanup() {
      box.hidden = true;
      box.removeEventListener('click', onClick);
      $('#quickInput').removeEventListener('input', onEdit);
    }
    box.addEventListener('click', onClick);
    $('#quickInput').addEventListener('input', onEdit);
  });
}

// ───────────────────────── 저축 입력 ─────────────────────────

function openSavingSheet() {
  const sheet = openSheet(`
    <h4>저축 직접 입력</h4>
    <div class="chips" id="svSign">
      <button class="chip selected" data-sign="1">넣기</button>
      <button class="chip" data-sign="-1">빼기</button>
    </div>
    <label class="amount-wrap"><input class="amount-input" id="svAmount" inputmode="numeric" placeholder="0" autocomplete="off"><span>원</span></label>
    <div class="amount-hint" id="svHint"></div>
    <div class="sheet-row"><input type="date" id="svDate" value="${state.today}" max="${state.today}"></div>
    <input class="memo" id="svMemo" placeholder="메모 (선택)">
    <button class="save" id="svSave">저장</button>
  `);
  const amount = sheet.querySelector('#svAmount');
  amount.focus();
  bindAmountInput(amount, sheet.querySelector('#svHint'));
  let sign = 1;
  sheet.querySelector('#svSign').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sign]');
    if (!b) return;
    sign = Number(b.dataset.sign);
    sheet.querySelectorAll('#svSign .chip').forEach((c) => c.classList.toggle('selected', c === b));
  });
  const save = async () => {
    const value = readAmount(amount);
    if (!value) { amount.focus(); return; }
    const id = await db.savings.add({ date: sheet.querySelector('#svDate').value || state.today, amount: sign * value, type: 'manual', memo: sheet.querySelector('#svMemo').value.trim() });
    closeSheet();
    await refresh();
    showToast(`저축 ${sign > 0 ? '+' : '−'}${won(value)}`, async () => { await db.savings.delete(id); await refresh(); });
    await maybeShowOverflow();
  };
  amount.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  sheet.querySelector('#svSave').addEventListener('click', save);
}

// ───────────────────────── 투자 종목 수정 ─────────────────────────
// 종목 표에서 누르면: 매수 기록이 하나면 바로 수정, 여러 건이면 고르는 시트

async function openStockEditor(key) {
  const pf = await loadPortfolio();
  const st = pf.stocks.find((x) => x.key === key);
  if (st && st.assetType !== 'stock') { openAssetEditor(key); return; }
  const lots = pf.holdings.filter((h) => holdingKey(h) === key).sort((a, b) => a.date.localeCompare(b.date));
  if (!st || !lots.length) return;
  const sales = pf.sales.filter((x) => x.key === key);
  const short = sales.some((x) => x.short > 1e-9);
  const sheet = openSheet(`
    <h4>${esc(st.name)}</h4>
    <div class="stock-summary">
      ${st.qty ? `<div><span>보유</span><b>${Number(st.qty.toFixed(4))}주</b></div>
      <div><span>평균 매수가</span><b>${priceText(st.avgPrice, st.currency)}</b></div>
      <div><span>평가액</span><b>${won(st.value)}</b></div>` : '<div><span>보유</span><b>전량 매도</b></div>'}
      ${sales.length ? `<div><span>실현손익</span><b class="gain ${st.realized > 0 ? 'up' : st.realized < 0 ? 'down' : ''}">${signedWon(st.realized)}</b></div>` : ''}
    </div>
    ${short ? '<div class="note warn">매수 기록보다 많이 판 매도 기록이 있습니다. 매수 기록이나 매도 기록을 확인하세요.</div>' : ''}
    <div class="row sheet-actions">
      <button class="save" id="skSell" ${st.qty ? '' : 'disabled'}>매도</button>
      ${st.code ? '<button class="save ghost" id="skBuy">추가 매수</button>' : ''}
    </div>
    <h5 class="sheet-sub">매수 기록 <small>누르면 수정</small></h5>
    <ul class="list lot-list">${lots.map((h) => `
      <li data-lot="${h.id}" role="button" tabindex="0">
        <div class="grow"><div>${h.date}</div><div class="sub">${holdingDetail(h)}</div></div>
        <div class="amt">${num(costKRW(h))}</div><span class="chev">›</span>
      </li>`).join('')}</ul>
    ${sales.length ? `<h5 class="sheet-sub">매도 기록</h5>
    <ul class="list lot-list">${sales.map((x) => `
      <li>
        <div class="grow"><div>${x.date}</div><div class="sub">${saleDetail(x)}</div></div>
        <div class="amt gain ${x.realized > 0 ? 'up' : x.realized < 0 ? 'down' : ''}">${signedWon(x.realized)}</div>
        <button class="del" data-del-sale="${x.id}" aria-label="매도 기록 삭제">×</button>
      </li>`).join('')}</ul>` : ''}
  `);
  sheet.addEventListener('click', async (e) => {
    const li = e.target.closest('[data-lot]');
    if (li) { openHoldingSheet(0, lots.find((h) => h.id === Number(li.dataset.lot))); return; }
    const del = e.target.closest('[data-del-sale]');
    if (del) { closeSheet(); await deleteSale(Number(del.dataset.delSale)); }
  });
  sheet.querySelector('#skSell')?.addEventListener('click', () => openSellSheet(st));
  sheet.querySelector('#skBuy')?.addEventListener('click', () => openHoldingSheet(0, { code: lots[0].code, name: lots[0].name }));
}

function saleDetail(x) {
  const p = x.currency === 'USD'
    ? `$${x.price.toLocaleString('en-US', { maximumFractionDigits: 2 })} × ${num(x.fx)}원`
    : `${num(x.price)}원`;
  return `${Number(x.qty.toFixed(4))}주 × ${p} = ${won(x.proceeds)} · ${x.toSavings ? '저축으로' : '저축 안 함'}`;
}

// ───────────────────────── 주식 외 자산 (현금·유동자산·부동산·기타) ─────────────────────────
// 1원 = 1단위로 넣고 빼며, '가치 갱신'은 그날의 단위 가격(평가액 ÷ 남은 단위)을 시세처럼 저장한다.

const ASSET_HINTS = {
  cash: { name: '예: 파킹통장, 증권사 예수금, 비상금', amount: '보유 금액', in: '입금', out: '출금' },
  liquid: { name: '예: 정기예금, 적금, CMA, MMF', amount: '넣은 금액', in: '추가 납입', out: '인출' },
  realestate: { name: '예: 아파트, 전세보증금', amount: '취득가 (또는 지금 가치)', in: '추가 투입', out: '매각·회수' },
  other: { name: '예: 금, 코인, 펀드', amount: '매입 금액', in: '추가 매입', out: '매도·인출' },
};

function assetSegHTML(active) {
  return `<div class="seg asset-seg" role="tablist">${Object.entries(ASSET_TYPES).map(([t, label]) =>
    `<button role="tab" data-asset-type="${t}" class="${t === active ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}

function bindAssetSeg(sheet, transfer) {
  sheet.querySelector('.asset-seg')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-asset-type]');
    if (!b || b.classList.contains('on')) return;
    if (b.dataset.assetType === 'stock') openHoldingSheet(transfer);
    else openAssetSheet(transfer, b.dataset.assetType);
  });
}

const newAssetCode = () => `@${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// 그 날짜의 단위 가격 (가치 갱신 기록이 없으면 1)
async function unitOn(code, date) {
  const row = await db.prices.where('[code+date]').between([code, ''], [code, date], true, true).last();
  return row ? row.close : 1;
}

function openAssetSheet(transfer = 0, type = 'cash') {
  const hint = ASSET_HINTS[type];
  const sheet = openSheet(`
    ${assetSegHTML(type)}
    ${transfer ? `<div class="note">저축 한도 초과분 <b>${won(transfer)}</b>을 투자로 옮깁니다.</div>` : ''}
    <label class="field"><span>이름</span><input id="asName" placeholder="${hint.name}" autocomplete="off"></label>
    <label class="field"><span>${hint.amount} (원)</span><input id="asAmount" inputmode="numeric" value="${transfer ? num(transfer) : ''}" placeholder="0"></label>
    <div class="amount-hint" id="asHint"></div>
    <label class="field"><span>날짜</span><input id="asDate" type="date" value="${state.today}" max="${state.today}"></label>
    <label class="check"><input type="checkbox" id="asFromSavings" ${transfer ? 'checked' : ''}><span>저축에서 옮긴 돈<small>켜면 이 금액만큼 저축에서 빠집니다</small></span></label>
    <button class="save" id="asSave">추가</button>
  `);
  bindAssetSeg(sheet, transfer);
  const q = (id) => sheet.querySelector(id);
  bindAmountInput(q('#asAmount'), q('#asHint'));
  q('#asName').focus();
  q('#asSave').addEventListener('click', async () => {
    const name = q('#asName').value.trim() || ASSET_TYPES[type];
    const amount = readAmount(q('#asAmount'));
    if (!amount) { q('#asAmount').focus(); return; }
    const date = q('#asDate').value || state.today;
    const fromSavings = q('#asFromSavings').checked;
    await db.transaction('rw', db.holdings, db.savings, async () => {
      await db.holdings.add({ code: newAssetCode(), name, assetType: type, market: 'NONE', currency: 'KRW', qty: amount, price: 1, date, fx: 1 });
      if (fromSavings) await db.savings.add({ date, amount: -amount, type: 'invest', memo: `투자 이동 · ${name}` });
    });
    closeSheet();
    await refresh();
    showToast(`${ASSET_TYPES[type]} ${name} ${won(amount)} 추가`);
  });
}

async function openAssetEditor(key) {
  let pf = await loadPortfolio();
  let st = pf.stocks.find((x) => x.key === key);
  if (!st) return;
  // 예전 '직접 평가 자산'(코드 없음)은 가치 갱신을 저장할 코드를 붙여 준다
  if (!st.code) {
    const code = newAssetCode();
    await db.holdings.where('id').anyOf(pf.holdings.filter((h) => holdingKey(h) === key).map((h) => h.id)).modify({ code, assetType: assetTypeOf(pf.holdings.find((h) => holdingKey(h) === key)) });
    await db.sales.where('key').equals(key).modify({ key: code, code });
    pf = await loadPortfolio();
    st = pf.stocks.find((x) => x.key === code);
    key = code;
  }
  const hint = ASSET_HINTS[st.assetType] || ASSET_HINTS.other;
  const lots = pf.holdings.filter((h) => holdingKey(h) === key);
  const sales = pf.sales.filter((x) => x.key === key);
  const revals = await db.prices.where('code').equals(st.code).toArray();
  const records = [
    ...lots.map((h) => ({ date: h.date, html: `<div class="grow"><div>${hint.in}</div><div class="sub">${h.date}</div></div><div class="amt">+${num(h.qty * h.price)}</div><button class="del" data-del-lot="${h.id}" aria-label="삭제">×</button>` })),
    ...sales.map((x) => ({ date: x.date, html: `<div class="grow"><div>${hint.out}</div><div class="sub">${x.date} · ${x.toSavings ? '저축으로' : '저축 안 함'}</div></div><div class="amt">−${num(x.proceeds)}</div><button class="del" data-del-sale="${x.id}" aria-label="삭제">×</button>` })),
    ...revals.map((r) => ({ date: r.date, html: `<div class="grow"><div>가치 갱신</div><div class="sub">${r.date}</div></div><div class="amt">${r.value ? won(r.value) : ''}</div><button class="del" data-del-reval="${r.date}" aria-label="삭제">×</button>` })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const dir = st.gain > 0 ? 'up' : st.gain < 0 ? 'down' : '';
  const sheet = openSheet(`
    <div class="asset-title"><input id="aeName" value="${esc(st.name)}" aria-label="이름"><span class="type-badge" style="--chip:${TYPE_COLORS[st.assetType]}">${ASSET_TYPES[st.assetType]}</span></div>
    <div class="stock-summary">
      <div><span>지금 가치</span><b>${won(st.value)}</b></div>
      <div><span>넣은 금액</span><b>${won(st.principal)}</b></div>
      ${st.gain ? `<div><span>평가손익</span><b class="gain ${dir}">${signedWon(st.gain)} (${rateText(st.rate)})</b></div>` : ''}
      ${sales.length ? `<div><span>실현손익</span><b class="gain ${st.realized > 0 ? 'up' : st.realized < 0 ? 'down' : ''}">${signedWon(st.realized)}</b></div>` : ''}
    </div>
    <div class="row sheet-actions">
      <button class="save ghost" id="aeIn">${hint.in}</button>
      <button class="save ghost" id="aeOut" ${st.qty ? '' : 'disabled'}>${hint.out}</button>
      ${st.assetType !== 'cash' ? `<button class="save ghost" id="aeReval" ${st.qty ? '' : 'disabled'}>가치 갱신</button>` : ''}
    </div>
    <h5 class="sheet-sub">기록</h5>
    <ul class="list lot-list">${records.map((r) => `<li>${r.html}</li>`).join('')}</ul>
    <button class="danger-link" id="aeDelete">이 자산 전체 삭제</button>
  `);
  const q = (id) => sheet.querySelector(id);
  const code = st.code;
  q('#aeName').addEventListener('change', async () => {
    const name = q('#aeName').value.trim();
    if (!name) return;
    await db.holdings.where('code').equals(code).modify({ name });
    await refresh();
    showToast('이름을 바꿨습니다');
  });
  q('#aeIn').addEventListener('click', () => openAssetFlow(st, 'in'));
  q('#aeOut').addEventListener('click', () => openAssetFlow(st, 'out'));
  q('#aeReval')?.addEventListener('click', () => openAssetFlow(st, 'reval'));
  sheet.querySelector('.lot-list').addEventListener('click', async (e) => {
    const lot = e.target.closest('[data-del-lot]');
    const sale = e.target.closest('[data-del-sale]');
    const reval = e.target.closest('[data-del-reval]');
    if (sale) { closeSheet(); await deleteSale(Number(sale.dataset.delSale)); return; }
    if (lot) {
      const row = await db.holdings.get(Number(lot.dataset.delLot));
      await db.holdings.delete(row.id);
      closeSheet();
      await refresh();
      showToast(`${hint.in} 기록 삭제`, async () => { await db.holdings.put(row); await refresh(); });
    }
    if (reval) {
      const row = await db.prices.get([code, reval.dataset.delReval]);
      await db.prices.delete([code, reval.dataset.delReval]);
      closeSheet();
      await refresh();
      showToast('가치 갱신 기록 삭제', async () => { await db.prices.put(row); await refresh(); });
    }
  });
  q('#aeDelete').addEventListener('click', async () => {
    const ok = await showModal(`${st.name}을(를) 기록까지 모두 삭제할까요?\n저축과 주고받은 기록은 내역 탭 → 저축에 남습니다.`, [{ key: 'no', label: '취소' }, { key: 'yes', label: '삭제', primary: true }]);
    if (ok !== 'yes') return;
    const backup = {
      holdings: await db.holdings.where('code').equals(code).toArray(),
      sales: await db.sales.where('key').equals(code).toArray(),
      prices: await db.prices.where('code').equals(code).toArray(),
    };
    await db.transaction('rw', db.holdings, db.sales, db.prices, async () => {
      await db.holdings.where('code').equals(code).delete();
      await db.sales.where('key').equals(code).delete();
      await db.prices.where('code').equals(code).delete();
    });
    closeSheet();
    await refresh();
    showToast(`${st.name} 삭제`, async () => {
      await db.transaction('rw', db.holdings, db.sales, db.prices, async () => {
        await db.holdings.bulkPut(backup.holdings);
        await db.sales.bulkPut(backup.sales);
        await db.prices.bulkPut(backup.prices);
      });
      await refresh();
    });
  });
}

// 입금(in) · 출금(out) · 가치 갱신(reval)
function openAssetFlow(st, mode) {
  const hint = ASSET_HINTS[st.assetType] || ASSET_HINTS.other;
  const title = { in: hint.in, out: hint.out, reval: '가치 갱신' }[mode];
  const sheet = openSheet(`
    <h4>${esc(st.name)} ${title}</h4>
    ${mode === 'reval' ? `<p class="muted small">이자·시세 변동을 반영한 지금 가치(전체 금액)를 넣으세요. 지금 기록상 가치는 ${won(st.value)}입니다.</p>` : ''}
    ${mode === 'out' ? `<div class="note">지금 가치 <b>${won(st.value)}</b></div>` : ''}
    <label class="amount-wrap"><input class="amount-input" id="afAmount" inputmode="numeric" placeholder="0" autocomplete="off" value="${mode === 'reval' ? num(st.value) : ''}"><span>원</span></label>
    <div class="amount-hint" id="afHint"></div>
    ${mode === 'out' ? '<button class="pill" id="afAll" type="button">전액</button>' : ''}
    <div class="sheet-row"><input type="date" id="afDate" value="${state.today}" max="${state.today}"></div>
    ${mode === 'in' ? '<label class="check"><input type="checkbox" id="afSavings"><span>저축에서 옮긴 돈<small>켜면 이 금액만큼 저축에서 빠집니다</small></span></label>' : ''}
    ${mode === 'out' ? '<label class="check"><input type="checkbox" id="afSavings" checked><span>저축으로 옮기기<small>끄면 총자산에서 빠져나간 돈(지출·출금)으로 기록됩니다</small></span></label>' : ''}
    <button class="save" id="afSave">저장</button>
  `);
  const q = (id) => sheet.querySelector(id);
  const amount = q('#afAmount');
  amount.focus();
  amount.select();
  bindAmountInput(amount, q('#afHint'));
  q('#afAll')?.addEventListener('click', () => { amount.value = num(st.value); amount.dispatchEvent(new Event('input')); });
  const save = async () => {
    const value = readAmount(amount);
    if (!value) { amount.focus(); return; }
    const date = q('#afDate').value || state.today;
    const unit = await unitOn(st.code, date);
    const [holdings, sales] = await Promise.all([db.holdings.toArray(), db.sales.toArray()]);
    const held = Math.min(heldQtyOn(holdings, sales, st.key, date), heldQtyOn(holdings, sales, st.key, '9999-12-31'));
    if (mode === 'in') {
      const fromSavings = q('#afSavings').checked;
      let lotId;
      let savingId;
      await db.transaction('rw', db.holdings, db.savings, async () => {
        lotId = await db.holdings.add({ code: st.code, name: st.name, assetType: st.assetType, market: 'NONE', currency: 'KRW', qty: value / unit, price: unit, date, fx: 1 });
        if (fromSavings) savingId = await db.savings.add({ date, amount: -value, type: 'invest', memo: `투자 이동 · ${st.name}` });
      });
      closeSheet();
      await refresh();
      showToast(`${st.name} ${hint.in} +${won(value)}`, async () => {
        await db.holdings.delete(lotId);
        if (savingId) await db.savings.delete(savingId);
        await refresh();
      });
    } else if (mode === 'out') {
      const qty = value / unit;
      if (qty > held + 1e-6) { showToast(`${date} 기준 최대 ${won(held * unit)}까지 ${hint.out}할 수 있습니다`); return; }
      const toSavings = q('#afSavings').checked;
      const sale = { key: st.key, code: st.code, date, qty: Math.min(qty, held), price: unit, currency: 'KRW', fx: 1, toSavings };
      let saleId;
      await db.transaction('rw', db.sales, db.savings, async () => {
        if (toSavings) sale.savingId = await db.savings.add({ date, amount: value, type: 'sell', memo: `${hint.out} · ${st.name}` });
        saleId = await db.sales.add(sale);
      });
      closeSheet();
      await refresh();
      showToast(`${st.name} ${hint.out} −${won(value)}`, async () => {
        await db.sales.delete(saleId);
        if (sale.savingId) await db.savings.delete(sale.savingId);
        await refresh();
      });
      if (toSavings) await maybeShowOverflow();
    } else {
      if (!held) { showToast(`${date}에는 남은 금액이 없습니다`); return; }
      const prev = await db.prices.get([st.code, date]);
      await db.prices.put({ code: st.code, date, close: value / held, value });
      closeSheet();
      await refresh();
      showToast(`${st.name} 가치 ${won(value)}`, async () => {
        if (prev) await db.prices.put(prev); else await db.prices.delete([st.code, date]);
        await refresh();
      });
    }
  };
  amount.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  q('#afSave').addEventListener('click', save);
}

// ───────────────────────── 매도 ─────────────────────────

async function openSellSheet(st) {
  const usd = st.currency === 'USD';
  const avgCostKrw = st.qty ? st.principal / st.qty : 0; // 1주당 원가 (원화)
  const sheet = openSheet(`
    <h4>${esc(st.name)} 매도</h4>
    <div class="note">보유 <b>${Number(st.qty.toFixed(4))}주</b> · 평균 매수가 <b>${priceText(st.avgPrice, st.currency)}</b></div>
    <div class="row">
      <label class="field" style="flex:1"><span>매도 수량</span>
        <span class="input-with-btn"><input id="slQty" inputmode="decimal" placeholder="0"><button type="button" class="pill" id="slAll">전량</button></span></label>
    </div>
    <div class="row">
      <label class="field" style="flex:1"><span>매도 단가 (${usd ? '달러' : '원'})</span><input id="slPrice" inputmode="decimal" value="${st.lastClose != null ? st.lastClose.toLocaleString('ko-KR', { maximumFractionDigits: usd ? 2 : 0 }) : ''}"></label>
      <label class="field" style="flex:1"><span>매도일</span><input id="slDate" type="date" value="${state.today}" max="${state.today}"></label>
    </div>
    ${usd ? '<label class="field"><span>매도 시 환율 (원/달러)</span><input id="slFx" inputmode="decimal"></label>' : ''}
    <label class="check"><input type="checkbox" id="slToSavings" checked><span>매도 금액을 저축으로 옮기기<small>끄면 총자산에서 빠져나간 돈(출금)으로 기록됩니다</small></span></label>
    <div class="sell-preview" id="slPreview"></div>
    <button class="save" id="slSave">매도 기록</button>
  `);
  const q = (id) => sheet.querySelector(id);
  bindPriceInput(q('#slPrice'), () => st.currency);
  if (usd) bindPriceInput(q('#slFx'), () => 'USD');
  let fxTouched = false;
  const prefillFx = async () => {
    if (!usd || fxTouched) return;
    const rate = await fxOn(q('#slDate').value || state.today);
    if (fxTouched) return;
    q('#slFx').value = rate ? rate.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '';
    preview();
  };
  const preview = () => {
    const qty = readNumber(q('#slQty'));
    const proceeds = qty * readNumber(q('#slPrice')) * (usd ? readNumber(q('#slFx')) : 1);
    if (!qty || !proceeds) { q('#slPreview').innerHTML = ''; return; }
    const basis = qty * avgCostKrw;
    const realized = proceeds - basis;
    const dir = realized > 0 ? 'up' : realized < 0 ? 'down' : '';
    q('#slPreview').innerHTML = `
      <div><span>매도 금액</span><b>${won(proceeds)}</b></div>
      <div><span>매수 원가</span><b>${won(basis)}</b></div>
      <div><span>실현손익</span><b class="gain ${dir}">${signedWon(realized)} (${rateText(basis ? (realized / basis) * 100 : 0)})</b></div>
      <div class="muted small">${q('#slToSavings').checked ? `총자산 변화 없음 — 투자 ${won(proceeds)} → 저축` : `총자산 −${won(proceeds)} (출금)`}</div>`;
  };
  q('#slAll').addEventListener('click', () => { q('#slQty').value = String(Number(st.qty.toFixed(6))); preview(); });
  q('#slDate').addEventListener('change', prefillFx);
  if (usd) q('#slFx').addEventListener('input', () => { fxTouched = true; });
  for (const id of ['#slQty', '#slPrice', '#slFx', '#slToSavings']) q(id)?.addEventListener('input', preview);
  q('#slToSavings').addEventListener('change', preview);
  q('#slQty').focus();
  prefillFx();

  q('#slSave').addEventListener('click', async () => {
    const qty = readNumber(q('#slQty'));
    const price = readNumber(q('#slPrice'));
    const fx = usd ? readNumber(q('#slFx')) : 1;
    const date = q('#slDate').value || state.today;
    if (!qty) { q('#slQty').focus(); return; }
    if (!price) { q('#slPrice').focus(); return; }
    if (!fx) { q('#slFx').focus(); return; }
    const [holdings, sales] = await Promise.all([db.holdings.toArray(), db.sales.toArray()]);
    const heldThen = heldQtyOn(holdings, sales, st.key, date);
    const heldNow = heldQtyOn(holdings, sales, st.key, '9999-12-31');
    const max = Math.min(heldThen, heldNow);
    if (qty > max + 1e-9) {
      showToast(`${date}에 팔 수 있는 수량은 최대 ${Number(max.toFixed(4))}주입니다`);
      q('#slQty').focus();
      return;
    }
    const toSavings = q('#slToSavings').checked;
    const proceeds = qty * price * fx;
    const sale = { key: st.key, code: st.code, date, qty, price, currency: st.currency, fx, toSavings };
    let saleId;
    await db.transaction('rw', db.sales, db.savings, async () => {
      if (toSavings) sale.savingId = await db.savings.add({ date, amount: Math.round(proceeds), type: 'sell', memo: `매도 · ${st.name}` });
      saleId = await db.sales.add(sale);
    });
    closeSheet();
    await refresh();
    showToast(`${st.name} ${Number(qty.toFixed(4))}주 매도 기록`, async () => {
      await db.transaction('rw', db.sales, db.savings, async () => {
        await db.sales.delete(saleId);
        if (sale.savingId) await db.savings.delete(sale.savingId);
      });
      await refresh();
    });
    if (toSavings) await maybeShowOverflow();
  });
}

async function deleteSale(id) {
  const sale = await db.sales.get(id);
  if (!sale) return;
  const saving = sale.savingId ? await db.savings.get(sale.savingId) : null;
  const ok = await showModal(
    `매도 기록을 삭제할까요?\n${sale.date} · ${sale.qty}주${saving ? `\n저축으로 옮긴 매도 대금 ${won(saving.amount)}도 함께 지워집니다.` : ''}`,
    [{ key: 'no', label: '취소' }, { key: 'yes', label: '삭제', primary: true }],
  );
  if (ok !== 'yes') return;
  await db.transaction('rw', db.sales, db.savings, async () => {
    await db.sales.delete(id);
    if (saving) await db.savings.delete(saving.id);
  });
  await refresh();
  showToast('매도 기록 삭제', async () => {
    await db.transaction('rw', db.sales, db.savings, async () => {
      await db.sales.put(sale);
      if (saving) await db.savings.put(saving);
    });
    await refresh();
  });
}

// ───────────────────────── 투자 종목 등록 ─────────────────────────
// transfer: 저축에서 옮길 금액 (한도 초과 팝업에서 열면 초과 금액이 채워져 있다)

const MARKET_LABEL = { KR: '국내 주식 · 원화', US: '미국 주식 · 달러', NONE: '종목코드를 넣어 주세요 — 현금·부동산 등은 위에서 종류를 고르세요' };

// 단가 입력: 원화는 정수, 달러는 소수점 둘째 자리까지
function bindPriceInput(input, getCurrency) {
  input.addEventListener('input', () => {
    if (getCurrency() === 'USD') {
      const v = input.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
      const [i, d] = v.split('.');
      input.value = (i ? Number(i).toLocaleString('ko-KR') : (d !== undefined ? '0' : '')) + (d !== undefined ? `.${d.slice(0, 2)}` : '');
    } else {
      const digits = input.value.replace(/[^\d]/g, '');
      input.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
    }
  });
}

const readNumber = (input) => Number(input.value.replace(/,/g, '')) || 0;

// preset: 기존 매수 기록(id 있음 → 수정) 또는 미리 채울 종목(id 없음 → 같은 종목 추가 매수)
function openHoldingSheet(transfer = 0, preset = null) {
  const editing = preset?.id ? preset : null;
  const sheet = openSheet(`
    ${editing ? '<h4>매수 기록 수정</h4>' : preset ? `<h4>${esc(preset.name || preset.code)} 추가 매수</h4>` : assetSegHTML('stock')}
    ${transfer ? `<div class="note">저축 한도 초과분 <b>${won(transfer)}</b>을 투자로 옮깁니다.</div>` : ''}
    <label class="field"><span>종목코드 — 국내 6자리 숫자 · 미국 티커</span>
      <input id="hdCode" maxlength="10" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="005930 또는 AAPL"></label>
    <div class="market-badge" id="hdMarket">종목코드를 넣으면 국내·미국을 알아서 구분합니다</div>
    <label class="field"><span>종목명</span><input id="hdName" placeholder="비우면 국내 종목은 시세 받을 때 채워짐"></label>
    <div class="row">
      <label class="field" style="flex:1"><span>보유 수량</span><input id="hdQty" inputmode="decimal" placeholder="10"></label>
      <label class="field" style="flex:1"><span id="hdPriceLabel">매수 단가 (원)</span><input id="hdPrice" inputmode="decimal" placeholder="70,000"></label>
    </div>
    <div class="row">
      <label class="field" style="flex:1"><span>매수일</span><input id="hdDate" type="date" value="${state.today}" max="${state.today}"></label>
      <label class="field" style="flex:1" id="hdFxField" hidden><span>매수 시 환율 (원/달러)</span><input id="hdFx" inputmode="decimal" placeholder="1,380.5"></label>
    </div>
    ${editing ? '<p class="muted small">저축에서 옮긴 기록은 내역 탭 → 저축에서 따로 고칠 수 있습니다.</p>'
    : `<label class="field"><span>저축에서 차감할 금액 (원)</span><input id="hdTransfer" inputmode="numeric" value="${transfer ? num(transfer) : ''}" placeholder="0 (저축과 무관하면 비워 두기)"></label>`}
    <div class="amount-hint" id="hdHint"></div>
    <button class="save" id="hdSave">${editing ? '수정 저장' : '등록'}</button>
    ${editing ? '<button class="danger-link" id="hdDelete">이 매수 기록 삭제</button>' : ''}
  `);
  const q = (id) => sheet.querySelector(id);
  bindAssetSeg(sheet, transfer);
  let market = 'NONE';
  let fxTouched = false;
  const currency = () => currencyOf(market);
  bindPriceInput(q('#hdPrice'), currency);
  bindPriceInput(q('#hdFx'), () => 'USD');
  if (q('#hdTransfer')) bindAmountInput(q('#hdTransfer'));

  const updateHint = () => {
    const cost = costKRW({ qty: readNumber(q('#hdQty')), price: readNumber(q('#hdPrice')), currency: currency(), fx: readNumber(q('#hdFx')) });
    q('#hdHint').textContent = cost ? `원금 ${won(cost)}` : '';
  };
  const prefillFx = async () => {
    if (market !== 'US' || fxTouched) return;
    const rate = await fxOn(q('#hdDate').value || state.today);
    if (fxTouched) return; // 기다리는 사이 직접 입력했거나 기존 기록 값이 채워짐
    q('#hdFx').value = rate ? rate.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '';
    updateHint();
  };
  q('#hdCode').addEventListener('input', () => {
    const m = marketOf(q('#hdCode').value);
    const badge = q('#hdMarket');
    badge.classList.toggle('bad', m === null);
    badge.textContent = m ? MARKET_LABEL[m] : '종목코드 형식을 확인하세요';
    if (!m || m === market) return;
    market = m;
    q('#hdPriceLabel').textContent = `매수 단가 (${market === 'US' ? '달러' : '원'})`;
    q('#hdPrice').placeholder = market === 'US' ? '189.50' : '70,000';
    q('#hdPrice').value = '';
    q('#hdFxField').hidden = market !== 'US';
    prefillFx();
    updateHint();
  });
  q('#hdDate').addEventListener('change', prefillFx);
  q('#hdFx').addEventListener('input', () => { fxTouched = true; });
  for (const id of ['#hdQty', '#hdPrice', '#hdFx']) q(id).addEventListener('input', updateHint);

  // 기존 기록이나 같은 종목으로 미리 채우기
  if (preset) {
    q('#hdCode').value = preset.code || '';
    q('#hdCode').dispatchEvent(new Event('input'));
    q('#hdName').value = preset.name && preset.name !== preset.code ? preset.name : '';
  }
  if (editing) {
    const usd = editing.currency === 'USD';
    const fmt = (v, d) => v.toLocaleString('ko-KR', { maximumFractionDigits: d });
    q('#hdQty').value = String(editing.qty);
    q('#hdPrice').value = fmt(editing.price, usd ? 2 : 0);
    q('#hdDate').value = editing.date;
    if (usd) { q('#hdFx').value = fmt(editing.fx, 2); fxTouched = true; }
    updateHint();
    q('#hdDelete').addEventListener('click', async () => {
      const ok = await showModal(`${editing.name || editing.code || '이 기록'} 매수 기록을 삭제할까요?\n${editing.date} · ${editing.qty}주`, [{ key: 'no', label: '취소' }, { key: 'yes', label: '삭제', primary: true }]);
      if (ok !== 'yes') return;
      await db.holdings.delete(editing.id);
      closeSheet();
      await refresh();
      showToast('매수 기록 삭제', async () => { await db.holdings.put(editing); await refresh(); });
    });
  } else if (preset) {
    q('#hdQty').focus();
  } else {
    q('#hdCode').focus();
  }

  q('#hdSave').addEventListener('click', async () => {
    const code = q('#hdCode').value.trim().toUpperCase();
    const m = marketOf(code);
    // 코드 없는 자산은 위에서 현금·유동자산·부동산·기타를 고른다 (예전 '직접 평가 자산'을 고칠 때만 예외)
    if (!m || (m === 'NONE' && !(editing && !editing.code))) { q('#hdCode').focus(); return; }
    let qty = readNumber(q('#hdQty'));
    let price = readNumber(q('#hdPrice'));
    const fx = m === 'US' ? readNumber(q('#hdFx')) : 1;
    const move = q('#hdTransfer') ? readAmount(q('#hdTransfer')) : 0;
    // 종목코드 없이 금액만 옮기는 경우(펀드 등): 수량 1 × 옮긴 금액
    if (m === 'NONE' && !qty && !price && move) { qty = 1; price = move; }
    if (!qty) { q('#hdQty').focus(); return; }
    if (!price) { q('#hdPrice').focus(); return; }
    if (!fx) { q('#hdFx').focus(); return; }
    const date = q('#hdDate').value || state.today;
    const name = q('#hdName').value.trim() || (m === 'NONE' ? '직접 평가 자산' : m === 'US' ? code : '');
    const row = { code, name, market: m, currency: currencyOf(m), qty, price, date, fx };
    const before = editing ? await db.holdings.toArray() : null; // 되돌리기용 (종목명 일괄 변경까지)
    await db.transaction('rw', db.holdings, db.savings, async () => {
      if (editing) await db.holdings.put({ ...row, id: editing.id });
      else await db.holdings.add(row);
      // 종목명은 같은 종목의 다른 매수 기록에도 맞춘다
      if (code && q('#hdName').value.trim()) await db.holdings.where('code').equals(code).modify({ name });
      if (move) await db.savings.add({ date, amount: -move, type: 'invest', memo: `투자 이동 · ${name || code}` });
    });
    closeSheet();
    await refresh();
    if (editing) {
      showToast('매수 기록 수정', async () => {
        await db.transaction('rw', db.holdings, async () => { await db.holdings.clear(); await db.holdings.bulkPut(before); });
        await refresh();
      });
    }
    else showToast(move ? `저축 ${won(move)} → 투자` : '종목 등록 완료');
    if (m !== 'NONE') updatePrices();
  });
}

function openValuationSheet() {
  const sheet = openSheet(`
    <h4>평가액 직접 입력</h4>
    <p class="muted small">시세 API를 쓸 수 없을 때, 증권 앱에서 본 총 평가액을 넣으면 그날의 점으로 그립니다.</p>
    <label class="amount-wrap"><input class="amount-input" id="vlAmount" inputmode="numeric" placeholder="0" autocomplete="off"><span>원</span></label>
    <div class="amount-hint" id="vlHint"></div>
    <div class="sheet-row"><input type="date" id="vlDate" value="${state.today}" max="${state.today}"></div>
    <button class="save" id="vlSave">저장</button>
  `);
  const amount = sheet.querySelector('#vlAmount');
  amount.focus();
  bindAmountInput(amount, sheet.querySelector('#vlHint'));
  const save = async () => {
    const value = readAmount(amount);
    if (!value) { amount.focus(); return; }
    await db.valuations.put({ date: sheet.querySelector('#vlDate').value || state.today, value });
    closeSheet();
    await refresh();
    showToast(`평가액 ${won(value)} 기록`);
  };
  amount.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  sheet.querySelector('#vlSave').addEventListener('click', save);
}

// ───────────────────────── 팝업 ─────────────────────────

function showModal(text, buttons) {
  return new Promise((resolve) => {
    $('#modalText').textContent = text;
    const actions = $('#modalActions');
    actions.innerHTML = buttons.map((b) => `<button data-key="${b.key}" class="${b.primary ? 'primary' : ''}">${esc(b.label)}</button>`).join('');
    $('#modal').hidden = false;
    actions.onclick = (e) => {
      const b = e.target.closest('[data-key]');
      if (!b) return;
      $('#modal').hidden = true;
      actions.onclick = null;
      resolve(b.dataset.key);
    };
  });
}

const OK = [{ key: 'ok', label: '확인', primary: true }];

async function showSettlementResult(s) {
  const label = monthLabel(s.ym);
  let text;
  if (s.amount > 0) text = `${label} 정산\n지난달 ${won(s.amount)}이 저축으로 이동했습니다.`;
  else if (s.amount < 0) {
    const lines = Object.entries(s.cuts).map(([id, cut]) => `· ${catName(Number(id))} −${won(cut)}`);
    text = `${label} 정산\n${won(-s.amount)} 부족으로 다음 항목 예산이 감액되었습니다.\n${lines.join('\n')}`;
  } else text = `${label} 정산\n남은 금액과 초과 금액이 같아 저축 변동이 없습니다.`;
  await showModal(text, OK);
}

async function maybeShowPreview() {
  if (!isLastDayOfMonth(state.today)) return;
  if ((await getSetting('previewShown')) === state.today) return;
  await setSetting('previewShown', state.today);
  const s = await previewSettlement(ymOf(state.today));
  const text = s.net >= 0
    ? `오늘은 이번 달 마지막 날입니다.\n이번 달 정산 예정 금액 ${won(s.net)} — 내일 저축으로 옮겨집니다.`
    : `오늘은 이번 달 마지막 날입니다.\n이번 달 정산 예정 금액 −${won(-s.net)} — 초과한 항목의 다음 달 예산에서 감액됩니다.`;
  await showModal(text, OK);
}

async function maybeShowOverflow() {
  const limit = Number(await getSetting('savingsLimit', 0)) || 0;
  if (!limit) return;
  const over = (await savingsBalance()) - limit;
  if (over <= 0) return;
  const key = await showModal(
    `저축이 한도를 ${won(over)} 초과했습니다.\n투자자산으로 옮기세요.`,
    [{ key: 'close', label: '닫기' }, { key: 'move', label: '이동 기록하기', primary: true }],
  );
  if (key === 'move') openHoldingSheet(over);
}

// ───────────────────────── 토스트 (되돌리기) ─────────────────────────

let toastTimer = null;
function showToast(text, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(text)}</span>${undo ? '<button id="undoBtn">되돌리기</button>' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  if (undo) {
    t.querySelector('#undoBtn').onclick = async () => {
      t.hidden = true;
      clearTimeout(toastTimer);
      await undo();
    };
  }
}

// ───────────────────────── 내역 ─────────────────────────

async function renderHistory() {
  const ym = state.historyYm;
  $('#historyMonth').textContent = monthLabel(ym);
  $('#nextMonth').disabled = ym >= ymOf(state.today);
  const allCats = await db.categories.toArray();
  const cat = (id) => allCats.find((c) => c.id === id) || { name: '(삭제된 항목)', color: '#999' };

  const expenses = (await db.expenses.where('ym').equals(ym).toArray()).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  $('#expenseList').innerHTML = expenses.length
    ? `<li><div class="grow muted small">합계</div><div class="amt">${won(total)}</div></li>` + expenses.map((e) => `
      <li>
        <span class="dot" style="background:${esc(cat(e.categoryId).color)}"></span>
        <div class="grow"><div>${esc(cat(e.categoryId).name)}</div><div class="sub">${dayLabel(e.date, state.today)}${e.memo ? ` · ${esc(e.memo)}` : ''}</div></div>
        <div class="amt">${num(e.amount)}</div>
        <button class="del" data-del-expense="${e.id}" aria-label="삭제">×</button>
      </li>`).join('')
    : '<li class="empty">지출 내역이 없습니다</li>';

  const TYPE = { settle: '정산', manual: '직접 입력', invest: '투자 이동', sell: '매도 대금', income: '수입' };
  const savings = (await db.savings.orderBy('date').reverse().toArray());
  const monthIncomes = savings.filter((x) => x.type === 'income' && ymOf(x.date) === ym);
  const incomeTotal = monthIncomes.reduce((t, x) => t + x.amount, 0);
  $('#incomeList').innerHTML = monthIncomes.length
    ? `<li><div class="grow muted small">합계</div><div class="amt income-amt">+${num(incomeTotal)}</div></li>` + monthIncomes.map((x) => `
      <li>
        <span class="dot" style="background:var(--saving)"></span>
        <div class="grow" data-edit-income="${x.id}" role="button"><div>${esc(x.memo || '수입')} <span class="edit-hint">편집 ›</span></div><div class="sub">${dayLabel(x.date, state.today)} · 저축에 반영</div></div>
        <div class="amt income-amt">+${num(x.amount)}</div>
        <button class="del" data-del-saving="${x.id}" aria-label="삭제">×</button>
      </li>`).join('')
    : '<li class="empty">이번 달 수입이 없습니다</li>';

  $('#savingList').innerHTML = savings.length ? savings.map((s) => `
    <li>
      <div class="grow"${s.type === 'income' ? ` data-edit-income="${s.id}" role="button"` : ''}><div>${TYPE[s.type] || s.type}${s.type === 'income' ? ' <span class="edit-hint">편집 ›</span>' : ''}</div><div class="sub">${s.date}${s.memo ? ` · ${esc(s.memo)}` : ''}</div></div>
      <div class="amt" style="color:${s.amount < 0 ? 'var(--red)' : 'inherit'}">${s.amount < 0 ? '−' : '+'}${num(Math.abs(s.amount))}</div>
      <button class="del" data-del-saving="${s.id}" aria-label="삭제">×</button>
    </li>`).join('') : '<li class="empty">저축 내역이 없습니다</li>';

  const holdings = await db.holdings.orderBy('date').reverse().toArray();
  $('#holdingList').innerHTML = holdings.length ? holdings.map((h) => `
    <li>
      <div class="grow" data-edit-holding="${h.id}" role="button"><div>${esc(h.name || h.code)} <span class="edit-hint">편집 ›</span></div><div class="sub">${holdingDetail(h)}</div></div>
      <div class="amt">${num(costKRW(h))}</div>
      <button class="del" data-del-holding="${h.id}" aria-label="삭제">×</button>
    </li>`).join('') : '<li class="empty">등록된 종목이 없습니다</li>';

  const pf = await loadPortfolio();
  $('#saleList').innerHTML = pf.sales.length ? pf.sales.map((x) => `
    <li>
      <div class="grow"><div>${esc(x.name)}</div><div class="sub">${x.date} · ${saleDetail(x)}</div></div>
      <div class="amt gain ${x.realized > 0 ? 'up' : x.realized < 0 ? 'down' : ''}">${signedWon(x.realized)}</div>
      <button class="del" data-del-sale="${x.id}" aria-label="삭제">×</button>
    </li>`).join('') : '<li class="empty">매도 기록이 없습니다</li>';

  const vals = await db.valuations.orderBy('date').reverse().toArray();
  $('#valuationList').innerHTML = vals.length ? vals.map((v) => `
    <li>
      <div class="grow">${v.date}</div>
      <div class="amt">${num(v.value)}</div>
      <button class="del" data-del-valuation="${v.date}" aria-label="삭제">×</button>
    </li>`).join('') : '<li class="empty">직접 입력한 평가액이 없습니다</li>';
}

function holdingDetail(h) {
  const type = assetTypeOf(h);
  if (type !== 'stock') return `${ASSET_TYPES[type]} · ${won(h.qty * h.price)} · ${h.date}`;
  const parts = [h.code ? `${esc(h.code)} ${h.market === 'US' ? '🇺🇸' : '🇰🇷'}` : '직접 평가'];
  if (h.currency === 'USD') parts.push(`${h.qty}주 × $${h.price.toLocaleString('en-US', { maximumFractionDigits: 2 })} × ${num(h.fx)}원`);
  else parts.push(`${h.qty}주 × ${num(h.price)}원`);
  parts.push(h.date);
  return parts.join(' · ');
}

async function onHistoryClick(e) {
  const editIncome = e.target.closest('[data-edit-income]');
  if (editIncome) {
    const x = await db.savings.get(Number(editIncome.dataset.editIncome));
    if (x) openIncomeSheet({ existing: x });
    return;
  }
  const edit = e.target.closest('[data-edit-holding]');
  if (edit) {
    const h = await db.holdings.get(Number(edit.dataset.editHolding));
    if (h && assetTypeOf(h) !== 'stock') openAssetEditor(holdingKey(h));
    else if (h) openHoldingSheet(0, h);
    return;
  }
  const b = e.target.closest('button.del');
  if (!b) return;
  if (b.dataset.delExpense) {
    const id = Number(b.dataset.delExpense);
    const row = await db.expenses.get(id);
    await db.expenses.delete(id);
    await refresh();
    showToast('지출 삭제', async () => { await db.expenses.put(row); await refresh(); });
    return;
  }
  if (b.dataset.delSale) { await deleteSale(Number(b.dataset.delSale)); return; }
  if ((await showModal('이 기록을 삭제할까요?', [{ key: 'no', label: '취소' }, { key: 'yes', label: '삭제', primary: true }])) !== 'yes') return;
  if (b.dataset.delSaving) await db.savings.delete(Number(b.dataset.delSaving));
  if (b.dataset.delHolding) await db.holdings.delete(Number(b.dataset.delHolding));
  if (b.dataset.delValuation) await db.valuations.delete(b.dataset.delValuation);
  await refresh();
}

// ───────────────────────── 설정 ─────────────────────────

let draft = [];

// 설정: 종목별 시세 상태 (마지막 종가 날짜, 마지막 요청 결과)
async function renderPriceStatus() {
  const box = $('#priceStatusList');
  const rows = await priceStatusList();
  box.innerHTML = rows.length ? rows.map((r) => {
    const ok = r.log ? r.log.ok : null;
    const when = r.log ? new Date(r.log.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const price = r.lastClose == null ? '시세 없음'
      : r.market === 'US' ? `$${r.lastClose.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
        : r.market === 'FX' ? `${r.lastClose.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원` : `${num(r.lastClose)}원`;
    return `<li>
      <span class="dot" style="background:${ok === false ? 'var(--over)' : r.lastDate ? 'var(--ok)' : 'var(--principal)'}"></span>
      <div class="grow"><div>${esc(r.code)} <small class="muted">${r.market === 'US' ? '미국' : r.market === 'FX' ? '환율' : '국내'}</small></div>
        <div class="sub">${r.log ? `${when} ${ok ? `요청 성공${r.log.rows != null ? ` · ${r.log.rows}건` : ''}` : esc(r.log.message || '실패')}` : '아직 요청 안 함'}</div></div>
      <div class="amt">${price}<div class="sub">${r.lastDate || ''}</div></div>
    </li>`;
  }).join('') : '<li class="empty">시세를 받는 종목이 없습니다</li>';
}

async function renderSettings() {
  $('#appVersion').textContent = `앱 버전 ${APP_VERSION}`;
  renderPriceStatus();
  renderLockSettings($('#lockSettings'), {
    toast: showToast,
    confirm: (text) => showModal(text, [{ key: 'no', label: '아니요' }, { key: 'yes', label: '네', primary: true }]),
  });
  draft = (await activeCategories()).map((c) => ({ ...c }));
  drawCategoryEditor();
  $('#savingsLimit').value = num(Number(await getSetting('savingsLimit', 0)) || 0).replace(/^0$/, '');
  $('#totalBudget').value = num(Number(await getSetting('totalBudget', 0)) || 0).replace(/^0$/, '');
  updateTotalBudgetHint();
  $('#apiKey').value = (await getSetting('apiKey')) || '';
  $('#avKey').value = (await getSetting('avKey')) || '';
}

// 설정 화면: 총 예산 − 항목 예산 합계를 입력하는 동안 바로 보여준다
function updateTotalBudgetHint() {
  const total = readAmount($('#totalBudget'));
  const allocated = draft.reduce((s, c) => s + (c.budget || 0), 0);
  const hint = $('#totalBudgetHint');
  hint.classList.remove('neg');
  if (!total) {
    hint.textContent = `총 예산에서 항목 예산 합계(지금 ${won(allocated)})를 뺀 금액이 홈 화면 저축 카드에 '이번 달 예상 저축'으로 나옵니다.`;
  } else if (total >= allocated) {
    hint.textContent = `항목 예산 합계 ${won(allocated)} · 예상 저축 ${won(total - allocated)}`;
  } else {
    hint.textContent = `항목 예산 합계(${won(allocated)})가 총 예산보다 ${won(allocated - total)} 많습니다`;
    hint.classList.add('neg');
  }
}

function drawCategoryEditor() {
  $('#categoryEditor').innerHTML = draft.map((c, i) => `
    <div class="cat-row" data-i="${i}">
      <input type="color" value="${esc(c.color || '#16a34a')}" data-f="color" aria-label="색상">
      <input value="${esc(c.name)}" data-f="name" placeholder="항목 이름">
      <input value="${c.budget ? num(c.budget) : ''}" data-f="budget" inputmode="numeric" placeholder="월 예산">
      <button class="del" data-remove="${i}" aria-label="항목 삭제">×</button>
      <input class="aliases" value="${esc((c.aliases || []).join(', '))}" data-f="aliases" placeholder="별칭 (예: 밥, 점심)">
    </div>`).join('');
}

function onCategoryEdit(e) {
  const row = e.target.closest('.cat-row');
  const f = e.target.dataset.f;
  if (!row || !f) return;
  const c = draft[Number(row.dataset.i)];
  if (f === 'budget') {
    const digits = e.target.value.replace(/[^\d]/g, '');
    e.target.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
    c.budget = Number(digits) || 0;
  } else if (f === 'aliases') {
    c.aliases = e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  } else c[f] = e.target.value;
  if (f === 'budget') updateTotalBudgetHint();
}

async function saveSettings() {
  const ym = ymOf(state.today);
  const names = draft.map((c) => c.name.trim());
  if (names.some((n) => !n)) { showToast('항목 이름을 입력하세요'); return; }
  if (new Set(names).size !== names.length) { showToast('같은 이름의 항목이 있습니다'); return; }

  const existing = await activeCategories();
  const keep = new Set(draft.filter((c) => c.id).map((c) => c.id));
  for (const c of existing) {
    if (!keep.has(c.id)) {
      // 삭제한 항목: 지난 기록은 남기고 숨긴다. 이번 달 예산에서는 뺀다.
      await db.categories.update(c.id, { archived: true });
      await db.monthlyBudgets.delete([ym, c.id]);
    }
  }
  for (const [i, c] of draft.entries()) {
    const row = { name: c.name.trim(), budget: c.budget || 0, color: c.color || '#16a34a', aliases: c.aliases || [], order: i, archived: false };
    if (c.id) {
      await db.categories.update(c.id, row);
      await updateCategoryBudget(c.id, row.budget, ym);
    } else {
      c.id = await db.categories.add(row);
    }
  }
  await ensureMonth(ym);
  await setSetting('savingsLimit', readAmount($('#savingsLimit')));
  await setSetting('totalBudget', readAmount($('#totalBudget')));
  await setSetting('apiKey', $('#apiKey').value.trim());
  await setSetting('avKey', $('#avKey').value.trim());
  await refresh();
  await renderSettings();
  showToast('설정을 저장했습니다');
  await maybeShowOverflow();
}

async function exportBackup() {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `my-finance-${state.today}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importBackup(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const ok = await showModal(`백업 파일(${data.exportedAt?.slice(0, 10) || '날짜 모름'})로 이 기기의 데이터를 모두 바꿀까요?`, [{ key: 'no', label: '취소' }, { key: 'yes', label: '가져오기', primary: true }]);
    if (ok !== 'yes') return;
    await importAll(data);
    location.reload();
  } catch (err) {
    showModal(`가져오기 실패: ${err.message}`, OK);
  }
}

async function testPrices() {
  await setSetting('apiKey', $('#apiKey').value.trim());
  await setSetting('avKey', $('#avKey').value.trim());
  showToast('시세를 받아오는 중… (미국 종목은 종목당 12초)');
  const r = await updatePrices({ force: true });
  await refresh();
  renderPriceStatus();
  if (r.skipped.includes('noHoldings')) return showModal('종목코드가 있는 투자 종목이 없습니다.', OK);
  const lines = [];
  if (r.added) lines.push(`시세 ${r.added}건을 저장했습니다.`);
  for (const x of r.errors) lines.push(`${x.code}: ${x.message}`);
  if (r.skipped.includes('noKRKey')) lines.push('국내 종목: 금융위 인증키가 없습니다.');
  if (r.skipped.includes('noUSKey')) lines.push('미국 종목: Alpha Vantage 키가 없습니다.');
  if (!lines.length) lines.push('새로 받은 시세가 없습니다.\n국내 종가는 다음 영업일 오후 1시 이후 반영됩니다.');
  showModal(`시세 업데이트\n${lines.join('\n')}`, OK);
}

// ───────────────────────── 연결 ─────────────────────────

function showView(name) {
  for (const v of ['home', 'history', 'settings']) $(`#view-${v}`).hidden = v !== name;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

function bindUI() {
  $('#fab').addEventListener('click', () => openExpenseSheet());
  $('#budgetBars').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (b) openExpenseSheet(Number(b.dataset.cat));
  });
  $('#savingBar').addEventListener('click', openSavingSheet);
  $('#savingAdd').addEventListener('click', openSavingSheet);
  $('#addHoldingBtn').addEventListener('click', () => openHoldingSheet());
  $('#addValuationBtn').addEventListener('click', openValuationSheet);
  $('#stockTable').addEventListener('click', (e) => {
    const row = e.target.closest('[data-stock]');
    if (row) openStockEditor(row.dataset.stock);
  });
  $('#backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  const quick = $('#quickInput');
  quick.addEventListener('input', onQuickInput);
  quick.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitQuick();
    }
  });

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#prevMonth').addEventListener('click', () => { state.historyYm = addMonths(state.historyYm, -1); renderHistory(); });
  $('#nextMonth').addEventListener('click', () => { state.historyYm = addMonths(state.historyYm, 1); renderHistory(); });
  $('#view-history').addEventListener('click', onHistoryClick);

  $('#categoryEditor').addEventListener('input', onCategoryEdit);
  $('#categoryEditor').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    draft.splice(Number(b.dataset.remove), 1);
    drawCategoryEditor();
  });
  $('#addCategory').addEventListener('click', () => {
    draft.push({ name: '', budget: 0, color: '#64748b', aliases: [] });
    drawCategoryEditor();
    $('#categoryEditor .cat-row:last-child [data-f=name]').focus();
  });
  $('#totalBudget').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/[^\d]/g, '');
    e.target.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
    updateTotalBudgetHint();
  });
  $('#savingsLimit').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/[^\d]/g, '');
    e.target.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
  });
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#importFile').addEventListener('change', importBackup);
  $('#testApi').addEventListener('click', testPrices);
}

init();
