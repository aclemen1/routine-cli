const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

export function parseDuration(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid duration: ${value}`);
    return value * 1000;
  }
  const text = value.trim();
  if (!/^(\d+[smh])+$/.test(text)) throw new Error(`invalid duration: ${JSON.stringify(value)} (expected e.g. 30s, 10m, 1h30m)`);
  let ms = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)([smh])/g)) ms += Number(n) * UNIT_MS[unit!]!;
  if (ms <= 0) throw new Error(`invalid duration: ${JSON.stringify(value)}`);
  return ms;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
}
