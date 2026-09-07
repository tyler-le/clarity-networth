# Clarity contributor guide

Clarity is a calm, beginner-friendly financial app. Prefer one clear action
over extra dashboards, finance jargon, or visually urgent treatment of normal
financial situations.

## Core product principles

**Audience:** everyday adults who want to understand their money quickly,
including people who are new to investing or feel overwhelmed by traditional
finance software. They may be successful financially without being fluent in
finance terminology. Do not design only for power users.

**Promise:** Clarity should answer, in roughly 30 seconds: *Where do I stand?*
*What changed?* and *What is the one useful thing I can do or understand next?*
It is not a trading terminal, a budgeting spreadsheet, or a collection of
financial widgets.

Use these feature filters before adding or expanding a surface:

1. Does it improve a real recurring decision, understanding, or confidence?
2. Can a beginner understand its purpose without a tooltip?
3. Does it earn its screen space over a simpler existing view?
4. Can it be reduced to one primary takeaway and one optional deeper action?
5. Does it work honestly with incomplete bank/provider data?

If the answer to any of these is no, simplify, defer, place it behind
progressive disclosure, or do not add it. Prefer improving reliability and
clarity in existing core flows over adding a marginal feature.

## Design standards

- Make the important answer visually dominant: use a clear title, a single
  primary number or takeaway, restrained supporting copy, and an obvious next
  action. Do not make every number bold or every card visually prominent.
- Start high level; reveal detail only after a deliberate tap/click. This is
  especially important for debt, retirement, holdings, transactions, and
  assumptions. Normal debt or a market dip must not make the product feel
  punitive or alarming.
- Use familiar language such as “money you owe,” “save most interest,” and
  “small wins first.” Explain any unavoidable financial concept in context.
- Prefer direct labels over decorative copy. Avoid redundant explanations,
  empty-state guilt, generic helper text, and duplicate controls.
- Use color sparingly and semantically: green for positive/progress, red or
  coral for debt and negative states, and neutral surfaces for normal context.
  Never rely on color alone. Dark mode must retain calm contrast without
  washing the experience in accent color.
- Use visualizations only when they clarify a relationship or trend better than
  a compact number or sentence. Charts must have honest scales, readable axes,
  responsive dimensions, and useful interaction. Do not add decorative charts.
- Respect device context. Mobile is a primary experience: large touch targets,
  no clipped text, no horizontal scrolling, stable layouts, and enough bottom
  space above navigation. Desktop may use available width but must not turn
  whitespace into a reason to add low-value content.

## Product and UI

- Preserve the visual hierarchy: a quick check-in first, details on demand.
- Do not introduce a new tab or permanent card unless it delivers distinct,
  recurring value. Use progressive disclosure for potentially stressful or
  dense topics such as debt, retirement assumptions, and transactions.
- Use plain language. Spell out Financial Independence; explain terms such as
  Coast Financial Independence when they are first introduced.
- Keep responsive behavior intentional across phone, tablet, laptop, and
  desktop. Avoid hard-coded dimensions that truncate, overlap, or shift content.
- Demo data must be coherent, realistic, fully categorized, and exercise the
  same states people see with real accounts. Update demo API/UI assertions when
  demo data changes.

## Financial data and correctness

- Never fabricate financial history, rates, returns, contribution sources, or
  account identities. Clearly distinguish verified provider data from user
  input and from demo data.
- Prefer provider data where it is available; preserve explicit user overrides
  across syncs until the user clears them.
- Handle missing provider fields gracefully. A missing APR, account mask, or
  holdings response must not produce a guessed value or break the UI.
- Keep all user data isolated by authenticated storage key. Do not log secrets,
  tokens, raw financial payloads, or personally identifying financial data.

## Changes and tests

- Before changing behavior, locate the existing unit, integration, and UI tests
  that cover it. Update all affected expectations in the same change.
- Every new feature or user-visible behavior change must add or update its
  relevant tests in the same commit. A feature is not complete until its
  correctness and supported-device behavior are covered.
- Add a focused unit test for calculations and an integration test for changed
  API contracts. Add a Playwright interaction test whenever a user-visible
  action, loading state, or layout changes.
- Run `npm run test:ci` before committing or pushing. It is required locally
  and in GitHub Actions. Do not use `git push --no-verify` to bypass a failing
  suite.
- When a full suite is impractical during iteration, run the smallest relevant
  tests first, then run `npm run test:ci` before the final commit.
- Treat a failed GitHub Action as actionable evidence: read the failed log,
  identify whether it is an assertion, deterministic bug, infrastructure issue,
  or flaky timing failure, and fix or stabilize it before proceeding.
- Browser tests must cover the supported Playwright projects: phone, tablet,
  laptop, and desktop when a responsive component is affected.

## Delivery

- Keep commits narrowly scoped and descriptive.
- A push to `main` runs: full test suite → staging deployment and smoke test →
  production promotion and smoke test. Never bypass staging in code or CI.
- Do not make unrelated refactors while fixing a bug. Preserve user changes in
  the working tree.
