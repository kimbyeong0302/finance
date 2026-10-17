// 앱 잠금: PIN + (가능하면) Face ID·지문.
//
// PIN은 그대로 저장하지 않고 PBKDF2(SHA-256, 소금값, 15만 회)로 만든 해시만 저장한다.
// Face ID·지문은 브라우저의 WebAuthn(패스키)으로 이 기기의 생체 인증을 요청한다.
// 서버가 없으므로 서명 검증 대신 '사용자 확인(UV)' 표시만 확인한다 — 화면 잠금 용도로 충분하지만,
// 데이터 자체를 암호화하지는 않는다 (개발자 도구로 IndexedDB를 열면 보인다).
import { db, getSetting, setSetting } from './db.js';

export const LOCK_KEYS = ['lockPin', 'lockCred', 'lockFails'];
const ITER = 150000;
const enc = new TextEncoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

async function hashPin(pin, salt, iter = ITER) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unb64(salt), iterations: iter, hash: 'SHA-256' }, key, 256);
  return b64(bits);
}

export async function lockConfig() {
  return {
    pin: await getSetting('lockPin'),
    cred: await getSetting('lockCred'),
    after: Number(await getSetting('lockAfter', 60)),
  };
}

export async function isLockEnabled() {
  return !!(await getSetting('lockPin'));
}

async function setPin(pin) {
  const salt = b64(randomBytes(16));
  await setSetting('lockPin', { salt, iter: ITER, len: pin.length, hash: await hashPin(pin, salt) });
  await setSetting('lockFails', null);
}

async function verifyPin(pin) {
  const p = await getSetting('lockPin');
  if (!p) return true;
  const h = await hashPin(pin, p.salt, p.iter);
  // 길이가 같은 두 문자열을 끝까지 비교
  let diff = h.length ^ p.hash.length;
  for (let i = 0; i < Math.min(h.length, p.hash.length); i++) diff |= h.charCodeAt(i) ^ p.hash.charCodeAt(i);
  return diff === 0;
}

// ───────── Face ID · 지문 (WebAuthn) ─────────

export async function biometricAvailable() {
  try {
    return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

async function registerBiometric() {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: '내 재정' },
      user: { id: randomBytes(16), name: '내 재정', displayName: '내 재정 잠금' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      attestation: 'none',
      timeout: 60000,
    },
  });
  await setSetting('lockCred', b64(cred.rawId));
}

async function verifyBiometric() {
  const id = await getSetting('lockCred');
  if (!id) return false;
  const res = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: unb64(id) }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  // authenticatorData 33번째 바이트(flags)의 UV(0x04) — 생체/기기 잠금으로 본인 확인을 했는지
  const flags = new Uint8Array(res.response.authenticatorData)[32];
  return !!(flags & 0x04);
}

// ───────── 틀린 PIN 제한 ─────────
// 5번 틀리면 30초, 그 뒤로 틀릴 때마다 대기 시간이 두 배 (최대 15분)

async function failState() {
  return (await getSetting('lockFails')) || { count: 0, until: 0 };
}

async function recordFail() {
  const f = await failState();
  f.count += 1;
  if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60, 30 * 2 ** (f.count - 5)) * 1000;
  await setSetting('lockFails', f);
  return f;
}

// ───────── 숫자 키패드 ─────────

function keypadHTML(withBio) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', withBio ? 'bio' : '', '0', 'del'];
  return `<div class="keypad">${keys.map((k) => {
    if (!k) return '<span></span>';
    if (k === 'bio') return '<button class="key key-bio" data-key="bio" aria-label="Face ID·지문으로 열기"><svg viewBox="0 0 24 24"><path d="M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2M9 9v1M15 9v1M12 9v4h-1M9 16c1.6 1.3 4.4 1.3 6 0"/></svg></button>';
    if (k === 'del') return '<button class="key key-del" data-key="del" aria-label="지우기">⌫</button>';
    return `<button class="key" data-key="${k}">${k}</button>`;
  }).join('')}</div>`;
}

// PIN 입력 화면. container 안에 그린다. 반환값 없음 — onSubmit(pin)이 true를 돌려주면 끝.
function pinPad(container, { title, sub, length, minLength = 4, maxLength = 6, withBio, onBio, onSubmit, footer = '' }) {
  let value = '';
  const fixed = !!length;
  container.innerHTML = `
    <div class="lock-head">
      <img src="icons/icon-192.png" alt="" class="lock-icon">
      <div class="lock-title">${title}</div>
      <div class="lock-sub" id="lockSub">${sub || ''}</div>
    </div>
    <div class="pin-dots" id="pinDots"></div>
    ${fixed ? '' : '<button class="lock-ok" id="pinOk" disabled>다음</button>'}
    ${keypadHTML(withBio)}
    <div class="lock-foot">${footer}</div>`;
  const dots = container.querySelector('#pinDots');
  const subEl = container.querySelector('#lockSub');
  const ok = container.querySelector('#pinOk');
  const draw = () => {
    const n = fixed ? length : Math.max(minLength, value.length);
    dots.innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < value.length ? 'on' : ''}"></i>`).join('');
    if (ok) ok.disabled = value.length < minLength;
  };
  let busy = false;
  const submit = async () => {
    if (busy) return;
    busy = true;
    const done = await onSubmit(value, (msg) => {
      subEl.textContent = msg;
      subEl.classList.add('err');
      dots.classList.remove('shake');
      void dots.offsetWidth;
      dots.classList.add('shake');
    });
    busy = false;
    if (!done) { value = ''; draw(); }
  };
  const press = (k) => {
    if (busy) return;
    if (k === 'del') value = value.slice(0, -1);
    else if (k === 'bio') { onBio?.(); return; }
    else if (value.length < (fixed ? length : maxLength)) value += k;
    draw();
    if (fixed && value.length === length) submit();
  };
  container.querySelector('.keypad').addEventListener('click', (e) => {
    const b = e.target.closest('[data-key]');
    if (b) press(b.dataset.key);
  });
  ok?.addEventListener('click', submit);
  container.onkeydown = (e) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
    else if (e.key === 'Enter' && !fixed && value.length >= minLength) submit();
  };
  draw();
  return { setSub: (t) => { subEl.textContent = t; subEl.classList.remove('err'); } };
}

// ───────── 잠금 화면 ─────────

const root = () => document.getElementById('lock');
let unlocking = null;

export function isLocked() {
  return document.documentElement.classList.contains('locked');
}

// 잠그고, 풀릴 때까지 기다린다
export function lockNow() {
  if (unlocking) return unlocking;
  document.documentElement.classList.add('locked');
  unlocking = (async () => {
    const cfg = await lockConfig();
    if (!cfg.pin) { finish(); return; }
    const el = root();
    el.hidden = false;
    const hasBio = !!cfg.cred && await biometricAvailable();
    await new Promise((resolve) => {
      const tryBio = async () => {
        try {
          if (await verifyBiometric()) { await setSetting('lockFails', null); resolve(); }
        } catch { /* 취소하면 PIN으로 */ }
      };
      pinPad(el, {
        title: '내 재정',
        sub: hasBio ? 'Face ID·지문 또는 PIN으로 열기' : 'PIN을 입력하세요',
        length: cfg.pin.len,
        withBio: hasBio,
        onBio: tryBio,
        footer: '<button class="lock-link" id="lockForgot">PIN을 잊었나요?</button>',
        onSubmit: async (pin, fail) => {
          const f = await failState();
          if (f.until > Date.now()) {
            fail(`${Math.ceil((f.until - Date.now()) / 1000)}초 뒤에 다시 시도하세요`);
            return false;
          }
          if (await verifyPin(pin)) { await setSetting('lockFails', null); resolve(); return true; }
          const nf = await recordFail();
          fail(nf.until > Date.now()
            ? `${nf.count}번 틀렸습니다. ${Math.ceil((nf.until - Date.now()) / 1000)}초 뒤에 다시 시도하세요`
            : `PIN이 맞지 않습니다 (${nf.count}/5)`);
          return false;
        },
      });
      el.querySelector('#lockForgot').addEventListener('click', () => forgotFlow(el));
      el.tabIndex = -1;
      el.focus();
      // 지원되면 바로 Face ID를 띄워 본다 (사용자 탭이 필요하면 조용히 실패 → 버튼으로)
      if (hasBio) tryBio();
    });
    finish();
  })();
  return unlocking;

  function finish() {
    const el = root();
    el.hidden = true;
    el.innerHTML = '';
    document.documentElement.classList.remove('locked', 'booting');
    unlocking = null;
  }
}

// PIN을 잊으면 데이터를 지우고 처음부터 — 복구 방법이 없다는 걸 분명히 알린다
function forgotFlow(el) {
  const box = document.createElement('div');
  box.className = 'lock-forgot';
  box.innerHTML = `
    <p><b>PIN은 되찾을 수 없습니다.</b><br>잠금을 풀려면 이 기기의 모든 기록(예산·저축·투자)을 지우고 처음부터 시작해야 합니다.
    백업 파일이 있다면 초기화 뒤 설정 → JSON 가져오기로 되살릴 수 있습니다.</p>
    <input id="forgotConfirm" placeholder="계속하려면 '초기화'라고 입력" autocomplete="off">
    <div class="row"><button class="btn" id="forgotCancel">취소</button><button class="btn danger" id="forgotGo" disabled>모두 지우기</button></div>`;
  el.appendChild(box);
  const input = box.querySelector('#forgotConfirm');
  input.addEventListener('input', () => { box.querySelector('#forgotGo').disabled = input.value.trim() !== '초기화'; });
  box.querySelector('#forgotCancel').addEventListener('click', () => box.remove());
  box.querySelector('#forgotGo').addEventListener('click', async () => {
    db.close();
    await db.delete();
    location.reload();
  });
  input.focus();
}

// ───────── 설정 화면 ─────────

const AFTER_OPTIONS = [
  [0, '다른 앱에 갔다 오면 바로 잠금'],
  [60, '1분 넘게 다른 앱에 있으면 잠금'],
  [300, '5분 넘게 다른 앱에 있으면 잠금'],
  [-1, '앱을 새로 열 때만 잠금'],
];

export async function renderLockSettings(box, { toast, confirm }) {
  const cfg = await lockConfig();
  const bioOk = await biometricAvailable();
  box.innerHTML = cfg.pin ? `
    <div class="lock-status on">잠금 켜짐 · PIN ${cfg.pin.len}자리${cfg.cred ? ' · Face ID·지문' : ''}</div>
    <div class="row">
      <button class="btn ghost" id="lkChange">PIN 바꾸기</button>
      ${bioOk ? (cfg.cred ? '<button class="btn ghost" id="lkBioOff">Face ID·지문 해제</button>' : '<button class="btn ghost" id="lkBioOn">Face ID·지문 등록</button>') : ''}
      <button class="btn ghost danger-text" id="lkOff">잠금 끄기</button>
    </div>
    <label class="field"><span>자동 잠금</span><select id="lkAfter">${AFTER_OPTIONS.map(([v, t]) => `<option value="${v}" ${v === cfg.after ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    ${bioOk ? '' : '<p class="muted small">이 기기·브라우저에서는 Face ID·지문을 쓸 수 없어 PIN만 사용합니다.</p>'}`
    : `
    <div class="lock-status">잠금 꺼짐 — 누구나 이 기기에서 앱을 열면 내용을 볼 수 있습니다.</div>
    <button class="btn ghost" id="lkOn">PIN 잠금 켜기</button>`;

  const q = (id) => box.querySelector(id);
  q('#lkOn')?.addEventListener('click', () => pinSetup({ toast, then: async () => {
    if (await biometricAvailable()) {
      if ((await confirm('Face ID·지문으로도 열 수 있게 할까요?')) === 'yes') {
        try { await registerBiometric(); toast('Face ID·지문을 등록했습니다'); } catch { toast('Face ID·지문 등록을 취소했습니다'); }
      }
    }
    renderLockSettings(box, { toast, confirm });
  } }));
  q('#lkChange')?.addEventListener('click', () => pinSetup({ toast, needOld: true, then: () => renderLockSettings(box, { toast, confirm }) }));
  q('#lkBioOn')?.addEventListener('click', async () => {
    try { await registerBiometric(); toast('Face ID·지문을 등록했습니다'); } catch { toast('Face ID·지문 등록을 취소했습니다'); }
    renderLockSettings(box, { toast, confirm });
  });
  q('#lkBioOff')?.addEventListener('click', async () => {
    await setSetting('lockCred', null);
    toast('Face ID·지문 잠금 해제를 껐습니다');
    renderLockSettings(box, { toast, confirm });
  });
  q('#lkOff')?.addEventListener('click', () => pinSetup({ toast, onlyVerify: true, then: async () => {
    await db.settings.bulkDelete(LOCK_KEYS);
    toast('잠금을 껐습니다');
    renderLockSettings(box, { toast, confirm });
  } }));
  q('#lkAfter')?.addEventListener('change', async (e) => {
    await setSetting('lockAfter', Number(e.target.value));
    toast('자동 잠금을 바꿨습니다');
  });
}

// PIN 설정·변경·확인 — 전체 화면 키패드
function pinSetup({ toast, needOld = false, onlyVerify = false, then }) {
  const el = root();
  el.hidden = false;
  el.classList.add('setup');
  const close = () => { el.hidden = true; el.classList.remove('setup'); el.innerHTML = ''; };
  const cancel = '<button class="lock-link" id="pinCancel">취소</button>';
  const bindCancel = () => el.querySelector('#pinCancel').addEventListener('click', close);

  const askNew = () => {
    pinPad(el, {
      title: '새 PIN', sub: '숫자 4~6자리', footer: cancel,
      onSubmit: async (first) => {
        pinPad(el, {
          title: 'PIN 확인', sub: '한 번 더 입력하세요', length: first.length, footer: cancel,
          onSubmit: async (second, fail) => {
            if (second !== first) { fail('처음 입력한 PIN과 다릅니다'); return false; }
            await setPin(first);
            close();
            toast(needOld ? 'PIN을 바꿨습니다' : 'PIN 잠금을 켰습니다');
            await then?.();
            return true;
          },
        });
        bindCancel();
        return true;
      },
    });
    bindCancel();
  };

  if (needOld || onlyVerify) {
    getSetting('lockPin').then((p) => {
      pinPad(el, {
        title: '지금 PIN', sub: '확인을 위해 입력하세요', length: p.len, footer: cancel,
        onSubmit: async (pin, fail) => {
          if (!(await verifyPin(pin))) { fail('PIN이 맞지 않습니다'); return false; }
          if (onlyVerify) { close(); await then?.(); return true; }
          askNew();
          return true;
        },
      });
      bindCancel();
    });
  } else {
    askNew();
  }
}
