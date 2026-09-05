import { filterSnapshots, scrubIndex } from './chart-utils.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const state = {
  dashboard: null,
  spending: null,
  networthRange: 'ytd',
  spendingRange: '1m',
  spendingMonth: null,
  spendingCategory: 'all',
  spendingSort: 'recent',
  view: 'overview'
};

const accountGroupOrder = ['Cash', 'Savings', 'Investments', 'Credit cards', 'Loans & debt', 'Other'];
const accountGroupIcons = { Cash: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 9h1M17 15h1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>', Savings: '◒', Investments: '↗', 'Credit cards': '▣', 'Loans & debt': '−', Other: '◇' };

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
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

function setView(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `${view}View`));
  $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#pageTitle').textContent = view === 'overview' ? 'Net Worth' : view === 'profile' ? 'Profile' : view[0].toUpperCase() + view.slice(1);
  if (view === 'overview' && state.dashboard) {
    requestAnimationFrame(() => {
      restoreNetWorthHero();
      renderLineChart(visibleSnapshots(state.dashboard.snapshots || []), state.dashboard.summary);
    });
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function restoreNetWorthHero() {
  const d = state.dashboard;
  if (!d) return;
  const s = d.summary;
  $('#netWorth').textContent = fmt.format(s.netWorth);
  const snaps = visibleSnapshots(d.snapshots || []);
  if (snaps.length < 2) {
    $('#netWorthDelta').textContent = 'Tracking starts today';
    const start = snaps[0]?.date ? new Date(`${snaps[0].date}T12:00:00`) : new Date();
    $('#netWorthChartDate').textContent = `Tracking since ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    return;
  }
  const old = snaps.length > 1 ? Number(snaps[0].net_worth) : s.netWorth;
  const delta = s.netWorth - old;
  const startDate = snaps[0]?.date ? new Date(`${snaps[0].date}T12:00:00`) : null;
  const periodStart = startDate?.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) || 'start';
  $('#netWorthDelta').textContent = `${delta >= 0 ? '+' : '−'}${fmt.format(Math.abs(delta))} since ${periodStart}`;
  const estimateNote = snaps.some((snapshot) => snapshot.source === 'estimated') ? 'Estimated history · ' : '';
  $('#netWorthChartDate').textContent = `${estimateNote}Drag across the chart to view history`;
}

function netWorthRangeLabel(range) {
  return ({ ytd: 'Year to date', '1y': '1 year', '3y': '3 years', '5y': '5 years', all: 'All history' })[range] || 'Year to date';
}

function visibleSnapshots(snapshots) {
  return filterSnapshots(snapshots, state.networthRange);
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
    renderTimelineStart(el, snapshots[0], summary);
    return;
  }

  const width = Math.max(1, Math.round(el.clientWidth || 700));
  const height = Math.max(1, Math.round(el.clientHeight || 150));
  const plotLeft = 48, plotRight = 8, plotTop = 8, plotBottom = height - 22;
  const vals = snapshots.map((s) => Number(s.net_worth));
  let min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || Math.max(Math.abs(max) * .1, 1);
  min -= range * .08;
  max += range * .08;
  const points = vals.map((v, i) => {
    const x = plotLeft + (i / Math.max(vals.length - 1, 1)) * (width - plotLeft - plotRight);
    const y = plotBottom - ((v - min) / (max - min)) * (plotBottom - plotTop);
    return [x, y];
  });
  const d = points.map(([x,y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${d} L ${points.at(-1)[0]} ${plotBottom} L ${points[0][0]} ${plotBottom} Z`;
  const yTicks = [max, (max + min) / 2, min];
  const yAxis = yTicks.map((value) => {
    const y = plotBottom - ((value - min) / (max - min)) * (plotBottom - plotTop);
    return `<line x1="${plotLeft}" y1="${y}" x2="${width - plotRight}" y2="${y}" class="chart-grid"/><text x="${plotLeft - 6}" y="${y + 3}" text-anchor="end" class="chart-axis-label">${axisCurrency(value)}</text>`;
  }).join('');
  const dateLabel = (index) => new Date(`${snapshots[index].date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  const xTicks = width > 420 ? [0, Math.floor((snapshots.length - 1) / 2), snapshots.length - 1] : [0, snapshots.length - 1];
  const xAxis = [...new Set(xTicks)].map((index) => `<text x="${points[index][0]}" y="${height - 5}" text-anchor="${index === 0 ? 'start' : index === snapshots.length - 1 ? 'end' : 'middle'}" class="chart-axis-label">${dateLabel(index)}</text>`).join('');
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
    const idx = scrubIndex({ clientX: event.clientX, left: rect.left, width: rect.width, pointCount: snapshots.length });
    const snap = snapshots[idx];
    const [x, y] = points[idx];
    scrubLine.setAttribute('x1', x);
    scrubLine.setAttribute('x2', x);
    scrubDot.setAttribute('cx', x);
    scrubDot.setAttribute('cy', y);
    scrubLine.classList.add('visible');
    scrubDot.classList.add('visible');
    tooltip.classList.remove('hidden');
    tooltip.style.left = `${Math.max(8, Math.min(rect.width - 8, relativeX))}px`;
    tooltip.textContent = fmt.format(Number(snap.net_worth));

    const date = new Date(`${snap.date}T12:00:00`);
    $('#netWorth').textContent = fmt.format(Number(snap.net_worth));
    $('#netWorthDelta').innerHTML = `<span class="positive">Assets ${fmt.format(Number(snap.assets || 0))}</span><span class="networth-separator"> · </span><span class="negative">Debt ${fmt.format(Number(snap.liabilities || 0))}</span>`;
    $('#netWorthChartDate').textContent = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}${snap.source === 'estimated' ? ' · Estimated from activity' : ''}`;
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
  const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

  const totalAssets = accounts.filter((account) => !isDebt(account)).reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
  const totalDebt = accounts.filter(isDebt).reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
  $('#accountsSummary').innerHTML = `<div><span>Net worth</span><strong>${fmt.format(totalAssets - totalDebt)}</strong></div><div><span>You have</span><strong class="positive">${fmt.format(totalAssets)}</strong></div><div><span>You owe</span><strong class="negative">${fmt.format(totalDebt)}</strong></div>`;
  $('#accountGrid').innerHTML = grouped.map(([name, items]) => {
    const debt = items.every(isDebt);
    const total = items.reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
    return `<details class="account-collection ${debt ? 'debt' : 'asset'}">
      <summary class="account-collection-head"><span class="account-collection-icon" aria-hidden="true">${accountGroupIcons[name] || '◇'}</span><div><h2>${name}</h2><p>${items.length} account${items.length === 1 ? '' : 's'}</p></div><div class="account-collection-total ${debt ? 'negative' : 'positive'}"><span>${debt ? 'Owed' : 'Held'}</span><strong>${fmt.format(total)}</strong></div></summary>
      <div class="account-collection-items">${items.map((account) => `<article class="account-item ${debt ? 'debt' : 'asset'}">
        ${institutionMark(account)}<div class="account-copy"><div class="account-name">${escapeHtml(account.nickname || account.name)}</div><div class="account-inst">${escapeHtml(account.institution_name || '')} · ${escapeHtml(accountDescriptor(account.subtype || account.type))}</div><div class="account-inline-balance ${debt ? 'negative' : 'positive'}">${displayBalance(account)}</div></div><button class="account-rename" data-account-rename="${escapeHtml(account.id)}" data-account-name="${escapeHtml(account.nickname || account.name)}" aria-label="Rename ${escapeHtml(account.nickname || account.name)}">✎</button>
      </article>`).join('')}</div>
    </details>`;
  }).join('');
}

function renderConnections(items) {
  const realItems = items.filter((item) => !item.demo);
  const panel = $('#connectionsList');
  panel.innerHTML = realItems.length ? realItems.map((item) => `<div class="connection-row"><div>${item.institution_logo ? `<img class="connection-logo" src="${escapeHtml(item.institution_logo)}" alt="" />` : '<span class="connection-fallback" aria-hidden="true">⌂</span>'}<span>${escapeHtml(item.institution_name)}</span></div><button class="unlink-button" data-unlink="${escapeHtml(item.id)}">Unlink</button></div>`).join('') : '<div class="empty">No connected institutions.</div>';
}

const spendingColors = ['#1f6f4a', '#7ea98b', '#d5a75f', '#b88692', '#9ca9bd', '#c4c9c1'];

function renderSpending(data) {
  if (!data) return;
  const total = Number(data.total || 0);
  $('#spendingTotal').textContent = fmt.format(total);
  const rangeLabel = ({ '1m': 'this month', '3m': 'over the last 3 months', ytd: 'year to date', '1y': 'over the last year' })[data.range] || 'this month';
  $('#spendingContext').textContent = total ? `${fmt.format(data.monthlyAverage)} monthly average · ${rangeLabel}` : `No posted spending ${rangeLabel}. It can take a little time to arrive after connecting.`;
  const rows = data.categories || [];
  const donut = $('#spendingDonut');
  if (!rows.length) {
    donut.style.background = '#edf0eb'; donut.innerHTML = '<span>No data</span>';
    $('#spendingLegend').innerHTML = '<p class="spending-empty">Your category mix will appear here.</p>';
    $('#topCategories').innerHTML = '<p class="spending-empty">No categories to show yet.</p>';
    $('#spendingTrend').innerHTML = '<p class="spending-empty">Monthly patterns will appear once transactions arrive.</p>';
    renderSpendingTransactions(data);
    return;
  }
  let cursor = 0;
  const stops = rows.map((row, index) => { const next = cursor + row.share * 100; const stop = `${spendingColors[index % spendingColors.length]} ${cursor.toFixed(2)}% ${next.toFixed(2)}%`; cursor = next; return stop; });
  donut.style.background = `conic-gradient(${stops.join(', ')})`;
  donut.innerHTML = '<span>Plan<br>mix</span>';
  $('#spendingLegend').innerHTML = rows.slice(0, 5).map((row, index) => `<button class="legend-row" data-spending-category="${escapeHtml(row.name)}"><i style="background:${spendingColors[index % spendingColors.length]}"></i><span>${escapeHtml(row.name)}</span><strong>${row.percentage}%</strong></button>`).join('');
  $('#topCategories').innerHTML = rows.slice(0, 4).map((row, index) => `<button class="merchant-row" data-spending-category="${escapeHtml(row.name)}"><span class="merchant-rank">${index + 1}</span><span>${escapeHtml(row.name)}</span><strong>${fmt.format(row.amount)}</strong></button>`).join('');
  const months = data.monthly || [];
  const max = Math.max(...months.map((row) => row.amount), 1);
  if (state.spendingMonth && !months.some((row) => row.month === state.spendingMonth)) state.spendingMonth = null;
  $('#spendingTrend').innerHTML = months.length ? months.map((row) => `<button class="trend-column ${state.spendingMonth === row.month ? 'active' : ''}" type="button" data-spending-month="${row.month}" title="${escapeHtml(row.month)}: ${fmt.format(row.amount)}"><div class="trend-bar" style="height:${Math.max(8, row.amount / max * 100)}%"></div><span>${new Date(`${row.month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'short' })}</span></button>`).join('') : '<p class="spending-empty">Monthly patterns will appear once transactions arrive.</p>';
  renderSpendingTransactions(data);
}

function renderSpendingTransactions(data) {
  const filter = $('#spendingCategoryFilter');
  const categories = (data.categories || []).map((row) => row.name);
  if (state.spendingCategory !== 'all' && !categories.includes(state.spendingCategory)) state.spendingCategory = 'all';
  filter.innerHTML = `<option value="all">All plan categories</option>${categories.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
  filter.value = state.spendingCategory;
  $('#spendingSort').value = state.spendingSort;
  let rows = (data.transactions || []).filter((transaction) => (state.spendingCategory === 'all' || transaction.category === state.spendingCategory) && (!state.spendingMonth || String(transaction.date).startsWith(state.spendingMonth)));
  rows = [...rows].sort((a, b) => state.spendingSort === 'highest' ? b.amount - a.amount : String(b.date).localeCompare(String(a.date)) || b.amount - a.amount);
  $('#spendingTransactionCount').textContent = `${rows.length} posted`;
  const options = [['fixed', 'Fixed costs'], ['savings', 'Savings'], ['investments', 'Investments'], ['guilt_free', 'Guilt-free']];
  $('#spendingTransactions').innerHTML = rows.length ? rows.map((transaction) => {
    const categoryControl = state.dashboard?.demoMode
      ? `<span class="transaction-category-label">${escapeHtml(transaction.category)}</span>`
      : `<select data-transaction-category="${escapeHtml(transaction.id)}" aria-label="Plan category for ${escapeHtml(transaction.name)}">${options.map(([value, label]) => `<option value="${value}" ${transaction.bucket === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
    return `<div class="spending-transaction-row"><div><strong>${escapeHtml(transaction.name)}</strong><span>${new Date(`${transaction.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></div><div class="transaction-plan"><b>${fmt.format(transaction.amount)}</b>${categoryControl}</div></div>`;
  }).join('') : '<p class="spending-empty">No posted transactions in this category for this period.</p>';
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
  if (state.view === 'overview') renderLineChart(visibleSnapshots(d.snapshots || []), s);
  renderAccounts(d.accounts || []);
  renderConnections(d.items || []);
  $('#demoToggle').textContent = d.demoMode ? 'Exit demo' : 'Try demo';
  $('#demoToggle').setAttribute('aria-pressed', String(d.demoMode));
  $('#setupCard').classList.toggle('hidden', d.plaidConfigured);
  if (!d.plaidConfigured) showNotice('Demo mode is active. Add Plaid Sandbox credentials to .env to connect real institutions.');
}

async function loadAll() {
  const [dashboard, spending] = await Promise.all([api('/api/dashboard'), api(`/api/spending?range=${state.spendingRange}`)]);
  state.dashboard = dashboard;
  state.spending = spending;
  renderDashboard();
  renderSpending(spending);
  $('#monthLabel').textContent = 'Account overview';
}

async function connectPlaid() {
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
      },
      onExit: (err) => { if (err) showNotice(err.display_message || err.error_message || 'Plaid Link closed with an error.'); }
    });
    handler.open();
  } catch (error) {
    showNotice(error.message);
  }
}

async function syncAccounts() {
  const btn = $('#syncButton');
  btn.disabled = true;
  btn.textContent = '↻ Syncing…';
  try {
    const result = await api('/api/sync', { method: 'POST', body: '{}' });
    await loadAll();
    const failed = result.results?.filter((r) => !r.ok) || [];
    showNotice(failed.length ? `Synced with ${failed.length} connection error(s).` : 'Accounts synced.', failed.length ? 'warn' : 'success');
    $('#syncStatus').textContent = `Last sync ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  } catch (error) {
    showNotice(error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '↻ Sync accounts';
  }
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('#profileButton').addEventListener('click', () => setView('profile'));
$('#demoToggle').addEventListener('click', async () => {
  const button = $('#demoToggle');
  button.disabled = true;
  try {
    await api('/api/demo-mode', { method: 'POST', body: JSON.stringify({ enabled: !state.dashboard?.demoMode }) });
    await loadAll();
    showNotice(state.dashboard?.demoMode ? 'Demo mode is on. Your real data is safely hidden.' : 'Back to your real data.', 'success');
  } catch (error) { showNotice(error.message); }
  finally { button.disabled = false; }
});
$('#connectButton').addEventListener('click', connectPlaid);
$('#syncButton').addEventListener('click', syncAccounts);
$('#accountGrid').addEventListener('click', (event) => {
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
$('#connectionsList').addEventListener('click', async (event) => {
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
  restoreNetWorthHero();
  renderLineChart(visibleSnapshots(state.dashboard?.snapshots || []), state.dashboard?.summary);
}));
$$('[data-spending-range]').forEach((button) => button.addEventListener('click', async () => {
  state.spendingRange = button.dataset.spendingRange;
  state.spendingMonth = null;
  $$('[data-spending-range]').forEach((control) => control.classList.toggle('active', control === button));
  try {
    state.spending = await api(`/api/spending?range=${state.spendingRange}`);
    renderSpending(state.spending);
  } catch (error) { showNotice(error.message); }
}));
$('#spendingCategoryFilter').addEventListener('change', (event) => { state.spendingCategory = event.target.value; renderSpendingTransactions(state.spending); });
$('#spendingSort').addEventListener('change', (event) => { state.spendingSort = event.target.value; renderSpendingTransactions(state.spending); });
function openSpendingCategory(category) {
  if (!category) return;
  state.spendingCategory = category;
  $('#spendingTransactionsPanel').open = true;
  renderSpendingTransactions(state.spending);
}
$('#topCategories').addEventListener('click', (event) => openSpendingCategory(event.target.closest('[data-spending-category]')?.dataset.spendingCategory));
$('#spendingLegend').addEventListener('click', (event) => openSpendingCategory(event.target.closest('[data-spending-category]')?.dataset.spendingCategory));
$('#spendingTransactions').addEventListener('change', async (event) => {
  const select = event.target.closest('[data-transaction-category]');
  if (!select) return;
  select.disabled = true;
  try {
    await api(`/api/transactions/${select.dataset.transactionCategory}/category`, { method: 'PATCH', body: JSON.stringify({ bucket: select.value }) });
    state.spending = await api(`/api/spending?range=${state.spendingRange}`);
    renderSpending(state.spending);
  } catch (error) { showNotice(error.message); select.disabled = false; }
});
$('#spendingTrend').addEventListener('click', (event) => {
  const month = event.target.closest('[data-spending-month]')?.dataset.spendingMonth;
  const row = state.spending?.monthly?.find((entry) => entry.month === month);
  if (!row) return;
  state.spendingMonth = month;
  $$('.trend-column').forEach((bar) => bar.classList.toggle('active', bar.dataset.spendingMonth === month));
  $('#spendingTotal').textContent = fmt.format(row.amount);
  $('#spendingContext').textContent = `Total spending in ${new Date(`${month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;
  $('#spendingTransactionsPanel').open = true;
  renderSpendingTransactions(state.spending);
});

function showAuthenticatedApp() {
  $('#authScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
}

async function startGoogleSignIn() {
  const config = await api('/api/auth/config');
  if (!config.configured) {
    $('#authMessage').textContent = 'Google sign-in is not configured. Add GOOGLE_CLIENT_ID and a strong ENCRYPTION_KEY to the server environment.';
    return;
  }
  for (let attempts = 0; attempts < 30 && !window.google?.accounts?.id; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!window.google?.accounts?.id) { $('#authMessage').textContent = 'Google sign-in could not load. Check your connection and try again.'; return; }
  window.google.accounts.id.initialize({
    client_id: config.googleClientId,
    callback: async ({ credential }) => {
      try {
        $('#authMessage').textContent = 'Signing you in…';
        await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential }) });
        showAuthenticatedApp();
        await loadAll();
      } catch (error) { $('#authMessage').textContent = error.message; }
    }
  });
  window.google.accounts.id.renderButton($('#googleSignIn'), { theme: 'outline', size: 'large', width: Math.min(360, Math.floor($('#googleSignIn').clientWidth || 360)), text: 'signin_with' });
}

async function initializeApp() {
  try {
    await api('/api/auth/me');
    showAuthenticatedApp();
    await loadAll();
  } catch {
    await startGoogleSignIn();
  }
}

$('#signOutButton').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  state.dashboard = null;
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
    if (!state.dashboard || state.view !== 'overview') return;
    restoreNetWorthHero();
    renderLineChart(visibleSnapshots(state.dashboard.snapshots || []), state.dashboard.summary);
  });
});

initializeApp().catch((error) => { $('#authMessage').textContent = error.message; });
