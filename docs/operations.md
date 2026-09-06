# Production operations

## Environments

- **Production** serves real users and only accepts production credentials.
- **Staging** is isolated: separate Railway Postgres and volume, separate encryption and session secrets, and no production Plaid credentials. Do not connect real financial institutions to staging.

Before staging sign-in is enabled, add `https://clarity-networth-staging.up.railway.app` to a dedicated Google OAuth client’s Authorized JavaScript origins, then set that client ID only in staging.

## Backups and recovery

Postgres is the primary encrypted financial-data store. The application also maintains an encrypted per-user mirror and a daily encrypted snapshot on its Railway volume. Snapshots retain 35 days and are removed with a user’s account deletion request.

This protects against a bad application write or database loss, but it is not an off-site disaster-recovery system. Before public launch, configure a separate encrypted backup destination and test a complete restore there at least quarterly.

## Monitoring

- Railway calls `/api/health` for deploy health checks. The endpoint fails closed if secure production configuration or PostgreSQL is unavailable.
- GitHub Actions checks the production health endpoint hourly. A failed run is a signal to investigate immediately.
- Railway logs must never contain financial payloads, access tokens, cursors, or secrets.

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
