# For Nyeleti — Private Crowdfunding Site

A single-page, mobile-first private crowdfunding site to help fund Nyeleti's PMP certification exam (goal: **R9,700 ZAR**). Contributors tap a button, pay by card or Instant EFT on PayFast's hosted checkout, and the on-site progress bar updates automatically when PayFast fires an ITN webhook to a Cloudflare Worker.

> **Status (May 2026, post-pivot):** The architecture described from Part 2 onwards is the *original* PayFast + Cloudflare Worker design. After PayFast formally declined onboarding at KYC review (sole-trader donation collection isn't a permitted merchant category under their sponsor-bank agreement), the project pivoted to **BackaBuddy** as merchant-of-record. The Worker code, KV setup, MD5 verifier, unit tests, and all PayFast integration code remain in the repo as reference but are **not live in production**. The live site now links Contribute buttons to a BackaBuddy donation URL; the on-site progress bar is updated manually from two constants in `app.js`. See **Part 1.5** below for the full story.

This README is the complete build specification. It also documents the *decision process* — what we considered, what we tried, what we rejected, and why. Read this section first if you ever build something similar; the technical spec below is only useful once the architectural decisions make sense.

---

# Part 1 — Lessons from a payment gateway pivot

When building a small project that takes money from real people, the payment rail you pick determines everything else: the user experience, the verification timeline, the security model, and how much code you write. We changed our minds twice. Here's why, so the next person (which might be you in 6 months) doesn't have to relearn it.

## Original plan: Luno wallet + balance polling

The first idea was clever-on-paper and wrong-in-practice. The Luno crypto exchange offers a ZAR wallet with a free read-only API. The architecture would have been:

- Contributors do an EFT from their bank into the Luno ZAR wallet (Luno publishes deposit instructions and a unique reference).
- A Cloudflare Worker holding a Luno API key with `Perm_R_Balances` permission polls the wallet balance.
- The frontend reads the balance from the Worker and renders a progress bar.
- Contributors fill a Google Form separately to leave their name on a supporter wall.

**Why this looked good:** zero fees, an existing wallet, a clean polling API, and full control.

**Why it broke down once we thought about real contributors:**

1. **South African banks impose a 24-hour fraud hold on first transfers to a new beneficiary.** A 60-year-old aunt adding Luno's partner bank as a new payee and then trying to send R200 immediately will be blocked. Many will give up. This is the single biggest UX killer for any "EFT-to-an-intermediary" flow.
2. **Luno requires a specific deposit reference.** Get it wrong (extra space, wrong case, abbreviation) and the money lands in Luno's suspense account; you spend a week on support tickets to reclaim it.
3. **Two-step flow loses people.** Even contributors who navigate the EFT successfully then need to come back to your site and fill in a Google Form to appear on the wall. Most won't.
4. **Luno transaction descriptions don't surface clean contributor names.** Reconciliation would have been manual ("R200 came in around 14:32, the form was submitted by John at 14:33, probably him").
5. **Designed for the wrong audience.** Luno's UX is great for crypto-comfortable individuals moving money into their own account. It's hostile to casual one-off contributions from friends and family.

**The takeaway:** *if your contributors are not your sophistication level, optimise the rail for them, not for you.* "Free + I already have the wallet" looked compelling until we mapped the actual contributor journey step by step. Mapping the journey from the contributor's perspective — including the parts that happen inside their own bank app — is the cheapest possible product research.

## Second plan: Yoco hosted payment page

Yoco is South Africa's most consumer-recognised online payment processor (their card readers are everywhere). They offer hosted **Payment Pages** — a URL like `pay.yoco.com/<your-slug>` where contributors land, enter their card details, do 3D Secure, and pay. Receipts are emailed automatically. Webhooks (`payment.succeeded`) fire to your endpoint with HMAC SHA-256 signatures using the [Standard Webhooks](https://www.standardwebhooks.com/) spec.

**Why this looked good:**

1. **The contributor experience is excellent.** Tap a link, enter card details, OTP, done. No beneficiary setup, no fraud hold, no Google Form. A 60-year-old who's never heard of Yoco can pay in under 90 seconds.
2. **Clean developer experience.** Modern webhook signing (HMAC SHA-256, not MD5), JSON payloads, replay protection via `webhook-timestamp`, idempotent event IDs (`evt_…`). All best-practice.
3. **24-hour verification timeline.** Sign up today, transact tomorrow — fits a rapid-ship project.
4. **Fees are reasonable.** ~2.95% on local cards, paid out in 1–2 business days to your personal bank account (Sole Trader account uses your SA ID, no business registration needed).

**Why it broke down:** *on the exact day we tried to set it up, Yoco had paused all new online payment activations.* The waitlist message said "as soon as we're ready to activate your profile we will be in touch" — no timeline. This isn't Yoco's fault, it's just timing. But it killed the rapid-ship plan.

**The takeaway:** *external dependencies have failure modes you can't predict.* Always know your second-best option before you commit to your best one. Don't sink hours into onboarding flows for one provider without at least knowing the URL of the next provider down your list. We lost ~30 minutes finding out Yoco was paused; if we hadn't known about PayFast, we'd have lost a day.

## Third plan (current): PayFast

[PayFast](https://www.payfast.co.za) is the oldest established South African payment gateway (founded 2007, now part of the Network Group). Less developer-friendly than Yoco in 2026, but available right now, with a feature set that genuinely fits our use case.

**Why this won:**

1. **Self-service signup works today.** Sole Trader account uses your SA ID and personal bank account — no business registration required.
2. **Supports both cards AND Instant EFT** (via the Ozow rail). Instant EFT is *especially* friendly for older contributors: they log into their bank app the way they normally would, approve the payment, and money moves in real time. No beneficiary fraud hold, no card details to type.
3. **ITN webhooks with three layers of security:** an MD5 signature over the form fields + passphrase, a server-side validation callback to PayFast's API, and a published list of source IPs to allowlist (21 IPs, all in `3.163.x.237`). Belt and braces.
4. **Account type explicitly supports our use case:** during signup PayFast asked "How will you use PayFast?" with options including personal use cases. The Sole Trader account does not require a registered business or NPO number (we briefly went down the wrong "Non-Profit" branch — that requires actual NPO/PBO registration with SARS, which takes weeks).
5. **Fee competitive:** 2.4–3.5% depending on payment method.

**Trade-offs we accepted:**

1. **Older signature scheme.** MD5 over URL-encoded form fields plus a passphrase — works fine, just less elegant than HMAC SHA-256.
2. **Form-urlencoded payloads, not JSON.** Slightly more parsing work in the Worker.
3. **No clean static-link URL.** Contributors pay via a form POST from your site to PayFast — meaning the frontend builds an HTML form rather than embedding a pre-baked link. Tiny extra work, no real downside.
4. **1–3 business day verification gate.** Slower than Yoco's 24h would have been. Acceptable for our timeline.

## Providers we evaluated but didn't pursue

| Provider | Why considered | Why not |
|---|---|---|
| **Paystack** | Stripe-owned, HMAC SHA-512 webhooks, the cleanest developer experience of the lot. | Held as Plan C if PayFast verification stalls. Verification timeline in SA was unclear vs PayFast which we knew worked. |
| **Manual bank EFT to a personal account** | Zero infra, ships today. | Worst contributor UX of any option — same beneficiary fraud-hold problem as the Luno plan. |
| **PayShap** | Instant payments to a phone number on all major SA bank apps — genuinely the easiest experience for SA users. | No API or webhooks. Would need fully manual progress-bar updates. |
| **SnapScan** | Popular for QR code payments. | More suited to in-person/QR than to a static contribute-from-anywhere link. |
| **Stripe** | The gold standard internationally. | Not available for SA merchants receiving payments in ZAR. |
| **PayPal** | Globally recognised. | SA payouts require linking an FNB account; ZAR support is limited; FX controls add complexity. |

## Meta-lessons (applicable beyond this project)

1. **Map the journey from the actual user's perspective.** Don't trust your own sense of "this is easy" — you're not your user. A 60-year-old contributor is the test, not a backend engineer who finds Luno's API charming.
2. **Verification timelines compound.** Every payment provider gates real money behind FICA. Start signup *first*, code *second*. While you wait on verification, you can build and test against sandbox credentials.
3. **Know your alternatives before you commit.** Have a Plan B in your head before you spend an hour on Plan A.
4. **Architecture is mostly portable across providers.** Cloudflare Worker + KV + GitHub Pages + a webhook receiver works for any modern payment provider. The provider-specific bits — signature algorithm, payload shape, payment URL pattern — are localised swap-outs, not foundational. ~85% of code survives a payment provider pivot if you keep the security boundary clean.
5. **Set the passphrase / signing secret to a strong random value, not the example the docs show you.** PayFast's UI suggests "iced tea is great for summer" → `/cedTisgr84Summ3R`. That advice is aimed at people typing into Shopify admin panels. For webhook signing where both sides are servers, use a 32+ character random string from a password manager.
6. **Defense in depth on webhooks: signature + IP + validation callback.** Any one of these can be circumvented in some attack model. All three together is robust.

---

# Part 1.5 — The PayFast decline and pivot to BackaBuddy

Part 1 ended with PayFast as the chosen rail and the Worker built against their ITN spec. After PayFast completed KYC review, that plan was formally declined. This section captures what happened, the regulatory stack underneath the decision, and the pivot to a merchant-of-record model. The lessons here are more important than the rest of Part 1 — they describe a structural limit in SA fintech that no amount of "shop around for a different gateway" solves.

## PayFast decline (May 2026)

After completing KYC review, PayFast formally declined onboarding. Their stated reason: as a Third-Party Payment Provider operating under a sponsor bank, their card-scheme and regulatory parameters don't accommodate sole traders collecting personal donations. Donation facilitation through them is only available to entities officially registered as NPO, NPC, or PBO.

Verbatim from their email: *"We do facilitate donations; however, this is only available to organizations that are officially registered as an NPO, NPC, or PBO."*

## The underlying legal stack (the real lesson)

This isn't one statute — it's a layered constraint:

- **National Payment System Act 78 of 1998.** Only registered banks (or SARB-designated entities) may clear/settle payments.
- **PASA/SARB directives + Visa/Mastercard scheme rules.** A regulated acquirer must onboard a merchant under an approved merchant category. Individual donation collection doesn't map to one.
- **FIC Act 38 of 2001 (FICA).** Third-party fund collection into a personal account is an AML red flag.
- **PayFast's contract with its sponsor bank.** PayFast operates under a sponsor bank; their scheme agreement forbids onboarding sole traders for donation collection. It's a contract/compliance limit downstream of the law stack, not one named law.

## Why no direct card gateway works for this case

The same constraint applies to Yoco, Peach, Stripe (Paystack), Stitch direct, etc. Direct card acceptance for an individual collecting third-party donations into a personal account is structurally blocked in SA without NPO/NPC/PBO registration. The Yoco pause in Part 1 was operational noise; even if Yoco had been open for new activations, they'd have hit the same compliance wall once KYC review completed.

## The pivot to BackaBuddy

Moved to **BackaBuddy** as merchant-of-record. Supports "Independent campaigns" for individuals — not just registered nonprofits — and explicitly serves the education category. BackaBuddy holds the regulated payment-collection relationship.

## Site role after the pivot

The GitHub Pages site is the editorial story page — the front door. BackaBuddy is the payment engine. BackaBuddy is operated by Blue Gecko (Pty) Ltd, has been running for 11+ years, and has facilitated over R800M in donations across the platform — a trusted, established South African crowdfunding operator. Contribute buttons across the site open the BackaBuddy donation URL in a new tab. The link to the BackaBuddy campaign page itself (for donors who want to see live progress, total raised, donor count, etc.) lives in one place only — below the hero progress bar — and nowhere else. Everywhere else on the site goes straight to the donation page. The progress bar on this site is manually updated by editing two constants in `app.js` (`RAISED_ZAR` and `GOAL_ZAR`); the canonical live number lives on BackaBuddy.

## What changed in the codebase

The Cloudflare Worker (`worker/`), Workers KV, PayFast ITN webhook handler, MD5 signature verification, IP allowlist, and unit tests are all retained in the repo but no longer wired into the live site. They're preserved as reference for the original PayFast architecture and may be useful for future fundraisers that DO qualify (registered entities), or for the broader payments business idea this project surfaced.

## Broader insight (briefly)

The PayFast decline surfaced a real gap in SA fintech: individual/informal collectors of card payments are structurally underserved by every major gateway because of the card-scheme + sponsor-bank constraint. The market is moving toward A2A (account-to-account) rails — PayShap's Request-to-Pay feature in particular routes around card-scheme limitations and is bank-backed. A future Blackware product opportunity sits in that space — out of scope for this fundraiser, captured here for future reference.

---

# Part 2 — Architecture *(original architecture — retained in repo, not live in production after the BackaBuddy pivot)*

```
┌───────────────────────────────────────────────────────────────────────┐
│                       Contributor's phone                              │
└───────────┬─────────────────────────────────────────────┬─────────────┘
            │ 1. GET                                      │ 6. GET /summary
            ▼                                             │    (on page load)
┌────────────────────────────────────┐                    │
│  GitHub Pages (static site)         │                    │
│  index.html / app.js / style.css    │                    │
│  Contribute button → HTML form POST │                    │
└───────────┬────────────────────────┘                    │
            │ 2. Form POST to PayFast                     │
            ▼                                             │
┌────────────────────────────────────┐                    │
│  PayFast hosted checkout            │                    │
│  payfast.co.za/eng/process          │                    │
│  - amount, card or Instant EFT      │                    │
│  - 3D Secure OTP                    │                    │
└───────────┬────────────────────────┘                    │
            │ 3. ITN webhook (form-urlencoded POST)       │
            ▼                                             │
┌──────────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                                    │
│  POST /webhook                                                        │
│    1. Verify source IP is in PayFast's allowlist                      │
│    2. Verify MD5 signature against passphrase                         │
│    3. Server-side validation callback to payfast.co.za/eng/query/    │
│       validate (PayFast confirms the payload is genuine)             │
│    4. Check payment_status === "COMPLETE"                             │
│    5. Idempotency: payment:{pf_payment_id} in KV                      │
│    6. Write payment:{pf_payment_id} = { amount, timestamp }           │
│  GET /summary                                                         │
│    - list payment:* keys, sum amount_gross                            │
│    - return { total_zar, goal_zar, percent }                          │
│    - 30s edge cache                                                   │
│  Storage: Workers KV                                                  │
│  Secret: PAYFAST_PASSPHRASE                                           │
└──────────────────────────────────────────────────────────────────────┘
```

**Three-layer ITN verification (this is the important bit):**

1. **IP allowlist check.** PayFast publishes 21 source IPs (all in the `3.163.x.237` range as of July 2025, listed below). Reject anything from another IP.
2. **MD5 signature check.** Re-compute the signature using your passphrase and compare. Reject mismatches.
3. **Server-side validation callback.** POST the received form data back to `https://www.payfast.co.za/eng/query/validate` and expect the literal response body `VALID`. This is PayFast's "did you actually send this?" round-trip. Reject anything that doesn't return `VALID`.

All three must pass for the Worker to write to KV.

---

# Part 3 — Stack *(original architecture — retained in repo, not live in production after the BackaBuddy pivot)*

| Layer | Choice |
|---|---|
| Frontend | Plain HTML/CSS/JS. No build step. Mobile-first. |
| Hosting | GitHub Pages (free). |
| Payment | PayFast Sole Trader account, hosted checkout via form POST to `payfast.co.za/eng/process`. |
| Webhook receiver / data store / read API | Cloudflare Worker + Workers KV (free tier). |
| Source of truth | Sum of `payment:*` keys in Workers KV, one per validated PayFast ITN with `payment_status === "COMPLETE"`. |

---

# Part 4 — Repo Structure

```
for-nyeleti/
├── index.html
├── style.css
├── app.js
├── worker/
│   ├── index.js              # Cloudflare Worker source
│   ├── wrangler.toml         # Cloudflare config — NO SECRETS
│   ├── package.json          # for Wrangler
│   └── .gitignore            # ignores node_modules, .wrangler/, .dev.vars
├── .gitignore
└── README.md                 # this file
```

Root `.gitignore`:
```
.DS_Store
worker/node_modules/
worker/.wrangler/
worker/.dev.vars
```

---

# Part 5 — Prerequisites

- ✅ GitHub account.
- ✅ Cloudflare account (free tier).
- ✅ PayFast Sole Trader account (signup is done; verification 1–3 business days; passphrase set).
- Node.js 18+ locally for the Wrangler CLI.

PayFast credentials already collected:
- **Merchant ID:** `12740752`
- **Merchant Key:** `1hbgaznnfphw8` *(semi-public; appears in payment forms)*
- **Passphrase:** stored in your password manager *(never in repo, never in chat)*
- **Sandbox credentials:** to be retrieved from Developer Settings → Sandbox section *(used for testing pre-verification)*

---

# Part 6 — Setup, Step by Step

## 1. PayFast (DONE if reading this — for reference)

Already completed:
- Signed up as Sole Trader (not Non-Profit — Non-Profit requires registered NPO/PBO numbers).
- Industry: Charitable & Social Services. Annual turnover: R10,000.
- Description: personal fundraising for partner's PMP exam.
- "How will you use PayFast?" → "To accept payment on my eCommerce website" (loosest fit).
- Email verified, proof of address submitted (City of Johannesburg statement).
- **Passphrase set** in Settings → Developer Settings (32+ char random, in password manager).
- **ITN Status: OFF** for now — flip ON after Worker is deployed.
- **Notify URL: empty** for now — fill after Worker is deployed.
- **"Enable require signature": OFF** — keeps the frontend form simple; ITN webhook signature is the real security layer.

Outstanding: waiting on FICA verification (1–3 business days).

## 2. Cloudflare Worker

```bash
npm install -g wrangler
wrangler login
mkdir -p worker && cd worker
npm init -y
```

`worker/wrangler.toml`:

```toml
name = "for-nyeleti-api"
main = "index.js"
compatibility_date = "2024-11-01"

[vars]
GOAL_ZAR = "9700"
ALLOWED_ORIGIN = "https://YOUR_GITHUB_USERNAME.github.io"
PAYFAST_MERCHANT_ID = "12740752"
# Source IP allowlist for PayFast ITN — verify against
# https://support.payfast.help/portal/en/kb/articles/whitelisting-ip-addresses-2-7-2025
# before deploy. Comma-separated, no spaces.
PAYFAST_ALLOWED_IPS = "3.163.232.237,3.163.233.237,3.163.234.237,3.163.235.237,3.163.236.237,3.163.237.237,3.163.238.237,3.163.239.237,3.163.240.237,3.163.241.237,3.163.242.237,3.163.243.237,3.163.244.237,3.163.245.237,3.163.246.237,3.163.247.237,3.163.248.237,3.163.249.237,3.163.250.237,3.163.251.237,3.163.252.237"

[[kv_namespaces]]
binding = "PAYMENTS"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

Create the KV namespace:

```bash
wrangler kv:namespace create PAYMENTS
# Copy the printed id into wrangler.toml above.
```

`worker/index.js` — implement against this contract:

```javascript
// Endpoints:
//   POST /webhook   — PayFast ITN receiver (form-urlencoded)
//   GET  /summary   — { total_zar, goal_zar, percent }
//   OPTIONS /summary — CORS preflight
//
// Security on /webhook (three layers, all must pass):
//   1. Source IP must be in env.PAYFAST_ALLOWED_IPS
//      Use request.headers.get("cf-connecting-ip") on Cloudflare.
//   2. MD5 signature over form fields + passphrase must match.
//   3. Server-side validation callback to PayFast must return "VALID".
//
// Security on /summary:
//   Access-Control-Allow-Origin: env.ALLOWED_ORIGIN (exact, not *)
//
// Idempotency:
//   Each ITN includes pf_payment_id (PayFast's unique ID per transaction).
//   Worker writes payment:{pf_payment_id} in KV. Re-deliveries hit the same
//   key. PayFast retries non-2xx for up to 24h; idempotency makes that safe.
//
// Summary computation:
//   List KV keys with prefix `payment:` → sum amount_gross (in rands, decimal).
//   List KV keys with prefix `refund:` → subtract amount_gross.
//   Filter only entries where mode === "live" (skip test mode in production).
//   Compute percent = min(100, round(total / goal * 100)).
//   Cache via Cache API for 30s.

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
  }
};

// --- Implementation outline ---
//
// async function handleITN(request, env, ctx):
//   1. Read raw body as text (form-urlencoded).
//   2. Source IP check:
//        const sourceIp = request.headers.get('cf-connecting-ip');
//        const allowed = env.PAYFAST_ALLOWED_IPS.split(',');
//        if (!allowed.includes(sourceIp)) return 403;
//   3. Parse form fields into a Map preserving order
//      (URLSearchParams iterates in insertion order — use that).
//      Extract `signature` field separately; remove from canonical fields.
//   4. Compute expected signature:
//        - Build query string from remaining fields in the order received,
//          values URL-encoded with PHP-style (spaces as +, not %20).
//        - Append "&passphrase=" + URL_encoded passphrase from env.
//        - MD5 the result. Lowercase hex.
//        - Compare to the received `signature` (case-insensitive).
//        Workers don't have MD5 in Web Crypto — import a small MD5 implementation
//        like js-md5 (~5KB) or write one inline. MD5 is fast and stateless;
//        any correct implementation works.
//   5. Validation callback:
//        Re-POST the original body to https://www.payfast.co.za/eng/query/validate
//        as Content-Type: application/x-www-form-urlencoded.
//        Expect response body to equal "VALID" (case-sensitive, no trailing chars).
//        Use the sandbox URL https://sandbox.payfast.co.za/eng/query/validate
//        when payload's `test_mode === "true"` or `payment_status` indicates test.
//   6. Check payment_status:
//        Only `COMPLETE` should affect the bar.
//        FAILED, CANCELLED, PENDING → return 200 (acknowledge) but don't write.
//   7. Idempotency: if `payment:{pf_payment_id}` already exists in KV, return 200 fast.
//   8. Write KV entry:
//        await env.PAYMENTS.put(`payment:${pf_payment_id}`, JSON.stringify({
//          amount_gross: parseFloat(form.amount_gross),
//          amount_fee: parseFloat(form.amount_fee),
//          amount_net: parseFloat(form.amount_net),
//          item_name: form.item_name,
//          name_first: form.name_first,
//          name_last: form.name_last,
//          mode: form.test_mode === 'true' ? 'test' : 'live',
//          timestamp: new Date().toISOString()
//        }));
//   9. Return 200 OK fast. PayFast retries on non-2xx; keep this handler tight.
//
// async function handleSummary(request, env, ctx):
//   1. Cache lookup: const cache = caches.default; const hit = await cache.match(request);
//      If hit, return it.
//   2. List KV keys with prefix `payment:`, paginate if >1000 (won't be).
//   3. For each, get the JSON, filter to mode === 'live'.
//   4. Sum amount_gross → paid_total.
//   5. List `refund:` keys (for future), sum → refunded_total.
//   6. total = paid_total - refunded_total.
//   7. goal = parseFloat(env.GOAL_ZAR).
//   8. percent = Math.min(100, Math.round((total / goal) * 100)).
//   9. Response { total_zar: total, goal_zar: goal, percent }.
//  10. Cache-Control: public, max-age=30. CORS headers.
//  11. ctx.waitUntil(cache.put(request, response.clone())). Return.
//
// function corsHeaders(env):
//   return {
//     'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
//     'Access-Control-Allow-Methods': 'GET, OPTIONS',
//     'Access-Control-Allow-Headers': 'Content-Type',
//     'Vary': 'Origin'
//   };
```

Set the passphrase as a Cloudflare secret (never commit it):

```bash
wrangler secret put PAYFAST_PASSPHRASE
# paste the 32+ char passphrase from your password manager when prompted
```

Test locally:

```bash
wrangler dev
# in another terminal, post a hand-signed payload to http://localhost:8787/webhook
```

Deploy:

```bash
wrangler deploy
```

Note the deployed URL — looks like `https://for-nyeleti-api.YOUR_SUBDOMAIN.workers.dev`.

## 3. Configure Notify URL in PayFast

After Cloudflare deploy, go to PayFast → **Settings → Developer Settings → Notifications Settings**:

- **Notify URL:** `https://for-nyeleti-api.YOUR_SUBDOMAIN.workers.dev/webhook`
- **ITN Status:** flip to **ON**
- Save.

Trigger a test webhook from PayFast (in sandbox if available, otherwise a real R10 to your own card) and check `wrangler tail` for the request.

## 4. GitHub repo + Pages

1. Create a new GitHub repo (public is fine — no secrets in repo).
2. Push the code.
3. **Settings → Pages → Source: Deploy from branch → main → / (root) → Save.**
4. After ~1 minute the site is live at `https://YOUR_USERNAME.github.io/REPO_NAME/`.
5. Update Worker's `ALLOWED_ORIGIN` in `wrangler.toml` to match this URL exactly. Redeploy: `cd worker && wrangler deploy`.
6. Update `app.js` constants:

```javascript
const WORKER_URL = 'https://for-nyeleti-api.YOUR_SUBDOMAIN.workers.dev';
const PAYFAST_PROCESS_URL = 'https://www.payfast.co.za/eng/process';
const PAYFAST_MERCHANT_ID = '12740752';
const PAYFAST_MERCHANT_KEY = '1hbgaznnfphw8';
const RETURN_URL = 'https://YOUR_USERNAME.github.io/REPO_NAME/?paid=1';
const CANCEL_URL = 'https://YOUR_USERNAME.github.io/REPO_NAME/?cancelled=1';
```

## 5. Test mode end-to-end (before going live)

PayFast sandbox lives at `https://sandbox.payfast.co.za/eng/process` with separate sandbox merchant credentials.

1. In `app.js`, temporarily switch `PAYFAST_PROCESS_URL` to the sandbox URL and use sandbox credentials.
2. Make a test payment with a PayFast test card.
3. Confirm the Worker logs show IP check passed, signature verified, validation callback returned VALID, KV entry written.
4. Reload the site. The bar should reflect the test amount (during testing only — production filter is `mode === 'live'`).
5. Switch back to live URL + live credentials. Make a real R10 contribution. Refund yourself via PayFast dashboard to confirm refund handling.

---

# Part 7 — Frontend Specification

`index.html` contains a single HTML form that POSTs to PayFast:

```html
<form action="https://www.payfast.co.za/eng/process" method="post" id="contribute-form">
  <input type="hidden" name="merchant_id" value="12740752">
  <input type="hidden" name="merchant_key" value="1hbgaznnfphw8">
  <input type="hidden" name="return_url" value="https://YOUR_USERNAME.github.io/REPO_NAME/?paid=1">
  <input type="hidden" name="cancel_url" value="https://YOUR_USERNAME.github.io/REPO_NAME/?cancelled=1">
  <input type="hidden" name="notify_url" value="https://for-nyeleti-api.YOUR_SUBDOMAIN.workers.dev/webhook">
  <input type="hidden" name="item_name" value="Contribution to Nyeleti's PMP">
  <input type="hidden" name="email_confirmation" value="1">
  <!-- amount filled by JS based on selection or input -->
  <input type="hidden" name="amount" id="amount-field" value="">
  <!-- preset buttons and custom input handled in app.js -->
</form>
```

`app.js` must:

1. On `DOMContentLoaded`, fetch `GET ${WORKER_URL}/summary` and render the progress bar.
2. Bar width = `percent`%, animated. Label: `R{total_zar} of R{goal_zar}` with thousands separators.
3. If `percent >= 100`, apply `.goal-reached` class to `<body>` — CSS handles violet bar + "We did it 🎉" + subtle pulse.
4. Contribute CTA opens a small amount picker (preset chips: R100, R200, R500, R1000 + "Other" text input) → fills `#amount-field` → submits the form.
5. If page loads with `?paid=1` in URL, show a thank-you toast and re-fetch summary once (the webhook may take ~30s to land).
6. If page loads with `?cancelled=1`, show a gentle "no worries, try again anytime" message.
7. Failures: Worker 5xx → "Loading…" then "Updating shortly" (never show R0).
8. No polling, no auto-refresh. Visitors who want fresh data reload.

## PMI-inspired style

Colours, per PMI's 2019 rebrand:
- **Tangerine `#F58220`** — primary CTA, accents.
- **Aqua `#00B8B0`** — progress bar fill (live state).
- **Violet `#6B2C91`** — goal-reached state.
- **Black** — primary text.
- **Warm off-white** — background.

Type: Inter from Google Fonts with system-sans fallback. Bold for headlines, regular for body. Generous line-height, mobile-first one column, big tap targets.

Page copy structure:

```
Help fund Nyeleti's PMP

[Short personal paragraph — placeholder [KATLEGO'S NOTE HERE] in index.html
 for Katlego to drop in the real copy]

[Progress bar: R{X} of R9,700]

[Contribute button → opens amount picker → form submits to PayFast]

[Footer: small thank-you note]
```

---

# Part 8 — Environment Variables Reference

| Name | Where | Type | Example | Committed? |
|---|---|---|---|---|
| `PAYFAST_PASSPHRASE` | Worker | secret | (32+ char random) | **No** |
| `GOAL_ZAR` | Worker | var | `9700` | Yes (`wrangler.toml`) |
| `ALLOWED_ORIGIN` | Worker | var | `https://katlego95.github.io` | Yes |
| `PAYFAST_MERCHANT_ID` | Worker | var | `12740752` | Yes |
| `PAYFAST_ALLOWED_IPS` | Worker | var | (21 IPs, comma-separated) | Yes |
| `PAYMENTS` | Worker | KV namespace binding | (id) | Yes |
| `WORKER_URL` | Frontend constant | string | `https://for-nyeleti-api.you.workers.dev` | Yes |
| `PAYFAST_PROCESS_URL` | Frontend constant | string | `https://www.payfast.co.za/eng/process` | Yes |
| `PAYFAST_MERCHANT_ID` | Frontend constant | string | `12740752` | Yes |
| `PAYFAST_MERCHANT_KEY` | Frontend constant | string | `1hbgaznnfphw8` | Yes |

**The only secret in the system is `PAYFAST_PASSPHRASE`.** Everything else is configuration and can live in the repo.

---

# Part 9 — Security Checklist (must all be true before launch)

- [ ] `PAYFAST_PASSPHRASE` set via `wrangler secret put`. Never in `wrangler.toml`, never in source.
- [ ] `git log -p` shows no passphrase content anywhere in history.
- [ ] `worker/.dev.vars` is in `.gitignore` if used locally.
- [ ] Worker `/webhook` rejects requests from IPs not in `PAYFAST_ALLOWED_IPS` (verify with curl from an outside IP → 403).
- [ ] Worker `/webhook` rejects requests with invalid MD5 signature (verify with a hand-tampered curl → 401).
- [ ] Worker `/webhook` rejects requests where PayFast's validation callback returns anything other than `VALID` (verify by tampering and observing 401).
- [ ] Worker `/webhook` only writes to KV when `payment_status === "COMPLETE"`.
- [ ] Worker filters out `mode === "test"` payments in `/summary` (live total only).
- [ ] Idempotency: re-posting the same `pf_payment_id` does not double-count. Verify by re-POSTing a captured live ITN.
- [ ] Worker `/summary` `Access-Control-Allow-Origin` is the exact GitHub Pages origin, not `*`.
- [ ] Frontend bundle contains no secrets — only public config (merchant_id, merchant_key, URLs).
- [ ] HTTPS everywhere (GitHub Pages and Workers both enforce this).
- [ ] PayFast Notify URL points to deployed Worker `/webhook`.
- [ ] PayFast ITN Status is ON.

---

# Part 10 — Operational Runbook

## Going live after verification
1. PayFast emails confirming verification → log into dashboard.
2. Confirm Notify URL is set, ITN Status is ON.
3. Make a R10 test contribution to your own card. Verify bar updates within ~60s of reload.
4. Refund the R10 via PayFast dashboard. Verify bar decrements.

## Rotating the passphrase
1. PayFast dashboard → Settings → Developer Settings → set new passphrase → save.
2. Immediately: `cd worker && wrangler secret put PAYFAST_PASSPHRASE` (paste new value).
3. Test with a real R10 contribution. If signature verification fails, the rotation slipped — re-check both sides match.

## Updating PayFast IP allowlist
PayFast occasionally changes their source IPs (they migrated to AWS in mid-2025 — the current 21 IPs are all in `3.163.x.237`). When they announce a change:
1. Update `PAYFAST_ALLOWED_IPS` in `wrangler.toml`.
2. `cd worker && wrangler deploy`.

## Changing the goal
1. Update `GOAL_ZAR` in `worker/wrangler.toml`.
2. `cd worker && wrangler deploy`.
3. Update display copy in `index.html`. Push to GitHub. Pages redeploys.

## Manual KV entries (e.g. someone paid via PayShap or cash outside PayFast)
```bash
wrangler kv:key put --binding=PAYMENTS "payment:manual-2026-05-17-aunt-mary" '{"amount_gross":500,"item_name":"Manual contribution from Aunt Mary","mode":"live","timestamp":"2026-05-17T14:30:00Z"}'
```

## Inspecting state
```bash
wrangler kv:key list --binding=PAYMENTS
wrangler kv:key get --binding=PAYMENTS "payment:..."
wrangler tail  # live Worker logs
```

---

# Part 11 — Failure Modes & Mitigations

| Failure | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PayFast ITN delivery fails (network) | Low | Bar misses one contribution | PayFast retries failed ITNs for up to 24h. Idempotency makes dupes safe. |
| Worker returns 5xx on ITN | Low | Same as above | Keep handler fast and simple. Log to `wrangler tail`. |
| Signature verification fails (wrong passphrase) | Possible during setup | Bar stops updating | `wrangler tail` shows 401s. Rotate via dashboard + `wrangler secret put`. |
| Validation callback returns not-VALID | Rare | Bar misses contribution | Could indicate tampering OR PayFast temporary issue. Log payload and inspect. |
| Source IP not in allowlist | Should be zero | Bar stops | PayFast announces IP changes. Update `PAYFAST_ALLOWED_IPS` and redeploy. |
| KV eventual consistency | Always | Up to ~60s delay before new payment appears globally | Acceptable. 30s cache plus KV propagation typically <1min total. |
| Contributor closes PayFast page before completing | Common | No payment, no ITN | No cleanup needed. Cancel URL handles UX gracefully. |
| Refund issued via dashboard | Possible | Bar should drop | Handle the corresponding ITN event (refund payment_status). |
| Goal exceeded | Likely good problem | Bar capped at 100% | `percent` clamps at 100; `total_zar` keeps growing. Display: "R{X} raised — exceeded goal by R{X-9700}!" |
| Cloudflare Worker free tier hit (100k req/day) | Effectively impossible | Brief 503s | 30s cache absorbs spikes. Upgrade is $5/mo if ever needed. |
| Workers KV free tier hit (1000 writes/day) | Impossible at your volume | None | <50 writes total expected. |
| Repo accidentally pushed with secret | Possible | Passphrase leaked | Rotate immediately in PayFast → `wrangler secret put` new value → rewrite git history with `git filter-repo`. |

---

# Part 12 — What's intentionally NOT in this build

- **No supporter wall.** PayFast ITN includes `name_first` and `name_last` so a names-only list is technically possible — but we chose bar-only for ship speed.
- **No personal messages on contributions.** Same reason.
- **No live auto-refresh.** Page loads show fresh data; visitors reload.
- **No "require signature" on outbound form.** Frontend builds a plain HTML form; ITN signature is the security boundary. Could be added as hardening later (Worker would need a `/create-payment` endpoint that returns a server-signed form payload).
- **No analytics, no tracking, no third-party scripts.** Clean, fast, trustworthy.

---

# Part 13 — Done means…

1. PayFast account verified, ITN Status ON, Notify URL pointing to Worker.
2. Visiting the GitHub Pages URL on mobile shows a warm, personal page with bar + goal + single big Contribute CTA.
3. Tapping Contribute opens the amount picker → submits to PayFast → user pays → within ~60s on reload, bar reflects the new total.
4. A refund via PayFast dashboard correctly reduces the total.
5. Re-posting the same captured ITN does NOT double-count.
6. Tampering with the ITN body, or sending from a non-PayFast IP, returns 401/403.
7. DevTools shows no secrets, no CORS errors, exactly one fetch to the Worker on page load.
8. `git log` is clean. Security checklist fully ticked.
