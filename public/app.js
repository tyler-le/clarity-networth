import { filterSnapshots, scrubIndex } from './chart-utils.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const state = {
  dashboard: null,
  spending: null,
  investments: null,
  networthRange: 'ytd',
  spendingRange: '1m',
  spendingMonth: null,
  allocationDisplay: 'percentage',
  spendingCategory: 'all',
  spendingSort: 'recent',
  investmentRange: '1y',
  investmentFilter: 'all',
  investmentSort: 'value',
  view: 'overview',
  demoPreview: false
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
  if (view === 'investments' && state.investments) requestAnimationFrame(() => renderInvestments(state.investments));
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
  const planTransactions = transactions.filter((transaction) => transaction.bucket !== 'income' && transaction.bucket !== 'transfer');
  const total = planTransactions.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const income = transactions.filter((transaction) => transaction.bucket === 'income').reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  return { ...data, total, income, monthlyAverage: total, categories: allocationRows(planTransactions), transactions };
}

function renderSpendingTrend(data) {
  const months = data.monthly || [];
  const max = Math.max(...months.flatMap((row) => [Number(row.amount || 0), Number(row.income || 0)]), 1);
  if (state.spendingMonth && !months.some((row) => row.month === state.spendingMonth)) state.spendingMonth = null;
  const detail = months.find((row) => row.month === state.spendingMonth) || months.at(-1);
  if (detail) {
    const label = new Date(`${detail.month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const remaining = Number(detail.income || 0) - Number(detail.amount || 0);
    $('#trendDetail').innerHTML = `<span>${state.spendingMonth ? label : `Latest · ${label}`}</span><strong><i class="income"></i>${fmt.format(detail.income || 0)}</strong><strong><i class="spend"></i>${fmt.format(detail.amount || 0)}</strong><b class="${remaining >= 0 ? 'positive' : 'negative'}">${remaining >= 0 ? 'Left' : 'Over'} ${fmt.format(Math.abs(remaining))}</b>`;
  } else $('#trendDetail').innerHTML = '';
  $('#spendingTrend').innerHTML = months.length ? months.map((row) => `<button class="trend-column ${state.spendingMonth === row.month ? 'active' : ''}" type="button" data-spending-month="${row.month}" title="${escapeHtml(row.month)}: Income ${fmt.format(row.income || 0)} · Spent ${fmt.format(row.amount)}"><div class="trend-bars"><i class="trend-bar income" style="height:${Number(row.income || 0) ? Math.max(5, Number(row.income || 0) / max * 100) : 0}%"></i><i class="trend-bar spending" style="height:${Number(row.amount || 0) ? Math.max(5, Number(row.amount || 0) / max * 100) : 0}%"></i></div><span>${new Date(`${row.month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'short' })}</span></button>`).join('') : '<p class="spending-empty">Monthly patterns will appear once transactions arrive.</p>';
}

function renderCashFlowSankey(data) {
  const el = $('#cashflowSankey');
  const income = Number(data.income || 0), spending = Number(data.total || 0), rows = data.categories || [];
  if (!income && !spending) { el.innerHTML = ''; return; }
  const width = 700, height = 122, scale = 66 / Math.max(income, spending, 1);
  const node = (x, y, h, color, label, value, category = '') => `<g ${category ? `data-cashflow-category="${escapeHtml(category)}" class="cashflow-target"` : ''}><rect x="${x}" y="${y}" width="10" height="${h}" rx="4" fill="${color}"/><text x="${x + 15}" y="${y + 11}" class="cashflow-label">${escapeHtml(label)}</text><text x="${x + 15}" y="${y + 24}" class="cashflow-value">${fmt.format(value)}</text></g>`;
  const curve = (fromX, fromY, toX, toY, amount, color) => `<path d="M ${fromX} ${fromY} C ${fromX + 88} ${fromY}, ${toX - 88} ${toY}, ${toX} ${toY}" fill="none" stroke="${color}" stroke-opacity=".42" stroke-width="${Math.max(5, amount * scale)}" stroke-linecap="round"/>`;
  const leftH = Math.max(12, income * scale), spentH = Math.max(12, spending * scale), leftY = 28, spentY = 15, remaining = income - spending;
  const remainingH = Math.max(remaining > 0 ? 10 : 0, remaining * scale), remainingY = spentY + spentH + 13;
  let rightY = 10, right = '';
  let paths = curve(62, leftY + Math.min(leftH / 2, 24), 270, spentY + Math.min(spentH / 2, 24), spending, '#c87862');
  if (remaining > 0) paths += curve(62, leftY + leftH - 7, 270, remainingY + Math.min(remainingH / 2, 12), remaining, '#5b9a70');
  for (const [index, row] of rows.entries()) {
    const h = Math.max(8, Number(row.amount || 0) * scale), y = rightY, color = spendingColors[index % spendingColors.length];
    rightY += h + 8;
    paths += curve(280, spentY + Math.min(spentH / 2, 26), 528, y + Math.min(h / 2, 8), row.amount, color);
    right += node(528, y, h, color, row.name, row.amount, row.name);
  }
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Income flowing to spending categories">${paths}${node(52, leftY, leftH, '#5b9a70', 'Income', income)}${node(270, spentY, spentH, '#c87862', 'Spent', spending)}${remaining > 0 ? node(270, remainingY, remainingH, '#5b9a70', 'Left', remaining) : ''}${right}</svg>`;
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
  const remaining = income - total;
  $('#spendingTotal').textContent = fmt.format(Math.abs(remaining));
  $('#cashflowHeadline').textContent = remaining >= 0 ? 'Left after spending' : 'Over income';
  $('#cashflowHeadline').className = `cashflow-headline ${remaining >= 0 ? 'positive' : 'negative'}`;
  $('#spendingSummary').innerHTML = `<span><i class="income"></i>Income <strong>${fmt.format(income)}</strong></span><span>Spent <strong>${fmt.format(total)}</strong></span>`;
  const rangeLabel = ({ '1m': 'this month', '3m': 'over the last 3 months', ytd: 'year to date', '1y': 'over the last year' })[data.range] || 'this month';
  const selectedMonthLabel = state.spendingMonth && new Date(`${state.spendingMonth}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  $('#spendingContext').textContent = total || income ? (selectedMonthLabel ? `Cash flow in ${selectedMonthLabel}` : `Income minus money out · ${rangeLabel}`) : `No posted cash flow ${selectedMonthLabel || rangeLabel}. It can take a little time to arrive after connecting.`;
  renderCashFlowSankey(selected);
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
  const categories = [...new Set((data.transactions || []).map((transaction) => transaction.category))];
  if (state.spendingCategory !== 'all' && !categories.includes(state.spendingCategory)) state.spendingCategory = 'all';
  filter.innerHTML = `<option value="all">All activity</option>${categories.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
  filter.value = state.spendingCategory;
  $('#spendingSort').value = state.spendingSort;
  let rows = (data.transactions || []).filter((transaction) => (state.spendingCategory === 'all' || transaction.category === state.spendingCategory) && (!state.spendingMonth || String(transaction.date).startsWith(state.spendingMonth)));
  rows = [...rows].sort((a, b) => state.spendingSort === 'highest' ? b.amount - a.amount : String(b.date).localeCompare(String(a.date)) || b.amount - a.amount);
  $('#spendingTransactionCount').textContent = `${rows.length} posted`;
  const options = [['fixed', 'Fixed costs'], ['savings', 'Savings'], ['investments', 'Investments'], ['guilt_free', 'Guilt-free']];
  $('#spendingTransactions').innerHTML = rows.length ? rows.map((transaction) => {
    const categoryControl = transaction.bucket === 'income' || state.dashboard?.demoMode
      ? `<span class="transaction-category-label">${escapeHtml(transaction.category)}</span>`
      : `<select data-transaction-category="${escapeHtml(transaction.id)}" aria-label="Plan category for ${escapeHtml(transaction.name)}">${options.map(([value, label]) => `<option value="${value}" ${transaction.bucket === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
    return `<div class="spending-transaction-row ${transaction.bucket === 'income' ? 'income-transaction' : ''}"><div><strong>${escapeHtml(transaction.name)}</strong><span>${new Date(`${transaction.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></div><div class="transaction-plan"><b>${transaction.bucket === 'income' ? '+' : ''}${fmt.format(transaction.amount)}</b>${categoryControl}</div></div>`;
  }).join('') : '<p class="spending-empty">No posted transactions in this category for this period.</p>';
}

function portfolioSnapshots(data) {
  const snapshots = data.snapshots || [];
  if (state.investmentRange === 'all' || !snapshots.length) return snapshots;
  const latest = new Date(`${snapshots.at(-1).date}T12:00:00`);
  const cutoff = new Date(latest);
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  const visible = snapshots.filter((snapshot) => new Date(`${snapshot.date}T12:00:00`) >= cutoff);
  return visible.length ? visible : snapshots.slice(-1);
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
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Portfolio value history"><defs><linearGradient id="portfolioFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#287143" stop-opacity=".16"/><stop offset="1" stop-color="#287143" stop-opacity="0"/></linearGradient></defs>${grid}${xAxis}<path d="${area}" fill="url(#portfolioFade)"/><path d="${line}" fill="none" stroke="#287143" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>${points.length === 1 ? `<circle cx="${points[0][0]}" cy="${points[0][1]}" r="5" fill="#287143"/>` : ''}</svg>`;
}

function renderInvestments(data) {
  if (!data) return;
  const accounts = data.accounts || [];
  $('#investmentTotal').textContent = fmt.format(data.total || 0);
  const snapshots = portfolioSnapshots(data);
  const started = snapshots[0]?.date ? new Date(`${snapshots[0].date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null;
  const reconstructed = snapshots.some((snapshot) => snapshot.source === 'reconstructed');
  $('#investmentContext').textContent = accounts.length ? `${accounts.length} connected account${accounts.length === 1 ? '' : 's'}${started ? ` · ${reconstructed ? `Reconstructed since ${started}` : `Tracking since ${started}`}` : ' · Sync to begin tracking'}` : 'Connect an investment account to begin.';
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
    $('#investmentAllocationInsight').textContent = `${largest.name} is your largest allocation at ${Math.round(largest.share * 100)}%. Tap a category to explore it.`;
    const selected = allocation.find((row) => row.name === state.investmentFilter);
    donut.style.background = `conic-gradient(${allocation.map((row, index) => { const next = cursor + row.share * 100; const color = state.investmentFilter === 'all' || row.name === state.investmentFilter ? colors[index % colors.length] : '#dde4dd'; const stop = `${color} ${cursor.toFixed(2)}% ${next.toFixed(2)}%`; cursor = next; return stop; }).join(', ')})`;
    donut.innerHTML = selected ? `<span><strong>${fmt.format(selected.value)}</strong><small>${escapeHtml(selected.name)} · ${Math.round(selected.share * 100)}%</small></span>` : '<span><strong>Your mix</strong><small>Tap a category</small></span>';
    $('#investmentAllocation').innerHTML = `<button class="investment-allocation-row ${state.investmentFilter === 'all' ? 'active' : ''}" data-investment-filter="all"><i></i><span>All assets</span><strong>${fmt.format(data.total || 0)}</strong></button>${allocation.map((row, index) => `<button class="investment-allocation-row ${state.investmentFilter === row.name ? 'active' : ''}" data-investment-filter="${escapeHtml(row.name)}"><i style="background:${colors[index % colors.length]}"></i><span>${escapeHtml(row.name)}</span><small>${Math.round(row.share * 100)}%</small><strong>${fmt.format(row.value)}</strong></button>`).join('')}`;
  } else {
    donut.style.background = '#edf0eb'; donut.innerHTML = '<span>Awaiting<br>holdings</span>';
    $('#investmentAllocationInsight').textContent = 'Allocation appears when your institution provides holdings.';
    $('#investmentAllocation').innerHTML = '<p class="spending-empty">Allocation appears when your institution provides holdings.</p>';
  }
  $('#investmentAccounts').innerHTML = accounts.length ? accounts.map((account) => `<div class="investment-account-row"><div><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(account.institution_name || '')}</span></div><b>${fmt.format(account.value)}</b></div>`).join('') : '<p class="spending-empty">No investment accounts connected.</p>';
  const names = new Map(accounts.map((account) => [account.account_id, account.name]));
  let positions = (data.positions || []).filter((position) => state.investmentFilter === 'all' || assetClassLabel(position.type, position.asset_class_override) === state.investmentFilter);
  positions = [...positions].sort((a, b) => state.investmentSort === 'performance' ? Number(b.gain_pct ?? -Infinity) - Number(a.gain_pct ?? -Infinity) : state.investmentSort === 'equity' ? assetClassLabel(a.type, a.asset_class_override).localeCompare(assetClassLabel(b.type, b.asset_class_override)) || Number(b.value) - Number(a.value) : Number(b.value) - Number(a.value));
  $('#investmentSort').value = state.investmentSort;
  $('#investmentPositionCount').textContent = data.positionsAvailable ? `${positions.length} holding${positions.length === 1 ? '' : 's'}` : 'Not available';
  $('#investmentPositions').innerHTML = data.positionsAvailable ? positions.map((position) => { const gain = position.gain_pct; const performance = gain == null ? 'Performance unavailable' : `${gain >= 0 ? '+' : '−'}${Math.abs(gain * 100).toFixed(1)}%`; const classification = assetClassLabel(position.type, position.asset_class_override); return `<div class="position-row"><div class="position-symbol">${escapeHtml(position.ticker || '•')}</div><div><strong>${escapeHtml(position.name)}</strong><span>${escapeHtml(classification)} · ${escapeHtml(names.get(position.account_id) || 'Investment account')}</span><select class="position-class-select" data-position-class="${escapeHtml(position.id)}" aria-label="Asset class for ${escapeHtml(position.name)}"><option value="" ${position.asset_class_override ? '' : 'selected'}>Automatic · ${escapeHtml(assetClassLabel(position.type))}</option>${['Equities', 'Funds', 'Fixed income', 'Cash', 'Crypto', 'Other'].map((option) => `<option value="${option}" ${position.asset_class_override === option ? 'selected' : ''}>${option}</option>`).join('')}</select></div><div class="position-value"><b>${fmt.format(position.value)}</b><small class="${gain == null ? '' : gain >= 0 ? 'positive' : 'negative'}">${performance}</small></div></div>`; }).join('') : '<p class="positions-empty">Position details aren’t available from this connection yet. Your investment account balances still count toward your portfolio and net worth.</p>';
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
  if (state.demoPreview) {
    const preview = await api('/api/demo-preview');
    state.dashboard = preview.dashboard;
    state.spending = preview.spending;
    state.investments = preview.investments;
    renderDashboard();
    renderSpending(preview.spending);
    renderInvestments(preview.investments);
    $('#monthLabel').textContent = 'Demo workspace';
    return;
  }
  const [dashboard, spending, investments] = await Promise.all([api('/api/dashboard'), api(`/api/spending?range=${state.spendingRange}`), api('/api/investments')]);
  state.dashboard = dashboard;
  state.spending = spending;
  state.investments = investments;
  renderDashboard();
  renderSpending(spending);
  renderInvestments(investments);
  $('#monthLabel').textContent = 'Account overview';
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
      },
      onExit: (err) => { if (err) showNotice(err.display_message || err.error_message || 'Plaid Link closed with an error.'); }
    });
    handler.open();
  } catch (error) {
    showNotice(error.message);
  }
}

async function syncAccounts() {
  if (state.demoPreview) { showNotice('Sign in to sync your own accounts.'); return; }
  const buttons = $$('[data-sync-accounts]');
  buttons.forEach((button) => { button.disabled = true; button.textContent = '↻ Syncing…'; });
  try {
    const result = await api('/api/sync', { method: 'POST', body: '{}' });
    await loadAll();
    const failed = result.results?.filter((r) => !r.ok) || [];
    showNotice(failed.length ? `Synced with ${failed.length} connection error(s).` : 'Accounts synced.', failed.length ? 'warn' : 'success');
    $('#syncStatus').textContent = `Last sync ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  } catch (error) {
    showNotice(error.message);
  } finally { buttons.forEach((button) => { button.disabled = false; button.textContent = '↻ Sync accounts'; }); }
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('#profileButton').addEventListener('click', () => setView('profile'));
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
$('#connectButton').addEventListener('click', connectPlaid);
$$('[data-sync-accounts]').forEach((button) => button.addEventListener('click', syncAccounts));
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
  $('#spendingTransactionsPanel').open = true;
  renderSpending(state.spending);
}
$('#spendingLegend')?.addEventListener('click', (event) => openSpendingCategory(event.target.closest('[data-spending-category]')?.dataset.spendingCategory));
$('#cashflowSankey').addEventListener('click', (event) => openSpendingCategory(event.target.closest('[data-cashflow-category]')?.dataset.cashflowCategory));
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
  $('#investmentHoldingsPanel').open = true;
  renderInvestments(state.investments);
});
$('#investmentDonut').addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  const rows = state.investments?.allocation || [];
  const selected = state.investmentFilter === 'all' ? rows[0] : rows.find((row) => row.name === state.investmentFilter);
  if (!selected) return;
  state.investmentFilter = selected.name;
  $('#investmentHoldingsPanel').open = true;
  renderInvestments(state.investments);
});
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
  $$('[data-spending-range]').forEach((control) => control.classList.remove('active'));
  renderSpending(state.spending);
  $('#spendingTransactionsPanel').open = true;
});
$$('[data-investment-range]').forEach((button) => button.addEventListener('click', () => {
  state.investmentRange = button.dataset.investmentRange;
  $$('[data-investment-range]').forEach((control) => control.classList.toggle('active', control === button));
  renderInvestments(state.investments);
}));
$('#investmentAllocation').addEventListener('click', (event) => {
  const filter = event.target.closest('[data-investment-filter]')?.dataset.investmentFilter;
  if (!filter) return;
  state.investmentFilter = filter;
  $('#investmentHoldingsPanel').open = true;
  renderInvestments(state.investments);
});
$('#investmentSort').addEventListener('change', (event) => {
  state.investmentSort = event.target.value;
  renderInvestments(state.investments);
});
$('#investmentPositions').addEventListener('change', async (event) => {
  const select = event.target.closest('[data-position-class]');
  if (!select) return;
  select.disabled = true;
  try {
    await api(`/api/positions/${encodeURIComponent(select.dataset.positionClass)}/asset-class`, { method: 'PATCH', body: JSON.stringify({ asset_class: select.value }) });
    state.investments = await api('/api/investments');
    renderInvestments(state.investments);
    showNotice(select.value ? 'Holding classification updated.' : 'Using the institution classification.', 'success');
  } catch (error) { showNotice(error.message); select.disabled = false; }
});

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
      restoreNetWorthHero();
      renderLineChart(visibleSnapshots(state.dashboard.snapshots || []), state.dashboard.summary);
    }
    if (state.view === 'investments' && state.investments) renderInvestments(state.investments);
  });
});

initializeApp().catch((error) => { $('#authMessage').textContent = error.message; });
