import { md5 } from './md5.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/webhook') {
      return handleITN(request, env, ctx);
    }
    if (request.method === 'GET' && url.pathname === '/summary') {
      return handleSummary(request, env, ctx);
    }
    if (request.method === 'OPTIONS' && url.pathname === '/summary') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    return new Response('Not found', { status: 404 });
  },
};

// PHP urlencode() equivalent. See SPEC-VERIFICATION.md §2b — URLSearchParams.toString()
// leaves !*'() unencoded and uses %20 for space, both of which diverge from PHP.
export function phpUrlEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/%20/g, '+');
}

// Constant-time compare for two equal-length lowercase-hex strings.
function constantTimeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Parse raw form-urlencoded ITN body. Returns { fields, signature }.
// `fields` is the entries in insertion order, excluding the `signature` field
// and any fields appearing after it — matching PHP SDK Notification::dataToString.
export function parseItnBody(rawBody) {
  const params = new URLSearchParams(rawBody);
  const fields = [];
  let signature = null;
  for (const [k, v] of params) {
    if (k === 'signature') {
      signature = v;
      break;
    }
    fields.push([k, v]);
  }
  return { fields, signature };
}

// Build PHP-urlencoded canonical string. Appends passphrase if non-empty.
export function buildCanonicalString(fields, passphrase) {
  const body = fields.map(([k, v]) => `${k}=${phpUrlEncode(v)}`).join('&');
  if (!passphrase) return body;
  return `${body}&passphrase=${phpUrlEncode(passphrase)}`;
}

// Verify the signature on a parsed ITN. Returns true iff MD5(canonical+passphrase) matches.
export function verifyItnSignature(fields, signature, passphrase) {
  if (!signature || !passphrase) return false;
  const canonical = buildCanonicalString(fields, passphrase);
  const expected = md5(canonical);
  return constantTimeEqualHex(expected.toLowerCase(), String(signature).toLowerCase());
}

async function callPayfastValidate(canonicalNoPassphrase, testMode, env) {
  const override = env.PAYFAST_VALIDATE_BASE_URL;
  const base = override || (testMode ? 'https://sandbox.payfast.co.za' : 'https://www.payfast.co.za');
  try {
    const resp = await fetch(`${base}/eng/query/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: canonicalNoPassphrase,
    });
    if (!resp.ok) {
      console.log(`validate callback HTTP ${resp.status}`);
      return false;
    }
    const text = (await resp.text()).trim();
    return text === 'VALID';
  } catch (err) {
    console.log(`validate callback error: ${err && err.message ? err.message : err}`);
    return false;
  }
}

async function handleITN(request, env, ctx) {
  const sourceIp = request.headers.get('cf-connecting-ip') || '';
  const allowedIps = (env.PAYFAST_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowedIps.length === 0 || !allowedIps.includes(sourceIp)) {
    console.log(`ITN rejected: source IP ${JSON.stringify(sourceIp)} not in allowlist`);
    return new Response('Forbidden', { status: 403 });
  }

  const rawBody = await request.text();
  const { fields, signature } = parseItnBody(rawBody);

  if (!signature) {
    console.log('ITN rejected: missing signature');
    return new Response('Unauthorized', { status: 401 });
  }
  if (!env.PAYFAST_PASSPHRASE) {
    console.log('ITN rejected: PAYFAST_PASSPHRASE not configured');
    return new Response('Server misconfiguration', { status: 500 });
  }

  if (!verifyItnSignature(fields, signature, env.PAYFAST_PASSPHRASE)) {
    console.log(`ITN rejected: signature mismatch from ${sourceIp}`);
    return new Response('Unauthorized', { status: 401 });
  }

  const formMap = Object.fromEntries(fields);
  const testMode = formMap.test_mode === 'true';
  const canonicalNoPassphrase = buildCanonicalString(fields, '');
  const validateOk = await callPayfastValidate(canonicalNoPassphrase, testMode, env);
  if (!validateOk) {
    console.log(`ITN rejected: validation callback did not return VALID (pf_payment_id=${formMap.pf_payment_id || 'none'})`);
    return new Response('Unauthorized', { status: 401 });
  }

  const paymentStatus = formMap.payment_status;
  const pfPaymentId = formMap.pf_payment_id;
  const mode = testMode ? 'test' : 'live';

  if (!pfPaymentId) {
    console.log('ITN: missing pf_payment_id — acknowledging without write');
    return new Response('OK', { status: 200 });
  }

  if (paymentStatus !== 'COMPLETE') {
    console.log(`ITN: payment_status=${paymentStatus} pf_payment_id=${pfPaymentId} mode=${mode} — acknowledged, no KV write`);
    return new Response('OK', { status: 200 });
  }

  const kvKey = `payment:${pfPaymentId}`;
  const existing = await env.PAYMENTS.get(kvKey);
  if (existing) {
    console.log(`ITN: duplicate pf_payment_id=${pfPaymentId} — idempotent no-op`);
    return new Response('OK', { status: 200 });
  }

  const entry = {
    amount_gross: parseFloat(formMap.amount_gross || '0'),
    amount_fee:   parseFloat(formMap.amount_fee   || '0'),
    amount_net:   parseFloat(formMap.amount_net   || '0'),
    item_name:    formMap.item_name || '',
    name_first:   formMap.name_first || '',
    name_last:    formMap.name_last || '',
    mode,
    timestamp:    new Date().toISOString(),
  };
  await env.PAYMENTS.put(kvKey, JSON.stringify(entry));
  console.log(`ITN: stored ${kvKey} amount_gross=${entry.amount_gross} mode=${mode}`);

  return new Response('OK', { status: 200 });
}

async function handleSummary(request, env, ctx) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  const goalZar = parseFloat(env.GOAL_ZAR || '0');
  let paidCents = 0;
  let refundedCents = 0;

  for (const prefix of ['payment:', 'refund:']) {
    let cursor;
    do {
      const list = await env.PAYMENTS.list({ prefix, cursor });
      for (const { name } of list.keys) {
        const entry = await env.PAYMENTS.get(name, 'json');
        if (!entry || entry.mode !== 'live') continue;
        // /summary reports what actually reaches Nyeleti after PayFast's processing fee,
        // so we aggregate amount_net (gross minus fee) for both payments and refunds.
        const cents = Math.round(Number(entry.amount_net || 0) * 100);
        if (prefix === 'payment:') paidCents += cents;
        else refundedCents += cents;
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  }

  const totalZar = Math.max(0, (paidCents - refundedCents) / 100);
  const percent = goalZar > 0 ? Math.min(100, Math.round((totalZar / goalZar) * 100)) : 0;

  const body = JSON.stringify({ total_zar: totalZar, goal_zar: goalZar, percent });

  const response = new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders(env),
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30',
    },
  });

  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
