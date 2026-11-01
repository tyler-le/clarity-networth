# Clarity

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Everyday adults who want to understand their money quickly, including people
new to investing or overwhelmed by traditional finance software. Financial
success does not imply fluency in financial terminology. Mobile is a primary
way to use the product.

## Product Purpose

Clarity is a calm, beginner-friendly personal-finance app. In roughly 30
seconds, it should answer: Where do I stand? What changed? What is the one
useful thing I can do or understand next?

## Positioning

A focused financial picture with a quick check-in first and details on
demand. Clarity is not a trading terminal, budgeting spreadsheet, or collection
of financial widgets. No exclusive market or competitive claims are established.

## Operating Context

People can explore a public demo without signing in. Personal accounts belong
to each signed-in user. Clarity is an installable responsive PWA used from a
browser on phones, tablets, laptops, and desktops; no app-store download is
required. Development is local. Production promotion uses the manual
`deploy-to-prod` workflow with required tests and smoke checks.

## Capabilities and Constraints

- Net worth, verified daily snapshots, assets, and money owed.
- Cash flow, income, spending categories, saving, investing, and transactions.
  Transfers and card payments must not double-count spending.
- Connected and manual accounts, nicknames, duplicate detection, unlinking,
  and an optional debt-payoff plan.
- Investments, holdings, allocation, account context, and corrections for
  incomplete provider classifications.
- Retirement milestones and assumptions, goals, and check-ins.
- Provider data, user input, estimates, and demo data must remain distinguishable.
  Never invent history, rates, returns, contribution sources, or identities.
- Preserve explicit user overrides across syncs until cleared. Missing provider
  fields must produce honest, usable states rather than guesses.
- Isolate user data by authenticated storage key. Never log secrets, tokens,
  raw financial payloads, or personally identifying financial data.
- Use familiar language; spell out Financial Independence and explain Coast
  Financial Independence when first introduced.

## Brand Commitments

The product name is Clarity. Its voice is calm, direct, familiar, and
nonjudgmental. Normal debt or a market dip must not feel punitive or alarming.
Avoid finance jargon, empty-state guilt, decorative copy, and generic helper
text. Existing app identity and assets remain the reference for scoped
refinements; initialization does not authorize a redesign.

## Evidence on Hand

- `AGENTS.md`: authoritative product, design, data, accessibility, and delivery
  requirements supplied by the user.
- `README.md`: existing capabilities, architecture, local operation, and demo
  description.
- `public/`: incumbent app implementation, manifest, icons, and installation
  assets.
- `test/`: financial calculations, API integration coverage, and browser journeys.
- Demo data is representative demonstration content, not customer evidence.
  No testimonials, customer counts, performance claims, or benchmarks are
  established by this product record.

## Product Principles

1. Prioritize recurring understanding, decisions, and confidence over feature
   count; improve reliability and clarity before adding marginal surfaces.
2. Offer one primary takeaway and one optional deeper action. Reveal dense or
   stressful detail after a deliberate interaction.
3. Make purposes understandable to beginners without a tooltip.
4. Work honestly with incomplete provider data and preserve user corrections.
5. Give every surface a clear check-in before supporting detail, with controls
   kept beside the answers they change.

## Accessibility & Inclusion

Never rely on color alone. Support readable contrast in light and dark modes,
large touch targets, readable text, stable responsive layouts, and adequate
space above mobile navigation. Primary flows must not require horizontal
scrolling. Charts must have honest scales, readable axes, responsive dimensions,
and useful interaction. Responsive UI changes require browser coverage on
phone, tablet, laptop, and desktop.
