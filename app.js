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
const STRIP_H  = 56;   // must match --strip-h in style.css

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const formatRand = (n) =>
  'R' + Math.round(n).toLocaleString('en-ZA', { maximumFractionDigits: 0 });

// Track currently-displayed raised value so re-renders animate from previous
// instead of always counting from R0.
let currentRaisedN = 0;

function animateRaisedTo(targetN, duration = 600) {
  const els = $$('[data-raised]');
  if (!els.length) return;
  if (prefersReducedMotion()) {
    els.forEach((el) => { el.textContent = formatRand(targetN); });
    currentRaisedN = targetN;
    return;
  }
  const startN = currentRaisedN;
  if (startN === targetN) {
    els.forEach((el) => { el.textContent = formatRand(targetN); });
    return;
  }
  const start = performance.now();
  function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);          // cubic ease-out
    const value = startN + (targetN - startN) * eased;
    els.forEach((el) => { el.textContent = formatRand(value); });
    if (t < 1) requestAnimationFrame(tick);
    else currentRaisedN = targetN;
  }
  requestAnimationFrame(tick);
}

function renderProgress({ total_zar, goal_zar, percent }) {
  $$('[data-amounts]').forEach((el) => el.classList.remove('amounts--failed'));
  $$('[data-bar-fill]').forEach((el) => { el.style.width = percent + '%'; });
  $$('[data-bar]').forEach((el)      => { el.setAttribute('aria-valuenow', String(percent)); });
  $$('[data-goal]').forEach((el)     => { el.textContent = formatRand(goal_zar);  });
  animateRaisedTo(total_zar);
  if (percent >= 100) {
    document.body.classList.add('goal-reached');
    $$('[data-contribute]').forEach((btn) => { btn.textContent = 'Thank you'; });
  }
}

function renderFailureState() {
  $$('[data-amounts]').forEach((el) => el.classList.add('amounts--failed'));
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

// Hero-bar → sticky-strip transition. The signature motion.
function wireStripToggle() {
  const heroBar = $('[data-hero-bar]');
  const strip = $('.strip');
  if (!heroBar || !strip) return;
  if (!('IntersectionObserver' in window)) {
    strip.classList.add('strip--visible');
    return;
  }
  const io = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      strip.classList.remove('strip--visible');
    } else {
      strip.classList.add('strip--visible');
    }
  }, {
    rootMargin: `-${STRIP_H}px 0px 0px 0px`,
    threshold: 0,
  });
  io.observe(heroBar);
}

// Reveal observer: handles [data-reveal] (single element) and
// [data-reveal-stagger] (parent triggers staggered children).
function observeReveal() {
  const els = $$('[data-reveal], [data-reveal-stagger]');
  if (!els.length) return;
  if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
    els.forEach((el) => el.classList.add('in-view'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  els.forEach((el) => io.observe(el));
}

// Section-rule observer: draws in the hairline above each section
// (the ::before pseudo on [data-reveal-rule] elements).
function observeSectionRules() {
  const els = $$('[data-reveal-rule]');
  if (!els.length) return;
  if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
    els.forEach((el) => el.classList.add('section--seen'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('section--seen');
        io.unobserve(entry.target);
      }
    }
  }, { threshold: 0, rootMargin: '0px 0px -8% 0px' });
  els.forEach((el) => io.observe(el));
}

// Hero arrival sequence — adds .is-loaded to <body>, CSS handles the rest.
// requestAnimationFrame defer ensures the initial opacity:0 state has painted
// before the transition kicks off, so the sequence is reliable.
function triggerLoadSequence() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.add('is-loaded');
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  $$('[data-goal]').forEach((el) => { el.textContent = formatRand(GOAL_ZAR); });
  wireDialog();
  handleReturnQuery();
  wireStripToggle();
  observeReveal();
  observeSectionRules();
  triggerLoadSequence();
  fetchSummary();
});
