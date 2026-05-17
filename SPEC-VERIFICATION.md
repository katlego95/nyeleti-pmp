# PayFast ITN spec verification

Audit trail for what the Worker was built against. Captured **2026-05-17**.

This is not a tutorial. It is the record of *what we confirmed*, *what we adjusted*, and *what we deferred*. If PayFast changes their spec later, diff their docs against this file.

---

## Source of truth

PayFast's official PHP SDK on GitHub:
`https://github.com/PayFast/payfast-php-sdk` (commit on `master`).

We treat the SDK as canonical because:

1. The official developer portal (`developer.payfast.co.za/docs`) was unreachable during this audit — TLS certificate expired (verified with `curl`). The cert expiry on a production developer surface is itself a finding; we will recheck after PayFast restores it.
2. The PHP SDK is published, version-controlled, and demonstrably exercises the live signing path.
3. Where the SDK and the project README diverge, this document calls out the diff.

Files we read verbatim:

- `lib/PaymentIntegrations/Notification.php` — inbound ITN verification (`isValidNotification`, `dataToString`, `pfValidSignature`, `pfValidServerConfirmation`).
- `lib/PaymentIntegrations/CustomIntegration.php` — outbound payment form construction.
- `lib/Auth.php` — `generateSignature` (outbound form) and `generateApiSignature` (REST API).
- `lib/PayFastPayment.php` — base URL constants for live and sandbox.

---

## 1. Confirmed against the SDK (no adjustment needed)

- **Base URLs.** Live = `https://www.payfast.co.za`, Sandbox = `https://sandbox.payfast.co.za`. Confirmed in `PayFastPayment::setTestMode`.
- **Payment process endpoint.** `${baseUrl}/eng/process`. Confirmed in `CustomIntegration::createFormFields`.
- **Validation callback endpoint.** `${baseUrl}/eng/query/validate`. Method `POST`. Content-Type `application/x-www-form-urlencoded`. Body = the canonical param string (no passphrase appended). Confirmed in `Notification::pfValidServerConfirmation`.
- **Validation callback expected response.** Literal string `VALID`. SDK uses strict `===` against `(string)$response->getBody()`. (Our Worker trims first — see §2.)
- **ITN signature field order.** Insertion order from the incoming POST body. The SDK iterates `$_POST` (PHP preserves insertion order) and breaks at the `signature` key. Fields *after* `signature` in the POST body are excluded. Confirmed in `Notification::dataToString`.
- **MD5 hex case.** Lowercase. PHP `md5()` default. (Our Worker compares case-insensitive as cheap defense-in-depth.)
- **Passphrase append in ITN path.** `&passphrase=urlencode($pfPassphrase)`. Passphrase is URL-encoded with PHP `urlencode()` style. Confirmed in `Notification::pfValidSignature`.
- **Idempotency key.** `pf_payment_id` is PayFast's unique transaction ID. Confirmed by README and field list in CustomIntegration form construction.

---

## 2. Adjusted vs README guidance (with rationale)

### 2a. Empty-value handling: **INCLUDED, not skipped**

README left this open; my plan flagged it as an open question. Resolved.

The SDK's inbound ITN path (`Notification::dataToString`) does **not** skip empty values:

```php
foreach ($pfData as $key => $val) {
    if ($key !== 'signature') {
        $pfParamString .= $key . '=' . urlencode($val) . '&';
    } else {
        break;
    }
}
```

`urlencode('')` returns `''`, so an empty field produces `key=&` in the canonical string. The Worker must include empty fields too — skipping them would silently break signatures whenever PayFast sends an empty optional field.

Note that the SDK's *outbound* form-signing path (`Auth::generateSignature`) DOES skip empty values (`if (!empty($value))`). The inbound and outbound paths are not symmetric. We use the **inbound** rules.

### 2b. URL encoder: **NOT URLSearchParams.toString()**

The plan tentatively said `URLSearchParams.toString()` matches PHP `urlencode()`. **It doesn't.**

PHP `urlencode()` encodes these characters that JS `encodeURIComponent()` (and therefore `URLSearchParams.toString()`) leaves alone:

| Char | PHP urlencode | JS encodeURIComponent |
|---|---|---|
| space | `+` | `%20` |
| `!` | `%21` | `!` |
| `*` | `%2A` | `*` |
| `'` | `%27` | `'` |
| `(` | `%28` | `(` |
| `)` | `%29` | `)` |

A real ITN value like `item_name=Nyeleti's PMP` has both a space and an apostrophe — both encoded by PHP, both left alone by JS. Signatures would silently fail.

The Worker uses a small `phpUrlEncode()` helper:

```js
function phpUrlEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/%20/g, '+');
}
```

The canonical sample fixture (§4) deliberately exercises both the space and apostrophe cases so the unit test catches encoder regressions.

### 2c. Validation response: **trim before compare**

The PHP SDK strict-equals against `VALID` with no trimming. The Worker trims first, then case-sensitive equals `VALID`. Strictly more permissive: any future PayFast change that adds a trailing newline would silently pass with us and silently fail with the SDK. The cost of being permissive here is near-zero (a stray `VALID\n` from PayFast is functionally identical to `VALID`); the cost of being strict is a hard failure on whitespace we can't control. Documented.

### 2d. Constant-time compare: **kept, despite SDK using `===`**

The PHP SDK does `$pfData['signature'] === $signature` — plain string equality. Standard Webhooks (HMAC) needs constant-time compare to defeat timing-side-channel signature forgery. The MD5 case is weaker (PayFast can be forced into MD5 collisions in theory but the practical threat is low). We use a constant-time byte-array compare on the decoded digests anyway. Cheap, no downside.

### 2e. IP allowlist: **static list, not DNS resolution**

The PHP SDK uses `gethostbynamel` to resolve `www.payfast.co.za`, `sandbox.payfast.co.za`, `w1w.payfast.co.za`, `w2w.payfast.co.za` and accepts the resulting IPs. We use the static 21-IP list from PayFast's KB article (§3), as specified by the project README. Trade-offs:

- **DNS approach**: dynamic; breaks during DNS issues; if PayFast fronts these hostnames with a CDN, the resolved IPs are the CDN's, not the actual webhook egress IPs.
- **Static list**: stale if PayFast renumbers; needs manual refresh.

We pick static because Cloudflare Workers don't naturally have DNS lookup (`fetch` does, but adding a DNS lookup per webhook adds latency and a failure mode). If PayFast announces a renumbering, update `PAYFAST_ALLOWED_IPS` in `wrangler.toml` and redeploy.

---

## 3. Deferred to PayFast docs as source of truth (with URLs)

These will be resolved by the user via the PayFast portal or by reading live sandbox traffic. They are *not* blockers for the Worker code, which handles whatever PayFast sends.

### 3a. Sandbox merchant credentials

Sandbox `merchant_id`, `merchant_key`, and `passphrase` are published by PayFast in the Developer Portal under "Sandbox" / "Developer Settings". We do **not** hard-code these from third-party sources — the user will retrieve them from `developer.payfast.co.za` (or the portal-equivalent) when the cert is restored and paste them into `worker/.dev.vars` (local) and `app.js` (frontend) for sandbox testing only.

### 3b. Refund event payload shape

The README anticipates refund handling but PayFast does not publish a dedicated `refund.succeeded`-style event in the same way HMAC-based gateways do. Refunds in PayFast are surfaced via the ITN with a different `payment_status` (commonly `REFUND` or similar). The Worker logs the `payment_status` of every received ITN; once a real refund is observed in sandbox we'll codify the exact string.

For now the Worker writes to KV **only** when `payment_status === 'COMPLETE'`. Refund handling is wired in (logs payload, returns 200) but does not yet decrement totals — pending observation of the real refund payload shape.

URLs to check later (when the dev portal is back up):
- `https://developer.payfast.co.za/docs#payfast-notifications`
- `https://support.payfast.help/portal/en/kb/articles/refunds` (or similar)

### 3c. PayFast IP allowlist currency

Sourced from KB article on AWS migration (July 2025): 21 IPs, all in `3.163.x.237` with `x` in `{232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252}`. Confirmed via WebFetch.

PayFast does not publish a programmatic IP list. Manual refresh required if they announce a change. Check:
- `https://support.payfast.help/portal/en/kb/articles/whitelisting-ip-addresses-2-7-2025`
- `https://support.payfast.help/portal/en/kb/articles/what-ip-addresses-does-payfast-use` (404 at audit time)

---

## 4. Canonical fixture

`worker/test/payfast-canonical-sample.json` contains a worked example built using the algorithm extracted above. It is **not** taken from PayFast docs (none were reachable); it is a *self-consistent* fixture computed by hand with shell `md5` and the PHP-equivalent encoding rules.

This fixture is sufficient to catch:

- Wrong field iteration (sorting alphabetically instead of insertion-order)
- Wrong URL encoder (using `URLSearchParams.toString()` or `encodeURIComponent` directly — apostrophe in `Nyeleti's` will produce different bytes)
- Wrong space encoding (`%20` vs `+`)
- Wrong passphrase append format
- Wrong MD5 hex case

It is **not** sufficient to prove end-to-end correctness against PayFast's live signing implementation. That validation happens in Task #8 (local Worker tests) against a real PayFast sandbox ITN.

---

## 5. Supply-chain audit (npm transitive deps)

Install command used (verbatim, in `worker/`):

```
npm install --save-dev --save-exact --ignore-scripts wrangler@4.88.0
```

- **Pinned version chosen:** `wrangler@4.88.0`, published 2026-05-05, **11 days old** at install time. Past the 7-day cutoff the project rule requires.
- `--save-exact` → no `^` prefix in `package.json` (lockfile-driven and exact-version-driven).
- `--ignore-scripts` → blocks `preinstall`/`postinstall`/`install` hooks on every package in the tree. This is the primary execution vector for the recent supply-chain compromises.
- `package-lock.json` committed (~48 KB) to lock the full transitive tree.

**`npm audit --audit-level=moderate`**: `found 0 vulnerabilities`.

**`npm ls --all` summary** — Wrangler pulled in these transitive packages. All are expected for a Cloudflare CLI build/runtime:

- Cloudflare-owned: `@cloudflare/kv-asset-handler`, `@cloudflare/unenv-preset`, `@cloudflare/workerd-darwin-arm64`, `workerd`, `unenv`, `miniflare`.
- Build tooling: `esbuild` + `@esbuild/darwin-arm64`, `blake3-wasm`, `path-to-regexp`, `pathe`.
- Local-dev runtime (used by `wrangler dev`): `undici` (HTTP), `ws` (WebSocket), `fsevents` (macOS file-watch), `sharp` + `@img/sharp-darwin-arm64` + `@img/sharp-libvips-darwin-arm64` (image transforms for Workers Assets), `semver`, `detect-libc`.
- Error rendering: `youch`, `youch-core`, `@poppinss/*`, `@speed-highlight/core`, `cookie`, `kleur`, `supports-color`, `@sindresorhus/is`, `error-stack-parser-es`, `@cspotcode/source-map-support`, `@jridgewell/trace-mapping`, `@jridgewell/resolve-uri`, `@jridgewell/sourcemap-codec`.

No unfamiliar packages, no obvious supply-chain anomalies. All native binaries (`workerd`, `esbuild`, `sharp`, `fsevents`) are pulled in via npm's platform-specific `optionalDependencies` mechanism — they install via the package manifest without needing postinstall scripts, which is why `--ignore-scripts` does not break `wrangler dev`. Verified: `npx wrangler --version` → `4.88.0`.

**Forbidden surface:** the Worker `dependencies` map is `{}` (explicit empty object asserted in `worker/package.json`). The runtime bundle is only:
- `worker/index.js` (handwritten)
- `worker/md5.js` (handwritten, public-domain inline implementation)
No `dependencies`, no `js-md5`, no `node-fetch`, no `hono`, no `axios`. Wrangler is `devDependencies` only and is not bundled into the deployed Worker.

---

## 6. Test outcome

### Unit tests

`node --test test/verify.test.js` — **8 of 8 pass** (2026-05-17):

- MD5 RFC 1321 test vectors (all 7 official vectors pass)
- parseItnBody preserves POST insertion order, extracts signature
- buildCanonicalString reproduces the fixture canonical string byte-for-byte (this catches encoder regressions on `'` and space)
- verifyItnSignature accepts the canonical fixture
- verifyItnSignature rejects a tampered `amount_gross`
- verifyItnSignature rejects the right body with the wrong passphrase
- verifyItnSignature rejects a body with no signature field
- verifyItnSignature accepts uppercase-hex signatures (defense-in-depth)

This is JS-level self-consistency.

### Integration tests against `wrangler dev`

Worker booted on `127.0.0.1:8787`. Local validate-callback mock on `127.0.0.1:9999` always returns `VALID` (5-line `node -e`). Curl drove the following scenarios — **all 10 pass**:

| # | Scenario | Expected | Got |
|---|---|---|---|
| T1  | Valid test-mode ITN, allowed IP | 200 + KV write | 200, `OK` |
| T2  | Replay same `pf_payment_id` | 200, idempotent no-op | 200, KV unchanged |
| T3  | Tampered `amount_gross`, original signature | 401 | 401, `Unauthorized` |
| T4  | Source IP `9.9.9.9` (not in allowlist) | 403 | 403, `Forbidden` |
| T5  | No `signature` field in body | 401 | 401, `Unauthorized` |
| T6  | GET /summary with only test-mode entries | `total_zar = 0` | `{"total_zar":0,"goal_zar":9700,"percent":0}` |
| T7  | Valid live-mode ITN | 200 + KV write | 200, `OK` |
| T8  | GET /summary after live ingest | `total_zar = 200` | `{"total_zar":200,"goal_zar":9700,"percent":2}` |
| T9  | OPTIONS /summary preflight | 204 + CORS headers | 204, ACAO + ACAM + ACAH set |
| T10 | GET unknown path | 404 | 404, `Not found` |

`Access-Control-Allow-Origin` on `/summary` and the OPTIONS preflight is pinned to the configured value (never `*`, never echoed from the requesting `Origin`).

Final KV state after the suite: exactly two keys, `payment:1234567` (test-mode) and `payment:2222222` (live-mode). Replay correctly suppressed.

End-to-end against the real PayFast sandbox URL — deferred until sandbox credentials are retrieved from the developer portal (see §3a).

---

## 7. Open follow-ups

- [ ] Re-verify against `developer.payfast.co.za/docs` once their TLS cert is restored.
- [ ] Capture a real sandbox ITN body + signature in Task #8 and add it as a second fixture alongside the hand-computed one.
- [ ] Observe a real refund ITN and codify the `payment_status` string in the Worker.
