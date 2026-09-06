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

export function hasUsableNetWorthTrend(snapshots) {
  if (snapshots.length < 4) return false;
  const ordered = [...snapshots].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const first = new Date(`${ordered[0].date}T12:00:00`).getTime();
  const last = new Date(`${ordered.at(-1).date}T12:00:00`).getTime();
  return last - first >= 7 * 86_400_000;
}

export function scrubIndex({ clientX, left, width, pointCount }) {
  if (pointCount < 2 || width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (clientX - left) / width));
  return Math.round(ratio * (pointCount - 1));
}
