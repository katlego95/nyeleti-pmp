# Deploy

The complete post-verification command sequence. Run from a clean shell, top to bottom. Stop and read the notes between phases — they catch the things that will silently bite you.

The README has the architecture and the "why". `SPEC-VERIFICATION.md` has the audit trail of what the Worker was actually built against. **This file is the operational runbook.**

---

## Phase 0 — One-time machine prep

```bash
# In the repo root
cd /path/to/nyeleti-pmp

# Worker setup. Do this once per machine.
cd worker
npm install --save-dev --save-exact --ignore-scripts wrangler@4.88.0
```

Notes:

- `--ignore-scripts` is **non-negotiable**. It blocks `preinstall`/`postinstall`/`install` hooks on every package in the tree, which is the primary execution vector for the recent npm supply-chain compromises (see SPEC-VERIFICATION.md §5).
- `--save-exact` pins the version with no `^`. Don't change it casually.
- We use **`wrangler@4.88.0`** specifically. It was published 2026-05-05 and was 11 days old at install — past the 7-day cutoff. If you ever need to bump, re-check that the new version has been out for at least a week with no security advisories.
- Wrangler is a `devDependency`. The deployed Worker bundle pulls in **zero npm runtime deps** — only `index.js` and `md5.js`.

After install:

```bash
npm audit --audit-level=moderate
# Expected: "found 0 vulnerabilities"
```

Commit `package-lock.json` (already in the repo). Never edit it by hand.

---

## Phase 1 — Cloudflare auth (scope-limited)

```bash
# In worker/
npx wrangler login
```

This opens a browser to authorise Wrangler against your Cloudflare account.

**When Cloudflare asks which scopes to grant, choose only:**

- **Workers Scripts:Edit** — to deploy `index.js`.
- **Workers KV Storage:Edit** — to manage the `PAYMENTS` KV namespace.

**Decline all others.** Specifically *not* "Account:Read", *not* "User:Read", *not* "Zone:Edit", *not* "DNS:Edit". If a token gets exfiltrated, the blast radius is limited to the Worker + KV — not your DNS, not your billing, not your other zones.

If the OAuth flow doesn't surface a scope picker on your account, create the token manually:

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token.
2. Permissions: `Account – Workers Scripts – Edit`, `Account – Workers KV Storage – Edit`.
3. Account Resources: include only your one account.
4. Save the token. Export it as `CLOUDFLARE_API_TOKEN` in the shell you'll deploy from.

---

## Phase 2 — KV namespace

```bash
# In worker/
npx wrangler kv namespace create PAYMENTS
```

Copy the printed `id` into `worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "PAYMENTS"
id = "PASTE_THE_ID_HERE"
```

Commit `wrangler.toml`. The namespace ID is not a secret.

---

## Phase 3 — Sandbox bring-up

PayFast verification can take 1–3 business days. During that window, do everything against the sandbox.

### 3a. Retrieve sandbox credentials

Log into PayFast → **Settings → Developer Settings → Sandbox**. Note:

- Sandbox `merchant_id`
- Sandbox `merchant_key`
- Sandbox passphrase (set one if it isn't already; copy it)

These are not secrets in the same way as the live passphrase, but treat them like keys — never commit them.

### 3b. Set the sandbox passphrase as a Worker secret

```bash
# In worker/
npx wrangler secret put PAYFAST_PASSPHRASE
# Paste the sandbox passphrase when prompted. ENTER.
```

Cloudflare stores this in the Worker's secret storage. It is *not* readable back via `wrangler secret list` — only the name shows up.

### 3c. Set `ALLOWED_ORIGIN` for sandbox

While you're testing, you'll be serving the frontend either from GitHub Pages (preview branch) or locally. Update `worker/wrangler.toml`:

```toml
ALLOWED_ORIGIN = "https://YOUR_USERNAME.github.io"
```

Replace `YOUR_USERNAME` with your actual GitHub username. No trailing slash. If you're testing locally, you can temporarily set this to `http://127.0.0.1:8000` and redeploy, but **revert it before any real traffic**.

### 3d. Deploy

```bash
# In worker/
npm run deploy
```

`npm run deploy` runs the `preflight` script first (`npm ls --all && npm audit --audit-level=moderate`). If anything in the dependency tree has gained a moderate-or-higher advisory since you installed, deploy is blocked. Investigate, then retry.

Note the printed deployed URL. Looks like:

```
https://for-nyeleti-api.YOUR_SUBDOMAIN.workers.dev
```

### 3e. Wire up the Notify URL in PayFast (sandbox)

PayFast dashboard → **Settings → Developer Settings → Notification Settings** (sandbox view):

- **Notify URL:** `https://for-nyeleti-api.YOUR_SUBDOMAIN.workers.dev/webhook`
- **ITN Status:** ON
- Save.

### 3f. Update the frontend constants (sandbox)

In `app.js`:

```javascript
const WORKER_URL           = 'https://for-nyeleti-api.YOUR_SUBDOMAIN.workers.dev';
const PAYFAST_PROCESS_URL  = 'https://sandbox.payfast.co.za/eng/process';
const PAYFAST_MERCHANT_ID  = 'YOUR_SANDBOX_MERCHANT_ID';
const PAYFAST_MERCHANT_KEY = 'YOUR_SANDBOX_MERCHANT_KEY';
```

Push to GitHub. Pages redeploys in ~1 min.

### 3g. Sandbox end-to-end test

1. Open the deployed GitHub Pages URL on your phone.
2. Confirm the bar reads `R0 of R9 700`.
3. Tap Contribute → pick R100 → confirm → you land on PayFast sandbox checkout.
4. Use a PayFast sandbox test card to complete the payment.
5. PayFast redirects you back to the site with `?paid=1`. Toast appears.
6. Wait ~30s, reload. Bar should show R100.
7. In another terminal: `npx wrangler tail` — confirm a `200 OK` line shows up with the test ITN log.
8. Inspect KV state: `npx wrangler kv key list --binding=PAYMENTS` — you should see one `payment:` entry.

If the bar doesn't update, see the troubleshooting section at the bottom.

---

## Phase 4 — Production cutover (after PayFast verification email)

### 4a. Get the live passphrase and rotate

PayFast → Settings → Developer Settings → set a live passphrase (a 32+ char random string from a password manager — **not** the example "iced tea is great for summer" / `/cedTisgr84Summ3R` style example PayFast shows in their UI; that's example text, not a strong passphrase).

```bash
# In worker/
npx wrangler secret put PAYFAST_PASSPHRASE
# Paste the LIVE passphrase. ENTER.
```

Cloudflare swaps the secret atomically — no downtime.

### 4b. Switch the frontend to live

In `app.js`:

```javascript
const PAYFAST_PROCESS_URL  = 'https://www.payfast.co.za/eng/process';
const PAYFAST_MERCHANT_ID  = '12740752';
const PAYFAST_MERCHANT_KEY = '1hbgaznnfphw8';
```

`WORKER_URL` stays the same.

Push. Pages redeploys.

### 4c. Set the live Notify URL

PayFast dashboard → switch to **live** mode → Settings → Developer Settings → Notification Settings:

- **Notify URL:** `https://for-nyeleti-api.YOUR_SUBDOMAIN.workers.dev/webhook`
- **ITN Status:** ON
- Save.

### 4d. R10 live self-test

1. Open the GitHub Pages URL on your phone.
2. Tap Contribute → R10 → pay with your own real card.
3. Within ~60 seconds of reloading, the bar should show R10.
4. `npx wrangler tail` confirms the live ITN landed and was stored.
5. From the PayFast dashboard → refund the R10 to yourself.
6. Reload after ~60 seconds. Bar should drop back to R0.

If both work, the system is live.

---

## Operational runbook

### Rotate the passphrase

```bash
# 1. In PayFast dashboard, generate + save a new passphrase.
# 2. Immediately:
cd worker
npx wrangler secret put PAYFAST_PASSPHRASE
# paste new value
```

Cloudflare swaps atomically. No code change, no downtime.

### Update the PayFast IP allowlist

PayFast does not publish IP changes via an API. If they announce a renumbering:

1. Edit `PAYFAST_ALLOWED_IPS` in `worker/wrangler.toml`.
2. `cd worker && npm run deploy`.

### Change the goal

1. Edit `GOAL_ZAR` in `worker/wrangler.toml`.
2. Edit `GOAL_ZAR` in `app.js`.
3. `cd worker && npm run deploy`.
4. Push. Pages redeploys.

### Manual contribution (someone paid via PayShap, EFT, cash)

```bash
npx wrangler kv key put --binding=PAYMENTS \
  "payment:manual-2026-05-17-aunt-mary" \
  '{"amount_gross":500,"item_name":"Manual contribution from Aunt Mary","mode":"live","timestamp":"2026-05-17T14:30:00Z"}'
```

Wait ~30s for the edge cache to expire, then reload.

### Inspect state

```bash
npx wrangler kv key list --binding=PAYMENTS
npx wrangler kv key get  --binding=PAYMENTS "payment:..."
npx wrangler tail   # live tail of Worker logs
```

---

## Common issues

### Bar shows "Updating shortly…" forever

- `WORKER_URL` in `app.js` doesn't match the deployed URL.
- Or `ALLOWED_ORIGIN` in `wrangler.toml` doesn't match the Pages URL exactly (case- and trailing-slash-sensitive).
- Open browser DevTools → Network → look for the `/summary` request. CORS error in console = ALLOWED_ORIGIN mismatch.

### `wrangler tail` shows 401 on every ITN

- Most likely the passphrase doesn't match. Re-run `wrangler secret put PAYFAST_PASSPHRASE` and paste again — easy to miss whitespace from clipboard.
- Or PayFast is sending ITNs against the wrong passphrase (you rotated PayFast but not Cloudflare, or vice versa).

### `wrangler tail` shows 403 on every ITN

- `PAYFAST_ALLOWED_IPS` doesn't include PayFast's current source IP. Check the source IP in the log line, cross-reference against [PayFast's IP allowlist KB article](https://support.payfast.help/portal/en/kb/articles/whitelisting-ip-addresses-2-7-2025), update `wrangler.toml`, redeploy.

### `wrangler tail` shows "validate callback did not return VALID"

- PayFast couldn't confirm the ITN you forwarded back. Could mean: the body you forwarded was mutated (encoding bug), or PayFast is having a transient issue, or you're sending a sandbox ITN to live (or vice versa) — the Worker picks the URL by `test_mode`, so check that field in the logged payload.

### Bar shows the wrong number

- Cache. `/summary` has a 30s edge cache. Wait, then reload.
- KV eventual consistency. New writes can take up to ~60s to propagate globally.
- Run `npx wrangler kv key list --binding=PAYMENTS` to confirm the underlying state.

---

## Things to NEVER do

- **Never commit `.dev.vars`**. It's gitignored. If it ends up in `git status`, stop.
- **Never set `PAYFAST_VALIDATE_BASE_URL` in production**. It exists only as a local-dev hook so a mock validator can replace PayFast's real endpoint. If it leaks into prod (via `wrangler secret put` or `wrangler.toml`), the validation callback layer is silently bypassed.
- **Never run `npm install -g wrangler`**. Global install gives every npm script on the machine access to the same install tree. Pin it in this repo, run via `npx`.
- **Never grant the Cloudflare token broader scopes than Workers Scripts:Edit + Workers KV Storage:Edit.** No DNS, no Zone, no Account-level reads.
- **Never run `wrangler deploy` directly**. Use `npm run deploy` so the preflight (`npm ls --all && npm audit`) catches new advisories first.
- **Never paste the live passphrase into any chat, ticket, screenshot, or AI prompt.** Password manager only.
