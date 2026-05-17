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

const GOAL_ZAR = 9700;

const $ = (sel) => document.querySelector(sel);
const formatRand = (n) =>
  'R' + Math.round(n).toLocaleString('en-ZA', { maximumFractionDigits: 0 });

function renderProgress({ total_zar, goal_zar, percent }) {
  $('#bar-fill').style.width = percent + '%';
  $('#bar').setAttribute('aria-valuenow', String(percent));
  $('#amounts').textContent = `${formatRand(total_zar)} of ${formatRand(goal_zar)}`;
  if (percent >= 100) {
    document.body.classList.add('goal-reached');
    $('#contribute-btn').textContent = 'We did it 🎉';
  }
}

function renderFailureState() {
  $('#amounts').textContent = 'Updating shortly…';
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
  document.querySelectorAll('.chip').forEach((c) => {
    c.setAttribute('aria-pressed', c.dataset.amount === String(value) ? 'true' : 'false');
  });
}

function clearChipSelection() {
  document.querySelectorAll('.chip[aria-pressed="true"]').forEach((c) =>
    c.setAttribute('aria-pressed', 'false'),
  );
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

  $('#contribute-btn').addEventListener('click', () => {
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    setTimeout(() => customInput.focus(), 50);
  });

  document.querySelectorAll('.chip').forEach((chip) => {
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
    showToast('Thank you! Your contribution is on its way.');
    // PayFast ITN + KV propagation typically lands within ~30s; re-fetch once.
    setTimeout(fetchSummary, 30000);
  } else if (params.get('cancelled') === '1') {
    showToast('No worries — tap Contribute whenever you’re ready.', true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Pre-fill goal label immediately so the page doesn't sit on "Loading…" if /summary is slow.
  $('#amounts').textContent = `Loading… of ${formatRand(GOAL_ZAR)}`;
  wireDialog();
  handleReturnQuery();
  fetchSummary();
});
