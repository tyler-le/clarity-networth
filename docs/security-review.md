# Security review

Reviewed: 2026-09-19
Scope: Express API, vanilla-JS PWA, Plaid integration, Google sign-in,
encrypted persistence, database migrations, service worker, and deployment
workflows. This review is repository-grounded; Railway, Postgres, Google, and
Plaid account configuration were not directly inspected.

## Outcome

The app has a solid baseline for a private beta: Plaid access tokens remain
server-side, financial-store payloads and volume snapshots use AES-256-GCM,
financial API responses are private/no-store, financial routes require an
authenticated session, resource lookups are scoped to that member's store,
Plaid webhooks are signature-verified, and provider-cost routes use
database-backed opaque rate-limit keys.

Four narrow fixes were applied in this review.

| ID | Severity before fix | Finding | Resolution |
| --- | --- | --- | --- |
| SEC-001 | Medium | The signed `clarity_session` cookie exposed its email payload as base64url text to anyone who possessed the cookie. | `src/server.js` now encrypts and authenticates the session payload with AES-256-GCM (`v2` cookie format); tests prove it is accepted only intact and does not expose the email in readable form. Existing sessions will sign out once after deployment. |
| SEC-002 | Medium | Several background-sync and Plaid failure logs included raw provider error messages and one included an institution name. | `logOperationalError()` now logs only a controlled operation label plus a bounded provider/error code. It is used for provider, database, webhook, and background-sync failures. |
| SEC-003 | Low | Development-only behavior used a Host-derived staging check without an explicit production guard. | `isDevelopmentRequest()` now relies on Railway's deployment-controlled staging environment marker; a spoofed staging-looking Host header cannot enable development behavior in production. |
| SEC-004 | Low | A stalled Plaid response could hold an API request or scheduled sync worker indefinitely. | `plaidPost()` now uses a 15-second abort signal; existing safe dependency-error handling remains responsible for retry UI and background retry. |

## Verified controls

| Area | Evidence | Assessment |
| --- | --- | --- |
| Plaid secrets and tokens | `src/lib/plaid.js`, `src/server.js` link/exchange routes | Client ID and secret are read only on the server; the Plaid access token is encrypted before persistence and omitted from exports and public item responses. |
| Data at rest | `src/lib/secure-payload.js`, `src/lib/store.js`, `src/lib/database.js` | Financial payloads and local recovery snapshots are AES-256-GCM encrypted. Production refuses private API access unless distinct encryption and session secrets plus Postgres are configured. |
| Tenant isolation | `src/server.js` `verifySession`, `loadStore`, and resource routes | A verified Google identity maps to a one-way storage key; every account, transaction, item, holding, and history lookup searches only that authenticated store. Integration tests cover cross-session history isolation. |
| Authentication | `src/server.js` auth routes | Google ID tokens are verified for the configured audience and verified email; the invite gate is checked before and after Google verification. Cookie flags are `HttpOnly`, `SameSite=Lax`, and `Secure` in production. |
| CSRF and browser isolation | `src/server.js` API middleware | State-changing authenticated API requests with an Origin header must match the current origin. No CORS policy grants cross-origin credentialed API access; JSON API calls and SameSite cookies add defense in depth. |
| Browser protections | `src/server.js` headers; `public/sw.js` | CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, restrictive referrer and permissions policies, HSTS in production, and no service-worker caching of financial data are present. |
| Webhooks and dependency limits | `src/server.js` `verifyPlaidWebhook`, `plaidCostLimiter`; `db/migrations/003_rate_limit_counters.sql` | Webhooks require ES256 verification and a raw-body hash match. Billable Plaid actions are bounded per opaque user and IP-derived key; database failure fails closed for those calls. |
| Privacy telemetry | `src/lib/database.js` `recordLaunchEvent` / `recordDependencyEvent` | Event names are allowlisted and do not accept balances, account names, transaction data, paths, raw IPs, or request bodies. Retention is bounded. |

## Remaining recommendations

These are not implemented because they need deployment/provider decisions or a broader product policy.

| Priority | Finding and evidence | Recommendation |
| --- | --- | --- |
| High | Authentication throttling (`authLimiter` and `loginAttempts` in `src/server.js`) is process-local, unlike the Plaid-cost limit. A restart or multiple replicas can dilute it. | Put an edge rate limit/WAF rule in front of `/api/auth/*`, keyed by IP with a modest burst cap. If the app scales beyond one replica, move auth-failure limits to Postgres or Redis using opaque keys. |
| High | TLS enforcement for Postgres is not visible in `src/lib/database.js`; `DATABASE_URL` controls the client connection. | Verify Railway's database connection requires TLS or is private-network-only. For any public/external Postgres endpoint, require TLS with certificate validation and use a least-privileged application role. |
| Medium | `public/index.html` loads Plaid Link and Google Identity scripts from their providers. CSP allowlists exactly those origins, but there is no SRI pin. | Keep the script allowlist minimal and review provider-origin changes. SRI may be impractical for provider-managed, frequently updated identity/link scripts; do not add a brittle hash without testing their supported loading model. |
| Medium | One encryption key version is supported (`src/lib/secure-payload.js`). | Establish a documented key-rotation procedure: versioned key IDs, decrypt-old/encrypt-new migration, recovery test, and emergency rotation runbook before a broader launch. |
| Medium | Account deletion continues if Plaid item revocation is unavailable (`src/server.js` `DELETE /api/account`), so the local token is removed before a retry can revoke the remote Item. | Decide a deletion policy: retain only a minimal encrypted pending-revocation record until Plaid confirms removal, or clearly disclose the retry path and provide support-assisted revocation. |
| Low | The unauthenticated health endpoint reports `securityReady` and `databaseReady` in addition to `ok` (`src/server.js`). | Keep detailed readiness only on a private health endpoint; expose only `{ ok: true/false }` publicly if this is not needed by Railway. |
| Low | Development deployment is intentionally ungated in `.github/workflows/deploy-to-dev.yml`; production runs `npm run test:ci`. | Require a pull-request check or at least run the data/API suite before staging if more contributors are added. Keep production's exact-commit test gate. |

## Test evidence

- Added encrypted-session privacy and tamper-rejection coverage in
  `test/integration/http.test.js`.
- Added a bounded-Plaid-request coverage in `test/history.test.js`.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- Full test results are recorded with the change before release.

## Manual verification checklist

1. Confirm production runs with `NODE_ENV=production`, `DEMO_MODE=false`,
   distinct long random `DATA_ENCRYPTION_KEY` and `SESSION_SECRET`, a
   persistent `DATABASE_URL`, and only production Google/Plaid credentials.
2. Confirm the custom domain and Railway origin enforce HTTPS, and verify
   Postgres transport encryption/network isolation.
3. Confirm Railway and GitHub Actions access are least-privilege, MFA-protected,
   and secrets are not shared between staging and production.
4. Rotate the private-beta invite code if it has been shared outside the
   intended tester group; it is an admission gate, not a user-specific secret.
