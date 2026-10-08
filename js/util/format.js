// Formatting helpers for the UI and reports. Pure, no DOM.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Seconds -> "H:MM:SS" (or "D d H:MM:SS" beyond 24 h). */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const hms = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return d > 0 ? `${d} d ${hms}` : hms;
}

/** Seconds -> short human duration: "45 s", "12.5 min", "3.2 h". */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '–';
  const a = Math.abs(seconds);
  if (a < 90) return `${round(seconds, a < 10 ? 1 : 0)} s`;
  if (a < 5400) return `${round(seconds / 60, 1)} min`;
  return `${round(seconds / 3600, 1)} h`;
}

export function round(v, digits = 0) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Number with thousands separators and fixed max digits; non-finite -> "–". */
export function formatNumber(v, digits = 0) {
  if (!Number.isFinite(v)) return '–';
  return round(v, digits).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** Fraction 0..1 -> "73 %". */
export function formatPercent(frac, digits = 0) {
  if (!Number.isFinite(frac)) return '–';
  return `${formatNumber(frac * 100, digits)} %`;
}

export function formatDistance(m) {
  if (!Number.isFinite(m)) return '–';
  return m >= 1000 ? `${round(m / 1000, 2)} km` : `${round(m, 0)} m`;
}

/** Escape text for safe interpolation into HTML strings (used by report export). */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
