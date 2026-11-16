// 날짜·시각 변환. 공장 시간대는 한국(+09:00) 고정.
const TZ_OFFSET_MS = 9 * 3600 * 1000;

export function toIsoLocal(date, sec) {
  const s = Math.floor(sec);
  const ms = Math.round((sec - s) * 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}:${ss}${ms ? '.' + String(ms).padStart(3, '0') : ''}+09:00`;
}

export function toIsoUtc(date, sec) {
  const base = Date.parse(`${date}T00:00:00+09:00`);
  return new Date(base + Math.round(sec * 1000)).toISOString();
}

// 어떤 ISO 문자열이든 → { date, sec } (한국 시간 기준)
export function parseTimestamp(ts) {
  const ms = Date.parse(ts.trim());
  if (Number.isNaN(ms)) return null;
  const local = new Date(ms + TZ_OFFSET_MS);
  const date = local.toISOString().slice(0, 10);
  const sec = (local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds()) + local.getUTCMilliseconds() / 1000;
  return { date, sec };
}

export function todayLocal() {
  return new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekdayKo(date) {
  return ['일', '월', '화', '수', '목', '금', '토'][new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function hhmm(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

export function parseHhmm(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}
