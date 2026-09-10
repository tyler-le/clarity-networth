import { filterSnapshots, netWorthRangeBounds, preferredNetWorthRange, uniqueDailySnapshots } from '/chart-utils.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const themeStorageKey = 'clarity-theme';
const onboardingStorageKey = 'clarity-connection-onboarding-seen';

function isDevelopmentEnvironment() {
  return /(^localhost$)|(^127\.0\.0\.1$)|staging/i.test(location.hostname);
}

function applyEnvironmentIdentity() {
  if (!isDevelopmentEnvironment()) return;
  document.documentElement.dataset.environment = 'development';
  document.title = 'Clarity DEV';
  $$('.environment-badge').forEach((badge) => { badge.hidden = false; });
}

applyEnvironmentIdentity();

const state = {
  dashboard: null,
  spending: null,
  investments: null,
  retirement: null,
  networthRange: 'ytd',
  networthRangeInitialized: false,
  spendingRange: '1m',
  spendingMonth: null,
  allocationDisplay: 'percentage',
  spendingCategory: 'all',
  spendingSort: 'recent',
  // Set after the first verified portfolio payload arrives. Starting at "all"
  // avoids a transient 1Y selection that would turn a new connection into a
  // misleading vertical spike.
  investmentRange: 'all',
  investmentRangeInitialized: false,
  investmentFilter: 'all',
  investmentSort: 'value',
  holdingHistory: null,
  holdingHistoryMode: 'position',
  holdingHistoryRange: '1y',
  expandedAccountGroups: new Set(),
  holdingsExpanded: false,
  demoGoal: null,
  demoGoalInitialized: false,
  debtPlanExpanded: false,
  view: 'overview',
  returnView: 'overview',
  demoPreview: false,
  // A signed-in member with no connections sees the real product composition
  // populated by a clearly disclosed sample payload. Their actual dashboard
  // remains empty so actions such as Link always operate on their own account.
  onboardingPreview: null
};

const accountGroupOrder = ['Cash', 'Savings', 'Investments', 'Credit cards', 'Loans & debt', 'Other'];
const accountGroupIcons = { Cash: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 9h1M17 15h1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>', Savings: '◒', Investments: '↗', 'Credit cards': '▣', 'Loans & debt': '−', Other: '◇' };

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

// Tooltips are centered on their selected point, except at either edge where
// centering would place part of the value outside the chart (or its dialog).
function placeChartTooltip(tooltip, anchorX, chartWidth) {
  const inset = 8;
  const halfWidth = Math.min(tooltip.offsetWidth / 2, Math.max(0, (chartWidth - inset * 2) / 2));
  const left = Math.max(inset + halfWidth, Math.min(chartWidth - inset - halfWidth, anchorX));
  tooltip.style.left = `${left}px`;
}

async function api(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = response.status === 401 ? 'Your session has expired. Please sign in again.'
          : response.status === 429 && url.startsWith('/api/plaid/')
            ? (data.error || 'Too many connection attempts. Please wait a few minutes and try again.')
            : response.status === 429 ? 'You’ve refreshed recently. Please wait a few minutes and try again.'
          : response.status >= 500 ? 'We couldn’t reach your financial data right now. Your saved data is still here—please try again shortly.'
          : data.error && !/request failed|gateway|server error/i.test(data.error) ? data.error
          : 'Something went wrong. Please try again.';
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error;
      if (attempt === 0 && (!navigator.onLine || error instanceof TypeError)) await new Promise((resolve) => setTimeout(resolve, 550));
      else break;
    }
  }
  if (lastError instanceof TypeError) throw new Error('We couldn’t connect right now. Check your internet connection and try again.');
  throw lastError;
}

// Private-beta success telemetry is intentionally tiny and invisible: no
// amounts, merchants, account names, routes, or click replay leave the app.
// A failed telemetry request must never interrupt financial data or UI flow.
function trackProductEvent(event) {
  if (!state.dashboard || state.demoPreview || state.dashboard.demoMode) return;
  fetch('/api/launch-event', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event })
  }).catch(() => {});
}

// A card view is deliberately stricter than a scroll: the primary content has
// to be at least half visible for 750ms. This lets product reporting describe
// whether a non-interactive card was actually seen, without collecting scroll
// position, mouse data, or any financial content.
const coreCardViewEvents = {
  netWorthCard: 'net_worth_card_viewed',
  goalInsight: 'goal_card_viewed',
  cashFlowOverviewCard: 'cash_flow_overview_viewed',
  monthlyCashFlowCard: 'monthly_cash_flow_viewed',
  investmentHoldingsPanel: 'investment_holdings_viewed',
  investmentAllocationCard: 'investment_allocation_viewed',
  retirementOutlookCard: 'retirement_outlook_viewed',
  retirementSpendingTargetsCard: 'retirement_spending_targets_viewed',
  debtPayoffCard: 'debt_payoff_viewed'
};
let coreCardObserver;
const coreCardTimers = new Map();
const coreCardTracked = new Set();

function observeCoreCardViews() {
  if (state.demoPreview || state.dashboard?.demoMode || coreCardObserver || !('IntersectionObserver' in window)) return;
  coreCardObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const event = coreCardViewEvents[entry.target.id];
      if (!event || coreCardTracked.has(event)) return;
      if (!entry.isIntersecting || entry.intersectionRatio < 0.5) {
        clearTimeout(coreCardTimers.get(event));
        coreCardTimers.delete(event);
        return;
      }
      if (coreCardTimers.has(event)) return;
      const timer = window.setTimeout(() => {
        coreCardTimers.delete(event);
        if (coreCardTracked.has(event)) return;
        coreCardTracked.add(event);
        trackProductEvent(event);
      }, 750);
      coreCardTimers.set(event, timer);
    });
  }, { threshold: [0.5] });
  Object.keys(coreCardViewEvents).forEach((id) => {
    const card = document.getElementById(id);
    if (card) coreCardObserver.observe(card);
  });
}

function institutionMark(account) {
  if (account.institution_logo) return `<img class="institution-logo" src="${escapeHtml(account.institution_logo)}" alt="" />`;
  return `<span class="institution-fallback" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 9.5 12 4l9 5.5M5.5 11h13M6.5 11v7M11 11v7M15.5 11v7M4 20h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}

function showNotice(message, tone = 'warn') {
  const el = $('#notice');
  el.textContent = message;
  el.classList.remove('hidden');
  if (tone === 'success') setTimeout(() => el.classList.add('hidden'), 3200);
}

function setAppStatus(message = '') {
  const el = $('#appStatus');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

function setInitialLoading(loading) {
  $('#loadingSkeleton')?.classList.toggle('hidden', !loading);
  $('#appShell')?.classList.toggle('initial-loading', loading);
  $('#appShell')?.setAttribute('aria-busy', String(loading));
}

function savedTheme() {
  try {
    if (localStorage.getItem(themeStorageKey) === 'dark') return 'dark';
  } catch { /* Cookie fallback below. */ }
  return /(?:^|; )clarity-theme=dark(?:;|$)/.test(document.cookie) ? 'dark' : 'light';
}

function applyTheme(theme, persist = true) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : '';
  $('#themeColor')?.setAttribute('content', dark ? '#111513' : '#f6f7f4');
  const toggle = $('#themeToggle');
  if (toggle) toggle.checked = dark;
  if (persist) {
    // Keep a small non-sensitive cookie fallback. Some browsers can make
    // localStorage temporarily unavailable, but a chosen appearance should
    // still survive the next launch without delaying the initial paint.
    try { localStorage.setItem(themeStorageKey, dark ? 'dark' : 'light'); } catch { /* Cookie fallback remains available. */ }
    document.cookie = `clarity-theme=${dark ? 'dark' : 'light'}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  }
}

function setView(view) {
  if (view !== 'profile') state.returnView = view;
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `${view}View`));
  $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const pageMeta = {
    overview: ['Net Worth', 'Your financial picture'],
    spending: ['Cash flow', 'Income and money out'],
    investments: ['Investments', 'Your portfolio'],
    retirement: ['Retirement', 'A simple plan for later'],
    accounts: ['Accounts', 'What you own and owe'],
    profile: ['Profile', 'Settings']
  }[view] || [view[0].toUpperCase() + view.slice(1), ''];
  $('#pageTitle').textContent = pageMeta[0];
  $('#monthLabel').textContent = pageMeta[1];
  $('#connectButton').classList.toggle('hidden', view === 'profile' || Boolean(state.onboardingPreview));
  $('#profileBack').classList.toggle('hidden', view !== 'profile');
  $('#profileButton').classList.toggle('hidden', view === 'profile');
  const launchEvent = {
    spending: 'cash_flow_viewed', investments: 'investments_viewed',
    retirement: 'retirement_viewed', accounts: 'accounts_viewed'
  }[view];
  if (launchEvent) trackProductEvent(launchEvent);
  if (view === 'overview' && state.dashboard) {
    requestAnimationFrame(() => {
      renderNetWorthChartWhenVisible();
    });
  }
  if (view === 'investments' && state.investments) requestAnimationFrame(() => renderInvestments(state.investments));
  if (view === 'retirement' && state.retirement) requestAnimationFrame(() => renderRetirement(state.retirement));
  if (state.onboardingPreview) requestAnimationFrame(applyOnboardingPreviewCopy);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function applyOnboardingPreviewCopy() {
  if (!state.onboardingPreview) return;
  const copy = {
    netWorth: 'Your net worth',
    netWorthDelta: 'Built from connected balances',
    netWorthMovementTitle: 'Understand what changed',
    netWorthMovementDetail: 'See balance and debt movement over time.',
    investmentTotal: 'Your portfolio',
    investmentContext: 'Value, holdings, and performance in one view.',
    spendingTotal: 'Your monthly cash flow',
    cashflowHeadline: 'Income, spending, and saving in one view',
    spendingContext: 'Track what comes in, what goes out, and what is left.',
    spendingPeriodSummary: 'Your activity over time',
    monthlyCashFlowPeriod: 'Your monthly pattern',
    trendDetail: 'Compare income and spending by month.',
    retirementProjection: 'Your retirement outlook',
    retirementProjectionContext: 'Grounded in your balances and spending.',
    retirementAgeChip: 'Your timeline',
    retirementSpendContext: 'Targets reflect the life you want to fund.',
    retirementAssumption: 'Your plan',
    goalTitle: 'Build toward what matters',
    goalDetail: 'Track a goal from your connected balances.',
    clarityCheckinTitle: 'See your next meaningful step',
    clarityCheckinDetail: 'Clarity connects your current picture to a longer-term plan.'
  };
  Object.entries(copy).forEach(([id, text]) => {
    const element = $(`#${id}`);
    if (!element) return;
    element.textContent = text;
    element.classList.add('preview-copy');
  });
}

function restoreNetWorthHero() {
  const d = state.onboardingPreview?.dashboard || state.dashboard;
  if (!d) return;
  const s = d.summary;
  const accounts = d.accounts || [];
  if (!accounts.length) {
    $('#netWorth').textContent = '—';
    $('#netWorthDelta').textContent = 'Connect your first account';
    $('#netWorthChartContext').classList.add('hidden');
    $('#netWorthChart').innerHTML = '<div class="chart-empty"><span aria-hidden="true">⌁</span><b>Your financial picture starts here</b><small>Connect an account whenever you’re ready.</small></div>';
    return;
  }
  $('#netWorth').textContent = fmt.format(s.netWorth);
  $('#netWorthChartContext').classList.add('hidden');
  const snaps = visibleSnapshots(d.snapshots || []);
  if (snaps.length < 2) {
    $('#netWorthDelta').textContent = 'Tracking starts today';
    return;
  }
  const old = snaps.length > 1 ? Number(snaps[0].net_worth) : s.netWorth;
  const delta = s.netWorth - old;
  const startDate = snaps[0]?.date ? new Date(`${snaps[0].date}T12:00:00`) : null;
  const periodStart = startDate?.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) || 'start';
  $('#netWorthDelta').textContent = `${delta >= 0 ? '+' : '−'}${fmt.format(Math.abs(delta))} since ${periodStart}`;
}

function renderOverviewBriefing(data) {
  const accounts = data.accounts || [];
  const cash = accounts.filter((account) => account.type === 'depository').reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);
  const invested = accounts.filter((account) => account.type === 'investment').reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);
  const debt = accounts.filter(isDebt).reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);
  $('#overviewCash').textContent = fmt.format(cash);
  $('#overviewInvested').textContent = fmt.format(invested);
  $('#overviewDebt').textContent = fmt.format(debt);

  const runway = data.runway || {};
  $('#balanceSheetContext').textContent = runway.runwayMonths != null
    ? `${Math.min(99, Number(runway.runwayMonths)).toFixed(1)} months of essential costs in cash.`
    : 'Your assets and debt, based on your connected accounts.';

  const snapshots = visibleSnapshots(data.snapshots || []);
  const movement = $('#netWorthMovement');
  if (snapshots.length < 2) {
    movement.dataset.tone = 'steady';
    $('#netWorthMovementTitle').textContent = 'Tracking starts today';
    $('#netWorthMovementDetail').textContent = 'Your connected balances are saved daily, so the story behind your net worth grows from here.';
    return;
  }
  const baseline = snapshots[0];
  // The chart and its companion copy must use the same observed range.
  const current = snapshots.at(-1);
  const netChange = Number(current.net_worth || 0) - Number(baseline.net_worth || 0);
  const assetChange = Number(current.assets || 0) - Number(baseline.assets || 0);
  const debtChange = Number(current.liabilities || 0) - Number(baseline.liabilities || 0);
  movement.dataset.tone = netChange > 0 ? 'positive' : netChange < 0 ? 'watch' : 'steady';
  $('#netWorthMovementTitle').textContent = netChange === 0 ? 'Net worth was steady' : `Net worth ${netChange > 0 ? 'rose' : 'fell'} ${fmt.format(Math.abs(netChange))}`;
  const assetText = assetChange === 0 ? 'Assets were steady' : `Assets ${assetChange > 0 ? 'rose' : 'fell'} ${fmt.format(Math.abs(assetChange))}`;
  const debtText = debtChange === 0 ? 'debt was steady' : `debt ${debtChange < 0 ? 'fell' : 'rose'} ${fmt.format(Math.abs(debtChange))}`;
  $('#netWorthMovementDetail').textContent = `${assetText}; ${debtText}.`;
}

function renderClarityLayer(data) {
  const checkin = data.clarityCheckin || {};
  $('#clarityCheckin').classList.toggle('hidden', !checkin.available);
  if (checkin.available) {
    $('#clarityCheckin').dataset.action = checkin.action || 'overview';
    $('#clarityCheckin').dataset.tone = checkin.tone || 'steady';
    $('#clarityCheckinTitle').textContent = checkin.title;
    $('#clarityCheckinDetail').textContent = checkin.detail;
    $('#clarityCheckinAction').textContent = checkin.actionLabel || 'View details';
    $('#clarityCheckinMark').textContent = checkin.tone === 'attention' ? '!' : checkin.tone === 'watch' ? '•' : '✦';
  }
  const demoExperience = isDemoExperience();
  // Initialize the throwaway goal once per demo entry. After someone removes
  // or replaces it, their local demo action should remain visible instead of
  // being resurrected from the original demo payload on every render.
  if (demoExperience && !state.demoGoalInitialized) {
    state.demoGoal = data.goals?.[0] || null;
    state.demoGoalInitialized = true;
  }
  const goals = demoExperience ? (state.demoGoal ? [state.demoGoal] : []) : (data.goals || []);
  const goal = goals[0];
  $('#goalAction').textContent = goal ? 'Remove' : 'Add goal';
  if (goal) {
    $('#goalTitle').textContent = goal.name;
    const detail = goal.source === 'debt' ? `${fmt.format(goal.current)} remaining of ${fmt.format(goal.target)} starting debt` : `${fmt.format(goal.current)} of ${fmt.format(goal.target)}`;
    $('#goalDetail').textContent = demoExperience ? `Demo only · ${detail}` : detail;
    $('#goalProgress').style.width = `${Math.round(goal.progress * 100)}%`;
  } else { $('#goalTitle').textContent = 'Set a goal'; $('#goalDetail').textContent = 'Track a cash, investment, net-worth, or debt goal from your real balances.'; $('#goalProgress').style.width = '0%'; }
  const attention = (data.connectionHealth || []).filter((item) => item.state !== 'healthy');
  // The check-in already explains a connection issue at the highest priority;
  // do not repeat it immediately below and dilute the visual hierarchy.
  $('#connectionAttention').classList.toggle('hidden', !attention.length || checkin.action === 'profile');
  if (attention.length) {
    const stale = attention[0];
    $('#connectionAttentionTitle').textContent = stale.state === 'stale' ? `${stale.institution_name} update is delayed` : `${stale.institution_name} needs attention`;
    $('#connectionAttentionDetail').textContent = stale.state === 'stale' ? 'This connection has not updated recently. We will keep retrying automatically.' : 'This connection could not update. We will retry automatically.';
  }
}

function demoGoalProgress({ name, source, target }) {
  const accounts = state.dashboard?.accounts || [];
  const totalFor = (type) => accounts.filter((account) => account.type === type).reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);
  const current = source === 'cash' ? totalFor('depository')
    : source === 'investments' ? totalFor('investment')
      : source === 'debt' ? accounts.filter(isDebt).reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0)
        : Number(state.dashboard?.summary?.netWorth || 0);
  const debt = source === 'debt';
  return { id: 'demo-goal', name, source, target, current, progress: target ? Math.min(1, debt ? Math.max(0, 1 - current / target) : Math.max(0, current / target)) : 0 };
}

function renderRecurringCharges(recurring = {}) {
  const panel = $('#recurringCharges');
  const rows = recurring.recurring || [];
  panel.classList.toggle('hidden', !rows.length);
  if (!rows.length) return;
  const upcoming = recurring.upcoming?.[0];
  $('#recurringHint').textContent = upcoming ? `Next likely · ${new Date(`${upcoming.nextDate}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : `${rows.length} tracked`;
  $('#recurringList').innerHTML = rows.map((charge) => `<button type="button" data-recurring-charge="${escapeHtml(charge.key)}"><span>${escapeHtml(charge.name)}<small>${charge.cadence} · ${upcoming?.key === charge.key ? 'likely next' : `last ${new Date(`${charge.lastDate}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}</small></span><strong>${fmt.format(charge.amount)}</strong></button>`).join('');
}

function netWorthRangeLabel(range) {
  return ({ '1m': '1 month', '3m': '3 months', '6m': '6 months', ytd: 'Year to date', '1y': '1 year', all: 'All history' })[range] || 'Year to date';
}

function visibleSnapshots(snapshots) {
  return uniqueDailySnapshots(filterSnapshots(snapshots, state.networthRange));
}

function setInitialNetWorthRange(snapshots) {
  if (state.networthRangeInitialized) return;
  state.networthRange = preferredNetWorthRange(uniqueDailySnapshots(snapshots));
  state.networthRangeInitialized = true;
  $$('[data-networth-range]').forEach((control) => control.classList.toggle('active', control.dataset.networthRange === state.networthRange));
}

// The first response can arrive while the calm loading shell is still hiding
// the view. Rendering an SVG at that point produces a zero-width chart. Keep
// the existing contents until the card has real layout, then draw normally.
function renderNetWorthChartWhenVisible(attempt = 0) {
  if (state.view !== 'overview' || !state.dashboard) return;
  const chart = $('#netWorthChart');
  if (chart.clientWidth < 80 || chart.clientHeight < 60) {
    if (attempt < 8) requestAnimationFrame(() => renderNetWorthChartWhenVisible(attempt + 1));
    return;
  }
  restoreNetWorthHero();
  const rangeStart = netWorthRangeBounds(state.networthRange).startDate;
  const d = state.onboardingPreview?.dashboard || state.dashboard;
  renderLineChart(visibleSnapshots(d.snapshots || []), d.summary, rangeStart);
}

function axisCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 0 }).format(value);
}

function renderLineChart(snapshots, summary, rangeStart = null) {
  const el = $('#netWorthChart');
  // A hidden view reports a zero width. Leave the existing chart intact until
  // the view is visible, when setView/resize will render it at real size.
  if (el.clientWidth < 80 || el.clientHeight < 60) return;
  if (snapshots.length < 2) {
    renderTimelineStart(el, snapshots.at(-1), summary, rangeStart);
    return;
  }

  const width = Math.max(1, Math.round(el.clientWidth || 700));
  const height = Math.max(1, Math.round(el.clientHeight || 150));
  const plotLeft = 48, plotRight = 8, plotTop = 8, plotBottom = height - 22;
  const dateValue = (date) => new Date(`${date}T12:00:00`).getTime();
  const firstObserved = dateValue(snapshots[0].date);
  const requestedStart = rangeStart ? dateValue(rangeStart) : firstObserved;
  const domainStart = Math.min(firstObserved, requestedStart);
  const domainEnd = Math.max(domainStart + 86_400_000, dateValue(snapshots.at(-1).date));
  const xForDate = (date) => plotLeft + ((dateValue(date) - domainStart) / (domainEnd - domainStart)) * (width - plotLeft - plotRight);
  const vals = snapshots.map((s) => Number(s.net_worth));
  let min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || Math.max(Math.abs(max) * .1, 1);
  min -= range * .08;
  max += range * .08;
  const points = vals.map((v, i) => {
    const x = xForDate(snapshots[i].date);
    const y = plotBottom - ((v - min) / (max - min)) * (plotBottom - plotTop);
    return [x, y];
  });
  const d = points.map(([x,y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${d} L ${points.at(-1)[0]} ${plotBottom} L ${points[0][0]} ${plotBottom} Z`;
  const yTicks = [max, (max + min) / 2, min];
  const yAxis = yTicks.map((value) => {
    const y = plotBottom - ((value - min) / (max - min)) * (plotBottom - plotTop);
    return `<line x1="${plotLeft}" y1="${y}" x2="${width - plotRight}" y2="${y}" class="chart-grid"/><text x="${plotLeft - 6}" y="${y + 3}" text-anchor="end" class="chart-axis-label chart-y-axis-label">${axisCurrency(value)}</text>`;
  }).join('');
  // Repeating "Sep 2026" across a short range looks like a broken axis. Use
  // days for any short window (including one that crosses a month boundary),
  // then graduate to month/year as the selected range expands.
  const sameMonth = new Date(domainStart).getFullYear() === new Date(domainEnd).getFullYear() && new Date(domainStart).getMonth() === new Date(domainEnd).getMonth();
  const shortRange = domainEnd - domainStart <= 45 * 86400000;
  const hasUntrackedLead = domainStart < firstObserved;
  // A long selected range can still contain only a few very recent verified
  // points. Those endpoints need day labels, not two indistinguishable
  // "Sep 2026" labels at the right edge.
  const verifiedSpanIsShort = domainEnd - firstObserved <= 45 * 86400000;
  const dateLabel = (time) => new Date(time).toLocaleDateString('en-US', sameMonth || shortRange || (hasUntrackedLead && verifiedSpanIsShort) ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' });
  // Short spans need distinct days, not three calendar labels that round to
  // the same day. Longer spans retain a middle label for quick orientation.
  const tickTimes = sameMonth || width <= 420 ? [domainStart, domainEnd] : [domainStart, (domainStart + domainEnd) / 2, domainEnd];
  // The dashed lead-in explains the unavailable part of a selected range;
  // retain the first verified date and the latest date for orientation.
  const endpointTicks = [...new Set(hasUntrackedLead ? [firstObserved, domainEnd] : tickTimes)];
  // If two endpoint labels would occupy the same few pixels, showing both
  // harms legibility. The tracking annotation already identifies the start;
  // keep one unambiguous latest-date label instead.
  const visibleTickTimes = endpointTicks.length === 2
    && Math.abs(xForDate(new Date(endpointTicks[1]).toISOString().slice(0, 10)) - xForDate(new Date(endpointTicks[0]).toISOString().slice(0, 10))) < 72
    ? [endpointTicks[1]]
    : endpointTicks;
  const xAxis = visibleTickTimes.map((time, index, times) => `<text x="${(plotLeft + ((time - domainStart) / (domainEnd - domainStart)) * (width - plotLeft - plotRight)).toFixed(1)}" y="${height - 5}" text-anchor="${times.length === 1 || index === times.length - 1 ? 'end' : index === 0 ? 'start' : 'middle'}" class="chart-axis-label chart-x-axis-label">${dateLabel(time)}</text>`).join('');
  const trackingDate = new Date(`${snapshots[0].date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const unavailableLead = hasUntrackedLead
    ? `<path class="chart-unavailable-line" d="M ${plotLeft} ${points[0][1].toFixed(1)} L ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}"/><text x="${plotLeft + 8}" y="${plotTop + 13}" text-anchor="start" class="chart-unavailable-label">Tracking began ${trackingDate}</text>`
    : '';
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Net worth history${domainStart < firstObserved ? '; earlier time is not tracked' : ''}">
    <defs><linearGradient id="areaFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f6f4a" stop-opacity=".16"/><stop offset="1" stop-color="#1f6f4a" stop-opacity="0"/></linearGradient></defs>
    ${yAxis}${xAxis}<path d="${area}" fill="url(#areaFade)"/><path class="main-history-line" pathLength="1" d="${d}" fill="none" stroke="#1f6f4a" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>${unavailableLead}
    <line class="scrub-line" x1="0" y1="${plotTop}" x2="0" y2="${plotBottom}"/>
    <circle class="scrub-dot" cx="0" cy="0" r="5"/>
  </svg>
  <div class="chart-tooltip hidden"></div>`;

  const scrubLine = el.querySelector('.scrub-line');
  const scrubDot = el.querySelector('.scrub-dot');
  const tooltip = el.querySelector('.chart-tooltip');
  const svg = el.querySelector('svg');
  let active = false;

  const showPoint = (event) => {
    const rect = el.getBoundingClientRect();
    const relativeX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    // The SVG plot begins after the Y-axis gutter. Choose the nearest plotted
    // point in SVG space, rather than treating the full card width as data.
    const pointerX = relativeX / rect.width * width;
    const idx = points.reduce((nearest, point, index) => Math.abs(point[0] - pointerX) < Math.abs(points[nearest][0] - pointerX) ? index : nearest, 0);
    const snap = snapshots[idx];
    const [x, y] = points[idx];
    scrubLine.setAttribute('x1', x);
    scrubLine.setAttribute('x2', x);
    scrubDot.setAttribute('cx', x);
    scrubDot.setAttribute('cy', y);
    scrubLine.classList.add('visible');
    scrubDot.classList.add('visible');
    tooltip.classList.remove('hidden');
    tooltip.textContent = fmt.format(Number(snap.net_worth));
    placeChartTooltip(tooltip, x / width * rect.width, rect.width);

    const date = new Date(`${snap.date}T12:00:00`);
    $('#netWorth').textContent = fmt.format(Number(snap.net_worth));
    $('#netWorthDelta').innerHTML = `<span class="positive">Assets ${fmt.format(Number(snap.assets || 0))}</span><span class="networth-separator"> · </span><span class="negative">Debt ${fmt.format(Number(snap.liabilities || 0))}</span>`;
    $('#netWorthChartDate').textContent = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    $('#netWorthChartContext').classList.remove('hidden');
  };

  el.addEventListener('pointerdown', (event) => {
    active = true;
    trackProductEvent('net_worth_history_explored');
    el.setPointerCapture?.(event.pointerId);
    showPoint(event);
  });
  el.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse' || active) showPoint(event);
  });
  el.addEventListener('pointerup', (event) => {
    active = false;
    el.releasePointerCapture?.(event.pointerId);
  });
  el.addEventListener('pointercancel', () => { active = false; });
  el.addEventListener('selectstart', (event) => event.preventDefault());
  el.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse' || active) return;
    scrubLine.classList.remove('visible');
    scrubDot.classList.remove('visible');
    tooltip.classList.add('hidden');
    restoreNetWorthHero();
  });
  svg.addEventListener('dragstart', (event) => event.preventDefault());
}

function renderTimelineStart(el, snapshot, summary, rangeStart = null) {
  const value = Number(snapshot?.net_worth ?? summary?.netWorth ?? 0);
  const date = snapshot?.date ? new Date(`${snapshot.date}T12:00:00`) : new Date();
  const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const width = Math.max(1, Math.round(el.clientWidth || 700));
  const height = Math.max(1, Math.round(el.clientHeight || 150));
  const baseline = Math.round(height * .62);
  const rangeStartTime = rangeStart ? new Date(`${rangeStart}T12:00:00`).getTime() : date.getTime();
  const rangeEndTime = Math.max(rangeStartTime + 86_400_000, date.getTime());
  const naturalPoint = 24 + ((date.getTime() - rangeStartTime) / (rangeEndTime - rangeStartTime)) * (width - 48);
  const pointX = Math.round(Math.max(width * .58, Math.min(width - 24, naturalPoint)));
  const connectorStart = Math.max(18, pointX - 24);
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Net worth tracking began ${label}; earlier time is not tracked">
    <line class="chart-unavailable-line" x1="18" y1="${baseline}" x2="${connectorStart}" y2="${baseline}"/>
    <line class="chart-start-line" x1="${connectorStart}" y1="${baseline}" x2="${pointX}" y2="${baseline}"/>
    <circle class="chart-start-point" cx="${pointX}" cy="${baseline}" r="8"/>
    <text x="${pointX}" y="${baseline - 16}" text-anchor="middle" class="chart-start-value">${fmt.format(value)}</text>
    <text x="${pointX}" y="${height - 10}" text-anchor="middle" class="chart-start-detail">Tracking began ${label}</text>
  </svg>`;
}

function accountGroup(a) {
  const type = String(a.type || '').toLowerCase();
  const subtype = String(a.subtype || '').toLowerCase();
  if (type === 'investment') return 'Investments';
  if (type === 'credit') return 'Credit cards';
  if (type === 'loan') return 'Loans & debt';
  if (type === 'depository' && subtype.includes('savings')) return 'Savings';
  if (type === 'depository') return 'Cash';
  return 'Other';
}

function isDebt(a) {
  const type = String(a.type || '').toLowerCase();
  return type === 'credit' || type === 'loan';
}

function displayBalance(a) {
  const value = Math.abs(Number(a.current_balance || 0));
  return fmt2.format(value);
}

function accountSubtitle(account) {
  const institution = account.institution_name || '';
  const type = accountDescriptor(account.subtype || account.type);
  const mask = String(account.mask || '').replace(/\D/g, '').slice(-4);
  // The last four digits are only a visual disambiguator for accounts that
  // Plaid identifies as cards; do not imply that an absent mask is an error.
  return [institution, type, ...(String(account.type || '').toLowerCase() === 'credit' && mask ? [`••${mask}`] : [])].filter(Boolean).join(' · ');
}

function accountDescriptor(value) {
  const raw = String(value || '').trim().toLowerCase();
  const known = {
    ira: 'IRA', 'roth ira': 'Roth IRA', brokerage: 'Brokerage', checking: 'Checking', savings: 'Savings',
    'credit card': 'Credit card', auto: 'Auto loan', 'auto loan': 'Auto loan', '401k': '401(k)', '401(k)': '401(k)',
    mortgage: 'Mortgage', student: 'Student loan', 'student loan': 'Student loan', loan: 'Loan'
  };
  if (known[raw]) return known[raw];
  return raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function groupedAccounts(accounts) {
  const groups = new Map();
  for (const account of accounts) {
    const group = accountGroup(account);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(account);
  }
  return accountGroupOrder.filter((g) => groups.has(g)).map((name) => [name, groups.get(name)]);
}

function accountRow(a) {
  return `<div class="account-row">
    <div class="account-meta"><div class="account-icon">${escapeHtml((a.institution_name || a.name || '?')[0])}</div><div><div class="account-name">${escapeHtml(a.nickname || a.name)}</div><div class="account-inst">${escapeHtml(accountSubtitle(a))}</div></div></div>
    <div class="account-balance ${isDebt(a) ? 'negative' : 'positive'}">${displayBalance(a)}</div>
  </div>`;
}

function renderAccounts(accounts) {
  const grouped = groupedAccounts(accounts);
  if (!grouped.length) {
    $('#accountsSummary').innerHTML = '';
    $('#accountGrid').innerHTML = '<div class="empty">No connected accounts.</div>';
    return;
  }

  const cashAndSavings = accounts.filter((account) => ['Cash', 'Savings'].includes(accountGroup(account))).reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
  const invested = accounts.filter((account) => accountGroup(account) === 'Investments').reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
  const totalDebt = accounts.filter(isDebt).reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
  const previewing = Boolean(state.onboardingPreview);
  // The preview is an explanation of the product, not a fictional balance
  // sheet. Keep the real account layout, but replace every financial fact
  // with a short, truthful description before it reaches the DOM.
  $('#accountsSummary').innerHTML = previewing
    ? '<div><span>Cash & savings</span><strong class="onboarding-account-fact">Your balances</strong></div><div><span>Invested</span><strong class="onboarding-account-fact">Your portfolio</strong></div><div><span>Debt owed</span><strong class="onboarding-account-fact">Your debt</strong></div>'
    : `<div><span>Cash & savings</span><strong>${fmt.format(cashAndSavings)}</strong></div><div><span>Invested</span><strong class="positive">${fmt.format(invested)}</strong></div><div><span>Debt owed</span><strong class="negative">${fmt.format(totalDebt)}</strong></div>`;
  const previewAccountCopy = {
    Cash: 'A connected cash account',
    Savings: 'A connected savings account',
    Investments: 'A connected investment account',
    'Credit cards': 'A connected credit card',
    'Loans & debt': 'A connected loan',
    Other: 'A connected account'
  };
  $('#accountGrid').innerHTML = grouped.map(([name, items]) => {
    const debt = items.every(isDebt);
    const total = items.reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
    const sorted = [...items].sort((a, b) => Math.abs(Number(b.current_balance || 0)) - Math.abs(Number(a.current_balance || 0)));
    const expanded = state.expandedAccountGroups.has(name);
    const previewCount = 2;
    return `<section class="account-collection ${debt ? 'debt' : 'asset'}">
      <div class="account-collection-head"><span class="account-collection-icon" aria-hidden="true">${accountGroupIcons[name] || '◇'}</span><div><h2>${name}</h2><p class="onboarding-account-fact">${previewing ? 'Accounts you choose to share' : `${items.length} account${items.length === 1 ? '' : 's'}`}</p></div><div class="account-collection-total ${debt ? 'negative' : 'positive'}"><span>${previewing ? 'When connected' : debt ? 'Owed' : 'Held'}</span><strong class="onboarding-account-fact">${previewing ? 'Your balance' : fmt.format(total)}</strong></div></div>
      <div class="account-collection-items">${sorted.map((account, index) => `<article class="account-item ${debt ? 'debt' : 'asset'} ${index >= previewCount && !expanded ? 'hidden' : ''}">
        ${previewing ? institutionMark({}) : institutionMark(account)}<div class="account-copy"><div class="account-name onboarding-account-fact">${previewing ? previewAccountCopy[name] : escapeHtml(account.nickname || account.name)}</div><div class="account-inst onboarding-account-fact">${previewing ? 'Institution, type, and balance' : escapeHtml(accountSubtitle(account))}</div><div class="account-inline-balance ${debt ? 'negative' : 'positive'} onboarding-account-fact">${previewing ? 'Balance after you connect' : displayBalance(account)}</div></div>${previewing ? '' : account.manual ? `<button class="account-rename" data-manual-account="${escapeHtml(account.id)}" data-manual-name="${escapeHtml(account.name)}" data-manual-subtype="${escapeHtml(account.subtype || '')}" data-manual-value="${escapeHtml(account.current_balance)}" data-manual-kind="${debt ? 'liability' : 'asset'}" aria-label="Edit ${escapeHtml(account.name)}">✎</button>` : `<button class="account-rename" data-account-rename="${escapeHtml(account.id)}" data-account-name="${escapeHtml(account.nickname || account.name)}" aria-label="Rename ${escapeHtml(account.nickname || account.name)}">✎</button>`}
      </article>`).join('')}</div>${items.length > previewCount ? `<button class="account-group-more" data-account-group="${escapeHtml(name)}">${expanded ? 'Show less' : `View ${items.length - previewCount} more`}</button>` : ''}
    </section>`;
  }).join('');
}

function debtPlanForStrategy(plan, strategy) {
  const debts = plan?.debts || [];
  const priority = strategy === 'snowball'
    ? [...debts].sort((a, b) => Number(a.balance) - Number(b.balance))[0] || null
    : [...debts].filter((a) => a.interestRate != null).sort((a, b) => Number(b.interestRate) - Number(a.interestRate) || Number(a.balance) - Number(b.balance))[0] || null;
  return { ...plan, strategy, priority };
}

// Public preview and signed-in demo mode must behave like the same safe,
// throwaway scenario. The latter has a real session, so checking only
// demoPreview accidentally attempted to save a real member setting.
function isDemoExperience() {
  return Boolean(state.demoPreview || state.dashboard?.demoMode);
}

function renderDebtPayoff(plan) {
  const card = $('#debtPayoffCard');
  if (!plan?.accountCount) { card.classList.add('hidden'); card.innerHTML = ''; return; }
  card.classList.remove('hidden');
  const avalanche = plan.strategy !== 'snowball';
  const expanded = state.debtPlanExpanded;
  const priority = plan.priority;
  const target = priority ? `<strong>${escapeHtml(priority.name)}</strong>` : null;
  const nextStep = avalanche
    ? target ? `Put any extra payment toward ${target}${priority.interestRate != null ? ` at ${Number(priority.interestRate).toFixed(2).replace(/\.00$/, '')}% APR` : ''}.`
      : 'Add interest rates to see which balance is costing you the most.'
    : target ? `Put any extra payment toward ${target}, your smallest balance.` : 'Your balances will appear here once they are available.';
  const rateEditor = `<details class="debt-rate-editor"><summary>${plan.missingRates ? (plan.missingRates === 1 ? 'Add 1 interest rate' : `Add ${plan.missingRates} interest rates`) : 'Edit interest rates'} <span>Optional</span></summary><p>Rates make “Save most interest” specific. Update a rate anytime, or clear a manually entered rate to use your institution’s next available update.</p><div class="debt-rate-list">${plan.debts.map((debt) => { const rate = debt.interestRate == null ? '' : String(Number(debt.interestRate)); return `<label>${escapeHtml(debt.name)}<span><input data-debt-rate="${escapeHtml(debt.id)}" data-initial-rate="${escapeHtml(rate)}" value="${escapeHtml(rate)}" type="number" min="0" max="100" step="0.01" inputmode="decimal" aria-label="Annual interest rate for ${escapeHtml(debt.name)}" placeholder="APR" /><b>%</b></span></label>`; }).join('')}</div><button class="secondary debt-rate-save" type="button" data-save-debt-rates>Save rates</button></details>`;
  const summary = `<button class="debt-plan-summary" type="button" data-toggle-debt-plan aria-expanded="${expanded}"><span class="debt-plan-mark" aria-hidden="true">↘</span><span><small>DEBT PLAN</small><strong>One clear next step, when you’re ready</strong></span><b>${expanded ? 'Hide' : 'View plan'} <i aria-hidden="true">›</i></b></button>`;
  const planBody = `<div class="debt-plan-expanded"><div class="debt-payoff-head"><div><div class="card-label">DEBT PAYOFF</div><h2>${fmt.format(plan.totalDebt)} to pay down</h2><p>${plan.accountCount} balance${plan.accountCount === 1 ? '' : 's'} · choose the approach that fits you.</p></div></div><div class="debt-strategy-choice" role="group" aria-label="Debt payoff approach"><button type="button" class="${avalanche ? 'active' : ''}" data-debt-strategy="avalanche"><strong>Save most interest</strong><span>Highest rate first</span></button><button type="button" class="${!avalanche ? 'active' : ''}" data-debt-strategy="snowball"><strong>Small wins first</strong><span>Smallest balance first</span></button></div><div class="debt-next-step"><span>Next step</span><p>${nextStep}</p></div>${rateEditor}</div>`;
  card.innerHTML = `${summary}${expanded ? planBody : ''}`;
}

function renderConnections(items) {
  const panel = $('#connectionsList');
  const health = new Map((state.dashboard?.connectionHealth || []).map((entry) => [entry.id, entry]));
  const label = (timestamp) => {
    if (!timestamp || Number.isNaN(new Date(timestamp).getTime())) return 'No verified update yet';
    const date = new Date(timestamp);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay ? `Verified today at ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : `Last verified ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  };
  panel.innerHTML = items.length ? items.map((item) => {
    const status = health.get(item.id);
    const needsReconnect = Boolean(status?.action_required || status?.requires_reconnect);
    const verified = label(status?.last_verified_update_at || item.last_verified_update_at || item.last_synced_at);
    const detail = item.demo ? 'Sample connection · demo data only'
      : item.development_mock ? 'Development test connection · no Plaid account used'
      : needsReconnect ? `${verified} · Sign in again to resume updates`
        : status?.retrying_automatically ? `${verified} · Update delayed; retrying automatically`
          : status?.state === 'healthy' ? `${verified} · Updates automatically`
            : `${verified} · We’re checking again automatically`;
    const actions = item.demo ? '<span class="connection-demo-label">Demo</span>' : `${!item.development_mock && needsReconnect ? `<button class="reconnect-button" data-reconnect="${escapeHtml(item.id)}">Reconnect</button>` : ''}<button class="unlink-button" data-unlink="${escapeHtml(item.id)}">Unlink</button>`;
    return `<div class="connection-row"><div>${item.institution_logo ? `<img class="connection-logo" src="${escapeHtml(item.institution_logo)}" alt="" />` : '<span class="connection-fallback" aria-hidden="true">⌂</span>'}<span>${escapeHtml(item.institution_name)}<small class="connection-status ${status?.state || ''}">${detail}</small></span></div><span class="connection-actions">${actions}</span></div>`;
  }).join('') : '<div class="empty">No connected institutions yet. Connect one when you’re ready.</div>';
}

function renderProfileSettings(d) {
  const demoButton = $('#demoToggle');
  demoButton.textContent = d?.demoMode ? 'Exit demo' : 'Try demo';
  demoButton.setAttribute('aria-pressed', String(Boolean(d?.demoMode)));
  const user = d?.user || {};
  const name = String(user.name || '').trim() || 'Your account';
  const email = String(user.email || '').trim();
  $('#profileName').textContent = name;
  $('#profileEmail').textContent = email || 'Signed in securely';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  $('#profileMonogram').textContent = initials || 'C';
}

const spendingColors = ['#1f6f4a', '#7ea98b', '#d5a75f', '#b88692', '#9ca9bd', '#c4c9c1'];

function allocationRows(transactions) {
  const totals = new Map();
  for (const transaction of transactions) totals.set(transaction.category, (totals.get(transaction.category) || 0) + Number(transaction.amount || 0));
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const rows = [...totals.entries()].map(([name, amount]) => ({ name, amount, share: total ? amount / total : 0 }));
  const rounded = rows.map((row) => ({ ...row, percentage: Math.floor(row.share * 100), remainder: row.share * 100 - Math.floor(row.share * 100) }));
  let remaining = 100 - rounded.reduce((sum, row) => sum + row.percentage, 0);
  [...rounded].sort((a, b) => b.remainder - a.remainder).forEach((row) => { if (remaining > 0) { row.percentage += 1; remaining -= 1; } });
  return rounded.sort((a, b) => b.amount - a.amount);
}

function compactCategoryLabel(name) {
  return name === 'Guilt-free spending' ? 'Guilt-free' : name;
}

function spendingForSelectedMonth(data) {
  if (!state.spendingMonth) return data;
  const transactions = (data.transactions || []).filter((transaction) => String(transaction.date).startsWith(state.spendingMonth));
  const planTransactions = transactions.filter((transaction) => !['income', 'transfer', 'pre_tax_retirement'].includes(transaction.bucket));
  const total = planTransactions.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const income = transactions.filter((transaction) => transaction.bucket === 'income').reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  // flowCategoryRows is also used by spending categories, where `name` is the
  // public field. Normalize income sources at this boundary so a selected
  // month has the same { key, label, amount } shape as the server response.
  const incomeSources = flowCategoryRows(transactions.filter((transaction) => transaction.flowGroup === 'income'))
    .map(({ key, name, amount }) => ({ key, label: name, amount }));
  const actualSpend = planTransactions.filter((transaction) => !['savings', 'investments'].includes(transaction.bucket)).reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const savings = planTransactions.filter((transaction) => transaction.bucket === 'savings').reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const investments = planTransactions.filter((transaction) => transaction.bucket === 'investments').reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const savingsAndInvestments = planTransactions.filter((transaction) => ['savings', 'investments'].includes(transaction.bucket)).reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const actualSpendCategories = flowCategoryRows(planTransactions.filter((transaction) => transaction.flowGroup === 'actual_spend'));
  const preTaxRetirement = Number((data.monthly || []).find((row) => row.month === state.spendingMonth)?.pre_tax_retirement || 0);
  return { ...data, total, income, incomeSources, actualSpend, actualSpendCategories, savings, investments, savingsAndInvestments, preTaxRetirement, monthlyAverage: total, categories: allocationRows(planTransactions), transactions };
}

function flowCategoryRows(transactions) {
  const groups = new Map();
  for (const transaction of transactions) {
    const key = transaction.flowKey || 'other_spend';
    const current = groups.get(key) || { key, name: transaction.flowLabel || 'Other spend', amount: 0 };
    current.amount += Number(transaction.amount || 0);
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => b.amount - a.amount);
}

function renderSpendingTrend(data) {
  const months = data.monthly || [];
  if (state.spendingMonth && !months.some((row) => row.month === state.spendingMonth)) state.spendingMonth = null;
  const detail = months.find((row) => row.month === state.spendingMonth) || months.at(-1);
  if (detail) {
    const label = new Date(`${detail.month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const remaining = Number(detail.income || 0) - Number(detail.amount || 0);
    $('#trendDetail').innerHTML = `<span>${state.spendingMonth ? label : `Latest · ${label}`}</span><strong><i class="income"></i><small>Income</small>${fmt.format(detail.income || 0)}</strong><strong><i class="spend"></i><small>Spent</small>${fmt.format(detail.amount || 0)}</strong><b class="${remaining >= 0 ? 'positive' : 'negative'}">${remaining >= 0 ? 'Left' : 'Over'} ${fmt.format(Math.abs(remaining))}</b>`;
  } else $('#trendDetail').innerHTML = '';
  const chart = $('#spendingTrend');
  if (!months.length) { chart.innerHTML = '<p class="spending-empty">Monthly patterns will appear once transactions arrive.</p>'; return; }
  // A single diverging bar answers the useful monthly question immediately:
  // did more money come in than go out? The selected-month summary preserves
  // the underlying income and outflow values without making the bars overlap.
  const compact = chart.clientWidth < 480;
  const width = compact ? 390 : 720, height = 210, plot = { left: compact ? 39 : 48, right: 10, top: 12, bottom: 174 };
  const values = months.map((row) => Number(row.income || 0) - Number(row.amount || 0));
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 1);
  // Round the symmetric domain to a useful amount. Exact maxima create
  // awkward labels (for example $3,143 / $1,572) and make the visual feel
  // falsely precise; a calm $3k / $1.5k / $0 scale is easier to scan.
  const magnitude = 10 ** Math.floor(Math.log10(maxAbs));
  const normalized = maxAbs / magnitude;
  const increment = normalized < 2 ? .25 : normalized < 5 ? .5 : 1;
  const axisMax = Math.ceil(normalized / increment) * increment * magnitude;
  const zeroY = (plot.top + plot.bottom) / 2;
  const scale = Math.min(zeroY - plot.top, plot.bottom - zeroY) / axisMax;
  const money = (value) => {
    const prefix = value < 0 ? '−' : '';
    const absolute = Math.abs(value);
    const compactValue = absolute >= 1000 ? `$${Number((absolute / 1000).toFixed(1))}k` : fmt.format(absolute);
    return `${prefix}${compactValue}`;
  };
  const ticks = [axisMax, axisMax / 2, 0, -axisMax / 2, -axisMax].map((value) => {
    const y = zeroY - value * scale;
    return `<g><line x1="${plot.left}" y1="${y.toFixed(1)}" x2="${width - plot.right}" y2="${y.toFixed(1)}" class="trend-grid ${value === 0 ? 'zero' : ''}"/><text x="${plot.left - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="trend-axis">${money(value)}</text></g>`;
  }).join('');
  const step = (width - plot.left - plot.right) / months.length;
  const barWidth = Math.min(compact ? 22 : 34, step * .62);
  const bars = months.map((row, index) => {
    const value = values[index], x = plot.left + step * index + (step - barWidth) / 2;
    // Small positive values still need a visible bar, but that minimum must
    // grow upward from zero—not spill across it and resemble a deficit.
    const barHeight = Math.max(value ? 6 : 0, Math.abs(value) * scale);
    const y = value >= 0 ? zeroY - barHeight : zeroY;
    const label = new Date(`${row.month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'short' });
    const title = `${row.month}: Income ${fmt.format(row.income || 0)} · Money out ${fmt.format(row.amount || 0)} · ${value >= 0 ? 'Left' : 'Over'} ${fmt.format(Math.abs(value))}`;
    return `<g class="trend-column ${state.spendingMonth === row.month ? 'active' : ''}" data-spending-month="${row.month}" role="button" tabindex="0" aria-label="View ${escapeHtml(label)} cash flow activity" title="${escapeHtml(title)}"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="5" fill="${value >= 0 ? 'var(--income)' : 'var(--outflow)'}"/><text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 10}" text-anchor="middle" class="trend-month">${label}</text></g>`;
  }).join('');
  chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly cash flow. Green bars above zero show money left after cash outflow; coral bars below zero show months where cash outflow exceeded income.">${ticks}${bars}</svg>`;
}

function renderCashFlowSankey(data, el = $('#cashflowSankey'), expanded = false) {
  const income = Number(data.income || 0), actualSpend = Number(data.actualSpend || 0), savings = Number(data.savings || 0), investments = Number(data.investments || 0);
  // The interface rounds amounts to whole dollars. Do not render a node that
  // would read as "$0" after that rounding; it adds visual noise and implies
  // a meaningful flow where there is none.
  const hasVisibleAmount = (value) => Math.abs(Number(value || 0)) >= .5;
  if (![income, actualSpend, savings, investments].some(hasVisibleAmount)) { el.innerHTML = ''; return; }
  // Use the chart's actual container, not a device label. This survives
  // tablets, split-screen, zoom, sidebars, and window resizing.
  const availableWidth = el.clientWidth;
  const compact = availableWidth < 600;
  const tablet = !compact && availableWidth < 760;
  const allSpendCategories = (data.actualSpendCategories || []).filter((row) => hasVisibleAmount(row.amount));
  const incomeSources = (data.incomeSources?.length ? data.incomeSources : [{ key: 'income', label: 'Income received', amount: income }])
    .map((source) => ({ ...source, label: source.label || source.name || 'Income received' }))
    .filter((source) => hasVisibleAmount(source.amount));
  // On a phone, keep the primary story to three readable columns. Spending
  // categories are secondary detail, revealed below in the expanded view.
  const actualCategories = compact ? [] : (expanded ? allSpendCategories : allSpendCategories.slice(0, 4));
  const width = compact ? 390 : tablet ? 620 : 920;
  // Treat the blocks as compact labels for the flow, rather than cards that
  // compete with it. Phone labels get a little more vertical room to wrap.
  const rowHeight = compact ? 50 : 46, rowStep = compact ? 57 : 53;
  const middleNodes = [
    { key: 'actual_spend', label: 'Actual spend', value: actualSpend, color: 'var(--outflow)' },
    { key: 'savings', label: 'Save', value: savings, color: 'var(--save)' },
    { key: 'investments', label: 'Invest', value: investments, color: 'var(--invest)' }
  ].filter((node) => hasVisibleAmount(node.value));
  const withShare = (rows, total, valueKey = 'amount') => rows.map((row) => ({
    ...row,
    share: total > 0 ? Math.round(Number(row[valueKey] || 0) / total * 100) : null
  }));
  // A source and an outflow are not causally linked by Plaid. Build the
  // Sankey as an honest hierarchy: sources feed one period-total node, then
  // that total branches to the known allocations. This removes crossed,
  // proportional source-to-outcome estimates.
  const knownAllocation = middleNodes.reduce((sum, node) => sum + Number(node.value || 0), 0);
  const sourceTotal = incomeSources.reduce((sum, source) => sum + Number(source.amount || 0), 0);
  // “Money in” is deliberately limited to transactions Plaid categorized as
  // income. If more goes out than comes in, we explain the reconciliation
  // gap separately instead of inventing an inbound source for the Sankey.
  const bridgeTotal = sourceTotal;
  const unmatchedOutflow = Math.max(0, knownAllocation - sourceTotal);
  const unallocated = Math.max(0, sourceTotal - knownAllocation);
  const fundingRows = incomeSources;
  const allocationRows = unallocated >= .5
    ? [...middleNodes, { key: 'money_left', label: 'Money left', value: unallocated, color: 'var(--income)' }]
    : middleNodes;
  const incomeNodes = withShare(fundingRows, bridgeTotal);
  // Percentages describe the allocation stack itself. During a timing or
  // funding gap, outflows can legitimately exceed Plaid-categorized income;
  // dividing those rows by income would misleadingly produce 125%+ labels.
  const allocationNodes = withShare(allocationRows, Math.max(bridgeTotal, knownAllocation), 'value');
  const categoryNodes = withShare(actualCategories, actualSpend);
  const bridgeNode = { key: 'period_funds', label: 'Money in', value: bridgeTotal, color: 'var(--income)' };
  const contentHeight = (rows) => rows.length ? (rows.length - 1) * rowStep + rowHeight : 0;
  const height = Math.max(224, contentHeight(incomeNodes) + 16, contentHeight(allocationNodes) + 16, contentHeight(categoryNodes) + 16);
  // A node must visibly meet its flow. Fixed wide, transparent hit areas made
  // the bands appear to stop short of their labels on larger screens. Size
  // each column to its actual labels and render it as a quiet tinted block.
  const nodeWidth = (rows, minimum, maximum) => {
    const longest = Math.max(...rows.map((row) => String(row.label || '').length), 0);
    const characterWidth = compact ? 5.4 : 6.2;
    return Math.max(minimum, Math.min(maximum, Math.ceil(25 + longest * characterWidth)));
  };
  // Four columns still need breathing room on a phone. Keep the labels
  // compact there rather than letting the allocation column collide with the
  // spending-category column.
  const sourceW = nodeWidth(incomeNodes, compact ? 96 : 82, compact ? 104 : 132);
  const bridgeW = nodeWidth([bridgeNode], compact ? 72 : 88, compact ? 84 : 120);
  const middleW = nodeWidth(allocationNodes, compact ? 100 : 86, compact ? 116 : 128);
  const destinationW = nodeWidth(categoryNodes.map((row) => ({ label: row.name })), 92, 142);
  const sourceX = compact ? 5 : tablet ? 8 : 20;
  const bridgeX = compact ? 124 : tablet ? 166 : 230;
  const middleX = compact ? 230 : tablet ? 330 : 482;
  const destinationX = compact ? 0 : tablet ? 488 : 758;
  const colorFor = (key, fallback) => ({
    income_paychecks: 'var(--income)', income_interest: '#b08a4a', income_dividends: '#8a71a5', income_benefits: '#5e91a2', income_business: '#5d9b81', income_other: '#7893a8',
    actual_spend: 'var(--outflow)', savings: 'var(--save)', investments: 'var(--invest)',
    housing_bills: '#c87862', food_dining: '#c69656', shopping: '#9a78a2', transport: '#6996a7', health: '#6a9b88', insurance: '#728aac', services: '#8d87aa', entertainment: '#b47b92', travel: '#6499a0', education: '#8d9a5f', personal_care: '#b98675', home: '#739585', taxes: '#ab8066', civic: '#7d91a4', fees: '#9a8f81', uncategorized: '#9a8f81'
  }[key] || fallback);
  const block = (x, y, w, color, label, value, share, category = '', side = 'left') => {
    const maxChars = Math.max(7, Math.floor((w - 19) / (compact ? 5.4 : 6.2)));
    const words = String(label).trim().split(/\s+/).filter(Boolean);
    const lines = [];
    for (const word of words) {
      const shortened = word.length > maxChars ? `${word.slice(0, Math.max(1, maxChars - 1))}…` : word;
      const previous = lines.at(-1);
      if (previous && `${previous} ${shortened}`.length <= maxChars) lines[lines.length - 1] = `${previous} ${shortened}`;
      else if (lines.length < 2) lines.push(shortened);
      else lines[1] = `${lines[1].slice(0, Math.max(1, maxChars - 1))}…`;
    }
    const displayLines = lines.length ? lines : ['Income'];
    const labelMarkup = displayLines.map((line, index) => `<tspan x="${x + 11}" dy="${index ? 11 : 0}">${escapeHtml(line)}</tspan>`).join('');
    const valueY = y + (displayLines.length > 1 ? 39 : 29);
    const accentX = side === 'right' ? x + w - 6 : x;
    const shareMarkup = share == null ? '' : `<tspan dx="4" class="cashflow-share">${share}%</tspan>`;
    const description = `${label}: ${fmt.format(value)}${share == null ? '' : ` (${share}%)`}`;
    return `<g ${category ? `data-cashflow-category="${escapeHtml(category)}" data-cashflow-node="${escapeHtml(category)}" class="cashflow-target" role="button" tabindex="0" aria-label="Highlight flows for ${escapeHtml(label)}"` : ''}><title>${escapeHtml(description)}</title><rect data-testid="cashflow-node-surface" x="${x}" y="${y}" width="${w}" height="${rowHeight}" rx="5" fill="${color}" fill-opacity=".10" stroke="${color}" stroke-opacity=".38"/><rect data-testid="cashflow-node-accent" x="${accentX}" y="${y}" width="6" height="${rowHeight}" rx="2" fill="${color}"/><text x="${x + 11}" y="${y + 14}" class="cashflow-label">${labelMarkup}</text><text x="${x + 11}" y="${valueY}" class="cashflow-value">${fmt.format(value)}${shareMarkup}</text></g>`;
  };
  // Use perceptual (square-root) scaling. Exact dollars stay in each node,
  // while the flow still makes large categories visibly heavier without one
  // unusually large payment consuming the entire chart.
  const largestFlow = Math.max(sourceTotal, knownAllocation, 1);
  const flow = (fromX, fromY, toX, toY, amount, color, nodes) => {
    const value = Math.max(0, Number(amount || 0));
    const thickness = value ? 2 + Math.sqrt(value / largestFlow) * 22 : 0;
    return `<path class="cashflow-flow" data-cashflow-flow="${escapeHtml(nodes.join(' '))}" d="M ${fromX} ${fromY} C ${fromX + (toX - fromX) * .42} ${fromY}, ${toX - (toX - fromX) * .42} ${toY}, ${toX} ${toY}" fill="none" stroke="${color}" stroke-opacity=".24" stroke-width="${thickness}" stroke-linecap="round"/>`;
  };
  const verticallyCenter = (rows) => Math.max(8, (height - contentHeight(rows)) / 2);
  const sourceStart = verticallyCenter(incomeNodes);
  const middleStart = verticallyCenter(allocationNodes);
  const categoryStart = verticallyCenter(categoryNodes);
  const bridgeY = Math.max(8, (height - rowHeight) / 2);
  const middleY = new Map(allocationNodes.map((node, index) => [node.key, middleStart + index * rowStep]));
  let paths = '';
  incomeNodes.forEach((source, index) => {
    const y = sourceStart + index * rowStep;
    paths += flow(sourceX + sourceW, y + rowHeight / 2, bridgeX, bridgeY + rowHeight / 2, source.amount, source.color || colorFor(source.key, 'var(--income)'), [source.key, bridgeNode.key]);
  });
  if (sourceTotal >= .5) allocationNodes.forEach((node) => {
    paths += flow(bridgeX + bridgeW, bridgeY + rowHeight / 2, middleX, middleY.get(node.key) + rowHeight / 2, node.value, node.color, [bridgeNode.key, node.key]);
  });
  let categories = '';
  categoryNodes.forEach((row, index) => {
    const y = categoryStart + index * rowStep;
    const categoryColor = colorFor(row.key, 'var(--outflow-muted)');
    const spendY = middleY.get('actual_spend');
    if (spendY != null) paths += flow(middleX + middleW, spendY + rowHeight / 2, destinationX, y + rowHeight / 2, Number(row.amount || 0), categoryColor, ['actual_spend', row.key]);
    categories += block(destinationX, y, destinationW, categoryColor, row.name, row.amount, row.share, row.key, 'left');
  });
  const hiddenCategoryCount = allSpendCategories.length - actualCategories.length;
  const more = !expanded && hiddenCategoryCount > 0 ? `<button type="button" class="cashflow-more" data-cashflow-expand aria-label="Show all ${hiddenCategoryCount + actualCategories.length} spending categories">View all ${allSpendCategories.length} spending categories <span>↗</span></button>` : '';
  const categoryList = compact && expanded && allSpendCategories.length
    ? `<div class="cashflow-category-list" aria-label="Spending categories">${withShare(allSpendCategories, actualSpend).map((row) => `<button type="button" data-cashflow-category="${escapeHtml(row.key)}"><span><i style="background:${colorFor(row.key, 'var(--outflow-muted)')}"></i>${escapeHtml(row.name)}</span><strong>${fmt.format(row.amount)} <small>${row.share}%</small></strong></button>`).join('')}</div>`
    : '';
  const sourceBlocks = incomeNodes.map((source, index) => block(sourceX, sourceStart + index * rowStep, sourceW, source.color || colorFor(source.key, 'var(--income)'), source.label, source.amount, source.share, source.key, 'right')).join('');
  const bridgeBlock = sourceTotal >= .5 ? block(bridgeX, bridgeY, bridgeW, bridgeNode.color, bridgeNode.label, bridgeNode.value, null, bridgeNode.key, 'left') : '';
  const middleBlocks = allocationNodes.map((node) => block(middleX, middleY.get(node.key), middleW, node.color, node.label, node.value, node.share, node.key, 'left')).join('');
  const reconciliationNote = unmatchedOutflow >= .5
    ? `<p class="cashflow-reconciliation-note">${fmt.format(unmatchedOutflow)} more went out than Plaid categorized as income in this period. This is a timing or funding gap, not a transaction category.</p>`
    : '';
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Plaid-categorized income sources flow into money in, then spending, saving, and investing">${paths}${sourceBlocks}${bridgeBlock}${middleBlocks}${categories}</svg>${categoryList}${reconciliationNote}${more}`;
  // SVG focus delegation differs subtly across browsers. Bind directly as
  // well so keyboard focus always traces the same connected flow as hover.
  el.querySelectorAll('[data-cashflow-node]').forEach((node) => {
    node.addEventListener('focus', () => setCashflowFlowFocus(el, node.dataset.cashflowNode));
    node.addEventListener('pointerenter', () => setCashflowFlowFocus(el, node.dataset.cashflowNode));
  });
}

function renderSpending(data) {
  if (!data) return;
  // The selected range remains visible when a person drills into one month;
  // it explains where that month belongs and keeps both cash-flow visuals in
  // one shared context.
  $$('[data-spending-range]').forEach((control) => control.classList.toggle('active', control.dataset.spendingRange === state.spendingRange));
  renderSpendingTrend(data);
  const selected = spendingForSelectedMonth(data);
  const total = Number(selected.total || 0);
  const income = Number(selected.income || 0);
  const actualSpend = Number(selected.actualSpend || 0);
  const savingsAndInvestments = Number(selected.savingsAndInvestments || 0);
  const preTaxRetirement = Number(selected.preTaxRetirement || 0);
  const remaining = income - total;
  $('#spendingTotal').textContent = fmt.format(Math.abs(remaining));
  $('#cashflowHeadline').textContent = remaining >= 0 ? 'Left after spending and saving' : 'More allocated than income';
  $('#cashflowHeadline').className = `cashflow-headline ${remaining >= 0 ? 'positive' : 'negative'}`;
  const preTaxNote = $('#cashflowPreTax');
  preTaxNote.innerHTML = preTaxRetirement ? `<span class="cashflow-payroll-mark" aria-hidden="true">↗</span><div><span>PAYROLL CONTRIBUTIONS</span><strong>${fmt.format(preTaxRetirement)}</strong><p>401(k), HSA, and similar contributions saved before reaching your bank account.</p></div><i class="cashflow-payroll-chevron" aria-hidden="true">›</i>` : '';
  preTaxNote.setAttribute('aria-label', `View ${fmt.format(preTaxRetirement)} in payroll contributions`);
  preTaxNote.classList.toggle('hidden', !preTaxRetirement);
  const completedThrough = data.completedMonths ? new Date(`${data.endDate}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';
  const rangeLabel = ({ '1m': 'this month to date', '3m': 'last 3 completed months', '6m': 'last 6 completed months', ytd: `year to date through ${completedThrough}`, '1y': 'last 12 completed months' })[data.range] || 'this month to date';
  const selectedMonthLabel = state.spendingMonth && new Date(`${state.spendingMonth}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  $('#spendingPeriodSummary').textContent = selectedMonthLabel ? `${selectedMonthLabel} selected · ${rangeLabel}` : rangeLabel;
  $('#monthlyCashFlowPeriod').textContent = selectedMonthLabel ? `Selected: ${selectedMonthLabel}` : `Showing ${rangeLabel}`;
  $('#clearSpendingMonth').classList.toggle('hidden', !selectedMonthLabel);
  $('#spendingContext').textContent = total || income ? (selectedMonthLabel || rangeLabel) : `No posted cash flow for ${selectedMonthLabel || rangeLabel}. It can take a little time to arrive after connecting.`;
  renderCashFlowSankey(selected);
  renderRecurringCharges(state.dashboard?.recurring);
  // The Sankey now owns the category story; the older donut is intentionally
  // absent from the simplified cash-flow experience.
  if (!$('#spendingDonut')) { renderSpendingTransactions(selected); return; }
  const rows = selected.categories || [];
  const donut = $('#spendingDonut');
  if (!rows.length) {
    donut.style.background = '#edf0eb'; donut.innerHTML = '<span>No data</span>';
    $('#spendingLegend').innerHTML = '<p class="spending-empty">Your category mix will appear here.</p>';
    renderSpendingTransactions(selected);
    return;
  }
  let cursor = 0;
  const stops = rows.map((row, index) => { const next = cursor + row.share * 100; const stop = `${spendingColors[index % spendingColors.length]} ${cursor.toFixed(2)}% ${next.toFixed(2)}%`; cursor = next; return stop; });
  donut.style.background = `conic-gradient(${stops.join(', ')})`;
  const chosen = rows.find((row) => row.name === state.spendingCategory);
  donut.innerHTML = chosen ? `<span><strong>${state.allocationDisplay === 'amount' ? fmt.format(chosen.amount) : `${chosen.percentage}%`}</strong><small>${escapeHtml(compactCategoryLabel(chosen.name))}</small></span>` : '<span>Plan<br>mix</span>';
  $('#spendingLegend').innerHTML = rows.slice(0, 5).map((row, index) => `<button class="legend-row" data-spending-category="${escapeHtml(row.name)}"><i style="background:${spendingColors[index % spendingColors.length]}"></i><span>${escapeHtml(row.name)}</span><strong>${state.allocationDisplay === 'amount' ? fmt.format(row.amount) : `${row.percentage}%`}</strong></button>`).join('');
  renderSpendingTransactions(selected);
}

function renderSpendingTransactions(data) {
  const filter = $('#spendingCategoryFilter');
  const categories = [...new Map((data.transactions || []).map((transaction) => [transaction.flowKey || transaction.category, transaction.flowLabel || transaction.category])).entries()];
  const filterKeys = new Set(categories.map(([key]) => key));
  if (state.spendingCategory !== 'all' && !['actual_spend', 'save_invest'].includes(state.spendingCategory) && !filterKeys.has(state.spendingCategory)) state.spendingCategory = 'all';
  filter.innerHTML = `<option value="all">All activity</option><option value="actual_spend">Actual spend</option><option value="save_invest">Save & invest</option>${categories.map(([key, name]) => `<option value="${escapeHtml(key)}">${escapeHtml(name)}</option>`).join('')}`;
  filter.value = state.spendingCategory;
  $('#spendingSort').value = state.spendingSort;
  let rows = (data.transactions || []).filter((transaction) => {
    const matchesFilter = state.spendingCategory === 'all' || transaction.flowKey === state.spendingCategory || transaction.flowGroup === state.spendingCategory;
    return matchesFilter && (!state.spendingMonth || String(transaction.date).startsWith(state.spendingMonth));
  });
  rows = [...rows].sort((a, b) => state.spendingSort === 'highest' ? b.amount - a.amount : String(b.date).localeCompare(String(a.date)) || b.amount - a.amount);
  $('#spendingTransactionCount').textContent = `${rows.length} posted`;
  const options = [['fixed', 'Fixed costs'], ['savings', 'Savings'], ['investments', 'Investments'], ['guilt_free', 'Guilt-free']];
  $('#spendingTransactions').innerHTML = rows.length ? rows.map((transaction) => {
    const categoryControl = ['income', 'pre_tax_retirement'].includes(transaction.bucket) || state.dashboard?.demoMode
      ? `<span class="transaction-category-label">${escapeHtml(transaction.category)}</span>`
      : `<select data-transaction-category="${escapeHtml(transaction.id)}" aria-label="Plan category for ${escapeHtml(transaction.name)}">${options.map(([value, label]) => `<option value="${value}" ${transaction.bucket === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
    return `<div class="spending-transaction-row ${transaction.bucket === 'income' ? 'income-transaction' : ''} ${transaction.bucket === 'pre_tax_retirement' ? 'payroll-transaction' : ''}"><div><strong>${escapeHtml(transaction.name)}</strong><span>${new Date(`${transaction.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></div><div class="transaction-plan"><b>${transaction.bucket === 'income' ? '+' : ''}${fmt.format(transaction.amount)}</b>${categoryControl}</div></div>`;
  }).join('') : '<p class="spending-empty">No posted transactions in this category for this period.</p>';
}

function portfolioSnapshots(data) {
  // Older stores can contain more than one observation from a calendar day.
  // A daily portfolio chart must use the most recent value for that day,
  // otherwise it visually invents movement and can produce repeated axis
  // labels for a person who has only recently started tracking.
  const snapshots = uniqueDailySnapshots(data.snapshots || []);
  if (state.investmentRange === 'all' || !snapshots.length) return snapshots;
  const latest = new Date(`${snapshots.at(-1).date}T12:00:00`);
  return filterSnapshots(snapshots, state.investmentRange, latest);
}

function syncPortfolioRangeControls(snapshots) {
  let changed = false;
  if (!state.investmentRangeInitialized) {
    const latest = snapshots.at(-1)?.date ? new Date(`${snapshots.at(-1).date}T12:00:00`) : new Date();
    const preferredRange = preferredNetWorthRange(snapshots, latest);
    changed = preferredRange !== state.investmentRange;
    state.investmentRange = preferredRange;
    state.investmentRangeInitialized = true;
  }
  $$('[data-investment-range]').forEach((control) => {
    // A person can always choose their preferred lens. When their verified
    // history begins later than that lens, the chart shows a dotted lead-in
    // rather than disabling the choice or pretending old data exists.
    control.disabled = false;
    control.title = '';
    control.classList.toggle('active', control.dataset.investmentRange === state.investmentRange);
  });
  return changed;
}

let investmentRangeRequest = 0;
async function loadInvestmentRange(range) {
  const request = ++investmentRangeRequest;
  $$('[data-investment-range]').forEach((control) => { control.disabled = true; });
  try {
    const base = state.demoPreview || state.onboardingPreview || state.dashboard?.demoMode ? '/api/demo-investments' : '/api/investments';
    const investments = await api(`${base}?range=${encodeURIComponent(range)}`);
    // A faster second selection wins; never paint an older range over it.
    if (request !== investmentRangeRequest || state.investmentRange !== range) return;
    state.investments = investments;
    renderInvestments(investments);
  } catch (error) {
    if (request === investmentRangeRequest) showNotice(error.message);
  } finally {
    if (request === investmentRangeRequest) $$('[data-investment-range]').forEach((control) => { control.disabled = false; });
  }
}

function investmentRangeLabel(range) {
  return ({ '1m': 'last month', '3m': 'last 3 months', '6m': 'last 6 months', ytd: 'year to date', '1y': 'last year', all: 'all history' })[range] || 'last year';
}

function portfolioChangeLabel(snapshots) {
  const first = snapshots[0];
  const last = snapshots.at(-1);
  if (!first || !last) return investmentRangeLabel(state.investmentRange);
  const latest = new Date(`${last.date}T12:00:00`);
  const { startDate } = netWorthRangeBounds(state.investmentRange, latest);
  const start = new Date(`${first.date}T12:00:00`);
  if (state.investmentRange === 'all' && latest.getTime() - start.getTime() >= 14 * 86400000) return 'all history';
  // A small allowance covers a connection just after a calendar edge. If it
  // is not met, the selected control is a viewing preference—not evidence of
  // a complete period—so name the real tracking start instead.
  if (startDate && start.getTime() <= new Date(`${startDate}T12:00:00`).getTime() + 10 * 86400000) return investmentRangeLabel(state.investmentRange);
  return `since ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function renderPortfolioChart(data) {
  const el = $('#investmentChart');
  if (el.clientWidth < 80 || el.clientHeight < 60) return;
  const snapshots = portfolioSnapshots(data);
  if (!snapshots.length) {
    const stateName = data.historyStatus?.state === 'preparing' ? 'preparing' : 'tracking';
    const preparing = stateName === 'preparing';
    el.innerHTML = `<div class="portfolio-snapshot history-state" data-history-state="${stateName}"><span class="portfolio-snapshot-mark" aria-hidden="true">${preparing ? '⋯' : '↗'}</span><div><strong>${preparing ? 'Preparing your history' : 'Portfolio tracking is starting'}</strong><p>${preparing ? 'Your institution is preparing its reported activity. We will only show a past trend when it can be verified.' : 'Your current balance and allocation are up to date. We will add verified snapshots automatically.'}</p></div></div>`;
    return;
  }
  if (snapshots.length === 1) {
    const latest = new Date(`${snapshots[0].date}T12:00:00`);
    renderPortfolioTrackingStart(el, snapshots[0], data.total, netWorthRangeBounds(state.investmentRange, latest).startDate);
    return;
  }
  const width = Math.max(1, Math.round(el.clientWidth));
  const height = Math.max(1, Math.round(el.clientHeight));
  const plot = { left: 46, right: 6, top: 8, bottom: height - 23 };
  const firstObservedTime = new Date(`${snapshots[0].date}T12:00:00`).getTime();
  const lastObservedTime = new Date(`${snapshots.at(-1).date}T12:00:00`).getTime();
  const selectedStartDate = netWorthRangeBounds(state.investmentRange, new Date(`${snapshots.at(-1).date}T12:00:00`)).startDate;
  const requestedStartTime = selectedStartDate ? new Date(`${selectedStartDate}T12:00:00`).getTime() : firstObservedTime;
  const domainStart = Math.min(firstObservedTime, requestedStartTime);
  const domainEnd = Math.max(domainStart + 86_400_000, lastObservedTime);
  const values = snapshots.map((snapshot) => Number(snapshot.value || 0));
  let min = Math.min(...values), max = Math.max(...values);
  const spread = max - min || Math.max(Math.abs(max) * .12, 1);
  min -= spread * .1; max += spread * .1;
  const xForDate = (date) => plot.left + ((new Date(`${date}T12:00:00`).getTime() - domainStart) / (domainEnd - domainStart)) * (width - plot.left - plot.right);
  const points = values.map((value, index) => [xForDate(snapshots[index].date), plot.bottom - (value - min) / (max - min) * (plot.bottom - plot.top)]);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L ${points.at(-1)[0]} ${plot.bottom} L ${points[0][0]} ${plot.bottom} Z`;
  const firstDate = new Date(firstObservedTime);
  const lastDate = new Date(lastObservedTime);
  const sameMonth = firstDate.getFullYear() === lastDate.getFullYear() && firstDate.getMonth() === lastDate.getMonth();
  const shortRange = lastDate.getTime() - firstDate.getTime() <= 45 * 86400000;
  // Month/year is useful over a long history, but becomes repeated labels
  // across a short Aug→Sep window. Use distinct days in either case.
  const hasUntrackedLead = domainStart < firstObservedTime;
  const verifiedSpanIsShort = lastObservedTime - firstObservedTime <= 45 * 86400000;
  const label = (index) => new Date(`${snapshots[index].date}T12:00:00`).toLocaleDateString('en-US', sameMonth || shortRange || (hasUntrackedLead && verifiedSpanIsShort)
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', year: 'numeric' });
  const xIndices = [...new Set(width > 420 ? [0, Math.floor((snapshots.length - 1) / 2), snapshots.length - 1] : [0, snapshots.length - 1])];
  const grid = [max, (max + min) / 2, min].map((value) => { const y = plot.bottom - (value - min) / (max - min) * (plot.bottom - plot.top); return `<line x1="${plot.left}" y1="${y}" x2="${width - plot.right}" y2="${y}" class="chart-grid"/><text x="${plot.left - 6}" y="${y + 3}" text-anchor="end" class="chart-axis-label">${axisCurrency(value)}</text>`; }).join('');
  // The dashed lead-in explains the unavailable part of a selected range;
  // it should not make the verified part lose its dates.
  const endpointIndices = [...new Set(hasUntrackedLead ? [0, snapshots.length - 1] : xIndices)];
  const xAxisIndices = endpointIndices.length === 2 && Math.abs(points[endpointIndices[1]][0] - points[endpointIndices[0]][0]) < 72
    ? [endpointIndices[1]]
    : endpointIndices;
  const xAxis = xAxisIndices.map((index, position, indices) => `<text x="${points[index][0]}" y="${height - 5}" text-anchor="${indices.length === 1 || position === indices.length - 1 ? 'end' : position === 0 ? 'start' : 'middle'}" class="chart-axis-label chart-x-axis-label">${label(index)}</text>`).join('');
  const trackingDate = firstDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const unavailableLead = hasUntrackedLead
    ? `<path class="chart-unavailable-line" d="M ${plot.left} ${points[0][1].toFixed(1)} L ${points[0][0]} ${points[0][1]}"/><text x="${plot.left + 8}" y="${plot.top + 13}" text-anchor="start" class="chart-unavailable-label">Tracking began ${trackingDate}</text>`
    : '';
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Scrubbable portfolio value history${domainStart < firstObservedTime ? '; earlier time is not tracked' : ''}"><defs><linearGradient id="portfolioFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#287143" stop-opacity=".16"/><stop offset="1" stop-color="#287143" stop-opacity="0"/></linearGradient></defs>${grid}${xAxis}<path d="${area}" fill="url(#portfolioFade)"/><path class="main-history-line" pathLength="1" d="${line}" fill="none" stroke="#287143" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>${unavailableLead}${points.length === 1 ? `<circle cx="${points[0][0]}" cy="${points[0][1]}" r="5" fill="#287143"/>` : ''}<line class="scrub-line" x1="0" y1="${plot.top}" x2="0" y2="${plot.bottom}"/><circle class="scrub-dot" cx="0" cy="0" r="5"/></svg><div class="chart-tooltip hidden"></div>`;
  if (snapshots.length < 2) return;
  const scrubLine = el.querySelector('.scrub-line');
  const scrubDot = el.querySelector('.scrub-dot');
  const tooltip = el.querySelector('.chart-tooltip');
  let active = false;
  const restore = () => {
    $('#investmentTotal').textContent = fmt.format(Number(snapshots.at(-1)?.value ?? data.total ?? 0));
    $('#investmentChartDate').textContent = '';
    $('#investmentChartContext').classList.add('hidden');
  };
  const showPoint = (event) => {
    const rect = el.getBoundingClientRect();
    const relativeX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const pointerX = relativeX / rect.width * width;
    const index = points.reduce((nearest, point, candidate) => Math.abs(point[0] - pointerX) < Math.abs(points[nearest][0] - pointerX) ? candidate : nearest, 0);
    const snapshot = snapshots[index];
    const [x, y] = points[index];
    scrubLine.setAttribute('x1', x); scrubLine.setAttribute('x2', x);
    scrubDot.setAttribute('cx', x); scrubDot.setAttribute('cy', y);
    scrubLine.classList.add('visible'); scrubDot.classList.add('visible');
    tooltip.classList.remove('hidden');
    tooltip.textContent = fmt.format(Number(snapshot.value || 0));
    placeChartTooltip(tooltip, x / width * rect.width, rect.width);
    $('#investmentTotal').textContent = fmt.format(Number(snapshot.value || 0));
    $('#investmentChartDate').textContent = new Date(`${snapshot.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    $('#investmentChartContext').classList.remove('hidden');
  };
  el.addEventListener('pointerdown', (event) => { active = true; el.setPointerCapture?.(event.pointerId); showPoint(event); });
  el.addEventListener('pointermove', (event) => { if (event.pointerType === 'mouse' || active) showPoint(event); });
  el.addEventListener('pointerup', (event) => { active = false; el.releasePointerCapture?.(event.pointerId); });
  el.addEventListener('pointercancel', () => { active = false; });
  el.addEventListener('selectstart', (event) => event.preventDefault());
  el.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse' && !active) { scrubLine.classList.remove('visible'); scrubDot.classList.remove('visible'); tooltip.classList.add('hidden'); restore(); } });
}

function renderPortfolioTrackingStart(el, snapshot, total, rangeStart = null) {
  const width = Math.max(1, Math.round(el.clientWidth || 700));
  const height = Math.max(1, Math.round(el.clientHeight || 150));
  const baseline = Math.round(height * .62);
  const value = Number(snapshot?.value ?? total ?? 0);
  const date = new Date(`${snapshot.date}T12:00:00`);
  const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const rangeStartTime = rangeStart ? new Date(`${rangeStart}T12:00:00`).getTime() : date.getTime();
  const rangeEndTime = Math.max(rangeStartTime + 86_400_000, date.getTime());
  const naturalPoint = 24 + ((date.getTime() - rangeStartTime) / (rangeEndTime - rangeStartTime)) * (width - 48);
  const pointX = Math.round(Math.max(width * .58, Math.min(width - 24, naturalPoint)));
  const connectorStart = Math.max(18, pointX - 24);
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Portfolio tracking began ${label}; earlier time is not tracked">
    <line class="chart-unavailable-line" x1="18" y1="${baseline}" x2="${connectorStart}" y2="${baseline}"/>
    <line class="chart-start-line" x1="${connectorStart}" y1="${baseline}" x2="${pointX}" y2="${baseline}"/>
    <circle class="chart-start-point" cx="${pointX}" cy="${baseline}" r="8"/>
    <text x="${pointX}" y="${baseline - 16}" text-anchor="middle" class="chart-start-value">${fmt.format(value)}</text>
    <text x="${pointX}" y="${height - 10}" text-anchor="middle" class="chart-start-detail">Tracking began ${label}</text>
  </svg>`;
}

function aggregateHoldingRangeProgress(positions) {
  const progress = positions.map((position) => position.rangeProgress).filter(Boolean);
  // A grouped ticker is only performance-ready when every displayed position
  // has the same complete observed window. Never combine one account's dollar
  // movement with another account's percentage or silently fill a gap.
  if (!progress.length || progress.length !== positions.length || progress.some((entry) => entry.state !== 'ready')) return null;
  const first = progress[0];
  if (progress.some((entry) => entry.range !== first.range || entry.startDate !== first.startDate || entry.endDate !== first.endDate)) return null;
  const startValue = progress.reduce((sum, entry) => sum + Number(entry.startValue || 0), 0);
  const endValue = progress.reduce((sum, entry) => sum + Number(entry.endValue || 0), 0);
  const valueChange = progress.reduce((sum, entry) => sum + Number(entry.valueChange || 0), 0);
  const hasMarketChange = progress.every((entry) => entry.marketChange != null && Number.isFinite(Number(entry.marketChange)));
  const marketChange = hasMarketChange ? progress.reduce((sum, entry) => sum + Number(entry.marketChange), 0) : null;
  return {
    ...first,
    startValue,
    endValue,
    valueChange,
    marketChange,
    marketChangePct: marketChange != null && startValue > 0 ? marketChange / startValue : null,
    changeKind: marketChange != null ? 'market' : 'balance',
    points: Math.min(...progress.map((entry) => Number(entry.points || 0)))
  };
}

function aggregateHoldings(positions) {
  const groups = new Map();
  for (const position of positions) {
    const key = String(position.ticker || position.name || position.id).trim().toLowerCase();
    const group = groups.get(key) || { id: key, ticker: position.ticker, name: position.name, positions: [] };
    group.positions.push(position);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const value = group.positions.reduce((sum, position) => sum + Number(position.value || 0), 0);
    const costBasis = group.positions.every((position) => position.cost_basis != null)
      ? group.positions.reduce((sum, position) => sum + Number(position.cost_basis || 0), 0) : null;
    const classifications = [...new Set(group.positions.map((position) => assetClassLabel(position.type, position.asset_class_override)))];
    const classification = classifications.length === 1 ? classifications[0] : 'Mixed';
    return { ...group, value, costBasis, classification, gain: costBasis == null ? null : value - costBasis, gain_pct: costBasis ? (value - costBasis) / costBasis : null, rangeProgress: aggregateHoldingRangeProgress(group.positions) };
  });
}

function historyForRange(history, range = state.holdingHistoryRange) {
  if (!history?.length || range === 'all') return history || [];
  const filtered = filterSnapshots(history, range, new Date(`${history.at(-1).date}T12:00:00`));
  return filtered.length ? filtered : history.slice(-1);
}

function renderHoldingHistoryChart(history, kind, emptyMessage = null, historyState = 'ready') {
  const el = $('#holdingHistoryChart');
  if (historyState === 'loading') {
    el.innerHTML = `<div class="holding-history-state holding-history-skeleton" data-history-state="loading" role="status"><b>Loading history</b><span>Checking the latest reported activity.</span><i></i><i></i></div>`;
    return;
  }
  if (historyState === 'preparing') {
    el.innerHTML = `<div class="holding-history-state" data-history-state="preparing" role="status"><b>Preparing your history</b><span>${escapeHtml(emptyMessage || 'Your institution is preparing reported activity. We will only show a trend once it can be verified.')}</span></div>`;
    return;
  }
  if (history?.length === 1 || historyState === 'tracking') {
    const snapshot = history?.[0];
    if (snapshot) {
      renderHoldingTrackingStart(el, snapshot, kind);
      return;
    }
  }
  if (!history?.length || el.clientWidth < 80) {
    const message = emptyMessage || 'Your first verified update will start this chart. We will not invent earlier values.';
    el.innerHTML = `<div class="holding-history-empty holding-history-state" data-history-state="tracking"><b>Tracking starts with your next update</b><span>${escapeHtml(message)}</span></div>`;
    return;
  }
  const pointsData = historyForRange(history, state.holdingHistoryRange);
  const width = Math.max(1, Math.round(el.clientWidth));
  const height = Math.max(1, Math.round(el.clientHeight));
  const plot = { left: 12, right: 12, top: 12, bottom: height - 28 };
  const values = pointsData.map((entry) => Number(entry.value || 0));
  let min = Math.min(...values); let max = Math.max(...values);
  const spread = max - min || Math.max(Math.abs(max) * .08, 1);
  min -= spread * .12; max += spread * .12;
  const times = pointsData.map((row) => Date.parse(`${row.date}T00:00:00Z`));
  const points = values.map((value, index) => [plot.left + (times[index] - times[0]) / Math.max(times.at(-1) - times[0], 1) * (width - plot.left - plot.right), plot.bottom - (value - min) / (max - min) * (plot.bottom - plot.top)]);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L ${points.at(-1)[0]} ${plot.bottom} L ${points[0][0]} ${plot.bottom} Z`;
  const firstTime = times[0];
  const lastTime = times.at(-1);
  const shortSpan = lastTime - firstTime <= 45 * 86400000;
  // Two-digit years ("Sep 26") read like a day of the month. For longer
  // windows use the full year; reserve day labels for genuinely short spans.
  const label = (entry) => new Date(`${entry.date}T12:00:00`).toLocaleDateString('en-US', shortSpan
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', year: 'numeric' });
  const startLabel = label(pointsData[0]);
  const endLabel = label(pointsData.at(-1));
  // A flat or same-day history has one calendar period, not two endpoints.
  // Showing the label twice makes the axis look broken and adds no context.
  const historyAxis = startLabel === endLabel
    ? `<span class="holding-history-axis end">${endLabel}</span>`
    : `<span class="holding-history-axis start">${startLabel}</span><span class="holding-history-axis end">${endLabel}</span>`;
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${kind === 'market' ? 'Market price' : 'Your position value'} history"><defs><linearGradient id="holdingHistoryFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#287143" stop-opacity=".18"/><stop offset="1" stop-color="#287143" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#holdingHistoryFade)"/><path class="holding-history-line" pathLength="1" d="${line}" fill="none" stroke="#287143" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><line class="holding-scrub-line" x1="0" y1="${plot.top}" x2="0" y2="${plot.bottom}"/><circle class="holding-scrub-dot" cx="0" cy="0" r="4"/></svg>${historyAxis}<div class="chart-tooltip hidden"></div>`;
  if (pointsData.length < 2) return;
  const svg = el.querySelector('svg'); const tooltip = el.querySelector('.chart-tooltip'); const scrubLine = el.querySelector('.holding-scrub-line'); const scrubDot = el.querySelector('.holding-scrub-dot');
  const showPoint = (event) => {
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left)) / rect.width * width;
    const index = points.reduce((nearest, point, candidate) => Math.abs(point[0] - x) < Math.abs(points[nearest][0] - x) ? candidate : nearest, 0);
    const [pointX, pointY] = points[index];
    scrubLine.setAttribute('x1', pointX); scrubLine.setAttribute('x2', pointX); scrubDot.setAttribute('cx', pointX); scrubDot.setAttribute('cy', pointY);
    scrubLine.classList.add('visible'); scrubDot.classList.add('visible'); tooltip.classList.remove('hidden');
    tooltip.textContent = `${kind === 'market' ? fmt.format(Number(pointsData[index].value)) : fmt.format(Number(pointsData[index].value))} · ${new Date(`${pointsData[index].date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    placeChartTooltip(tooltip, pointX / width * rect.width, rect.width);
  };
  let active = false;
  svg.addEventListener('pointerdown', (event) => { active = true; svg.setPointerCapture?.(event.pointerId); showPoint(event); });
  svg.addEventListener('pointermove', (event) => { if (active || event.pointerType === 'mouse') showPoint(event); });
  svg.addEventListener('pointerup', () => { active = false; });
  svg.addEventListener('pointerleave', () => { if (!active) { scrubLine.classList.remove('visible'); scrubDot.classList.remove('visible'); tooltip.classList.add('hidden'); } });
}

function renderHoldingTrackingStart(el, snapshot, kind) {
  const width = Math.max(1, Math.round(el.clientWidth || 320));
  const height = Math.max(1, Math.round(el.clientHeight || 196));
  const baseline = Math.round(height * .58);
  const pointX = Math.round(width * .72);
  const date = new Date(`${snapshot.date}T12:00:00`);
  const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  el.innerHTML = `<svg data-history-state="tracking" viewBox="0 0 ${width} ${height}" role="img" aria-label="${kind === 'market' ? 'Market price' : 'Your position'} tracking began ${label}">
    <line class="chart-unavailable-line" x1="18" y1="${baseline}" x2="${pointX - 24}" y2="${baseline}"/>
    <line class="chart-start-line" x1="${pointX - 24}" y1="${baseline}" x2="${pointX}" y2="${baseline}"/>
    <circle class="chart-start-point" cx="${pointX}" cy="${baseline}" r="7"/>
    <text x="${pointX}" y="${baseline - 15}" text-anchor="middle" class="chart-start-value">${fmt.format(Number(snapshot.value || 0))}</text>
    <text x="${pointX}" y="${height - 10}" text-anchor="middle" class="chart-start-detail">Tracking began ${label}</text>
  </svg>`;
}

function holdingRangeMetric(progress) {
  if (progress?.state !== 'ready') return null;
  // A holding's balance can change because shares arrived, left, or moved
  // accounts. Only provider-confirmed same-share price movement is a holding
  // performance result; otherwise withhold the number entirely.
  if (progress.scope === 'holding' && progress.marketChange == null) return null;
  const change = Number(progress.marketChange ?? progress.valueChange);
  // A displayed “+$0” promises movement where there is none at the precision
  // we show people. Keep the chart/history available, but do not give a
  // neutral, rounded amount gain styling or a metric slot.
  if (!Number.isFinite(change) || Math.round(Math.abs(change) * 100) === 0) return null;
  const percent = progress.marketChange != null ? progress.marketChangePct : null;
  return {
    label: progress.marketChange != null ? 'Market movement' : 'Value change',
    value: `${change >= 0 ? '+' : '−'}${fmt.format(Math.abs(change))}`,
    detail: `${investmentRangeLabel(progress.range)}${percent == null ? '' : ` · ${change >= 0 ? '+' : '−'}${Math.abs(percent * 100).toFixed(1)}%`}`,
    tone: change >= 0 ? 'positive' : 'negative'
  };
}

function renderHoldingHistoryDetail() {
  const data = state.holdingHistory;
  if (!data) return;
  // Account and holding drill-ins answer different questions. Keep their
  // identities explicit instead of allowing an account with one holding to
  // accidentally inherit that holding's ticker as its title.
  const isAccountDetail = Boolean(data.accountId);
  const isMarket = state.holdingHistoryMode === 'market';
  const history = isMarket ? data.market : data.history;
  $('#holdingHistoryEyebrow').textContent = isMarket ? 'Market price' : (isAccountDetail ? 'Your account' : 'Your position');
  $('#holdingHistoryTitle').textContent = isAccountDetail ? (data.label || 'Investment account') : (data.ticker || data.label || 'Investment detail');
  $('#holdingHistorySubtitle').textContent = isAccountDetail
    ? 'Your account value over time'
    : (data.ticker && data.label !== data.ticker ? data.label : (isMarket ? 'Price history for this security' : 'Your value over time'));
  const rangeMetric = holdingRangeMetric(data.progress);
  const metrics = $('#holdingHistoryMetrics');
  metrics.classList.toggle('single', !rangeMetric);
  metrics.innerHTML = `<div><span>Current value</span><strong>${fmt.format(Number(data.value || 0))}</strong></div>${rangeMetric ? `<div><span>${rangeMetric.label}</span><strong class="${rangeMetric.tone}">${rangeMetric.value}</strong><small>${rangeMetric.detail}</small></div>` : ''}`;
  const hasMarket = (data.market || []).length > 1;
  $('#holdingHistoryTabs').innerHTML = `<button type="button" class="${!isMarket ? 'active' : ''}" data-holding-history-mode="position" role="tab" aria-selected="${!isMarket}">Your position</button>${hasMarket ? `<button type="button" class="${isMarket ? 'active' : ''}" data-holding-history-mode="market" role="tab" aria-selected="${isMarket}">Market price</button>` : ''}`;
  const ranges = [['1m', '1M'], ['3m', '3M'], ['6m', '6M'], ['ytd', 'YTD'], ['1y', '1Y'], ['all', 'All']];
  $('#holdingHistoryRange').innerHTML = ranges.map(([value, label]) => `<button type="button" class="${state.holdingHistoryRange === value ? 'active' : ''}" data-holding-history-range="${value}" aria-pressed="${state.holdingHistoryRange === value}">${label}</button>`).join('');
  $('#holdingHistoryNote').textContent = isMarket ? 'Market price does not include your purchases, sales, or contributions.' : (data.detail || data.reason || 'Your position history is unavailable.');
  // A dialog has no stable width until the browser has painted it. Defer chart
  // measurement one frame so mobile and desktop both receive a real canvas.
  requestAnimationFrame(() => renderHoldingHistoryChart(history, isMarket ? 'market' : 'position', data.reason, isMarket ? 'ready' : data.state));
  const positions = (state.investments?.positions || []).filter((position) => data.accountId ? position.account_id === data.accountId : data.ticker && String(position.ticker || '').toUpperCase() === data.ticker);
  const accounts = new Map((state.investments?.accounts || []).map((account) => [account.account_id, account]));
  const canEditClass = !state.demoPreview && !state.dashboard?.demoMode;
  // In an account drill-in, repeating the account name for every row hides
  // the only useful differentiator: the security. Prefer a ticker, then a
  // provider-supplied security name. When neither is meaningful, state that
  // plainly instead of echoing the account name as if it were a holding.
  const holdingLabel = (position, account) => {
    const accountLabels = new Set([account?.name, account?.nickname, account?.official_name]
      .filter(Boolean).map((value) => String(value).trim().toLowerCase()));
    const ticker = String(position.ticker || '').trim();
    if (ticker) return ticker;
    const name = String(position.name || '').trim();
    if (name && !accountLabels.has(name.toLowerCase())) return name;
    return `Unnamed ${assetClassLabel(position.type, position.asset_class_override).toLowerCase()} holding`;
  };
  $('#holdingHistoryWhere').innerHTML = positions.length ? `<span>${isAccountDetail ? 'Holdings in this account' : 'Held in'}</span>${positions.map((position) => {
    const account = accounts.get(position.account_id);
    const accountName = account?.name || 'Investment account';
    const assetClass = assetClassLabel(position.type, position.asset_class_override);
    const rowTitle = isAccountDetail ? holdingLabel(position, account) : accountName;
    const rowDetail = isAccountDetail ? `${accountName} · ${assetClass}` : assetClass;
    return `<div><b>${escapeHtml(rowTitle)}</b><small>${escapeHtml(rowDetail)}</small><strong>${fmt.format(Number(position.value || 0))}</strong>${canEditClass ? holdingClassControl(position) : ''}</div>`;
  }).join('')}` : '';
}

async function openHoldingHistory({ ticker = '', accountId = '' } = {}, { preserveRange = false } = {}) {
  const dialog = $('#holdingHistoryDialog');
  const selectedAccount = accountId ? (state.investments?.accounts || []).find((account) => account.account_id === accountId) : null;
  const accountLabel = selectedAccount?.name || 'Investment account';
  const accountValue = selectedAccount ? Number(selectedAccount.value || selectedAccount.balance || 0) : 0;
  state.holdingHistory = { state: 'loading', label: accountId ? accountLabel : 'Investment detail', ticker, value: accountValue, history: [], market: [], reason: 'Loading your history…' };
  if (!preserveRange) state.holdingHistoryMode = 'position';
  // This starts aligned with the page for continuity, then belongs only to
  // this drill-in. Changing it never alters the Investments overview.
  if (!preserveRange) state.holdingHistoryRange = state.investmentRange;
  if (!dialog.open) {
    dialog.showModal();
    // A dialog normally auto-focuses its first button. On the phone that is
    // the full-width drag target, so its keyboard ring looks like a colored
    // border around the new sheet. Keep initial focus on the dialog instead;
    // Tab still reaches the handle and shows its focus indicator as expected.
    dialog.focus({ preventScroll: true });
  }
  renderHoldingHistoryDetail();
  try {
    const base = state.demoPreview || state.onboardingPreview || state.dashboard?.demoMode ? '/api/demo-investments/history' : '/api/investments/history';
    const scope = accountId ? `account_id=${encodeURIComponent(accountId)}` : `ticker=${encodeURIComponent(ticker)}`;
    const query = `${scope}&range=${encodeURIComponent(state.holdingHistoryRange)}`;
    const response = await api(`${base}?${query}`);
    state.holdingHistory = {
      ...response,
      // The API normally supplies these fields. Retain the selected account
      // as a final UI safeguard for an incomplete provider response.
      label: response.label || (accountId ? accountLabel : response.ticker || 'Investment detail'),
      value: response.value == null && accountId ? accountValue : response.value,
      accountId: accountId || null
    };
    renderHoldingHistoryDetail();
  } catch (error) {
    state.holdingHistory = { state: 'unavailable', label: 'Investment detail', ticker, value: 0, history: [], market: [], reason: error.message || 'We could not load this history right now.' };
    renderHoldingHistoryDetail();
  }
}

function renderInvestments(data) {
  if (!data) return;
  const accounts = data.accounts || [];
  const allSnapshots = uniqueDailySnapshots(data.snapshots || []);
  syncPortfolioRangeControls(allSnapshots);
  // Initial payloads are intentionally requested as `all` so the client can
  // select the best available default. Once it selects a different range,
  // fetch the matching server-calculated account and holding performance
  // before rendering any amount beneath that selected control.
  if (data.range && data.range !== state.investmentRange) {
    void loadInvestmentRange(state.investmentRange);
    return;
  }
  const snapshots = portfolioSnapshots(data);
  const endSnapshot = snapshots.at(-1);
  const startSnapshot = snapshots[0];
  const displayedTotal = Number(endSnapshot?.value ?? data.total ?? 0);
  const periodChange = snapshots.length > 1 ? displayedTotal - Number(startSnapshot?.value || 0) : null;
  const periodLabel = investmentRangeLabel(state.investmentRange);
  const changePeriodLabel = portfolioChangeLabel(snapshots);
  $('#investmentTotal').textContent = fmt.format(displayedTotal);
  const started = snapshots[0]?.date ? new Date(`${snapshots[0].date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null;
  const changeCopy = periodChange == null ? (started ? `Tracking since ${started}` : 'Sync to begin tracking') : `${periodChange >= 0 ? '+' : '−'}${fmt.format(Math.abs(periodChange))} ${changePeriodLabel}`;
  $('#investmentContext').textContent = accounts.length ? changeCopy : 'Connect an investment account to begin.';
  $('#investmentChartDate').textContent = '';
  $('#investmentChartContext').classList.add('hidden');
  renderPortfolioChart(data);
  const allocation = data.allocation || [];
  $('#investmentAllocationCard').classList.toggle('hidden', !data.positionsAvailable);
  $('#investmentAccountsCard').classList.toggle('hidden', accounts.length < 1);
  $('#investmentHoldingsPanel').classList.toggle('hidden', !data.positionsAvailable);
  let cursor = 0;
  const colors = ['#287143', '#7ea98b', '#d5a75f', '#9ca9bd', '#b88692', '#7d91a5'];
  const donut = $('#investmentDonut');
  const previewing = Boolean(state.onboardingPreview);
  if (previewing) {
    $('#investmentAllocationInsight').textContent = 'Your allocation appears after you connect an investment account.';
    donut.style.background = 'conic-gradient(#287143 0 58%, #7ea98b 58% 80%, #d5e4d8 80% 100%)';
    donut.innerHTML = '<span><strong class="onboarding-account-fact">Your mix</strong><small class="onboarding-account-fact">After you connect</small></span>';
    $('#investmentAllocation').innerHTML = '<div class="investment-allocation-row onboarding-allocation-preview"><i></i><span>Your asset allocation</span><strong class="onboarding-account-fact">Personalized after you connect</strong></div>';
  } else if (allocation.length) {
    const largest = allocation[0];
    $('#investmentAllocationInsight').textContent = `${largest.name} is your largest allocation at ${Math.round(largest.share * 100)}%. Current mix · ${periodLabel} selected.`;
    const selected = allocation.find((row) => row.name === state.investmentFilter);
    donut.style.background = `conic-gradient(${allocation.map((row, index) => { const next = cursor + row.share * 100; const color = state.investmentFilter === 'all' || row.name === state.investmentFilter ? colors[index % colors.length] : '#dde4dd'; const stop = `${color} ${cursor.toFixed(2)}% ${next.toFixed(2)}%`; cursor = next; return stop; }).join(', ')})`;
    donut.innerHTML = selected ? `<span><strong>${fmt.format(selected.value)}</strong><small>${escapeHtml(selected.name)} · ${Math.round(selected.share * 100)}%</small></span>` : `<span><strong>${fmt.format(data.total || 0)}</strong><small>All assets</small></span>`;
    $('#investmentAllocation').innerHTML = `<button class="investment-allocation-row ${state.investmentFilter === 'all' ? 'active' : ''}" data-investment-filter="all"><i></i><span>All assets</span><strong>${fmt.format(data.total || 0)}</strong></button>${allocation.map((row, index) => `<button class="investment-allocation-row ${state.investmentFilter === row.name ? 'active' : ''}" data-investment-filter="${escapeHtml(row.name)}"><i style="background:${colors[index % colors.length]}"></i><span>${escapeHtml(row.name)}</span><small>${Math.round(row.share * 100)}%</small><strong>${fmt.format(row.value)}</strong></button>`).join('')}`;
  } else {
    donut.style.background = '#edf0eb'; donut.innerHTML = '<span>Awaiting<br>holdings</span>';
    $('#investmentAllocationInsight').textContent = 'Allocation appears when your institution provides holdings.';
    $('#investmentAllocation').innerHTML = '<p class="spending-empty">Allocation appears when your institution provides holdings.</p>';
  }
  $('#investmentAccounts').innerHTML = accounts.length ? (previewing ? accounts.slice(0, 3).map(() => `<div class="investment-account-row onboarding-investment-account" aria-label="Illustrative investment account preview"><div><strong class="onboarding-account-fact">Investment account</strong><span class="onboarding-account-fact">Holdings and verified history appear here</span></div><div class="investment-account-value"><b class="onboarding-account-fact">Value after you connect</b></div></div>`).join('') : accounts.map((account) => {
    const change = account.rangeProgress?.state === 'ready' ? Number(account.rangeProgress.valueChange) : null;
    const showChange = change != null && Number.isFinite(change) && Math.round(Math.abs(change) * 100) > 0;
    const changeLine = showChange ? `<small class="${change >= 0 ? 'positive' : 'negative'}">${change >= 0 ? '+' : '−'}${fmt.format(Math.abs(change))} · ${investmentRangeLabel(account.rangeProgress.range)}</small>` : '';
    return `<button type="button" class="investment-account-row" data-investment-account-history="${escapeHtml(account.account_id)}" aria-label="View ${escapeHtml(account.name)} performance history"><div><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(account.institution_name || '')} · View history</span></div><div class="investment-account-value"><b>${fmt.format(account.value)}</b>${changeLine}</div><i aria-hidden="true">›</i></button>`;
  }).join('')) : '<p class="spending-empty">No investment accounts connected.</p>';
  const names = new Map(accounts.map((account) => [account.account_id, account.name]));
  const isUnclassified = state.investmentFilter === 'Cash & unclassified';
  const unclassifiedAccounts = data.unclassifiedAccounts || [];
  let positions = aggregateHoldings((data.positions || []).filter((position) => state.investmentFilter === 'all' || (!isUnclassified && assetClassLabel(position.type, position.asset_class_override) === state.investmentFilter)));
  positions = [...positions].sort((a, b) => state.investmentSort === 'performance' ? Number(b.gain_pct ?? -Infinity) - Number(a.gain_pct ?? -Infinity) : state.investmentSort === 'equity' ? a.classification.localeCompare(b.classification) || Number(b.value) - Number(a.value) : Number(b.value) - Number(a.value));
  $('#investmentSort').value = state.investmentSort;
  if (isUnclassified) {
    const affected = unclassifiedAccounts.filter((account) => Math.abs(Number(account.difference || 0)) > 1);
    $('#investmentHoldingsInsight').textContent = affected.length ? `${affected.length} account${affected.length === 1 ? '' : 's'} needs holdings reconciliation · ${periodLabel} selected` : 'Account balances and holdings are currently reconciled.';
    $('#investmentPositions').innerHTML = affected.length ? affected.map((account) => {
      const missing = Number(account.difference) > 0;
      const amount = Math.abs(Number(account.difference || 0));
      const canEdit = !state.demoPreview && !state.dashboard?.demoMode;
      const action = missing && canEdit ? `<button type="button" class="manual-holding-button" data-add-manual-holding="${escapeHtml(account.account_id)}" data-manual-account-name="${escapeHtml(account.name)}" data-manual-remaining="${amount}">Add holding</button>` : '';
      return `<div class="unclassified-account-row"><div class="unclassified-mark" aria-hidden="true">?</div><div><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(account.institution_name || 'Institution')} · ${missing ? 'No matching holdings returned' : 'Holdings currently exceed the account balance'}</span></div><div class="unclassified-actions"><b class="${missing ? '' : 'negative'}">${missing ? '' : '−'}${fmt.format(amount)}</b>${action}</div></div>`;
    }).join('') : '<p class="positions-empty">All investment account balances match their returned holdings.</p>';
    $('#investmentHoldingsMore').classList.add('hidden');
    return;
  }
  if (previewing) {
    $('#investmentHoldingsInsight').textContent = 'See your holdings and how they change over time.';
    $('#investmentPositions').innerHTML = Array.from({ length: 3 }, () => '<div class="holding-row onboarding-holding-preview" aria-label="Illustrative holding preview"><div class="position-symbol onboarding-account-fact">•••</div><div class="holding-copy"><strong class="onboarding-account-fact">A connected holding</strong><span class="onboarding-account-fact">Name, value, and performance appear here</span><div class="holding-weight"><i><b style="width:56%"></b></i><span class="onboarding-account-fact">Your share of portfolio</span></div></div><div class="position-value"><b class="onboarding-account-fact">Value after you connect</b></div></div>').join('');
    $('#investmentHoldingsMore').classList.add('hidden');
    return;
  }
  const visiblePositions = state.holdingsExpanded ? positions : positions.slice(0, 3);
  const previewCopy = visiblePositions.length < positions.length ? `Showing ${visiblePositions.length} of ${positions.length}` : `${positions.length} current holding${positions.length === 1 ? '' : 's'}`;
  $('#investmentHoldingsInsight').textContent = data.positionsAvailable ? `${previewCopy}${state.investmentFilter === 'all' ? '' : ` · ${state.investmentFilter}`} · ${periodLabel} selected` : 'Holdings appear when your institution provides them.';
  $('#investmentPositions').innerHTML = data.positionsAvailable ? visiblePositions.map((position) => {
    const progress = position.rangeProgress;
    const change = progress?.state === 'ready' && progress.marketChange != null ? Number(progress.marketChange) : null;
    const hasVisibleChange = change != null && Math.round(Math.abs(change) * 100) > 0;
    const performance = change == null
      ? (progress?.state === 'tracking' ? 'Tracking started' : '')
      : hasVisibleChange ? `${change >= 0 ? '+' : '−'}${fmt.format(Math.abs(change))}${progress.marketChange != null && progress.marketChangePct != null ? ` · ${change >= 0 ? '+' : '−'}${Math.abs(progress.marketChangePct * 100).toFixed(1)}%` : ''}` : '';
    const share = data.total ? Math.max(0, Number(position.value || 0) / Number(data.total) * 100) : 0;
    const location = position.positions.length === 1 ? 'Held in 1 account' : `Held in ${position.positions.length} accounts`;
    return `<button type="button" class="holding-row" data-holding-history="${escapeHtml(position.ticker || '')}" aria-label="View ${escapeHtml(position.name)} history"><div class="position-symbol">${escapeHtml(position.ticker || '•')}</div><div class="holding-copy"><strong class="holding-ticker">${escapeHtml(position.ticker || 'Holding')}</strong><span>${escapeHtml(position.name)} · ${location}</span><div class="holding-weight"><i><b style="width:${Math.min(100, share).toFixed(1)}%"></b></i><span>${Math.round(share)}% of portfolio</span></div></div><div class="position-value"><b>${fmt.format(position.value)}</b>${performance ? `<small class="${change == null ? '' : change >= 0 ? 'positive' : 'negative'}">${performance}</small>` : ''}</div><i class="holding-chevron" aria-hidden="true">›</i></button>`;
  }).join('') : '<p class="positions-empty">Position details aren’t available from this connection yet. Your investment account balances still count toward your portfolio and net worth.</p>';
  const more = $('#investmentHoldingsMore');
  more.classList.toggle('hidden', positions.length <= 3);
  more.textContent = state.holdingsExpanded ? 'Show fewer holdings' : `View all ${positions.length} holdings`;
}

function assetClassLabel(type, override = null) {
  if (override) return override;
  const value = String(type || '').toLowerCase();
  if (value === 'equity') return 'Equities';
  if (value === 'etf' || value === 'mutual fund') return 'Funds';
  if (value === 'fixed income') return 'Fixed income';
  if (value === 'cash') return 'Cash';
  if (value === 'cryptocurrency') return 'Crypto';
  return 'Other';
}

const holdingClassOptions = [
  ['', 'Automatic'],
  ['Equities', 'Equities'],
  ['Funds', 'Funds'],
  ['Fixed income', 'Fixed income'],
  ['Cash', 'Cash'],
  ['Crypto', 'Crypto'],
  ['Other', 'Other']
];

function holdingClassControl(position) {
  const value = position.asset_class_override || '';
  const attribute = position.manual ? 'data-history-manual-holding-class' : 'data-history-position-class';
  return `<label class="holding-history-class">Asset type <select ${attribute}="${escapeHtml(position.id)}" aria-label="Asset type for ${escapeHtml(position.name || position.ticker || 'holding')}; Automatic uses your institution's classification" title="Automatic uses your institution's classification">${holdingClassOptions.map(([option, label]) => `<option value="${option}" ${value === option ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
}

function renderRetirement(data) {
  if (!data) return;
  state.retirement = data;
  const projectedBalance = fmt.format(data.projectedAtRetirement || 0);
  $('#retirementProjection').textContent = projectedBalance;
  $('#retirementProjectionContext').textContent = `On pace for ${projectedBalance} by age ${data.retirementAge}`;
  $('#retirementAgeChip').textContent = `${data.yearsToRetirement} years to go`;
  $('#retirementSpendContext').textContent = data.monthsObserved ? `Needed by age ${data.retirementAge}, in today’s dollars · Based on your last ${data.monthsObserved} month${data.monthsObserved === 1 ? '' : 's'} of spending.` : `Needed by age ${data.retirementAge}, in today’s dollars.`;
  $('#retirementAssumption').textContent = `At retirement · ${data.withdrawalRate}% withdrawal`;
  const estimatedLabel = (months, complete) => {
    if (complete) return 'Reached';
    if (!Number.isFinite(months)) return 'Needs a savings pace';
    const date = new Date();
    date.setMonth(date.getMonth() + months);
    return `Est. ${date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
  };
  const milestoneCards = (data.ladder || []).map((step) => {
    const interactive = ['coast', 'standard'].includes(step.key);
    const tag = interactive ? 'button' : 'div';
    const action = interactive ? ` type="button" data-retirement-milestone="${step.key}" aria-label="Learn about ${escapeHtml(step.name)}"` : '';
    const detail = step.key === 'coast' ? `Amount needed today to fund retirement by age ${data.retirementAge} without further contributions`
      : step.key === 'standard' ? 'Enough invested to cover retirement spending'
        : step.detail;
    return `<${tag} class="retirement-milestone ${step.complete ? 'complete' : ''}"${action}><span class="retirement-milestone-name">${step.complete ? '✓ ' : ''}${escapeHtml(step.name)}</span><strong>${fmt.format(step.target || 0)}</strong><small class="retirement-milestone-detail">${escapeHtml(detail)}</small><i aria-label="${Math.round(Math.min(100, Number(step.progress || 0)))}% of target"><b style="width:${Math.min(100, Number(step.progress || 0)).toFixed(1)}%"></b></i><em>${escapeHtml(estimatedLabel(step.estimatedMonths, step.complete))}</em></${tag}>`;
  }).join('');
  $('#retirementPath').innerHTML = milestoneCards;
  $('#retirementLifestylePaths').innerHTML = (data.lifestyles || []).map((path, index) => `<div class="retirement-lifestyle ${index === 1 ? 'featured' : ''}"><span>${escapeHtml(path.name)}</span><strong>${fmt.format(path.target || 0)}</strong><small>${escapeHtml(path.detail)} · By age ${data.retirementAge}</small></div>`).join('');
  const form = $('#retirementForm');
  form.age.value = data.age;
  form.retirement_age.value = data.retirementAge;
  form.withdrawal_rate.value = data.withdrawalRate;
  form.real_return.value = data.realReturn;
  $('#retirementAgeValue').value = data.age;
  $('#retirementRetireAgeValue').value = data.retirementAge;
  $('#retirementWithdrawalValue').value = data.withdrawalRate;
  $('#retirementReturnValue').value = data.realReturn;
  form.retirement_age.min = String(Math.min(80, Number(data.age) + 1));
  $('#retirementRetireAgeValue').min = form.retirement_age.min;
}

function renderDashboard() {
  const actual = state.dashboard;
  if (!actual) return;
  const d = state.onboardingPreview?.dashboard || actual;
  renderFreshAccountStates(actual);
  const s = d.summary;
  setInitialNetWorthRange(d.snapshots || []);
  if (state.view === 'overview') restoreNetWorthHero();
  renderOverviewBriefing(d);
  if (state.view === 'overview') renderNetWorthChartWhenVisible();
  renderAccounts(d.accounts || []);
  renderDebtPayoff(d.debtPayoff);
  renderConnections(actual.items || []);
  renderClarityLayer(d);
  renderProfileSettings(actual);
  $('#connectButton').classList.toggle('hidden', state.view === 'profile' || Boolean(state.onboardingPreview));
  // First-run has its own composed preview and CTA. A generic warning toast
  // makes that deliberate state look like an error or failed load.
  if (!d.plaidConfigured && !state.demoPreview && !state.onboardingPreview) showNotice('Connect an account when you’re ready to see your own data.');
}

// A new member has no financial facts yet. Preserve the product's real layout
// and render its preview dataset in that layout, while keeping the person’s
// actual empty dashboard separate for connection and privacy actions.
function renderFreshAccountStates(data) {
  const isFresh = !state.demoPreview && !(data.accounts || []).length && !(data.items || []).length;
  document.documentElement.dataset.freshAccount = String(isFresh);
  document.documentElement.dataset.onboardingPreview = String(isFresh);
  $('#onboardingPreviewBanner').classList.toggle('hidden', !isFresh);
  $$('.onboarding-tab-cta').forEach((cta) => cta.classList.toggle('hidden', !isFresh));
  if (isFresh) $('#notice').classList.add('hidden');
  if (isFresh) requestAnimationFrame(applyOnboardingPreviewCopy);
  else $$('.preview-copy').forEach((element) => element.classList.remove('preview-copy'));
  const views = [
    ['overviewView', 'freshOverviewState'],
    ['spendingView', 'freshSpendingState'],
    ['investmentsView', 'freshInvestmentsState'],
    ['retirementView', 'freshRetirementState'],
    ['accountsView', 'freshAccountsState']
  ];
  views.forEach(([viewId, stateId]) => {
    const view = $(`#${viewId}`);
    const freshState = $(`#${stateId}`);
    freshState.classList.add('hidden');
    [...view.children].forEach((child) => child.classList.remove('fresh-account-hidden'));
  });
}

async function loadAll() {
  const shouldShowSkeleton = !state.dashboard;
  let skeletonTimer;
  // The visual skeleton is intentionally delayed to avoid flashing on quick
  // requests, but assistive technology and interaction tests still need an
  // immediate, reliable signal that the application is not ready yet.
  $('#appShell')?.setAttribute('aria-busy', 'true');
  if (shouldShowSkeleton) skeletonTimer = setTimeout(() => setInitialLoading(true), 180);
  setAppStatus('Refreshing your financial picture…');
  try {
    if (state.demoPreview) {
      const preview = await api(`/api/demo-preview?range=${state.spendingRange}`);
      state.onboardingPreview = null;
      state.dashboard = preview.dashboard;
      state.spending = preview.spending;
      state.investments = preview.investments;
      state.retirement = preview.retirement;
      renderDashboard();
      renderSpending(preview.spending);
      renderInvestments(preview.investments);
      renderRetirement(preview.retirement);
      $('#monthLabel').textContent = 'Demo workspace';
      return;
    }
    const [dashboard, spending, investments, retirement] = await Promise.all([api('/api/dashboard'), api(`/api/spending?range=${state.spendingRange}`), api('/api/investments'), api('/api/retirement')]);
    state.dashboard = dashboard;
    const fresh = !(dashboard.accounts || []).length && !(dashboard.items || []).length;
    const preview = fresh ? await api(`/api/demo-preview?range=${state.spendingRange}`) : null;
    state.onboardingPreview = preview;
    state.spending = preview?.spending || spending;
    state.investments = preview?.investments || investments;
    state.retirement = preview?.retirement || retirement;
    applyTheme(dashboard.appearance?.theme || 'light', false);
    renderDashboard();
    renderSpending(state.spending);
    renderInvestments(state.investments);
    renderRetirement(state.retirement);
    observeCoreCardViews();
    $('#monthLabel').textContent = 'Account overview';
  } finally {
    clearTimeout(skeletonTimer);
    setInitialLoading(false);
    // This runs after the skeleton has restored the view, covering a slow
    // first request without relying on a browser resize event.
    renderNetWorthChartWhenVisible();
    setAppStatus('');
  }
}

async function loadSpending() {
  if (state.demoPreview || state.onboardingPreview) {
    const preview = await api(`/api/demo-preview?range=${state.spendingRange}`);
    return preview.spending;
  }
  return api(`/api/spending?range=${state.spendingRange}`);
}

async function connectPlaid() {
  if (isDemoExperience()) { showNotice('Exit demo to connect your own accounts.'); return; }
  try {
    const link = await api('/api/plaid/create_link_token', { method: 'POST', body: '{}' });
    if (link.development_mock) {
      showNotice('Connecting a development test institution…');
      const result = await api('/api/plaid/development_mock_connect', { method: 'POST', body: '{}' });
      await loadAll();
      showNotice(result.already_linked ? 'Your development test institution is already connected.' : 'Development test institution connected. No Plaid account was used.', 'success');
      showConnectionOnboarding();
      return;
    }
    const { link_token } = link;
    if (!window.Plaid) throw new Error('Plaid Link failed to load. Check your internet connection.');
    const handler = window.Plaid.create({
      token: link_token,
      onSuccess: async (public_token, metadata) => {
        showNotice('Connecting account…');
        const result = await api('/api/plaid/exchange_public_token', {
          method: 'POST',
          body: JSON.stringify({ public_token, institution_name: metadata.institution?.name || 'Connected institution', institution_id: metadata.institution?.institution_id || null })
        });
        await loadAll();
        showNotice(result.sync_pending ? 'Account connected. We’re finishing its first update and will keep trying automatically.' : 'Account connected.', 'success');
        showConnectionOnboarding();
      },
      onExit: (err) => { if (err) showNotice(err.display_message || err.error_message || 'Plaid Link closed with an error.'); }
    });
    handler.open();
  } catch (error) {
    showNotice(error.message);
  }
}

async function reconnectPlaid(itemId) {
  if (isDemoExperience()) { showNotice('Exit demo to reconnect your own accounts.'); return; }
  try {
    const { link_token, reconnect_session } = await api(`/api/items/${itemId}/create_reconnect_token`, { method: 'POST', body: '{}' });
    if (!window.Plaid) throw new Error('Plaid Link failed to load. Check your internet connection.');
    const handler = window.Plaid.create({
      token: link_token,
      onSuccess: async () => {
        showNotice('Refreshing your connection…');
        await api(`/api/items/${itemId}/reconnected`, { method: 'POST', body: JSON.stringify({ reconnect_session }) });
        await loadAll();
        showNotice('Institution reconnected.', 'success');
      },
      onExit: (err) => { if (err) showNotice(err.display_message || err.error_message || 'Reconnect closed before it was completed.'); }
    });
    handler.open();
  } catch (error) { showNotice(error.message); }
}

function showConnectionOnboarding() {
  try {
    if (localStorage.getItem(onboardingStorageKey)) return;
    localStorage.setItem(onboardingStorageKey, '1');
  } catch { /* It is okay to show this again when storage is unavailable. */ }
  const dialog = $('#connectionOnboardingDialog');
  if (dialog?.showModal) dialog.showModal();
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('#homeBrand').addEventListener('click', () => setView('overview'));
$('#profileButton').addEventListener('click', () => setView('profile'));
$('#profileBack').addEventListener('click', () => setView(state.returnView || 'overview'));
// Help tips should disappear as soon as the reader returns to the page. This
// keeps optional explanation from obscuring the next action on compact views.
document.addEventListener('click', (event) => {
  $$('.retirement-method[open]').forEach((tip) => {
    if (!tip.contains(event.target)) tip.removeAttribute('open');
  });
});
applyTheme(savedTheme(), false);
$('#themeToggle').addEventListener('change', async (event) => {
  const theme = event.target.checked ? 'dark' : 'light';
  applyTheme(theme);
  if (isDemoExperience()) return;
  try {
    const appearance = await api('/api/settings/appearance', { method: 'PATCH', body: JSON.stringify({ theme }) });
    state.dashboard.appearance = appearance;
  } catch {
    showNotice('Your appearance preference will stay on this device, but could not be saved to your profile.');
  }
});
$('#demoToggle').addEventListener('click', async () => {
  // The public demo is not an authenticated session. Its profile still offers
  // an obvious way back to the welcome screen, rather than leaving a button
  // labelled “Exit demo” that cannot actually exit.
  if (state.demoPreview) { await exitDemoPreview(); return; }
  const button = $('#demoToggle');
  const enteringDemo = !state.dashboard?.demoMode;
  button.disabled = true;
  try {
    state.demoGoal = null;
    state.demoGoalInitialized = false;
    // Replace the real view before the demo payload arrives. A transition
    // should never briefly leave balances or transactions visible below the
    // demo loading state.
    if (enteringDemo) {
      state.onboardingPreview = null;
      state.dashboard = null;
      state.spending = null;
      state.investments = null;
      state.retirement = null;
      setInitialLoading(true);
    }
    await api('/api/demo-mode', { method: 'POST', body: JSON.stringify({ enabled: enteringDemo }) });
    await loadAll();
    showNotice(state.dashboard?.demoMode ? 'Demo sandbox is on. Your real data is safely hidden.' : 'Your personal financial picture is back.', 'success');
  } catch (error) { showNotice(error.message); }
  finally { button.disabled = false; }
});
$('#exportDataButton').addEventListener('click', async () => {
  if (isDemoExperience()) { showNotice(state.demoPreview ? 'Sign in to export your own data.' : 'Exit demo to download your personal data.'); return; }
  const button = $('#exportDataButton');
  button.disabled = true;
  try {
    const response = await fetch('/api/data-export', { credentials: 'same-origin' });
    if (!response.ok) throw new Error((await response.json()).error || 'Could not export your data.');
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'clarity-financial-data.json';
    link.click();
    URL.revokeObjectURL(link.href);
    showNotice('Your data download is ready.', 'success');
  } catch (error) { showNotice(error.message); }
  finally { button.disabled = false; }
});
$('#deleteAccountButton').addEventListener('click', async () => {
  if (isDemoExperience()) { showNotice(state.demoPreview ? 'Demo data is not saved to an account.' : 'Exit demo before managing your account data.'); return; }
  if (!window.confirm('Permanently delete your connected financial data? This cannot be undone.')) return;
  const confirmation = window.prompt('Type DELETE to permanently remove your account and data.');
  if (confirmation !== 'DELETE') { showNotice('Account deletion was cancelled.'); return; }
  const button = $('#deleteAccountButton');
  button.disabled = true;
  try {
    await api('/api/account', { method: 'DELETE', body: JSON.stringify({ confirmation }) });
    state.onboardingPreview = null;
    state.dashboard = null;
    $('#appShell').classList.add('hidden');
    $('#authScreen').classList.remove('hidden');
    $('#googleSignIn').innerHTML = '';
    $('#authMessage').textContent = 'Your account and saved financial data have been deleted.';
    await startGoogleSignIn();
  } catch (error) { showNotice(error.message); }
  finally { button.disabled = false; }
});
$$('[data-connect-account]').forEach((button) => button.addEventListener('click', connectPlaid));
$('#connectButton').addEventListener('click', connectPlaid);
$('#viewNetWorthAfterConnection').addEventListener('click', () => setView('overview'));
let retirementPreviewTimer;
let retirementPreviewRequest;
function resetRetirementPreview() {
  clearTimeout(retirementPreviewTimer);
  retirementPreviewRequest?.abort();
  $('#retirementPreviewStatus').textContent = '';
}
function previewRetirementPlan() {
  if (state.demoPreview || state.dashboard?.demoMode) return;
  clearTimeout(retirementPreviewTimer);
  retirementPreviewTimer = setTimeout(async () => {
    retirementPreviewRequest?.abort();
    retirementPreviewRequest = new AbortController();
    const form = new FormData($('#retirementForm'));
    try {
      const preview = await api('/api/retirement/preview', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)), signal: retirementPreviewRequest.signal });
      state.retirement = preview;
      renderRetirement(preview);
      $('#retirementPreviewStatus').textContent = 'Preview — save to keep this plan.';
    } catch (error) {
      if (error.name !== 'AbortError') $('#retirementPreviewStatus').textContent = error.message;
    }
  }, 140);
}
function syncRetirementAgeBounds() {
  const form = $('#retirementForm');
  const age = Number(form.age.value);
  const retirementAge = form.retirement_age;
  const minimumRetirementAge = Math.min(80, age + 1);
  retirementAge.min = String(minimumRetirementAge);
  $('#retirementRetireAgeValue').min = retirementAge.min;
  if (Number(retirementAge.value) < minimumRetirementAge) {
    retirementAge.value = String(minimumRetirementAge);
    $('#retirementRetireAgeValue').value = retirementAge.value;
  }
}

function previewRetirementRange(input) {
  const value = $(`[data-retirement-value="${input.name}"]`);
  if (value) value.value = input.value;
  if (input.name === 'age') syncRetirementAgeBounds();
  previewRetirementPlan();
}

$$('#retirementForm input[type="range"]').forEach((input) => input.addEventListener('input', () => previewRetirementRange(input)));
$$('[data-retirement-value]').forEach((input) => {
  const applyTypedValue = () => {
    const range = $(`#retirementForm [name="${input.dataset.retirementValue}"]`);
    if (!range || !Number.isFinite(input.valueAsNumber)) return;
    range.value = String(input.valueAsNumber);
    input.value = range.value;
    previewRetirementRange(range);
  };
  input.addEventListener('change', applyTypedValue);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } });
});
$('#retirementReset').addEventListener('click', async () => {
  resetRetirementPreview();
  try { renderRetirement(await api('/api/retirement')); }
  catch (error) { showNotice(error.message); }
});
$('#retirementForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.demoPreview || state.dashboard?.demoMode) { showNotice('Sign in to save changes to your own plan.'); return; }
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    state.retirement = await api('/api/settings/retirement', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(form)) });
    renderRetirement(state.retirement);
    resetRetirementPreview();
    $('#retirementAdjust').open = false;
    showNotice('Plan updated — your retirement outlook has been recalculated.', 'success');
  } catch (error) { showNotice(error.message); }
  finally { button.disabled = false; }
});
function openRetirementMilestone(name) {
  const plan = state.retirement;
  if (!plan) return;
  const details = {
    coast: {
      label: 'COAST RETIREMENT', title: 'What is Coast independence?', value: plan.coast,
      description: 'The amount you need invested today so that, without contributing any more, it can grow enough to fund your retirement by your target age.'
    },
    lean: {
      label: 'LEAN RETIREMENT', title: 'What is Lean retirement?', value: plan.lean,
      description: `A smaller retirement target designed for a simpler lifestyle—about ${Math.round(Number(plan.leanMultiplier || .7) * 100)}% of your current annual spending.`
    },
    standard: {
      label: 'STANDARD RETIREMENT', title: 'What is Standard retirement?', value: plan.standard,
      description: `The amount invested by age ${plan.retirementAge} that could cover your current retirement lifestyle under this plan.`
    },
    fat: {
      label: 'MORE-ROOM RETIREMENT', title: 'What is a more-flexible retirement?', value: plan.fat,
      description: `A larger retirement target for more flexibility and discretionary spending—about ${Math.round(Number(plan.fatMultiplier || 1.5) * 100)}% of your current annual spending.`
    }
  }[name];
  if (!details) return;
  trackProductEvent('retirement_milestone_opened');
  const milestone = (plan.ladder || []).find((step) => step.key === name);
  const months = Number(milestone?.estimatedMonths);
  let timing = 'Set a saving pace';
  if (milestone?.complete) timing = 'Already reached';
  else if (Number.isFinite(months)) {
    const date = new Date();
    date.setMonth(date.getMonth() + months);
    timing = `Est. ${date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
  }
  $('#retirementInfoLabel').textContent = details.label;
  $('#retirementInfoTitle').textContent = details.title;
  $('#retirementInfoDescription').textContent = details.description;
  $('#retirementInfoValue').textContent = fmt.format(details.value || 0);
  $('#retirementInfoTargetLabel').textContent = name === 'coast' ? `Needed today · Can grow to age ${plan.retirementAge}` : `Needed by age ${plan.retirementAge}`;
  $('#retirementInfoTiming').textContent = timing;
  $('#retirementInfoDialog').showModal();
}

$('#retirementPath').addEventListener('click', (event) => {
  const milestone = event.target.closest('[data-retirement-milestone]');
  if (milestone) openRetirementMilestone(milestone.dataset.retirementMilestone);
});
$('#retirementInfoClose').addEventListener('click', () => $('#retirementInfoDialog').close());
$('#accountGrid').addEventListener('click', (event) => {
  const groupButton = event.target.closest('[data-account-group]');
  if (groupButton) {
    trackProductEvent('account_group_opened');
    const group = groupButton.dataset.accountGroup;
    if (state.expandedAccountGroups.has(group)) state.expandedAccountGroups.delete(group); else state.expandedAccountGroups.add(group);
    renderAccounts(state.dashboard?.accounts || []);
    return;
  }
  const manual = event.target.closest('[data-manual-account]');
  if (manual) {
    event.preventDefault(); event.stopPropagation();
    const dialog = $('#manualAccountDialog');
    dialog.dataset.accountId = manual.dataset.manualAccount;
    $('#manualAccountDialogTitle').textContent = 'Edit asset or debt';
    $('#manualAccountName').value = manual.dataset.manualName || '';
    $('#manualAccountKind').value = manual.dataset.manualKind || 'asset';
    $('#manualAccountSubtype').value = manual.dataset.manualSubtype || '';
    $('#manualAccountValue').value = manual.dataset.manualValue || '';
    $('#manualAccountDelete').classList.remove('hidden');
    dialog.showModal();
    return;
  }
  const button = event.target.closest('[data-account-rename]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const dialog = $('#nicknameDialog');
  dialog.dataset.accountId = button.dataset.accountRename;
  $('#nicknameInput').value = button.dataset.accountName || '';
  dialog.showModal();
  $('#nicknameInput').focus();
  $('#nicknameInput').select();
});
$('#debtPayoffCard').addEventListener('click', async (event) => {
  if (event.target.closest('[data-toggle-debt-plan]')) {
    trackProductEvent('debt_plan_opened');
    state.debtPlanExpanded = !state.debtPlanExpanded;
    renderDebtPayoff(state.dashboard?.debtPayoff);
    return;
  }
  const strategyButton = event.target.closest('[data-debt-strategy]');
  if (strategyButton) {
    trackProductEvent('debt_strategy_selected');
    const strategy = strategyButton.dataset.debtStrategy;
    try {
      if (isDemoExperience()) {
        state.dashboard.debtPayoff = debtPlanForStrategy(state.dashboard.debtPayoff, strategy);
      } else {
        state.dashboard.debtPayoff = await api('/api/settings/debt-strategy', { method: 'PATCH', body: JSON.stringify({ strategy }) });
      }
      renderDebtPayoff(state.dashboard.debtPayoff);
    } catch (error) { showNotice(error.message); }
    return;
  }
  if (!event.target.closest('[data-save-debt-rates]')) return;
  const button = event.target.closest('[data-save-debt-rates]');
  const inputs = [...$('#debtPayoffCard').querySelectorAll('[data-debt-rate]')];
  const entries = inputs.filter((input) => input.value.trim() !== String(input.dataset.initialRate || ''));
  if (!entries.length) { showNotice('Change a rate before saving.'); return; }
  button.disabled = true;
  try {
    if (isDemoExperience()) {
      for (const input of entries) {
        const debt = state.dashboard.debtPayoff.debts.find((entry) => entry.id === input.dataset.debtRate);
        if (debt) debt.interestRate = input.value.trim() === '' ? null : Number(input.value);
      }
      state.dashboard.debtPayoff.missingRates = state.dashboard.debtPayoff.debts.filter((debt) => debt.interestRate == null).length;
      state.dashboard.debtPayoff = debtPlanForStrategy(state.dashboard.debtPayoff, state.dashboard.debtPayoff.strategy);
    } else {
      let plan = state.dashboard.debtPayoff;
      for (const input of entries) plan = await api(`/api/accounts/${encodeURIComponent(input.dataset.debtRate)}/debt-details`, { method: 'PATCH', body: JSON.stringify({ interest_rate: input.value }) });
      state.dashboard.debtPayoff = plan;
    }
    renderDebtPayoff(state.dashboard.debtPayoff);
    showNotice('Debt payoff plan updated.', 'success');
  } catch (error) { showNotice(error.message); } finally { button.disabled = false; }
});
$('#nicknameForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const dialog = $('#nicknameDialog');
  const save = $('#nicknameSave');
  save.disabled = true;
  try {
    await api(`/api/accounts/${dialog.dataset.accountId}/nickname`, { method: 'PATCH', body: JSON.stringify({ nickname: $('#nicknameInput').value }) });
    dialog.close();
    await loadAll();
    showNotice('Account name updated.', 'success');
  } catch (error) { showNotice(error.message); }
  finally { save.disabled = false; }
});
$('#nicknameCancel').addEventListener('click', () => $('#nicknameDialog').close());
$('#nicknameClose').addEventListener('click', () => $('#nicknameDialog').close());
function openManualAccountDialog() {
  const dialog = $('#manualAccountDialog');
  dialog.dataset.accountId = '';
  $('#manualAccountDialogTitle').textContent = 'Add an asset or debt';
  $('#manualAccountName').value = ''; $('#manualAccountKind').value = 'asset'; $('#manualAccountSubtype').value = ''; $('#manualAccountValue').value = '';
  $('#manualAccountDelete').classList.add('hidden');
  dialog.showModal(); $('#manualAccountName').focus();
}
$('#addManualAccount').addEventListener('click', openManualAccountDialog);
$('#manualAccountClose').addEventListener('click', () => $('#manualAccountDialog').close());
$('#manualAccountForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const dialog = $('#manualAccountDialog'); const editing = Boolean(dialog.dataset.accountId); const save = $('#manualAccountSave'); save.disabled = true;
  const body = { name: $('#manualAccountName').value, kind: $('#manualAccountKind').value, subtype: $('#manualAccountSubtype').value, value: $('#manualAccountValue').value };
  try { await api(editing ? `/api/manual-accounts/${encodeURIComponent(dialog.dataset.accountId)}` : '/api/manual-accounts', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) }); dialog.close(); await loadAll(); showNotice(editing ? 'Manual item updated.' : 'Manual item added.', 'success'); }
  catch (error) { showNotice(error.message); } finally { save.disabled = false; }
});
$('#manualAccountDelete').addEventListener('click', async () => {
  const dialog = $('#manualAccountDialog'); if (!dialog.dataset.accountId || !window.confirm('Delete this manual item from your net worth?')) return;
  try { await api(`/api/manual-accounts/${encodeURIComponent(dialog.dataset.accountId)}`, { method: 'DELETE' }); dialog.close(); await loadAll(); showNotice('Manual item removed.', 'success'); } catch (error) { showNotice(error.message); }
});
$('#goalAction').addEventListener('click', async () => {
  const goal = state.dashboard?.goals?.[0];
  const activeGoal = isDemoExperience() ? state.demoGoal : goal;
  if (activeGoal) {
    $('#goalRemoveDetail').textContent = `Remove “${activeGoal.name}”? You can add it again whenever you want.`;
    $('#goalRemoveDialog').showModal();
    $('#goalRemoveCancel').focus();
    return;
  }
  $('#goalName').value = ''; $('#goalSource').value = 'cash'; $('#goalTarget').value = ''; $('#goalDialog').showModal(); $('#goalName').focus();
});
$('#goalClose').addEventListener('click', () => $('#goalDialog').close());
$('#goalCancel').addEventListener('click', () => $('#goalDialog').close());
$('#goalRemoveCancel').addEventListener('click', () => $('#goalRemoveDialog').close());
$('#goalRemoveConfirm').addEventListener('click', async () => {
  const goal = state.dashboard?.goals?.[0];
  const activeGoal = isDemoExperience() ? state.demoGoal : goal;
  if (!activeGoal) { $('#goalRemoveDialog').close(); return; }
  $('#goalRemoveConfirm').disabled = true;
  try {
    if (isDemoExperience()) { state.demoGoal = null; $('#goalRemoveDialog').close(); renderClarityLayer(state.dashboard); showNotice('Demo goal removed.', 'success'); return; }
    await api(`/api/goals/${encodeURIComponent(activeGoal.id)}`, { method: 'DELETE' });
    $('#goalRemoveDialog').close(); await loadAll(); showNotice('Goal removed.', 'success');
  } catch (error) { showNotice(error.message); } finally { $('#goalRemoveConfirm').disabled = false; }
});
$('#goalForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const goal = { name: $('#goalName').value.trim(), source: $('#goalSource').value, target: Number($('#goalTarget').value) };
  if (!goal.name || !Number.isFinite(goal.target) || goal.target <= 0) { showNotice('Enter a name and goal amount.'); return; }
  try {
    if (isDemoExperience()) {
      state.demoGoal = demoGoalProgress(goal);
      $('#goalDialog').close(); renderClarityLayer(state.dashboard); showNotice('Demo goal added. It resets when you leave the demo.', 'success'); return;
    }
    await api('/api/goals', { method: 'POST', body: JSON.stringify(goal) }); $('#goalDialog').close(); await loadAll(); showNotice('Goal added.', 'success');
  } catch (error) { showNotice(error.message); }
});
$('#connectionAttentionAction').addEventListener('click', () => setView('profile'));
$('#clarityCheckinAction').addEventListener('click', () => setView($('#clarityCheckin').dataset.action || 'overview'));
$('#connectionsList').addEventListener('click', async (event) => {
  const reconnect = event.target.closest('[data-reconnect]');
  if (reconnect) { await reconnectPlaid(reconnect.dataset.reconnect); return; }
  const button = event.target.closest('[data-unlink]');
  if (!button) return;
  if (!window.confirm('Unlink this institution? Its accounts will be removed from Clarity.')) return;
  button.disabled = true;
  try {
    await api(`/api/items/${button.dataset.unlink}`, { method: 'DELETE' });
    await loadAll();
    showNotice('Institution unlinked.', 'success');
  } catch (error) {
    showNotice(error.message);
    button.disabled = false;
  }
});
$$('[data-networth-range]').forEach((button) => button.addEventListener('click', () => {
  state.networthRange = button.dataset.networthRange;
  $$('[data-networth-range]').forEach((control) => control.classList.toggle('active', control === button));
  renderOverviewBriefing(state.dashboard);
  renderNetWorthChartWhenVisible();
}));
$$('[data-spending-range]').forEach((button) => button.addEventListener('click', async () => {
  state.spendingRange = button.dataset.spendingRange;
  state.spendingMonth = null;
  $$('[data-spending-range]').forEach((control) => control.classList.toggle('active', control === button));
  $('#spendingView').setAttribute('aria-busy', 'true');
  $$('[data-spending-range]').forEach((control) => { control.disabled = true; });
  try {
    state.spending = await loadSpending();
    renderSpending(state.spending);
  } catch (error) { showNotice(error.message); }
  finally {
    $('#spendingView').setAttribute('aria-busy', 'false');
    $$('[data-spending-range]').forEach((control) => { control.disabled = false; });
  }
}));
function openCashflowDialog() {
  trackProductEvent('cash_flow_expanded');
  const dialog = $('#cashflowDialog');
  dialog.showModal();
  renderCashFlowSankey(spendingForSelectedMonth(state.spending), $('#cashflowDialogContent'), true);
}
$('#cashflowExpand').addEventListener('click', openCashflowDialog);
$('#cashflowDialogClose').addEventListener('click', () => $('#cashflowDialog').close());
let cashflowResizeFrame;
new ResizeObserver(() => {
  cancelAnimationFrame(cashflowResizeFrame);
  cashflowResizeFrame = requestAnimationFrame(() => { if (state.spending) renderSpending(state.spending); });
}).observe($('#cashflowSankey'));
$$('[data-allocation-display]').forEach((button) => button.addEventListener('click', () => {
  state.allocationDisplay = button.dataset.allocationDisplay;
  $$('[data-allocation-display]').forEach((control) => control.classList.toggle('active', control === button));
  renderSpending(state.spending);
}));
$('#spendingCategoryFilter').addEventListener('change', (event) => { state.spendingCategory = event.target.value; renderSpendingTransactions(spendingForSelectedMonth(state.spending)); });
$('#spendingSort').addEventListener('change', (event) => { state.spendingSort = event.target.value; renderSpendingTransactions(spendingForSelectedMonth(state.spending)); });
function openSpendingCategory(category) {
  if (!category) return;
  trackProductEvent('cash_flow_drilldown');
  state.spendingCategory = category;
  const panel = $('#spendingTransactionsPanel');
  panel.open = true;
  renderSpending(state.spending);
  // A Sankey or payroll tap happens well above the activity drawer on a
  // phone. Bring the filtered result into view so the interaction has an
  // obvious, immediate outcome instead of appearing to do nothing.
  requestAnimationFrame(() => {
    const summary = panel.querySelector('summary');
    summary?.focus({ preventScroll: true });
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
function filterCashflowActivityInPlace(category, selected) {
  // Bridge/status rails describe the diagram but do not map to individual
  // transactions. Every real income, spending, save, or invest rail does.
  const data = spendingForSelectedMonth(state.spending);
  const transactionKeys = new Set((data.transactions || []).flatMap((transaction) => [transaction.flowKey, transaction.flowGroup]));
  if (!transactionKeys.has(category)) return;
  state.spendingCategory = selected ? category : 'all';
  $('#spendingTransactionsPanel').open = true;
  renderSpendingTransactions(data);
  // Deliberately do not focus or scroll. The Sankey is the current reading
  // context; the open drawer updates below it for later inspection.
}
$('#spendingLegend')?.addEventListener('click', (event) => openSpendingCategory(event.target.closest('[data-spending-category]')?.dataset.spendingCategory));
$('#cashflowSankey').addEventListener('click', (event) => {
  if (event.target.closest('[data-cashflow-expand]')) { openCashflowDialog(); return; }
  const node = event.target.closest('[data-cashflow-node]');
  if (node) {
    const selected = toggleCashflowFlowSelection($('#cashflowSankey'), node.dataset.cashflowNode);
    filterCashflowActivityInPlace(node.dataset.cashflowNode, selected);
  }
});
$('#cashflowSankey').addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const target = event.target.closest('[data-cashflow-category]');
  if (!target) return;
  event.preventDefault();
  const selected = toggleCashflowFlowSelection($('#cashflowSankey'), target.dataset.cashflowNode);
  filterCashflowActivityInPlace(target.dataset.cashflowNode, selected);
});
// Flows are deliberately not tap targets: once paths overlap, that interaction
// becomes ambiguous. Instead, focusing or hovering a clear category block
// quietly traces the part of the story it belongs to.
function setCashflowFlowFocus(container, key = '') {
  const hasFocus = Boolean(key);
  container.querySelectorAll('.cashflow-flow').forEach((path) => {
    const connected = key && (path.dataset.cashflowFlow || '').split(' ').includes(key);
    path.classList.toggle('is-connected', Boolean(connected));
    path.classList.toggle('is-muted', hasFocus && !connected);
  });
  container.querySelectorAll('[data-cashflow-node]').forEach((node) => {
    node.classList.toggle('is-selected', Boolean(key && node.dataset.cashflowNode === key));
  });
}
function selectedCashflowFlow(container) {
  return container.dataset.cashflowSelection || '';
}
function toggleCashflowFlowSelection(container, key) {
  const next = selectedCashflowFlow(container) === key ? '' : key;
  if (next) container.dataset.cashflowSelection = next;
  else delete container.dataset.cashflowSelection;
  setCashflowFlowFocus(container, next);
  return Boolean(next);
}
function wireCashflowFlowFocus(container) {
  container.addEventListener('pointerover', (event) => {
    const node = event.target.closest('[data-cashflow-node]');
    if (node) setCashflowFlowFocus(container, node.dataset.cashflowNode);
  });
  container.addEventListener('pointerleave', () => setCashflowFlowFocus(container, selectedCashflowFlow(container)));
  container.addEventListener('focusin', (event) => {
    const node = event.target.closest('[data-cashflow-node]');
    if (node) setCashflowFlowFocus(container, node.dataset.cashflowNode);
  });
  container.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      if (!container.contains(document.activeElement)) setCashflowFlowFocus(container, selectedCashflowFlow(container));
    });
  });
}
wireCashflowFlowFocus($('#cashflowSankey'));
wireCashflowFlowFocus($('#cashflowDialogContent'));
// The expanded dialog renders into a separate DOM node, so it needs the same
// in-place flow selection as the inline Sankey.
$('#cashflowDialogContent').addEventListener('click', (event) => {
  const node = event.target.closest('[data-cashflow-node]');
  if (node) toggleCashflowFlowSelection($('#cashflowDialogContent'), node.dataset.cashflowNode);
});
$('#cashflowDialogContent').addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const target = event.target.closest('[data-cashflow-node]');
  if (!target) return;
  event.preventDefault();
  toggleCashflowFlowSelection($('#cashflowDialogContent'), target.dataset.cashflowNode);
});
$('#cashflowPreTax').addEventListener('click', () => openSpendingCategory('payroll_retirement'));
function donutSelection(event, element, rows) {
  const rect = element.getBoundingClientRect();
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  if (Math.hypot(x, y) < rect.width * .18) return null;
  const angle = (Math.atan2(y, x) * 180 / Math.PI + 450) % 360;
  let cursor = 0;
  return rows.find((row) => { cursor += Number(row.share || 0) * 360; return angle <= cursor; }) || null;
}
$('#spendingDonut')?.addEventListener('click', (event) => {
  const selected = donutSelection(event, event.currentTarget, spendingForSelectedMonth(state.spending).categories || []);
  if (selected) openSpendingCategory(selected.name);
});
$('#spendingDonut')?.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  const rows = spendingForSelectedMonth(state.spending).categories || [];
  openSpendingCategory(state.spendingCategory === 'all' ? rows[0]?.name : state.spendingCategory);
});
$('#investmentDonut').addEventListener('click', (event) => {
  const selected = donutSelection(event, event.currentTarget, state.investments?.allocation || []);
  if (!selected) return;
  state.investmentFilter = selected.name;
  state.holdingsExpanded = true;
  renderInvestments(state.investments);
});
$('#investmentDonut').addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  const rows = state.investments?.allocation || [];
  const selected = state.investmentFilter === 'all' ? rows[0] : rows.find((row) => row.name === state.investmentFilter);
  if (!selected) return;
  state.investmentFilter = selected.name;
  state.holdingsExpanded = true;
  renderInvestments(state.investments);
});
$('#spendingTransactions').addEventListener('change', async (event) => {
  const select = event.target.closest('[data-transaction-category]');
  if (!select) return;
  select.disabled = true;
  try {
    await api(`/api/transactions/${select.dataset.transactionCategory}/category`, { method: 'PATCH', body: JSON.stringify({ bucket: select.value }) });
    state.spending = await loadSpending();
    renderSpending(state.spending);
  } catch (error) { showNotice(error.message); select.disabled = false; }
});
$('#spendingTrend').addEventListener('click', (event) => {
  const month = event.target.closest('[data-spending-month]')?.dataset.spendingMonth;
  const row = state.spending?.monthly?.find((entry) => entry.month === month);
  if (!row) return;
  trackProductEvent('cash_flow_month_selected');
  state.spendingMonth = state.spendingMonth === month ? null : month;
  renderSpending(state.spending);
  $('#spendingTransactionsPanel').open = true;
});
$('#clearSpendingMonth').addEventListener('click', () => {
  state.spendingMonth = null;
  renderSpending(state.spending);
});
$('#spendingTrend').addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const target = event.target.closest('[data-spending-month]');
  if (!target) return;
  event.preventDefault();
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
$$('[data-investment-range]').forEach((button) => button.addEventListener('click', async () => {
  if (button.disabled) return;
  state.investmentRange = button.dataset.investmentRange;
  await loadInvestmentRange(state.investmentRange);
}));
$('#investmentAllocation').addEventListener('click', (event) => {
  const filter = event.target.closest('[data-investment-filter]')?.dataset.investmentFilter;
  if (!filter) return;
  trackProductEvent('investment_allocation_filtered');
  // Holdings sit above allocation on small screens. Preserve the selected
  // allocation row's screen position when the matching list changes height.
  const allocationTop = $('#investmentAllocationCard').getBoundingClientRect().top;
  state.investmentFilter = filter;
  state.holdingsExpanded = false;
  renderInvestments(state.investments);
  requestAnimationFrame(() => {
    const shift = $('#investmentAllocationCard').getBoundingClientRect().top - allocationTop;
    if (Math.abs(shift) > .5) window.scrollBy(0, shift);
  });
});
$('#investmentSort').addEventListener('change', (event) => {
  state.investmentSort = event.target.value;
  renderInvestments(state.investments);
});
$('#investmentHoldingsMore').addEventListener('click', () => {
  state.holdingsExpanded = !state.holdingsExpanded;
  renderInvestments(state.investments);
});
$('#investmentAccounts').addEventListener('click', (event) => {
  const account = event.target.closest('[data-investment-account-history]');
  if (account) openHoldingHistory({ accountId: account.dataset.investmentAccountHistory });
});
$('#investmentPositions').addEventListener('change', async (event) => {
  const select = event.target.closest('[data-position-class]');
  const manualSelect = event.target.closest('[data-manual-holding-class]');
  if (!select && !manualSelect) return;
  const control = select || manualSelect;
  const path = select
    ? `/api/positions/${encodeURIComponent(select.dataset.positionClass)}/asset-class`
    : `/api/manual-holdings/${encodeURIComponent(manualSelect.dataset.manualHoldingClass)}/asset-class`;
  control.disabled = true;
  try {
    const response = await api(path, { method: 'PATCH', body: JSON.stringify({ asset_class: control.value }) });
    state.investments = select ? await api('/api/investments') : response;
    renderInvestments(state.investments);
    showNotice(select ? (select.value ? 'Holding classification updated.' : 'Automatic classification restored.') : 'Manual holding classification updated.', 'success');
  } catch (error) { showNotice(error.message); control.disabled = false; }
});
$('#investmentPositions').addEventListener('click', async (event) => {
  const add = event.target.closest('[data-add-manual-holding]');
  if (add) {
    trackProductEvent('holding_reconciliation_started');
    const dialog = $('#manualHoldingDialog');
    dialog.dataset.accountId = add.dataset.addManualHolding;
    $('#manualHoldingHelp').textContent = `Your institution did not return holdings for ${add.dataset.manualAccountName}. Add up to ${fmt.format(Number(add.dataset.manualRemaining || 0))} so your allocation is accurate. This does not change anything at your institution.`;
    $('#manualHoldingTicker').value = '';
    $('#manualHoldingName').value = '';
    $('#manualHoldingClass').value = '';
    $('#manualHoldingValue').value = Number(add.dataset.manualRemaining || 0).toFixed(2);
    dialog.showModal();
    $('#manualHoldingTicker').focus();
    return;
  }
  const holding = event.target.closest('[data-holding-history]');
  if (holding) {
    openHoldingHistory({ ticker: holding.dataset.holdingHistory });
    return;
  }
  const remove = event.target.closest('[data-remove-manual-holding]');
  if (!remove) return;
  if (!window.confirm('Remove this manual holding? Your institution data will stay unchanged.')) return;
  remove.disabled = true;
  try {
    state.investments = await api(`/api/manual-holdings/${encodeURIComponent(remove.dataset.removeManualHolding)}`, { method: 'DELETE' });
    renderInvestments(state.investments);
    showNotice('Manual holding removed.', 'success');
  } catch (error) { showNotice(error.message); remove.disabled = false; }
});
$('#holdingHistoryTabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-holding-history-mode]');
  if (!tab) return;
  state.holdingHistoryMode = tab.dataset.holdingHistoryMode;
  renderHoldingHistoryDetail();
});
$('#holdingHistoryRange').addEventListener('click', (event) => {
  const range = event.target.closest('[data-holding-history-range]')?.dataset.holdingHistoryRange;
  if (!range) return;
  state.holdingHistoryRange = range;
  const data = state.holdingHistory;
  if (data) openHoldingHistory({ ticker: data.ticker || '', accountId: data.accountId || '' }, { preserveRange: true });
});
$('#holdingHistoryWhere').addEventListener('change', async (event) => {
  const select = event.target.closest('[data-history-position-class]');
  const manualSelect = event.target.closest('[data-history-manual-holding-class]');
  if (!select && !manualSelect) return;
  const control = select || manualSelect;
  const path = select
    ? `/api/positions/${encodeURIComponent(select.dataset.historyPositionClass)}/asset-class`
    : `/api/manual-holdings/${encodeURIComponent(manualSelect.dataset.historyManualHoldingClass)}/asset-class`;
  control.disabled = true;
  try {
    const response = await api(path, { method: 'PATCH', body: JSON.stringify({ asset_class: control.value }) });
    state.investments = select ? await api('/api/investments') : response;
    renderInvestments(state.investments);
    renderHoldingHistoryDetail();
    showNotice(control.value ? 'Holding classification updated.' : 'Automatic classification restored.', 'success');
  } catch (error) {
    showNotice(error.message);
    control.disabled = false;
  }
});
$('#holdingHistoryClose').addEventListener('click', () => $('#holdingHistoryDialog').close());
// On phones the bottom-sheet handle is the single close affordance. It is a
// real drag target, not decorative chrome; desktop retains its conventional
// close button. Keep the threshold deliberate so chart scrubbing or a short
// accidental touch cannot dismiss the detail.
{
  const dialog = $('#holdingHistoryDialog');
  const handle = $('#holdingHistoryDragHandle');
  let startY = null;
  let dragging = false;
  let pointerId = null;
  let touchId = null;
  let settleTimer = null;
  let dragFrame = null;
  let pendingDragOffset = 0;
  const isPhoneDrawer = () => window.matchMedia('(max-width: 560px)').matches;
  const flushDrawerPosition = () => {
    if (dragFrame != null) window.cancelAnimationFrame(dragFrame);
    dragFrame = null;
    dialog.style.transform = `translate3d(0, ${pendingDragOffset}px, 0)`;
  };
  const reset = () => {
    window.clearTimeout(settleTimer);
    if (dragFrame != null) window.cancelAnimationFrame(dragFrame);
    settleTimer = null;
    dragFrame = null;
    pendingDragOffset = 0;
    dialog.style.transform = '';
    dialog.style.transition = '';
    dialog.removeAttribute('data-dragging');
    dialog.removeAttribute('data-settling');
  };
  const startDrawerDrag = (clientY) => {
    // Safari may emit both Pointer and Touch events for one gesture. Accept
    // the first stream only—two competing start positions make the sheet
    // visibly jitter under a thumb.
    if (dragging || !isPhoneDrawer() || !Number.isFinite(clientY)) return false;
    window.clearTimeout(settleTimer);
    dialog.removeAttribute('data-settling');
    startY = clientY;
    dragging = true;
    pendingDragOffset = 0;
    dialog.setAttribute('data-dragging', '');
    dialog.style.transition = 'none';
    return true;
  };
  const moveDrawerDrag = (clientY) => {
    if (!dragging || startY == null || !Number.isFinite(clientY)) return;
    pendingDragOffset = Math.max(0, clientY - startY);
    // Draw once per frame. Pointer events can arrive more than once during a
    // frame (and used to be handled by both the handle and window), which
    // makes a sheet visibly stutter under a thumb.
    if (dragFrame == null) {
      dragFrame = window.requestAnimationFrame(() => {
        dragFrame = null;
        dialog.style.transform = `translate3d(0, ${pendingDragOffset}px, 0)`;
      });
    }
  };
  const settleAndCloseDrawer = () => {
    dialog.removeAttribute('data-dragging');
    // Keep the entry keyframe disabled until the sheet has actually closed.
    // Otherwise removing data-dragging replays its opening transform while we
    // are trying to animate it downward, which is especially noticeable on a
    // quick swipe.
    dialog.setAttribute('data-settling', '');
    dialog.style.transition = 'transform .2s cubic-bezier(.2,.75,.25,1)';
    dialog.style.transform = `translate3d(0, ${Math.ceil(dialog.getBoundingClientRect().height)}px, 0)`;
    settleTimer = window.setTimeout(() => { dialog.close(); reset(); }, 210);
  };
  const finishDrawerDrag = (clientY) => {
    if (!dragging || startY == null || !Number.isFinite(clientY)) return;
    const offset = Math.max(0, clientY - startY);
    pendingDragOffset = offset;
    flushDrawerPosition();
    dragging = false;
    startY = null;
    pointerId = null;
    touchId = null;
    // A purposeful downward swipe should feel effortless. Window listeners
    // below cover browsers that drop pointer capture when a finger leaves the
    // small handle before lifting.
    if (offset >= Math.min(52, dialog.getBoundingClientRect().height * .1)) {
      settleAndCloseDrawer();
      return;
    }
    dialog.removeAttribute('data-dragging');
    dialog.setAttribute('data-settling', '');
    dialog.style.transition = 'transform .18s ease-out';
    dialog.style.transform = 'translate3d(0, 0, 0)';
    settleTimer = window.setTimeout(reset, 190);
  };
  handle.addEventListener('pointerdown', (event) => {
    if (!startDrawerDrag(event.clientY)) return;
    pointerId = event.pointerId;
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  const movePointerDrawerDrag = (event) => { if (event.pointerId === pointerId) moveDrawerDrag(event.clientY); };
  const finishPointerDrawerDrag = (event) => {
    if (event.pointerId !== pointerId) return;
    // Synthetic events and some iOS hand-offs have no retained capture. A
    // failed release must never prevent the sheet from completing its drag.
    try { handle.releasePointerCapture?.(event.pointerId); } catch { /* no retained capture */ }
    finishDrawerDrag(event.clientY);
  };
  // One global pointer stream is intentional. Events dispatched on the
  // handle bubble to window, so registering both targets applied every move
  // twice and caused the visible jitter reported on phones.
  window.addEventListener('pointermove', movePointerDrawerDrag);
  window.addEventListener('pointerup', finishPointerDrawerDrag);
  window.addEventListener('pointercancel', finishPointerDrawerDrag);
  // iOS can dispatch Touch Events without preserving the pointer capture
  // from a short handle. Support that native path directly as well.
  const matchingTouch = (event) => [...event.changedTouches].find((touch) => touch.identifier === touchId);
  // Pointer Events cover supported iOS and every current mobile browser.
  // Keep Touch Events solely as a fallback for legacy browsers so the two
  // event models can never fight over the same gesture.
  if (!window.PointerEvent) {
    handle.addEventListener('touchstart', (event) => {
      const touch = event.changedTouches[0];
      if (!touch || !startDrawerDrag(touch.clientY)) return;
      touchId = touch.identifier;
      event.preventDefault();
    }, { passive: false });
    window.addEventListener('touchmove', (event) => {
      const touch = matchingTouch(event);
      if (!touch) return;
      moveDrawerDrag(touch.clientY);
      event.preventDefault();
    }, { passive: false });
    window.addEventListener('touchend', (event) => {
      const touch = matchingTouch(event);
      if (touch) finishDrawerDrag(touch.clientY);
    });
    window.addEventListener('touchcancel', () => { if (touchId != null) finishDrawerDrag(startY || 0); });
  }
  // On a phone this dialog is a bottom sheet, not a blocking desktop modal.
  // A tap on its dimmed backdrop should dismiss it using the same calm exit
  // as a completed downward drag. Events from the sheet's contents never
  // match the dialog element, so chart and control taps remain unaffected.
  dialog.addEventListener('click', (event) => {
    if (isPhoneDrawer() && event.target === dialog) {
      settleAndCloseDrawer();
    }
  });
  dialog.addEventListener('close', reset);
}
$('#manualHoldingForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const dialog = $('#manualHoldingDialog');
  const save = $('#manualHoldingSave');
  save.disabled = true;
  try {
    state.investments = await api(`/api/investment-accounts/${encodeURIComponent(dialog.dataset.accountId)}/manual-holdings`, {
      method: 'POST',
      body: JSON.stringify({ ticker: $('#manualHoldingTicker').value, name: $('#manualHoldingName').value, asset_class: $('#manualHoldingClass').value, value: $('#manualHoldingValue').value })
    });
    state.investmentFilter = 'all';
    state.holdingsExpanded = true;
    dialog.close();
    renderInvestments(state.investments);
    showNotice('Manual holding added.', 'success');
  } catch (error) { showNotice(error.message); }
  finally { save.disabled = false; }
});
$('#manualHoldingCancel').addEventListener('click', () => $('#manualHoldingDialog').close());
$('#manualHoldingClose').addEventListener('click', () => $('#manualHoldingDialog').close());

function showAuthenticatedApp() {
  $('#authScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
}

async function startDemoPreview() {
  const button = $('#demoPreviewButton');
  button.disabled = true;
  button.textContent = 'Opening demo…';
  state.demoPreview = true;
  state.onboardingPreview = null;
  state.demoGoal = null;
  state.demoGoalInitialized = false;
  state.spendingMonth = null;
  state.spendingCategory = 'all';
  state.view = 'overview';
  showAuthenticatedApp();
  try {
    // A public demo is often someone’s first impression. Retry one failed
    // initial fetch automatically so a short service wake-up or connection
    // blip does not strand them on an empty app shell.
    let loaded = false;
    let lastError;
    for (let attempt = 0; attempt < 2 && !loaded; attempt += 1) {
      try { await loadAll(); loaded = true; }
      catch (error) { lastError = error; if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 450)); }
    }
    if (!loaded) throw lastError;
    setView('overview');
  } catch (error) {
    state.demoPreview = false;
    state.onboardingPreview = null;
    $('#appShell').classList.add('hidden');
    $('#authScreen').classList.remove('hidden');
    $('#authMessage').textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Explore the demo <span aria-hidden="true">→</span>';
  }
}

async function exitDemoPreview() {
  state.demoPreview = false;
  state.onboardingPreview = null;
  state.demoGoal = null;
  state.demoGoalInitialized = false;
  state.dashboard = null;
  state.spending = null;
  state.investments = null;
  state.retirement = null;
  $('#appShell').classList.add('hidden');
  $('#authScreen').classList.remove('hidden');
  $('#authMessage').textContent = '';
  await startGoogleSignIn();
}

let googleSignInConfig = null;
let accessCodeCheckVersion = 0;

async function renderGoogleSignIn(config) {
  $('#googleSignIn').innerHTML = '';
  if (!config.configured) {
    $('#googleSignIn').classList.add('hidden');
    $('#authMessage').textContent = 'Google sign-in is not configured. Add GOOGLE_CLIENT_ID and a strong ENCRYPTION_KEY to the server environment.';
    return;
  }
  for (let attempts = 0; attempts < 30 && !window.google?.accounts?.id; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!window.google?.accounts?.id) { $('#authMessage').textContent = 'Google sign-in could not load. Check your connection and try again.'; return; }
  window.google.accounts.id.initialize({
    client_id: config.googleClientId,
    callback: async ({ credential }) => {
      try {
        const inviteCode = $('#inviteCode').value.trim();
        if (!inviteCode) { $('#authMessage').textContent = 'Enter your access code first.'; return; }
        $('#authMessage').textContent = 'Signing you in…';
        await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential, inviteCode }) });
        showAuthenticatedApp();
        await loadAll();
      } catch (error) { $('#authMessage').textContent = error.message; }
    }
  });
  $('#googleSignIn').classList.remove('hidden');
  window.google.accounts.id.renderButton($('#googleSignIn'), { theme: 'outline', size: 'large', width: Math.min(360, Math.floor($('#googleSignIn').clientWidth || 360)), text: 'continue_with' });
}

async function startGoogleSignIn() {
  const config = await api('/api/auth/config');
  googleSignInConfig = config;
  $('#googleSignIn').innerHTML = '';
  $('#googleSignIn').classList.add('hidden');
  if (!config.configured) return renderGoogleSignIn(config);
  $('#accessCodeStatus').textContent = '';
}

async function validateAccessCode() {
  const inviteCode = $('#inviteCode').value.trim();
  if (!inviteCode) {
    $('#googleSignIn').innerHTML = '';
    $('#googleSignIn').classList.add('hidden');
    $('#accessCodeStatus').textContent = '';
    return;
  }
  if (!googleSignInConfig?.configured) {
    $('#accessCodeStatus').textContent = 'Sign-in is still loading. Please try again.';
    return;
  }
  const version = ++accessCodeCheckVersion;
  $('#accessCodeStatus').textContent = 'Checking access code…';
  try {
    await api('/api/auth/access-code', { method: 'POST', body: JSON.stringify({ inviteCode }) });
    if (version !== accessCodeCheckVersion || $('#inviteCode').value.trim() !== inviteCode) return;
    $('#accessCodeStatus').textContent = 'Access confirmed. Continue with Google.';
    await renderGoogleSignIn(googleSignInConfig);
  } catch (error) {
    if (version === accessCodeCheckVersion) $('#accessCodeStatus').textContent = error.message;
  }
}

async function initializeApp() {
  try {
    await api('/api/auth/me');
  } catch {
    await startGoogleSignIn();
    return;
  }
  showAuthenticatedApp();
  try {
    await loadAll();
  } catch (error) {
    showNotice(navigator.onLine ? 'We could not refresh your data. Your next sync will try again.' : 'You’re offline. Reconnect to refresh your financial picture.');
    setAppStatus('');
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then((registration) => {
    const showUpdate = () => $('#updateToast').classList.remove('hidden');
    if (registration.waiting) showUpdate();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate();
      });
    });
  }).catch(() => { /* The app works normally when service workers are unavailable. */ });
}

$('#updateAppButton').addEventListener('click', () => {
  navigator.serviceWorker?.getRegistration().then((registration) => {
    if (registration?.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    else window.location.reload();
  });
});

// The worker intentionally caches no app or financial data. Reloading when it
// claims a page can interrupt an initial sign-in or demo load, so there is no
// reason to force a navigation here. New assets take effect on the next launch.
window.addEventListener('offline', () => showNotice('You’re offline. Reconnect when you’re ready to refresh your data.'));
window.addEventListener('online', async () => {
  if (!state.dashboard || state.demoPreview) return;
  setAppStatus('Back online — refreshing…');
  try { await loadAll(); showNotice('Your financial picture is current again.', 'success'); }
  catch { showNotice('Back online, but refresh is still unavailable. We’ll try again next time.'); }
});

$('#demoPreviewButton').addEventListener('click', startDemoPreview);
$('#inviteCode').addEventListener('input', () => {
  accessCodeCheckVersion += 1;
  $('#googleSignIn').innerHTML = '';
  $('#googleSignIn').classList.add('hidden');
  $('#accessCodeStatus').textContent = '';
});
$('#inviteCode').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); validateAccessCode(); }
});

$('#signOutButton').addEventListener('click', async () => {
  if (state.demoPreview) { await exitDemoPreview(); return; }
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  state.demoPreview = false;
  state.onboardingPreview = null;
  state.dashboard = null;
  state.spending = null;
  state.investments = null;
  $('#appShell').classList.add('hidden');
  $('#authScreen').classList.remove('hidden');
  $('#googleSignIn').innerHTML = '';
  $('#authMessage').textContent = '';
  await startGoogleSignIn();
});

let chartResizeFrame;
window.addEventListener('resize', () => {
  cancelAnimationFrame(chartResizeFrame);
  chartResizeFrame = requestAnimationFrame(() => {
    if (state.view === 'overview' && state.dashboard) {
      renderNetWorthChartWhenVisible();
    }
    if (state.view === 'investments' && state.investments) renderInvestments(state.investments);
  });
});

registerServiceWorker();
initializeApp().catch((error) => { $('#authMessage').textContent = error.message; });
