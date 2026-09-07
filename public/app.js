import { filterSnapshots } from '/chart-utils.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const themeStorageKey = 'clarity-theme';
const onboardingStorageKey = 'clarity-connection-onboarding-seen';

const state = {
  dashboard: null,
  spending: null,
  investments: null,
  retirement: null,
  networthRange: 'ytd',
  spendingRange: '1m',
  spendingMonth: null,
  allocationDisplay: 'percentage',
  spendingCategory: 'all',
  spendingSort: 'recent',
  investmentRange: '1y',
  investmentFilter: 'all',
  investmentSort: 'value',
  expandedAccountGroups: new Set(),
  holdingsExpanded: false,
  view: 'overview',
  returnView: 'overview',
  demoPreview: false
};

const accountGroupOrder = ['Cash', 'Savings', 'Investments', 'Credit cards', 'Loans & debt', 'Other'];
const accountGroupIcons = { Cash: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 9h1M17 15h1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>', Savings: '◒', Investments: '↗', 'Credit cards': '▣', 'Loans & debt': '−', Other: '◇' };

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

async function api(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = response.status === 401 ? 'Your session has expired. Please sign in again.'
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
  $('#connectButton').classList.toggle('hidden', view === 'profile');
  $('#profileBack').classList.toggle('hidden', view !== 'profile');
  $('#profileButton').classList.toggle('hidden', view === 'profile');
  if (view === 'overview' && state.dashboard) {
    requestAnimationFrame(() => {
      renderNetWorthChartWhenVisible();
    });
  }
  if (view === 'investments' && state.investments) requestAnimationFrame(() => renderInvestments(state.investments));
  if (view === 'retirement' && state.retirement) requestAnimationFrame(() => renderRetirement(state.retirement));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function restoreNetWorthHero() {
  const d = state.dashboard;
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
  const goals = data.goals || [];
  const goal = goals[0];
  $('#goalAction').textContent = goal ? 'Remove' : 'Add goal';
  if (goal) {
    $('#goalTitle').textContent = goal.name;
    $('#goalDetail').textContent = goal.source === 'debt' ? `${fmt.format(goal.current)} remaining of ${fmt.format(goal.target)} starting debt` : `${fmt.format(goal.current)} of ${fmt.format(goal.target)}`;
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
  return filterSnapshots(snapshots, state.networthRange);
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
  renderLineChart(visibleSnapshots(state.dashboard.snapshots || []), state.dashboard.summary);
}

function axisCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 0 }).format(value);
}

function renderLineChart(snapshots, summary) {
  const el = $('#netWorthChart');
  // A hidden view reports a zero width. Leave the existing chart intact until
  // the view is visible, when setView/resize will render it at real size.
  if (el.clientWidth < 80 || el.clientHeight < 60) return;
  if (snapshots.length < 2) {
    renderTimelineStart(el, snapshots.at(-1), summary);
    return;
  }

  const width = Math.max(1, Math.round(el.clientWidth || 700));
  const height = Math.max(1, Math.round(el.clientHeight || 150));
  const plotLeft = 48, plotRight = 8, plotTop = 8, plotBottom = height - 22;
  const dateValue = (date) => new Date(`${date}T12:00:00`).getTime();
  const domainStart = dateValue(snapshots[0].date);
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
  // days while every available point is in the same calendar month, then
  // graduate to month/year as the selected range expands.
  const sameMonth = new Date(domainStart).getFullYear() === new Date(domainEnd).getFullYear() && new Date(domainStart).getMonth() === new Date(domainEnd).getMonth();
  const dateLabel = (time) => new Date(time).toLocaleDateString('en-US', sameMonth ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' });
  // Short spans need distinct days, not three calendar labels that round to
  // the same day. Longer spans retain a middle label for quick orientation.
  const tickTimes = sameMonth || width <= 420 ? [domainStart, domainEnd] : [domainStart, (domainStart + domainEnd) / 2, domainEnd];
  const xAxis = tickTimes.map((time, index) => `<text x="${(plotLeft + ((time - domainStart) / (domainEnd - domainStart)) * (width - plotLeft - plotRight)).toFixed(1)}" y="${height - 5}" text-anchor="${index === 0 ? 'start' : index === tickTimes.length - 1 ? 'end' : 'middle'}" class="chart-axis-label chart-x-axis-label">${dateLabel(time)}</text>`).join('');
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img">
    <defs><linearGradient id="areaFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f6f4a" stop-opacity=".16"/><stop offset="1" stop-color="#1f6f4a" stop-opacity="0"/></linearGradient></defs>
    ${yAxis}${xAxis}<path d="${area}" fill="url(#areaFade)"/><path d="${d}" fill="none" stroke="#1f6f4a" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
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
    tooltip.style.left = `${Math.max(8, Math.min(rect.width - 8, x / width * rect.width))}px`;
    tooltip.textContent = fmt.format(Number(snap.net_worth));

    const date = new Date(`${snap.date}T12:00:00`);
    $('#netWorth').textContent = fmt.format(Number(snap.net_worth));
    $('#netWorthDelta').innerHTML = `<span class="positive">Assets ${fmt.format(Number(snap.assets || 0))}</span><span class="networth-separator"> · </span><span class="negative">Debt ${fmt.format(Number(snap.liabilities || 0))}</span>`;
    $('#netWorthChartDate').textContent = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${snap.source === 'estimated' ? ' · Estimated from activity' : ''}`;
    $('#netWorthChartContext').classList.remove('hidden');
  };

  el.addEventListener('pointerdown', (event) => {
    active = true;
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

function renderTimelineStart(el, snapshot, summary) {
  const value = Number(snapshot?.net_worth ?? summary?.netWorth ?? 0);
  const date = snapshot?.date ? new Date(`${snapshot.date}T12:00:00`) : new Date();
  const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const width = Math.max(1, Math.round(el.clientWidth || 700));
  const height = Math.max(1, Math.round(el.clientHeight || 150));
  const baseline = Math.round(height * .75);
  const pointX = Math.round(width * .78);
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Net worth tracking starts today">
    <line x1="12" y1="${baseline}" x2="${width - 12}" y2="${baseline}" stroke="#e4e9e4" stroke-width="2"/>
    <line x1="${pointX}" y1="24" x2="${pointX}" y2="${baseline}" stroke="#b6c8bd" stroke-width="1.5" stroke-dasharray="4 5"/>
    <circle cx="${pointX}" cy="${Math.round(height * .48)}" r="9" fill="#fff" stroke="#16704b" stroke-width="4"/>
    <text x="${pointX}" y="38" text-anchor="middle" class="sankey-value">${fmt.format(value)}</text>
    <text x="${pointX}" y="${height - 10}" text-anchor="middle" class="sankey-label">${label} · Start</text>
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
    <div class="account-meta"><div class="account-icon">${escapeHtml((a.institution_name || a.name || '?')[0])}</div><div><div class="account-name">${escapeHtml(a.nickname || a.name)}</div><div class="account-inst">${escapeHtml(a.institution_name || '')} · ${escapeHtml(a.subtype || a.type)}</div></div></div>
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
  $('#accountsSummary').innerHTML = `<div><span>Cash & savings</span><strong>${fmt.format(cashAndSavings)}</strong></div><div><span>Invested</span><strong class="positive">${fmt.format(invested)}</strong></div><div><span>Debt owed</span><strong class="negative">${fmt.format(totalDebt)}</strong></div>`;
  $('#accountGrid').innerHTML = grouped.map(([name, items]) => {
    const debt = items.every(isDebt);
    const total = items.reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
    const sorted = [...items].sort((a, b) => Math.abs(Number(b.current_balance || 0)) - Math.abs(Number(a.current_balance || 0)));
    const expanded = state.expandedAccountGroups.has(name);
    const previewCount = 2;
    return `<section class="account-collection ${debt ? 'debt' : 'asset'}">
      <div class="account-collection-head"><span class="account-collection-icon" aria-hidden="true">${accountGroupIcons[name] || '◇'}</span><div><h2>${name}</h2><p>${items.length} account${items.length === 1 ? '' : 's'}</p></div><div class="account-collection-total ${debt ? 'negative' : 'positive'}"><span>${debt ? 'Owed' : 'Held'}</span><strong>${fmt.format(total)}</strong></div></div>
      <div class="account-collection-items">${sorted.map((account, index) => `<article class="account-item ${debt ? 'debt' : 'asset'} ${index >= previewCount && !expanded ? 'hidden' : ''}">
        ${institutionMark(account)}<div class="account-copy"><div class="account-name">${escapeHtml(account.nickname || account.name)}</div><div class="account-inst">${escapeHtml(account.institution_name || '')} · ${escapeHtml(accountDescriptor(account.subtype || account.type))}</div><div class="account-inline-balance ${debt ? 'negative' : 'positive'}">${displayBalance(account)}</div></div>${account.manual ? `<button class="account-rename" data-manual-account="${escapeHtml(account.id)}" data-manual-name="${escapeHtml(account.name)}" data-manual-subtype="${escapeHtml(account.subtype || '')}" data-manual-value="${escapeHtml(account.current_balance)}" data-manual-kind="${debt ? 'liability' : 'asset'}" aria-label="Edit ${escapeHtml(account.name)}">✎</button>` : `<button class="account-rename" data-account-rename="${escapeHtml(account.id)}" data-account-name="${escapeHtml(account.nickname || account.name)}" aria-label="Rename ${escapeHtml(account.nickname || account.name)}">✎</button>`}
      </article>`).join('')}</div>${items.length > previewCount ? `<button class="account-group-more" data-account-group="${escapeHtml(name)}">${expanded ? 'Show less' : `View ${items.length - previewCount} more`}</button>` : ''}
    </section>`;
  }).join('');
}

function renderConnections(items) {
  const panel = $('#connectionsList');
  const health = new Map((state.dashboard?.connectionHealth || []).map((entry) => [entry.id, entry]));
  panel.innerHTML = items.length ? items.map((item) => { const status = health.get(item.id); const needsReconnect = Boolean(status?.requires_reconnect); const detail = item.demo ? 'Sample connection' : status?.state === 'healthy' ? 'Up to date' : status?.state === 'stale' ? 'Update delayed · retrying automatically' : needsReconnect ? 'Reconnect to resume updates' : 'Update needs attention · retrying automatically'; const actions = item.demo ? '<span class="connection-demo-label">Demo</span>' : `${needsReconnect ? `<button class="reconnect-button" data-reconnect="${escapeHtml(item.id)}">Reconnect</button>` : ''}<button class="unlink-button" data-unlink="${escapeHtml(item.id)}">Unlink</button>`; return `<div class="connection-row"><div>${item.institution_logo ? `<img class="connection-logo" src="${escapeHtml(item.institution_logo)}" alt="" />` : '<span class="connection-fallback" aria-hidden="true">⌂</span>'}<span>${escapeHtml(item.institution_name)}<small class="connection-status ${status?.state || ''}">${detail}</small></span></div><span class="connection-actions">${actions}</span></div>`; }).join('') : '<div class="empty">No connected institutions.</div>';
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
  const actualSpend = planTransactions.filter((transaction) => !['savings', 'investments'].includes(transaction.bucket)).reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const savings = planTransactions.filter((transaction) => transaction.bucket === 'savings').reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const investments = planTransactions.filter((transaction) => transaction.bucket === 'investments').reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const savingsAndInvestments = planTransactions.filter((transaction) => ['savings', 'investments'].includes(transaction.bucket)).reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const actualSpendCategories = flowCategoryRows(planTransactions.filter((transaction) => transaction.flowGroup === 'actual_spend'));
  const preTaxRetirement = Number((data.monthly || []).find((row) => row.month === state.spendingMonth)?.pre_tax_retirement || 0);
  return { ...data, total, income, actualSpend, actualSpendCategories, savings, investments, savingsAndInvestments, preTaxRetirement, monthlyAverage: total, categories: allocationRows(planTransactions), transactions };
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
    $('#trendDetail').innerHTML = `<span>${state.spendingMonth ? label : `Latest · ${label}`}</span><strong><i class="income"></i>${fmt.format(detail.income || 0)}</strong><strong><i class="spend"></i>${fmt.format(detail.amount || 0)}</strong><b class="${remaining >= 0 ? 'positive' : 'negative'}">${remaining >= 0 ? 'Left' : 'Over'} ${fmt.format(Math.abs(remaining))}</b>`;
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
  if (!income && !actualSpend && !savings && !investments) { el.innerHTML = ''; return; }
  // Use the chart's actual container, not a device label. This survives
  // tablets, split-screen, zoom, sidebars, and window resizing.
  const availableWidth = el.clientWidth;
  const compact = availableWidth < 520;
  const tablet = !compact && availableWidth < 760;
  const allSpendCategories = data.actualSpendCategories || [];
  const actualCategories = expanded ? allSpendCategories : allSpendCategories.slice(0, 4);
  const width = compact ? 390 : tablet ? 620 : 920, height = expanded ? Math.max(260, actualCategories.length * 50 + 20) : 216;
  // On phones, equal-width nodes create a steadier left-to-right reading
  // path. Longer labels wrap within their own node instead of making the
  // source feel visually less important.
  const sourceX = compact ? 8 : 12, sourceW = compact ? 96 : tablet ? 120 : 176;
  const middleX = compact ? 147 : tablet ? 168 : 300, middleW = compact ? 96 : tablet ? 142 : 178;
  const destinationX = compact ? 286 : tablet ? 340 : 548, destinationW = compact ? 96 : tablet ? 196 : 332;
  const displayShare = (value, isIncome = false) => !income ? '—' : `${Math.round((isIncome ? 1 : value / income) * 100)}%`;
  const block = (x, y, w, color, label, value, category = '', isIncome = false) => {
    const mobileLines = compact ? ({ 'Take-home income': ['Take-home', 'income'], 'Actual spend': ['Actual', 'spend'], 'Housing & bills': ['Housing', '& bills'], 'Food & dining': ['Food', '& dining'] }[label] || [label]) : [label];
    const wrapped = mobileLines.length > 1;
    const height = wrapped ? 48 : 36;
    const labelMarkup = mobileLines.map((line, index) => `<tspan x="${x + 11}" dy="${index ? 10 : 0}">${escapeHtml(line)}</tspan>`).join('');
    const valueY = y + (wrapped ? 41 : 28);
    return `<g ${category ? `data-cashflow-category="${escapeHtml(category)}" class="cashflow-target" role="button" tabindex="0" aria-label="View ${escapeHtml(label)} transactions"` : ''}><rect x="${x}" y="${y}" width="${w}" height="${height}" rx="8" fill="var(--sankey-surface)" stroke="var(--sankey-border)"/><rect x="${x}" y="${y}" width="6" height="${height}" rx="3" fill="${color}"/><text x="${x + 11}" y="${y + 14}" class="cashflow-label">${labelMarkup}</text><text x="${x + 11}" y="${valueY}" class="cashflow-value">${fmt.format(value)}<tspan dx="4" class="cashflow-share">${displayShare(value, isIncome)}</tspan></text></g>`;
  };
  // Use perceptual (square-root) scaling. Exact dollars stay in each node,
  // while the flow still makes large categories visibly heavier without one
  // unusually large payment consuming the entire chart.
  const largestFlow = Math.max(actualSpend, savings, investments, 1);
  const flow = (fromX, fromY, toX, toY, amount, color) => {
    const value = Math.max(0, Number(amount || 0));
    const thickness = value ? 3 + Math.sqrt(value / largestFlow) * 45 : 0;
    return `<path class="cashflow-flow" d="M ${fromX} ${fromY} C ${fromX + (toX - fromX) * .42} ${fromY}, ${toX - (toX - fromX) * .42} ${toY}, ${toX} ${toY}" fill="none" stroke="${color}" stroke-opacity=".34" stroke-width="${thickness}" stroke-linecap="round"/>`;
  };
  const incomeY = 89, spendY = 18, saveY = 90, investY = 162;
  let paths = flow(sourceX + sourceW, incomeY + 18, middleX, spendY + 18, actualSpend, 'var(--outflow)');
  paths += flow(sourceX + sourceW, incomeY + 18, middleX, saveY + 18, savings, 'var(--save)');
  paths += flow(sourceX + sourceW, incomeY + 18, middleX, investY + 18, investments, 'var(--invest)');
  let categories = '';
  actualCategories.forEach((row, index) => {
    const y = 12 + index * (expanded || compact ? 50 : 47);
    paths += flow(middleX + middleW, spendY + 18, destinationX, y + 18, Number(row.amount || 0), 'var(--outflow-muted)');
    categories += block(destinationX, y, destinationW, 'var(--outflow-muted)', row.name, row.amount, row.key);
  });
  const hiddenCategoryCount = allSpendCategories.length - actualCategories.length;
  const moreLabel = compact ? `+${hiddenCategoryCount} more` : `${hiddenCategoryCount} more in expanded view`;
  const more = !expanded && hiddenCategoryCount > 0 ? `<text x="${destinationX + 4}" y="${height - 5}" class="cashflow-label cashflow-more">${moreLabel}</text>` : '';
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Take-home income split into spending, saving, and investing">${paths}${block(sourceX, incomeY, sourceW, 'var(--income)', 'Take-home income', income, 'income', true)}${block(middleX, spendY, middleW, 'var(--outflow)', 'Actual spend', actualSpend, 'actual_spend')}${block(middleX, saveY, middleW, 'var(--save)', 'Save', savings, 'savings')}${block(middleX, investY, middleW, 'var(--invest)', 'Invest', investments, 'investments')}${categories}${more}</svg>`;
}

function renderSpending(data) {
  if (!data) return;
  // The range is the browsing context until a person chooses one exact month.
  // In that state the range control intentionally has no active choice.
  $$('[data-spending-range]').forEach((control) => control.classList.toggle('active', !state.spendingMonth && control.dataset.spendingRange === state.spendingRange));
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
  const snapshots = data.snapshots || [];
  if (state.investmentRange === 'all' || !snapshots.length) return snapshots;
  const latest = new Date(`${snapshots.at(-1).date}T12:00:00`);
  const visible = filterSnapshots(snapshots, state.investmentRange, latest);
  return visible.length ? visible : snapshots.slice(-1);
}

function investmentRangeLabel(range) {
  return ({ '1m': 'last month', '3m': 'last 3 months', '6m': 'last 6 months', ytd: 'year to date', '1y': 'last year', all: 'all history' })[range] || 'last year';
}

function renderPortfolioChart(data) {
  const el = $('#investmentChart');
  if (el.clientWidth < 80 || el.clientHeight < 60) return;
  const snapshots = portfolioSnapshots(data);
  if (!snapshots.length) {
    el.innerHTML = `<div class="portfolio-snapshot"><span class="portfolio-snapshot-mark" aria-hidden="true">↗</span><div><strong>Portfolio snapshot</strong><p>Your current balance and allocation are up to date. Historical value will resume automatically when price history is available.</p></div></div>`;
    return;
  }
  const width = Math.max(1, Math.round(el.clientWidth));
  const height = Math.max(1, Math.round(el.clientHeight));
  const plot = { left: 46, right: 6, top: 8, bottom: height - 23 };
  const values = snapshots.map((snapshot) => Number(snapshot.value || 0));
  let min = Math.min(...values), max = Math.max(...values);
  const spread = max - min || Math.max(Math.abs(max) * .12, 1);
  min -= spread * .1; max += spread * .1;
  const points = values.map((value, index) => [plot.left + index / Math.max(values.length - 1, 1) * (width - plot.left - plot.right), plot.bottom - (value - min) / (max - min) * (plot.bottom - plot.top)]);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L ${points.at(-1)[0]} ${plot.bottom} L ${points[0][0]} ${plot.bottom} Z`;
  const label = (index) => new Date(`${snapshots[index].date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  const xIndices = [...new Set(width > 420 ? [0, Math.floor((snapshots.length - 1) / 2), snapshots.length - 1] : [0, snapshots.length - 1])];
  const grid = [max, (max + min) / 2, min].map((value) => { const y = plot.bottom - (value - min) / (max - min) * (plot.bottom - plot.top); return `<line x1="${plot.left}" y1="${y}" x2="${width - plot.right}" y2="${y}" class="chart-grid"/><text x="${plot.left - 6}" y="${y + 3}" text-anchor="end" class="chart-axis-label">${axisCurrency(value)}</text>`; }).join('');
  const xAxis = xIndices.map((index) => `<text x="${points[index][0]}" y="${height - 5}" text-anchor="${index === 0 ? 'start' : index === snapshots.length - 1 ? 'end' : 'middle'}" class="chart-axis-label">${label(index)}</text>`).join('');
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Scrubbable portfolio value history"><defs><linearGradient id="portfolioFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#287143" stop-opacity=".16"/><stop offset="1" stop-color="#287143" stop-opacity="0"/></linearGradient></defs>${grid}${xAxis}<path d="${area}" fill="url(#portfolioFade)"/><path d="${line}" fill="none" stroke="#287143" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>${points.length === 1 ? `<circle cx="${points[0][0]}" cy="${points[0][1]}" r="5" fill="#287143"/>` : ''}<line class="scrub-line" x1="0" y1="${plot.top}" x2="0" y2="${plot.bottom}"/><circle class="scrub-dot" cx="0" cy="0" r="5"/></svg><div class="chart-tooltip hidden"></div>`;
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
    tooltip.style.left = `${Math.max(8, Math.min(rect.width - 8, x / width * rect.width))}px`;
    tooltip.textContent = fmt.format(Number(snapshot.value || 0));
    $('#investmentTotal').textContent = fmt.format(Number(snapshot.value || 0));
    $('#investmentChartDate').textContent = `${new Date(`${snapshot.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${snapshot.source === 'reconstructed' ? ' · Estimated' : ''}`;
    $('#investmentChartContext').classList.remove('hidden');
  };
  el.addEventListener('pointerdown', (event) => { active = true; el.setPointerCapture?.(event.pointerId); showPoint(event); });
  el.addEventListener('pointermove', (event) => { if (event.pointerType === 'mouse' || active) showPoint(event); });
  el.addEventListener('pointerup', (event) => { active = false; el.releasePointerCapture?.(event.pointerId); });
  el.addEventListener('pointercancel', () => { active = false; });
  el.addEventListener('selectstart', (event) => event.preventDefault());
  el.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse' && !active) { scrubLine.classList.remove('visible'); scrubDot.classList.remove('visible'); tooltip.classList.add('hidden'); restore(); } });
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
    return { ...group, value, costBasis, classification, gain: costBasis == null ? null : value - costBasis, gain_pct: costBasis ? (value - costBasis) / costBasis : null };
  });
}

function renderInvestments(data) {
  if (!data) return;
  const accounts = data.accounts || [];
  const snapshots = portfolioSnapshots(data);
  const endSnapshot = snapshots.at(-1);
  const startSnapshot = snapshots[0];
  const displayedTotal = Number(endSnapshot?.value ?? data.total ?? 0);
  const periodChange = snapshots.length > 1 ? displayedTotal - Number(startSnapshot?.value || 0) : null;
  const periodLabel = investmentRangeLabel(state.investmentRange);
  $('#investmentTotal').textContent = fmt.format(displayedTotal);
  const started = snapshots[0]?.date ? new Date(`${snapshots[0].date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null;
  const reconstructed = snapshots.some((snapshot) => snapshot.source === 'reconstructed');
  const changeCopy = periodChange == null ? (started ? `Tracking since ${started}` : 'Sync to begin tracking') : `${periodChange >= 0 ? '+' : '−'}${fmt.format(Math.abs(periodChange))} ${periodLabel}`;
  $('#investmentContext').textContent = accounts.length ? changeCopy : 'Connect an investment account to begin.';
  $('#investmentChartDate').textContent = '';
  $('#investmentChartContext').classList.add('hidden');
  renderPortfolioChart(data);
  const allocation = data.allocation || [];
  $('#investmentAllocationCard').classList.toggle('hidden', !data.positionsAvailable);
  $('#investmentAccountsCard').classList.toggle('hidden', accounts.length < 2);
  $('#investmentHoldingsPanel').classList.toggle('hidden', !data.positionsAvailable);
  let cursor = 0;
  const colors = ['#287143', '#7ea98b', '#d5a75f', '#9ca9bd', '#b88692', '#7d91a5'];
  const donut = $('#investmentDonut');
  if (allocation.length) {
    const largest = allocation[0];
    $('#investmentAllocationInsight').textContent = `${largest.name} is your largest allocation at ${Math.round(largest.share * 100)}%. Current mix · ${periodLabel} selected.`;
    const selected = allocation.find((row) => row.name === state.investmentFilter);
    donut.style.background = `conic-gradient(${allocation.map((row, index) => { const next = cursor + row.share * 100; const color = state.investmentFilter === 'all' || row.name === state.investmentFilter ? colors[index % colors.length] : '#dde4dd'; const stop = `${color} ${cursor.toFixed(2)}% ${next.toFixed(2)}%`; cursor = next; return stop; }).join(', ')})`;
    donut.innerHTML = selected ? `<span><strong>${fmt.format(selected.value)}</strong><small>${escapeHtml(selected.name)} · ${Math.round(selected.share * 100)}%</small></span>` : '<span><strong>Your mix</strong><small>Tap a category</small></span>';
    $('#investmentAllocation').innerHTML = `<button class="investment-allocation-row ${state.investmentFilter === 'all' ? 'active' : ''}" data-investment-filter="all"><i></i><span>All assets</span><strong>${fmt.format(data.total || 0)}</strong></button>${allocation.map((row, index) => `<button class="investment-allocation-row ${state.investmentFilter === row.name ? 'active' : ''}" data-investment-filter="${escapeHtml(row.name)}"><i style="background:${colors[index % colors.length]}"></i><span>${escapeHtml(row.name)}</span><small>${Math.round(row.share * 100)}%</small><strong>${fmt.format(row.value)}</strong></button>`).join('')}`;
  } else {
    donut.style.background = '#edf0eb'; donut.innerHTML = '<span>Awaiting<br>holdings</span>';
    $('#investmentAllocationInsight').textContent = 'Allocation appears when your institution provides holdings.';
    $('#investmentAllocation').innerHTML = '<p class="spending-empty">Allocation appears when your institution provides holdings.</p>';
  }
  $('#investmentAccounts').innerHTML = accounts.length ? accounts.map((account) => `<div class="investment-account-row"><div><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(account.institution_name || '')} · Current value</span></div><b>${fmt.format(account.value)}</b></div>`).join('') : '<p class="spending-empty">No investment accounts connected.</p>';
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
  const visiblePositions = state.holdingsExpanded ? positions : positions.slice(0, 3);
  const previewCopy = visiblePositions.length < positions.length ? `Showing ${visiblePositions.length} of ${positions.length}` : `${positions.length} current holding${positions.length === 1 ? '' : 's'}`;
  $('#investmentHoldingsInsight').textContent = data.positionsAvailable ? `${previewCopy}${state.investmentFilter === 'all' ? '' : ` · ${state.investmentFilter}`} · ${periodLabel} selected` : 'Holdings appear when your institution provides them.';
  $('#investmentPositions').innerHTML = data.positionsAvailable ? visiblePositions.map((position) => {
    const gain = position.gain_pct;
    const performance = gain == null ? 'Performance unavailable' : `${gain >= 0 ? '+' : '−'}${Math.abs(gain * 100).toFixed(1)}%`;
    const canEdit = !state.demoPreview && !state.dashboard?.demoMode;
    const share = data.total ? Math.max(0, Number(position.value || 0) / Number(data.total) * 100) : 0;
    const accountBreakdown = position.positions.map((part) => {
      const categoryControl = canEdit ? `<select data-position-class="${escapeHtml(part.id)}" aria-label="Asset class for ${escapeHtml(part.name)} in ${escapeHtml(names.get(part.account_id) || 'investment account')}"><option value="" ${part.asset_class_override ? '' : 'selected'}>Automatic · ${escapeHtml(assetClassLabel(part.type))}</option>${['Equities', 'Funds', 'Fixed income', 'Cash', 'Crypto', 'Other'].map((option) => `<option value="${option}" ${part.asset_class_override === option ? 'selected' : ''}>${option}</option>`).join('')}</select>` : '';
      const manualControl = canEdit && part.manual ? `<div class="manual-holding-controls"><select data-manual-holding-class="${escapeHtml(part.id)}" aria-label="Asset class for manually added ${escapeHtml(part.name)}">${['Equities', 'Funds', 'Fixed income', 'Cash', 'Crypto', 'Other'].map((option) => `<option value="${option}" ${part.asset_class_override === option ? 'selected' : ''}>${option}</option>`).join('')}</select><button type="button" class="manual-holding-remove" data-remove-manual-holding="${escapeHtml(part.id)}">Remove</button></div>` : categoryControl;
      return `<div class="holding-account"><div><span>${escapeHtml(names.get(part.account_id) || 'Investment account')}</span><small>${part.manual ? 'Manual · ' : ''}${escapeHtml(assetClassLabel(part.type, part.asset_class_override))}</small></div><b>${fmt.format(part.value)}</b>${manualControl}</div>`;
    }).join('');
    const location = position.positions.length === 1 ? 'Held in 1 account' : `Held in ${position.positions.length} accounts`;
    return `<details class="holding-row"><summary aria-label="${escapeHtml(position.name)}, ${fmt.format(position.value)}"><div class="position-symbol">${escapeHtml(position.ticker || '•')}</div><div class="holding-copy"><strong class="holding-ticker">${escapeHtml(position.ticker || 'Holding')}</strong><div class="holding-weight"><i><b style="width:${Math.min(100, share).toFixed(1)}%"></b></i><span>${Math.round(share)}%</span></div></div><div class="position-value"><b>${fmt.format(position.value)}</b><small class="${gain == null ? '' : gain >= 0 ? 'positive' : 'negative'}">${performance}</small></div></summary><div class="holding-detail"><strong>${escapeHtml(position.name)}</strong><span>${escapeHtml(position.classification)} · ${location}</span><div class="holding-account-list">${accountBreakdown}</div></div></details>`;
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

function renderRetirement(data) {
  if (!data) return;
  state.retirement = data;
  $('#retirementProjection').textContent = fmt.format(data.projectedAtRetirement || 0);
  $('#retirementProjectionContext').textContent = `Projected at age ${data.retirementAge} if you keep saving ${fmt.format(data.annualContributions || 0)}/yr`;
  $('#retirementAgeChip').textContent = `${data.yearsToRetirement} years to go`;
  $('#retirementSpendContext').textContent = data.monthsObserved ? `Needed by age ${data.retirementAge}, in today’s dollars · Based on ${data.monthsObserved} month${data.monthsObserved === 1 ? '' : 's'} of spending.` : `Needed by age ${data.retirementAge}, in today’s dollars.`;
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
    const detail = step.key === 'coast' ? `Invested today, could grow to FI by age ${data.retirementAge}`
      : step.key === 'standard' ? `Portfolio needed by age ${data.retirementAge} for your current lifestyle`
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
  const d = state.dashboard;
  if (!d) return;
  const s = d.summary;
  if (state.view === 'overview') restoreNetWorthHero();
  $('#assets').textContent = `+${fmt.format(s.assets)}`;
  $('#liabilities').textContent = `−${fmt.format(s.liabilities)}`;
  $('#assets').classList.add('positive');
  $('#liabilities').classList.add('negative');
  if (state.view === 'overview') renderNetWorthChartWhenVisible();
  renderAccounts(d.accounts || []);
  renderConnections(d.items || []);
  renderClarityLayer(d);
  $('#demoToggle').textContent = d.demoMode ? 'Exit demo' : 'Try demo';
  $('#demoToggle').setAttribute('aria-pressed', String(d.demoMode));
  $('#connectButton').classList.toggle('hidden', state.view === 'profile');
  $('#setupCard').classList.toggle('hidden', d.plaidConfigured || state.demoPreview);
  if (!d.plaidConfigured && !state.demoPreview) showNotice('Connect an account when you’re ready to see your own data.');
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
    state.spending = spending;
    state.investments = investments;
    state.retirement = retirement;
    applyTheme(dashboard.appearance?.theme || 'light', false);
    renderDashboard();
    renderSpending(spending);
    renderInvestments(investments);
    renderRetirement(retirement);
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
  if (state.demoPreview) {
    const preview = await api(`/api/demo-preview?range=${state.spendingRange}`);
    return preview.spending;
  }
  return api(`/api/spending?range=${state.spendingRange}`);
}

async function connectPlaid() {
  if (state.demoPreview) { showNotice('Sign in to connect your own accounts.'); return; }
  try {
    const { link_token } = await api('/api/plaid/create_link_token', { method: 'POST', body: '{}' });
    if (!window.Plaid) throw new Error('Plaid Link failed to load. Check your internet connection.');
    const handler = window.Plaid.create({
      token: link_token,
      onSuccess: async (public_token, metadata) => {
        showNotice('Connecting account…');
        await api('/api/plaid/exchange_public_token', {
          method: 'POST',
          body: JSON.stringify({ public_token, institution_name: metadata.institution?.name || 'Connected institution', institution_id: metadata.institution?.institution_id || null })
        });
        await loadAll();
        showNotice('Account connected.', 'success');
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
  if (state.demoPreview) return;
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
  if (state.demoPreview) return;
  try {
    const appearance = await api('/api/settings/appearance', { method: 'PATCH', body: JSON.stringify({ theme }) });
    state.dashboard.appearance = appearance;
  } catch {
    showNotice('Your appearance preference will stay on this device, but could not be saved to your profile.');
  }
});
$('#demoToggle').addEventListener('click', async () => {
  if (state.demoPreview) { showNotice('You are already viewing the demo. Sign in to save changes or connect accounts.'); return; }
  const button = $('#demoToggle');
  button.disabled = true;
  try {
    await api('/api/demo-mode', { method: 'POST', body: JSON.stringify({ enabled: !state.dashboard?.demoMode }) });
    await loadAll();
    showNotice(state.dashboard?.demoMode ? 'Demo mode is on. Your real data is safely hidden.' : 'Back to your real data.', 'success');
  } catch (error) { showNotice(error.message); }
  finally { button.disabled = false; }
});
$('#exportDataButton').addEventListener('click', async () => {
  if (state.demoPreview) { showNotice('Sign in to export your own data.'); return; }
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
  if (state.demoPreview) { showNotice('Demo data is not saved to an account.'); return; }
  if (!window.confirm('Permanently delete your connected financial data? This cannot be undone.')) return;
  const confirmation = window.prompt('Type DELETE to permanently remove your account and data.');
  if (confirmation !== 'DELETE') { showNotice('Account deletion was cancelled.'); return; }
  const button = $('#deleteAccountButton');
  button.disabled = true;
  try {
    await api('/api/account', { method: 'DELETE', body: JSON.stringify({ confirmation }) });
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
      label: 'COAST RETIREMENT', title: 'What is Coast FIRE?', value: plan.coast,
      description: 'You have enough invested today that, if it grows until retirement, it could reach your Standard goal without more retirement contributions. You would still need income for today’s living costs.'
    },
    lean: {
      label: 'LEAN RETIREMENT', title: 'What is Lean FIRE?', value: plan.lean,
      description: `A smaller retirement target designed for a simpler lifestyle—about ${Math.round(Number(plan.leanMultiplier || .7) * 100)}% of your current annual spending.`
    },
    standard: {
      label: 'STANDARD RETIREMENT', title: 'What is Standard retirement?', value: plan.standard,
      description: 'The portfolio target intended to support your recent everyday lifestyle in retirement, using the withdrawal rate in your plan.'
    },
    fat: {
      label: 'FAT RETIREMENT', title: 'What is Fat FIRE?', value: plan.fat,
      description: `A larger retirement target for more flexibility and discretionary spending—about ${Math.round(Number(plan.fatMultiplier || 1.5) * 100)}% of your current annual spending.`
    }
  }[name];
  if (!details) return;
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
  $('#retirementInfoTargetLabel').textContent = name === 'coast' ? `Needed today · Coast FI by age ${plan.retirementAge}` : `Needed by age ${plan.retirementAge}`;
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
  if (goal) { if (!window.confirm(`Remove “${goal.name}”?`)) return; try { await api(`/api/goals/${encodeURIComponent(goal.id)}`, { method: 'DELETE' }); await loadAll(); showNotice('Goal removed.', 'success'); } catch (error) { showNotice(error.message); } return; }
  $('#goalName').value = ''; $('#goalSource').value = 'cash'; $('#goalTarget').value = ''; $('#goalDialog').showModal(); $('#goalName').focus();
});
$('#goalClose').addEventListener('click', () => $('#goalDialog').close());
$('#goalCancel').addEventListener('click', () => $('#goalDialog').close());
$('#goalForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await api('/api/goals', { method: 'POST', body: JSON.stringify({ name: $('#goalName').value, source: $('#goalSource').value, target: $('#goalTarget').value }) }); $('#goalDialog').close(); await loadAll(); showNotice('Goal added.', 'success'); } catch (error) { showNotice(error.message); }
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
  renderNetWorthChartWhenVisible();
}));
$$('[data-spending-range]').forEach((button) => button.addEventListener('click', async () => {
  state.spendingRange = button.dataset.spendingRange;
  state.spendingMonth = null;
  $$('[data-spending-range]').forEach((control) => control.classList.toggle('active', control === button));
  try {
    state.spending = await loadSpending();
    renderSpending(state.spending);
  } catch (error) { showNotice(error.message); }
}));
$('#cashflowExpand').addEventListener('click', () => { const dialog = $('#cashflowDialog'); dialog.showModal(); renderCashFlowSankey(spendingForSelectedMonth(state.spending), $('#cashflowDialogContent'), true); });
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
$('#spendingLegend')?.addEventListener('click', (event) => openSpendingCategory(event.target.closest('[data-spending-category]')?.dataset.spendingCategory));
$('#cashflowSankey').addEventListener('click', (event) => openSpendingCategory(event.target.closest('[data-cashflow-category]')?.dataset.cashflowCategory));
$('#cashflowSankey').addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const target = event.target.closest('[data-cashflow-category]');
  if (!target) return;
  event.preventDefault();
  openSpendingCategory(target.dataset.cashflowCategory);
});
// The expanded dialog renders into a separate DOM node, so it needs the same
// category interaction as the inline Sankey. Close it before revealing the
// filtered activity to make the result immediately visible on every device.
$('#cashflowDialogContent').addEventListener('click', (event) => {
  const category = event.target.closest('[data-cashflow-category]')?.dataset.cashflowCategory;
  if (!category) return;
  $('#cashflowDialog').close();
  openSpendingCategory(category);
});
$('#cashflowDialogContent').addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const target = event.target.closest('[data-cashflow-category]');
  if (!target) return;
  event.preventDefault();
  $('#cashflowDialog').close();
  openSpendingCategory(target.dataset.cashflowCategory);
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
  state.spendingMonth = month;
  $$('[data-spending-range]').forEach((control) => control.classList.remove('active'));
  renderSpending(state.spending);
  $('#spendingTransactionsPanel').open = true;
});
$('#spendingTrend').addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const target = event.target.closest('[data-spending-month]');
  if (!target) return;
  event.preventDefault();
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
$$('[data-investment-range]').forEach((button) => button.addEventListener('click', () => {
  state.investmentRange = button.dataset.investmentRange;
  $$('[data-investment-range]').forEach((control) => control.classList.toggle('active', control === button));
  renderInvestments(state.investments);
}));
$('#investmentAllocation').addEventListener('click', (event) => {
  const filter = event.target.closest('[data-investment-filter]')?.dataset.investmentFilter;
  if (!filter) return;
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
    showNotice(select ? (select.value ? 'Holding classification updated.' : 'Using the institution classification.') : 'Manual holding classification updated.', 'success');
  } catch (error) { showNotice(error.message); control.disabled = false; }
});
$('#investmentPositions').addEventListener('click', async (event) => {
  const add = event.target.closest('[data-add-manual-holding]');
  if (add) {
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
  state.spendingMonth = null;
  state.spendingCategory = 'all';
  state.view = 'overview';
  showAuthenticatedApp();
  try {
    await loadAll();
    setView('overview');
  } catch (error) {
    state.demoPreview = false;
    $('#appShell').classList.add('hidden');
    $('#authScreen').classList.remove('hidden');
    $('#authMessage').textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Explore the demo <span aria-hidden="true">→</span>';
  }
}

async function startGoogleSignIn() {
  const config = await api('/api/auth/config');
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
  window.google.accounts.id.renderButton($('#googleSignIn'), { theme: 'outline', size: 'large', width: Math.min(360, Math.floor($('#googleSignIn').clientWidth || 360)), text: 'continue_with' });
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

navigator.serviceWorker?.addEventListener('controllerchange', () => window.location.reload());
window.addEventListener('offline', () => showNotice('You’re offline. Reconnect when you’re ready to refresh your data.'));
window.addEventListener('online', async () => {
  if (!state.dashboard || state.demoPreview) return;
  setAppStatus('Back online — refreshing…');
  try { await loadAll(); showNotice('Your financial picture is current again.', 'success'); }
  catch { showNotice('Back online, but refresh is still unavailable. We’ll try again next time.'); }
});

$('#demoPreviewButton').addEventListener('click', startDemoPreview);

$('#signOutButton').addEventListener('click', async () => {
  if (!state.demoPreview) await api('/api/auth/logout', { method: 'POST', body: '{}' });
  state.demoPreview = false;
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
