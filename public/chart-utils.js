export function netWorthRangeBounds(range, anchor = new Date()) {
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  if (range === 'all') return { startDate: null, endDate: end.toISOString().slice(0, 10) };
  const start = new Date(end);
  if (range === '1m') start.setMonth(start.getMonth() - 1);
  else if (range === '3m') start.setMonth(start.getMonth() - 3);
  else if (range === '6m') start.setMonth(start.getMonth() - 6);
  else if (range === 'ytd') start.setMonth(0, 1);
  else if (range === '1y') start.setFullYear(start.getFullYear() - 1);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

export function filterSnapshots(snapshots, range, anchor = new Date()) {
  const { startDate, endDate } = netWorthRangeBounds(range, anchor);
  return snapshots.filter((snapshot) => (!startDate || snapshot.date >= startDate) && snapshot.date <= endDate);
}

// A recently connected person should not land on a long selected period that
// is mostly untracked space. Pick the longest range that is effectively fully
// covered; otherwise show only the history we actually have.
export function preferredNetWorthRange(snapshots, anchor = new Date()) {
  const uniqueDates = [...new Set((snapshots || []).map((snapshot) => snapshot.date).filter(Boolean))].sort();
  if (uniqueDates.length < 2) return 'all';
  const first = uniqueDates[0];
  const last = uniqueDates.at(-1);
  const firstTime = new Date(`${first}T12:00:00`).getTime();
  const lastTime = new Date(`${last}T12:00:00`).getTime();
  if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) || lastTime - firstTime < 14 * 86400000) return 'all';
  // A short allowance accounts for a first sync occurring a few days after a
  // calendar boundary, without presenting months of unavailable time as data.
  const tolerance = 10 * 86400000;
  for (const range of ['ytd', '1y', '6m', '3m', '1m']) {
    const { startDate } = netWorthRangeBounds(range, anchor);
    if (firstTime <= new Date(`${startDate}T12:00:00`).getTime() + tolerance) return range;
  }
  return 'all';
}

// Defensive rendering guard. The server keeps one net-worth snapshot per day,
// but chart data from an interrupted migration or older client must not form a
// vertical same-day line.
export function uniqueDailySnapshots(snapshots) {
  const byDate = new Map();
  for (const snapshot of snapshots || []) if (snapshot?.date) byDate.set(snapshot.date, snapshot);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function scrubIndex({ clientX, left, width, pointCount }) {
  if (pointCount < 2 || width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (clientX - left) / width));
  return Math.round(ratio * (pointCount - 1));
}
