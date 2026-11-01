---
name: Clarity
description: A calm financial check-in with detail on demand.
colors:
  canvas: "#f4f6f2"
  surface: "#ffffff"
  ink: "#1d2b26"
  muted: "#606f67"
  primary: "#1d6c48"
  loss: "#a23f3e"
  answer-bg: "#173f31"
  answer-text: "#f6fbf5"
  answer-muted: "#d2e4d8"
  answer-gain: "#c6f2d7"
  answer-loss: "#ffcac3"
  navigation-bg: "#eef2ec"
  navigation-selected: "#dcebe0"
  navigation-ink: "#19543a"
  control-border: "#87988d"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "27px"
    fontWeight: 650
    letterSpacing: "-0.025em"
  answer:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 650
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 650
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
rounded:
  control: "10px"
  group: "14px"
  surface: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "11px 16px"
    height: "44px minimum"
  financial-answer:
    backgroundColor: "{colors.answer-bg}"
    textColor: "{colors.answer-text}"
    rounded: "{rounded.surface}"
---

# Clarity design system

## Overview

A quick check-in leads each destination. One dominant answer comes before a
plain-language interpretation, then supporting detail. This direction follows
the approved interactive prototype and the user's requests for stronger
hierarchy, meaningful color, cohesive screens, and fewer disconnected cards.
PRODUCT.md owns product truth; public/styles.css owns implemented tokens.

## Colors

Use the forest answer surface for the main answer, not for every supporting
section. White or mineral-white text belongs on that surface; use the answer
gain/loss tokens for signed movement there. Ordinary green gain text is for
light surfaces and must not be reused on dark green backgrounds.

Green means positive movement or action. Muted red means loss or money owed.
Always pair financial color with a sign, label, or other non-color cue.
Balance changes include transfers; they are not labeled market returns.
Investment categories use stable blue, teal, ochre, and neutral classifications
from investmentClassColor; do not infer stock exposure from an ETF ticker.

Dark mode keeps supporting surfaces neutral and uses softer light text.
Primary buttons reverse to a pale green fill with dark text. Answer surfaces
use --answer-bg #24332c, --answer-text #edf0f2, --answer-gain #b5eac9,
and --answer-loss #ffc6bf. Test rendered pairs rather than token names alone.

## Typography

Use the existing system sans stack for UI and data. The Clarity wordmark uses
Georgia. Headlines are 27px on desktop and 25px on phones; primary answers
are 44px and 38px respectively. Use restrained secondary sizes and tabular
numerals. Controls and labels must remain legible without becoming the focal
point. Avoid oversized headings, decorative uppercase labels, and dense bold
numbers competing with the primary answer.

## Layout

Desktop has a side navigation; phones and tablets use the existing bottom
navigation. Preserve all five primary destinations. Phone padding is 18px
with space above the bottom navigation. Shared range controls remain sticky
and visibly govern their related graph and figures.

Use proximity and dividers to connect related information. Accounts presents
one grouped list, rather than equal-sized independent widgets. Account groups
start collapsed with their totals and counts visible. Investment accounts
also start collapsed; holdings appear underneath after expansion. Preserve
the user's choices during in-session rerenders and period changes.

## Elevation & Depth

Ordinary app surfaces use a border or a tonal change, with no resting shadow.
Dialogs remain separate layers. Preserve tooltips, native disclosure, focus,
and scrolling; styling must not clip planning help or diagram controls.

## Shapes

Controls use 10px corners; groups use 12–14px; primary surfaces use 16px.
On narrow screens Connect is a labeled-for-accessibility 44×44 icon button.
Its visible text must not wrap or overlap the profile control.

## Components

The same financial-answer surface is used on Net Worth, Cash Flow,
Investments, and Retirement. Supporting account balances remain neutral.
Retirement projections are not actual gains and should use answer text.

Keep the verified time-series graphs and cash-flow Sankey. Account and
holding history remain available. Allocation filters open the combined
holdings view explicitly. Missing holdings retain a truthful explanation and
the provider account balance. Dense lists and assumptions are disclosed.

The Debt plan section has been removed from Accounts at the user's request.
Debt accounts and their balances remain available in the grouped list.

## Do's and Don'ts

- Do apply the shared shell, typography, controls, and color roles across the
  entire app, including Profile, sign-in, and dialogs.
- Do check phone, tablet, laptop, desktop, and both themes.
- Do preserve charts, the Sankey diagram, and existing account workflows.
- Don't show synthetic prototype gains as provider-verified performance.
- Don't replace missing provider classifications or history with guesses.
- Don't use dark green text on a dark green answer surface.
- Don't add a card around every line or let every number compete equally.
