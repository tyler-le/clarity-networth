# Production operations

## Environments

- **Production** serves real users and only accepts production credentials.
- **Staging** is isolated: separate Railway Postgres and volume, separate encryption and session secrets, and no production Plaid credentials. Do not connect real financial institutions to staging.

Before staging sign-in is enabled, add `https://clarity-networth-staging.up.railway.app` to a dedicated Google OAuth client’s Authorized JavaScript origins, then set that client ID only in staging.

## Deployments

`main` is the only release branch. GitHub Actions runs the complete unit, integration, and browser suite for the exact commit, deploys it to staging, checks the live staging health endpoint and public pages, and only then deploys the same commit to production. Production is never deployed when an earlier stage fails.

The Railway service source is intentionally disconnected in both environments. Direct GitHub autodeploys would bypass the staging gate. The workflow uses two environment-scoped GitHub Actions secrets: `RAILWAY_STAGING_TOKEN` can deploy only to staging and `RAILWAY_TOKEN` can deploy only to production. Neither is an application environment variable or committed to Git.

## Backups and recovery

Postgres is the primary encrypted financial-data store. The application also maintains an encrypted per-user mirror and a daily encrypted snapshot on its Railway volume. Snapshots retain 35 days and are removed with a user’s account deletion request.

This protects against a bad application write or database loss, but it is not an off-site disaster-recovery system. Before public launch, configure a separate encrypted backup destination and test a complete restore there at least quarterly.

## Monitoring

- Railway calls `/api/health` for deploy health checks. The endpoint fails closed if secure production configuration or PostgreSQL is unavailable.
- GitHub Actions checks the production health endpoint hourly. A failed run is a signal to investigate immediately.
- Railway logs must never contain financial payloads, access tokens, cursors, or secrets.
- Use Railway Observability—not the Clarity customer app—for deployment health, resource use, logs, and availability. Private product-health measurement is documented in [Launch metrics](LAUNCH_METRICS.md). Any visual product report must be a separate private, read-only service.

## Provider cost controls

Clarity enforces these server-side limits before it calls Plaid:

- 5 Link-token requests per signed-in user per 15 minutes (20 per IP).
- 10 completed Item exchanges per signed-in user per day (25 per IP).
- 15 active linked institutions per user by default; `MAX_LINKED_ITEMS` may lower this, never exceed 30.
- `FREEMIUM_ENABLED=false` is the global product kill switch. With it off, no plan ingress or feature block is exposed. With it on, Free members may keep two currently linked institutions; unlinking an institution immediately frees a slot. Set and test the variable independently in staging before enabling it in production.
- Automated refreshes run server-side on a daily schedule. Users cannot trigger unbounded manual refreshes.
- Plaid webhook verification keys are cached for one hour and webhook traffic is IP-throttled before provider verification.

The counters are stored as opaque HMAC-derived identifiers in Postgres, so they survive deploys and do not retain raw IP or email data.

## Edge protection before public signup

Put the production custom domain behind Cloudflare before removing the email allow list. Configure managed bot protection and rate-limit rules for `/api/auth/*` and `/api/plaid/*`, while allowing Plaid's documented webhook traffic to reach `/api/plaid/webhook`. Keep Railway as the origin and do not cache any `/api/*` response.

## Incident response

1. Stop public access or disable the affected credentials.
2. Preserve only non-sensitive deployment and audit evidence.
3. Rotate affected Plaid, application encryption, session, and OAuth secrets as applicable.
4. Restore only from an encrypted, verified backup after identifying the cause.
5. Notify affected users and obtain legal advice when required.

## Release checklist

1. Merge only after CI passes.
2. Test the change in staging using demo data.
3. Verify `/api/health`, sign-in, account link/update/unlink, export, and deletion.
4. Deploy production and check logs and health endpoint.
5. Roll back promptly for a data-isolation, security, or data-integrity issue.
