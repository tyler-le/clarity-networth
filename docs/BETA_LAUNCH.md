# Private beta launch checklist

For beta-user installation instructions, see [Install Clarity on your phone](./PWA_INSTALL.md).

Clarity is ready for a small, invite-only beta after every item below is true. This document deliberately separates work enforced by the app from work that needs an account owner or legal/business decision.

## Enforced by the app and CI

- Per-user financial stores and Plaid access tokens are encrypted at rest.
- Account data is never cached by the browser, CDN, or API responses.
- Google sign-in, signed secure cookies, origin checks, rate limits, and production security configuration are required before private API access.
- Users can unlink institutions, export their stored data, and permanently delete their account and financial data.
- The public Privacy Policy, Terms, and Help & Feedback pages are available before sign-in.
- Every push runs unit, integration, and browser journeys at phone, tablet, laptop, and desktop breakpoints; production deploys only after staging and its smoke check pass.
- GitHub checks production availability hourly through `/api/health`.

## One-time owner setup before inviting anyone

1. In both Railway environments, set a dedicated `SUPPORT_EMAIL`. Use an inbox you monitor; it appears in the app's legal and support pages.
2. Keep production values set to `NODE_ENV=production`, `DEMO_MODE=false`, distinct long random `DATA_ENCRYPTION_KEY` and `SESSION_SECRET` values, `DATABASE_URL`, and the production Google OAuth client ID. The service refuses private API requests if critical production configuration is missing.
3. In Google Cloud, set the production domain as an authorized JavaScript origin and authorized redirect origin where required.
4. In Plaid, complete Production access and configure the production webhook as `https://YOUR_DOMAIN/api/plaid/webhook`. Confirm the requested products and institution coverage match the beta.
5. Confirm the production Railway volume/database backup policy and restrict Railway/GitHub access to people who need it.
6. Verify the GitHub Actions secrets `RAILWAY_STAGING_TOKEN` and `RAILWAY_TOKEN` remain scoped to their respective environments.

## First beta cohort

- Invite 3–5 trusted testers first with a private `INVITE_CODE`. Rotate the code if it is shared beyond the intended group.
- Ask each person to sign in, link one institution, inspect Net Worth and Cash Flow, and unlink it. They should never share credentials or account numbers with you.
- Review Railway logs and the hourly health workflow for several days. Treat an authentication, data-isolation, deletion, or Plaid-token issue as a pause-the-beta event.
- Expand slowly only after normal daily syncs and the release pipeline remain stable.

## Before a public launch

Obtain professional legal/privacy advice relevant to your jurisdiction, establish a customer-support process, finalize incident response and backup/restore drills, and complete Plaid's production/compliance requirements. Those business and legal decisions cannot be completed by application code alone.
