// 화면과 입력. 핵심 흐름: 예산(줄어드는 막대) → 저축(차오르는 막대) → 투자(불어나는 선)
/* global Chart */
import { db, exportAll, getSetting, importAll, setSetting } from './db.js';
import {
  activeCategories, ensureMonth, frequentAmounts, monthView, previewSettlement,
  runPendingSettlements, savingsBalance, updateCategoryBudget,
} from './ledger.js';
import { parseAmount, parseLine } from './parse.js';
import { catchUpPrices } from './prices.js';
import { buildSeries, latestPoint } from './invest.js';
import { addMonths, dayLabel, isLastDayOfMonth, monthLabel, num, todayStr, won, ymOf } from './util.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  categories: [],
  today: todayStr(),
  historyYm: ymOf(todayStr()),
  chart: null,
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
  const settled = await runPendingSettlements(state.today);
  await ensureMonth(ymOf(state.today));
  await refresh();

  for (const s of settled) await showSettlementResult(s);
  await maybeShowPreview();
  await maybeShowOverflow();

  const status = $('#priceStatus');
  catchUpPrices(state.today).then(async (r) => {
    if (r.errors?.length) status.textContent = r.errors[0].message;
    else if (r.added) status.textContent = `시세 ${r.added}건 업데이트`;
    else status.textContent = await priceStatusText();
    renderInvest();
    renderTotal();
  });
}

async function priceStatusText() {
  const last = await getSetting('lastPriceUpdate');
  const key = await getSetting('apiKey');
  if (!key) return (await db.holdings.count()) ? '시세 API 키가 없어 매수 단가·직접 입력 평가액으로 표시합니다.' : '';
  return last ? `시세 확인: ${last}` : '';
}

async function refresh() {
  state.categories = await activeCategories();
  await Promise.all([renderBudget(), renderSavings(), renderInvest()]);
  await renderTotal();
  if (!$('#view-history').hidden) renderHistory();
}

// ───────────────────────── 예산 막대 ─────────────────────────

function barColor(ratio) {
  if (ratio < 0) return 'var(--red)';
  if (ratio >= 0.5) return 'var(--green)';
  if (ratio >= 0.2) return 'var(--orange)';
  return 'var(--orange-dark)';
}

async function renderBudget() {
  const ym = ymOf(state.today);
  const view = await monthView(ym);
  $('#budgetTitle').textContent = `${Number(ym.slice(5))}월 예산`;
  const totalLeft = view.reduce((s, v) => s + v.left, 0);
  const totalFinal = view.reduce((s, v) => s + v.final, 0);
  $('#budgetSum').textContent = `남은 ${won(totalLeft)} / ${won(totalFinal)}`;

  const box = $('#budgetBars');
  if (!view.length) {
    box.innerHTML = '<div class="bars-empty">설정에서 예산 항목을 추가하세요.</div>';
    return;
  }
  box.innerHTML = view.map((v) => {
    const over = v.left < 0;
    const ratio = v.final > 0 ? v.left / v.final : (v.used > 0 ? -1 : 0);
    const h = over ? 0 : Math.max(0, Math.min(1, ratio)) * 100;
    return `
      <button class="bar ${over ? 'over' : ''}" data-cat="${v.category.id}" aria-label="${esc(v.category.name)} 지출 입력">
        <div class="bar-track">
          <div class="bar-fill" style="height:${h}%;background:${barColor(over ? -1 : ratio)}"></div>
          ${over ? `<div class="bar-over-text">${num(-v.left)} 초과</div>` : ''}
        </div>
        <div class="bar-name">${esc(v.category.name)}</div>
        <div class="bar-left" style="color:${over ? 'var(--red)' : 'inherit'}">${over ? '−' : ''}${num(Math.abs(v.left))}</div>
        ${v.cut > 0 ? `<div class="bar-cut">지난달 초과로 ${num(v.cut)}원 감액</div>` : ''}
      </button>`;
  }).join('');
}

// ───────────────────────── 저축 막대 ─────────────────────────

async function renderSavings() {
  const balance = await savingsBalance();
  const limit = Number(await getSetting('savingsLimit', 0)) || 0;
  const fill = $('#savingFill');
  const overEl = $('#savingOver');
  const bar = $('#savingBar');
  if (!limit) {
    fill.style.height = balance > 0 ? '100%' : '0%';
    fill.style.background = 'var(--save)';
    overEl.style.height = '0';
    bar.classList.remove('overflow');
    $('#savingLabel').innerHTML = `${num(balance)}원<br><span class="muted">한도 미설정</span>`;
    return;
  }
  const ratio = balance / limit;
  fill.style.height = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  fill.style.background = ratio >= 1 ? 'var(--save-full)' : ratio >= 0.8 ? 'var(--save-deep)' : 'var(--save)';
  const overflow = balance - limit;
  // 넘친 부분은 막대 위로 (최대 막대 높이의 1/3까지만 그린다)
  overEl.style.height = overflow > 0 ? `${Math.max(8, Math.min(60, (overflow / limit) * 180))}px` : '0';
  bar.classList.toggle('overflow', overflow > 0);
  $('#savingLabel').innerHTML = `${num(balance)}원<br><span class="muted">/ ${num(limit)}</span>`
    + (overflow > 0 ? `<br><span style="color:var(--save-full)">+${num(overflow)} 초과</span>` : '');
}

// ───────────────────────── 투자 꺾은선 ─────────────────────────

async function investSeries() {
  const [holdings, prices, manual] = await Promise.all([db.holdings.toArray(), db.prices.toArray(), db.valuations.toArray()]);
  return buildSeries(holdings, prices, manual, state.today);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function shortWon(v) {
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
  if (Math.abs(v) >= 1e6) return `${Math.round(v / 1e4).toLocaleString('ko-KR')}만`;
  if (Math.abs(v) >= 1e4) return `${Number((v / 1e4).toFixed(1))}만`;
  return num(v);
}

async function renderInvest() {
  const series = await investSeries();
  $('#investEmpty').hidden = series.length > 0;
  $('.chart-wrap').hidden = !series.length;
  const last = latestPoint(series);
  const gain = last.value - last.principal;
  $('#investGain').textContent = series.length
    ? `${gain >= 0 ? '+' : '−'}${num(Math.abs(gain))}원 (${last.principal ? ((gain / last.principal) * 100).toFixed(1) : '0.0'}%)`
    : '';
  $('#investGain').style.color = gain >= 0 ? 'var(--green)' : 'var(--red)';

  const labels = series.map((p) => dayLabel(p.date, '0000-00-00'));
  const data = {
    labels,
    datasets: [
      { label: '원금', data: series.map((p) => p.principal), borderColor: cssVar('--principal'), borderDash: [4, 4], stepped: true, pointRadius: 0, borderWidth: 2 },
      { label: '평가액', data: series.map((p) => p.value), borderColor: cssVar('--value'), backgroundColor: 'transparent', pointRadius: series.length > 40 ? 0 : 2, borderWidth: 2.5, tension: 0.2 },
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
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 12, color: cssVar('--muted'), font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label} ${won(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 4, color: cssVar('--muted'), font: { size: 10 } }, grid: { display: false } },
        y: { grace: '10%', ticks: { maxTicksLimit: 4, color: cssVar('--muted'), font: { size: 10 }, callback: (v) => shortWon(v) }, grid: { color: cssVar('--line') } },
      },
    },
  });
}

async function renderTotal() {
  const balance = await savingsBalance();
  const value = latestPoint(await investSeries()).value;
  $('#total').textContent = won(balance + value);
  $('#totalSub').textContent = `저축 ${won(balance)} · 투자 ${won(value)}`;
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
    <button class="chip ${c.id === selectedId ? 'selected' : ''}" data-cat="${c.id}" style="--chip:${esc(c.color)}">${esc(c.name)}</button>`).join('');
}

// ───────────────────────── 지출 입력 ─────────────────────────
// 목표: 3초 이내, 터치 2~3번. 막대에서 열면 항목이 이미 선택돼 있고, 금액 키패드가 즉시 뜬다.

function openExpenseSheet(categoryId = null) {
  let selected = categoryId;
  const sheet = openSheet(`
    <input class="amount-input" id="exAmount" inputmode="numeric" pattern="[0-9]*" placeholder="금액" autocomplete="off" enterkeyhint="done">
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
  if (e.status === 'noAmount') return `<div class="bad">금액을 찾지 못했습니다: “${esc(e.raw)}”</div>`;
  const cat = e.status === 'ok' ? catName(e.categoryId)
    : e.status === 'ambiguous' ? `항목 선택 필요 (${e.candidates.map(catName).join('/')})` : '항목 선택 필요';
  const parts = [cat, won(e.amount), dayLabel(e.date, state.today)];
  if (e.memo) parts.push(e.memo);
  return `<div class="${e.status === 'ok' ? '' : 'bad'}">${parts.map(esc).join(' · ')}</div>`;
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
    <input class="amount-input" id="svAmount" inputmode="numeric" placeholder="금액" autocomplete="off">
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

// ───────────────────────── 투자 종목 등록 ─────────────────────────
// transfer: 저축에서 옮길 금액 (한도 초과 팝업에서 열면 초과 금액이 채워져 있다)

function openHoldingSheet(transfer = 0) {
  const sheet = openSheet(`
    <h4>투자 종목 등록</h4>
    ${transfer ? `<div class="note">저축 한도 초과분 <b>${won(transfer)}</b>을 투자로 옮깁니다.</div>` : ''}
    <label class="field"><span>종목코드 (6자리, 비우면 시세 없이 직접 평가)</span><input id="hdCode" inputmode="numeric" maxlength="6" placeholder="005930"></label>
    <label class="field"><span>종목명</span><input id="hdName" placeholder="비우면 시세 받을 때 채워짐"></label>
    <div class="row">
      <label class="field" style="flex:1"><span>보유 수량</span><input id="hdQty" inputmode="decimal" placeholder="10"></label>
      <label class="field" style="flex:1"><span>매수 단가</span><input id="hdPrice" inputmode="numeric" placeholder="70,000"></label>
    </div>
    <label class="field"><span>매수일</span><input id="hdDate" type="date" value="${state.today}" max="${state.today}"></label>
    <label class="field"><span>저축에서 차감할 금액</span><input id="hdTransfer" inputmode="numeric" value="${transfer ? num(transfer) : ''}" placeholder="0 (저축과 무관하면 비워 두기)"></label>
    <div class="amount-hint" id="hdHint"></div>
    <button class="save" id="hdSave">등록</button>
  `);
  const q = (id) => sheet.querySelector(id);
  bindAmountInput(q('#hdPrice'));
  bindAmountInput(q('#hdTransfer'));
  q('#hdCode').focus();
  const updateHint = () => {
    const cost = (Number(q('#hdQty').value) || 0) * readAmount(q('#hdPrice'));
    q('#hdHint').textContent = cost ? `원금 ${won(cost)}` : '';
  };
  q('#hdQty').addEventListener('input', updateHint);
  q('#hdPrice').addEventListener('input', updateHint);

  q('#hdSave').addEventListener('click', async () => {
    const code = q('#hdCode').value.trim();
    let qty = Number(q('#hdQty').value) || 0;
    let price = readAmount(q('#hdPrice'));
    const move = readAmount(q('#hdTransfer'));
    // 종목코드 없이 금액만 옮기는 경우(펀드 등): 수량 1 × 옮긴 금액
    if (!qty && !price && move) { qty = 1; price = move; }
    if (!qty || !price) { q('#hdQty').focus(); return; }
    if (code && !/^[0-9A-Z]{6}$/i.test(code)) { q('#hdCode').focus(); return; }
    const date = q('#hdDate').value || state.today;
    const name = q('#hdName').value.trim() || (code ? '' : '직접 평가 자산');
    await db.transaction('rw', db.holdings, db.savings, async () => {
      await db.holdings.add({ code: code.toUpperCase(), name, qty, price, date });
      if (move) await db.savings.add({ date, amount: -move, type: 'invest', memo: `투자 이동${name ? ` · ${name}` : code ? ` · ${code}` : ''}` });
    });
    closeSheet();
    await refresh();
    showToast(move ? `저축 ${won(move)} → 투자` : '종목 등록 완료');
    if (code) catchUpPrices(state.today).then(() => { renderInvest(); renderTotal(); });
  });
}

function openValuationSheet() {
  const sheet = openSheet(`
    <h4>평가액 직접 입력</h4>
    <p class="muted small">시세 API를 쓸 수 없을 때, 증권 앱에서 본 총 평가액을 넣으면 그날의 점으로 그립니다.</p>
    <input class="amount-input" id="vlAmount" inputmode="numeric" placeholder="총 평가액" autocomplete="off">
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

  const TYPE = { settle: '정산', manual: '직접 입력', invest: '투자 이동' };
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
      <div class="grow"><div>${esc(h.name || h.code)}</div><div class="sub">${esc(h.code)} · ${h.qty}주 × ${num(h.price)} · ${h.date}</div></div>
      <div class="amt">${num(h.qty * h.price)}</div>
      <button class="del" data-del-holding="${h.id}" aria-label="삭제">×</button>
    </li>`).join('') : '<li class="empty">등록된 종목이 없습니다</li>';

  const vals = await db.valuations.orderBy('date').reverse().toArray();
  $('#valuationList').innerHTML = vals.length ? vals.map((v) => `
    <li>
      <div class="grow">${v.date}</div>
      <div class="amt">${num(v.value)}</div>
      <button class="del" data-del-valuation="${v.date}" aria-label="삭제">×</button>
    </li>`).join('') : '<li class="empty">직접 입력한 평가액이 없습니다</li>';
}

async function onHistoryClick(e) {
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
  showToast('시세를 받아오는 중…');
  const r = await catchUpPrices(state.today);
  if (r.skipped === 'noKey') return showModal('인증키를 먼저 입력하세요.', OK);
  if (r.skipped === 'noHoldings') return showModal('종목코드가 있는 투자 종목이 없습니다.', OK);
  await refresh();
  if (r.errors.length) return showModal(r.errors.map((x) => `${x.code}: ${x.message}`).join('\n'), OK);
  showModal(r.added ? `시세 ${r.added}건을 저장했습니다.` : '새로 받은 시세가 없습니다. (전 영업일 종가는 다음 영업일 오후 1시 이후 반영)', OK);
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
  $('#addHoldingBtn').addEventListener('click', () => openHoldingSheet());
  $('#addValuationBtn').addEventListener('click', openValuationSheet);
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
