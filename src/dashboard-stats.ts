export interface SyncMetrics { checked: number; saved: number }
interface Report {
  finishedAt: number;
  status: string;
  destination?: string;
  metrics?: SyncMetrics;
}
interface LocalFile { path: string; extension: string; stat: { size: number } }

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function normalizeStatsPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function restoreMetrics(value: unknown): SyncMetrics | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Partial<SyncMetrics>;
  if (typeof v.checked !== "number" || typeof v.saved !== "number" ||
      !Number.isSafeInteger(v.checked) || !Number.isSafeInteger(v.saved) ||
      v.checked < 0 || v.saved < 0 || v.saved > v.checked) return;
  return { checked: v.checked, saved: v.saved };
}

export function calculateDashboardStats(files: LocalFile[], reports: Report[], destination: string, now = new Date()) {
  const dest = normalizeStatsPath(destination);
  const localFiles = dest ? files.filter(f => normalizeStatsPath(f.path).startsWith(`${dest}/`)) : [];
  // Older records have no machine-readable counts/scope. Never invent counts from them.
  const measured = reports.filter(r => r.destination && normalizeStatsPath(r.destination) === dest && restoreMetrics(r.metrics));
  const dateMap: Record<string, number> = {};
  let checked = 0;
  let saved = 0;
  for (const report of measured) {
    const metrics = restoreMetrics(report.metrics)!;
    checked += metrics.checked;
    saved += metrics.saved;
    const date = new Date(report.finishedAt);
    if (metrics.saved && Number.isFinite(date.getTime())) {
      const key = localDateKey(date);
      dateMap[key] = (dateMap[key] ?? 0) + metrics.saved;
    }
  }
  const day = new Date(now);
  day.setHours(12, 0, 0, 0);
  if (!dateMap[localDateKey(day)]) day.setDate(day.getDate() - 1);
  let streak = 0;
  while (streak < 365 && dateMap[localDateKey(day)]) {
    streak++;
    day.setDate(day.getDate() - 1);
  }
  const completedRuns = measured.filter(r => r.status !== "canceled");
  return {
    checked, saved, dateMap, streak,
    files: localFiles.length,
    markdown: localFiles.filter(f => f.extension.toLowerCase() === "md").length,
    bytes: localFiles.reduce((total, f) => total + (Number.isFinite(f.stat.size) ? Math.max(0, f.stat.size) : 0), 0),
    successRate: completedRuns.length ? (100 * completedRuns.filter(r => r.status === "success").length / completedRuns.length).toFixed(1) : null,
  };
}
