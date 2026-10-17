// 화면과 입력. 핵심 흐름: 예산(줄어드는 막대) → 저축(차오르는 막대) → 투자(불어나는 선)
/* global Chart */
import { db, exportAll, getSetting, importAll, setSetting } from './db.js';
import {
  activeCategories, ensureMonth, frequentAmounts, monthView, previewSettlement,
  runPendingSettlements, savingsBalance, updateCategoryBudget,
} from './ledger.js';
import { parseAmount, parseLine } from './parse.js';
import { distributeTotal } from './settle.js';
import { catchUpPrices, fxOn } from './prices.js';
import { computePortfolio, costKRW, currencyOf, heldQtyOn, holdingKey, latestPoint, marketOf } from './invest.js';
import { addMonths, dayLabel, isLastDayOfMonth, monthLabel, num, todayStr, won, ymOf } from './util.js';

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

async function init() {
  if (!(await db.categories.count())) {
    await db.categories.bulkAdd(DEFAULT_CATEGORIES.map((c, i) => ({ ...c, order: i, archived: false })));
  }
  bindUI();
  await onOpen();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastOpenCheck > 5 * 60 * 1000) onOpen();
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
function updatePrices() {
  const status = $('#priceStatus');
  return catchUpPrices(state.today, { onProgress: (t) => { status.textContent = t; } }).then(async (r) => {
    if (r.errors.length) status.textContent = `${r.errors[0].code}: ${r.errors[0].message}`;
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

  renderAllocation(view, totalFinal);

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
function renderAllocation(view, totalFinal) {
  const box = $('#budgetAlloc');
  const parts = view.filter((v) => v.final > 0);
  box.hidden = !parts.length;
  if (!parts.length) return;
  $('#allocTotal').textContent = won(totalFinal);
  const pct = (v) => (v.final / totalFinal) * 100;
  $('#allocBar').innerHTML = parts.map((v) => `
    <span style="flex-grow:${v.final};background:${esc(v.category.color)}" title="${esc(v.category.name)} ${won(v.final)} (${pct(v).toFixed(1)}%)"></span>`).join('');
  $('#allocLegend').innerHTML = parts.map((v) => `
    <span><i style="background:${esc(v.category.color)}"></i>${esc(v.category.name)} <b>${Math.round(pct(v))}%</b></span>`).join('');
}

// 총 예산 수정 — 새 총액을 지금 배분 비율대로 항목에 나눈다
async function openTotalBudgetSheet() {
  const ym = ymOf(state.today);
  const view = await monthView(ym);
  const cats = view.map((v) => v.category);
  if (!cats.length) { showView('settings'); return; }
  const current = cats.reduce((s, c) => s + (c.budget || 0), 0);
  const totalCut = view.reduce((s, v) => s + v.cut, 0);
  const sheet = openSheet(`
    <h4>총 예산 수정</h4>
    <p class="muted small">새 총 예산을 지금 배분 비율대로 항목에 나눕니다. 항목별로 따로 바꾸려면 설정 탭에서 하세요.</p>
    <label class="amount-wrap"><input class="amount-input" id="tbAmount" inputmode="numeric" value="${num(current)}" autocomplete="off"><span>원</span></label>
    <div class="amount-hint" id="tbHint"></div>
    ${totalCut ? `<div class="note warn">지난달 초과로 감액된 ${won(totalCut)}은 이번 달 예산에서 따로 빠집니다.</div>` : ''}
    <ul class="list lot-list tb-preview" id="tbPreview"></ul>
    <button class="save" id="tbSave">저장</button>
  `);
  const input = sheet.querySelector('#tbAmount');
  bindAmountInput(input, sheet.querySelector('#tbHint'));
  input.focus();
  input.select();
  const plan = () => distributeTotal(cats.map((c) => ({ id: c.id, budget: c.budget || 0 })), readAmount(input));
  const draw = () => {
    const next = plan();
    sheet.querySelector('#tbPreview').innerHTML = cats.map((c) => {
      const diff = next[c.id] - (c.budget || 0);
      return `
      <li>
        <span class="dot" style="background:${esc(c.color)}"></span>
        <div class="grow">${esc(c.name)}</div>
        <div class="sub">${num(c.budget || 0)} →</div>
        <div class="amt">${num(next[c.id])}${diff ? `<small class="${diff > 0 ? 'up' : 'down'}"> ${diff > 0 ? '+' : '−'}${num(Math.abs(diff))}</small>` : ''}</div>
      </li>`;
    }).join('');
  };
  input.addEventListener('input', draw);
  draw();
  const save = async () => {
    const total = readAmount(input);
    if (!total) { input.focus(); return; }
    const next = plan();
    const before = cats.map((c) => ({ id: c.id, budget: c.budget || 0 }));
    const apply = async (rows) => {
      for (const r of rows) {
        await db.categories.update(r.id, { budget: r.budget });
        await updateCategoryBudget(r.id, r.budget, ym);
      }
    };
    await apply(cats.map((c) => ({ id: c.id, budget: next[c.id] })));
    closeSheet();
    await refresh();
    showToast(`총 예산 ${won(total)}`, async () => { await apply(before); await refresh(); });
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  sheet.querySelector('#tbSave').addEventListener('click', save);
}

// ───────────────────────── 저축 막대 ─────────────────────────

async function renderSavings() {
  const balance = await savingsBalance();
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
  r.innerHTML = `실현손익 <b class="gain ${pf.realized > 0 ? 'up' : pf.realized < 0 ? 'down' : ''}">${signedWon(pf.realized)}</b> · 매도 ${pf.sales.length}건`;
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

async function renderStocks() {
  const { dates, stocks } = await loadPortfolio();
  $('#stockSection').hidden = !stocks.length;
  if (!stocks.length) return;
  const color = (i) => STOCK_COLORS[i % STOCK_COLORS.length];

  $('#stockTable').innerHTML = stocks.map((st, i) => {
    const dir = st.gain > 0 ? 'up' : st.gain < 0 ? 'down' : '';
    const rdir = st.realized > 0 ? 'up' : st.realized < 0 ? 'down' : '';
    if (!st.qty) {
      return `
      <div class="stock-row sold" data-stock="${esc(st.key)}" role="button" tabindex="0" aria-label="${esc(st.name)} 기록 보기">
        <i class="stock-dot" style="background:${color(i)}"></i>
        <div class="stock-name"><b>${esc(st.name)}<em class="edit-hint">기록 ›</em></b><span>${st.code ? esc(st.code) : '직접 평가'} · 전량 매도</span></div>
        <div class="stock-value"><span class="muted small">실현손익</span><b class="gain ${rdir}">${signedWon(st.realized)}</b></div>
      </div>`;
    }
    const sub = [st.code ? `${esc(st.code)} ${st.market === 'US' ? '🇺🇸' : '🇰🇷'}` : '직접 평가', `${Number(st.qty.toFixed(4))}주`].join(' · ');
    return `
      <div class="stock-row" data-stock="${esc(st.key)}" role="button" tabindex="0" aria-label="${esc(st.name)} 수정">
        <i class="stock-dot" style="background:${color(i)}"></i>
        <div class="stock-name"><b>${esc(st.name)}<em class="edit-hint">편집 ›</em></b><span>${sub}</span></div>
        <div class="stock-value"><b>${num(st.value)}원</b><span class="gain ${dir}">${rateText(st.rate)}</span></div>
        <div class="stock-prices">
          <span>매수가 <b>${priceText(st.avgPrice, st.currency)}</b></span>
          <span>현재가 <b>${priceText(st.lastClose, st.currency)}</b>${st.lastDate ? ` <small>${dayLabel(st.lastDate, state.today)}</small>` : ''}</span>
          <span class="gain ${dir}">${st.gain > 0 ? '+' : st.gain < 0 ? '−' : ''}${num(Math.abs(st.gain))}원</span>
          ${st.realized ? `<span class="realized">실현 <b class="gain ${rdir}">${signedWon(st.realized)}</b></span>` : ''}
        </div>
      </div>`;
  }).join('');

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
    <h4>지출</h4>
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

// ───────────────────────── 한 줄 입력 ─────────────────────────

function catName(id) {
  return state.categories.find((c) => c.id === id)?.name || '?';
}

function describe(e) {
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
    if (e.status === 'ok') continue;
    const picked = await pickCategory(e);
    if (picked == null) return; // 입력을 고치면 취소
    e.categoryId = picked;
    e.status = 'ok';
    $('#quickPreview').innerHTML = entries.map(describe).join('');
  }

  const ids = await db.expenses.bulkAdd(
    entries.map((e) => ({ date: e.date, ym: ymOf(e.date), categoryId: e.categoryId, amount: e.amount, memo: e.memo })),
    { allKeys: true },
  );
  for (const ym of new Set(entries.map((e) => ymOf(e.date)))) await ensureMonth(ym);
  t.value = '';
  autoGrow(t);
  $('#quickPreview').innerHTML = '';
  t.blur();
  await refresh();
  const total = entries.reduce((s, e) => s + e.amount, 0);
  const msg = entries.length === 1 ? `${catName(entries[0].categoryId)} ${won(total)} 저장` : `${entries.length}건 ${won(total)} 저장`;
  showToast(msg, async () => { await db.expenses.bulkDelete(ids); await refresh(); });
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

const MARKET_LABEL = { KR: '국내 주식 · 원화', US: '미국 주식 · 달러', NONE: '직접 평가 자산 (시세 없음)' };

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
    <h4>${editing ? '매수 기록 수정' : preset ? `${esc(preset.name || preset.code)} 추가 매수` : '투자 종목 등록'}</h4>
    ${transfer ? `<div class="note">저축 한도 초과분 <b>${won(transfer)}</b>을 투자로 옮깁니다.</div>` : ''}
    <label class="field"><span>종목코드 — 국내 6자리 숫자 · 미국 티커 · 비우면 직접 평가</span>
      <input id="hdCode" maxlength="10" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="005930 또는 AAPL"></label>
    <div class="market-badge" id="hdMarket">${MARKET_LABEL.NONE}</div>
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
    if (!m) { q('#hdCode').focus(); return; }
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

  const TYPE = { settle: '정산', manual: '직접 입력', invest: '투자 이동', sell: '매도 대금' };
  const savings = (await db.savings.orderBy('date').reverse().toArray());
  $('#savingList').innerHTML = savings.length ? savings.map((s) => `
    <li>
      <div class="grow"><div>${TYPE[s.type] || s.type}</div><div class="sub">${s.date}${s.memo ? ` · ${esc(s.memo)}` : ''}</div></div>
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
  const parts = [h.code ? `${esc(h.code)} ${h.market === 'US' ? '🇺🇸' : '🇰🇷'}` : '직접 평가'];
  if (h.currency === 'USD') parts.push(`${h.qty}주 × $${h.price.toLocaleString('en-US', { maximumFractionDigits: 2 })} × ${num(h.fx)}원`);
  else parts.push(`${h.qty}주 × ${num(h.price)}원`);
  parts.push(h.date);
  return parts.join(' · ');
}

async function onHistoryClick(e) {
  const edit = e.target.closest('[data-edit-holding]');
  if (edit) {
    const h = await db.holdings.get(Number(edit.dataset.editHolding));
    if (h) openHoldingSheet(0, h);
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

async function renderSettings() {
  draft = (await activeCategories()).map((c) => ({ ...c }));
  drawCategoryEditor();
  $('#savingsLimit').value = num(Number(await getSetting('savingsLimit', 0)) || 0).replace(/^0$/, '');
  $('#apiKey').value = (await getSetting('apiKey')) || '';
  $('#avKey').value = (await getSetting('avKey')) || '';
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
  const r = await updatePrices();
  await refresh();
  if (r.skipped.includes('noHoldings')) return showModal('종목코드가 있는 투자 종목이 없습니다.', OK);
  const lines = [];
  if (r.added) lines.push(`시세 ${r.added}건을 저장했습니다.`);
  for (const x of r.errors) lines.push(`${x.code}: ${x.message}`);
  if (r.skipped.includes('noKRKey')) lines.push('국내 종목: 금융위 인증키가 없습니다.');
  if (r.skipped.includes('noUSKey')) lines.push('미국 종목: Alpha Vantage 키가 없습니다.');
  if (r.skipped.includes('usDoneToday')) lines.push('미국 종목·환율은 오늘 이미 받았습니다 (호출 횟수 절약).');
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
  $('#editTotalBudget').addEventListener('click', openTotalBudgetSheet);
  $('#editTotalBudget2').addEventListener('click', openTotalBudgetSheet);
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
