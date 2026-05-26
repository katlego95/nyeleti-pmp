// Configuration. The four constants below get filled in twice:
//   1. After `wrangler deploy`: replace YOUR_WORKER_SUBDOMAIN with the printed URL,
//      and replace __SANDBOX_MERCHANT_ID__ / __SANDBOX_MERCHANT_KEY__ with the values
//      from PayFast → Developer Settings → Sandbox.
//   2. After PayFast verification clears: switch PAYFAST_PROCESS_URL to the live URL
//      and replace merchant credentials with the live ones (see README Part 5).
// See deploy.md for the exact command sequence.
const WORKER_URL           = 'https://YOUR_WORKER_SUBDOMAIN.workers.dev';
const PAYFAST_PROCESS_URL  = 'https://sandbox.payfast.co.za/eng/process';
const PAYFAST_MERCHANT_ID  = '__SANDBOX_MERCHANT_ID__';
const PAYFAST_MERCHANT_KEY = '__SANDBOX_MERCHANT_KEY__';

const GOAL_ZAR = 10000;

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const formatRand = (n) =>
  'R' + Math.round(n).toLocaleString('en-ZA', { maximumFractionDigits: 0 });

function renderProgress({ total_zar, goal_zar, percent }) {
  $$('[data-bar-fill]').forEach((el) => { el.style.width = percent + '%'; });
  $$('[data-bar]').forEach((el)      => { el.setAttribute('aria-valuenow', String(percent)); });
  $$('[data-raised]').forEach((el)   => { el.textContent = formatRand(total_zar); });
  $$('[data-goal]').forEach((el)     => { el.textContent = formatRand(goal_zar);  });
  if (percent >= 100) {
    document.body.classList.add('goal-reached');
    $$('[data-contribute]').forEach((btn) => { btn.textContent = 'Thank you'; });
  }
}

function renderFailureState() {
  $$('[data-amounts]').forEach((el) => {
    el.textContent = 'Updating shortly';
  });
}

async function fetchSummary() {
  try {
    const resp = await fetch(`${WORKER_URL}/summary`, { mode: 'cors' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    renderProgress(data);
  } catch (err) {
    console.warn('summary fetch failed:', err);
    renderFailureState();
  }
}

function showToast(message, soft = false) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = message;
  t.hidden = false;
  t.classList.toggle('toast--soft', soft);
}

function readChosenAmount() {
  const raw = $('#custom-amount').value.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function selectChip(value) {
  $$('.chip').forEach((c) => {
    c.setAttribute('aria-pressed', c.dataset.amount === String(value) ? 'true' : 'false');
  });
}

function clearChipSelection() {
  $$('.chip[aria-pressed="true"]').forEach((c) => c.setAttribute('aria-pressed', 'false'));
}

function submitPayfast(amount) {
  const form = $('#payfast-form');
  form.action = PAYFAST_PROCESS_URL;
  form.querySelector('[name="merchant_id"]').value  = PAYFAST_MERCHANT_ID;
  form.querySelector('[name="merchant_key"]').value = PAYFAST_MERCHANT_KEY;
  form.querySelector('[name="return_url"]').value   = location.origin + location.pathname + '?paid=1';
  form.querySelector('[name="cancel_url"]').value   = location.origin + location.pathname + '?cancelled=1';
  form.querySelector('[name="notify_url"]').value   = WORKER_URL + '/webhook';
  $('#payfast-amount').value = amount.toFixed(2);
  form.submit();
}

function wireDialog() {
  const dialog = $('#amount-dialog');
  const customInput = $('#custom-amount');
  const confirmBtn = $('#amount-confirm');

  $$('[data-contribute]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
      setTimeout(() => customInput.focus(), 50);
    });
  });

  $$('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const v = Number(chip.dataset.amount);
      customInput.value = String(v);
      selectChip(v);
    });
  });

  customInput.addEventListener('input', clearChipSelection);

  $('#amount-cancel').addEventListener('click', () => dialog.close());

  $('#amount-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = readChosenAmount();
    if (!amount) {
      customInput.focus();
      customInput.setAttribute('aria-invalid', 'true');
      return;
    }
    customInput.removeAttribute('aria-invalid');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Redirecting…';
    submitPayfast(amount);
  });
}

function handleReturnQuery() {
  const params = new URLSearchParams(location.search);
  if (params.get('paid') === '1') {
    showToast('Thank you. Your contribution is on its way.');
    setTimeout(fetchSummary, 30000);     // single deferred re-fetch, not polling
  } else if (params.get('cancelled') === '1') {
    showToast('No worries — tap Contribute whenever you’re ready.', true);
  }
}

function observeSectionFadeIn() {
  const sections = $$('[data-section]');
  if (!sections.length) return;
  if (!('IntersectionObserver' in window) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sections.forEach((el) => el.classList.add('in-view'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });
  sections.forEach((el) => io.observe(el));
}

document.addEventListener('DOMContentLoaded', () => {
  // Seed the goal text so the strip shows "R0 raised of R10,000" before /summary returns.
  $$('[data-goal]').forEach((el) => { el.textContent = formatRand(GOAL_ZAR); });
  wireDialog();
  handleReturnQuery();
  observeSectionFadeIn();
  fetchSummary();
});
