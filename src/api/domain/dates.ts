import type { Cadence } from '../../shared/contracts';

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value &&
    value >= '2000-01-01' &&
    value <= '2100-12-31'
  );
}
export function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
    return zone.length <= 80;
  } catch {
    return false;
  }
}
const formatters = new Map<string, Intl.DateTimeFormat>();
export function localParts(at: Date, zone: string): { date: string; time: string } {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= 32) formatters.clear();
    formatters.set(zone, formatter);
  }
  const p = formatter.formatToParts(at);
  const get = (key: string) => p.find((part) => part.type === key)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}
export function isQuiet(
  at: Date,
  settings: { quietStart: string; quietEnd: string; timeZone: string },
): boolean {
  if (settings.quietStart === settings.quietEnd) return false;
  const { time } = localParts(at, settings.timeZone);
  return settings.quietStart < settings.quietEnd
    ? time >= settings.quietStart && time < settings.quietEnd
    : time >= settings.quietStart || time < settings.quietEnd;
}
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
export function occurs(start: string, cadence: Cadence, date: string): boolean {
  if (date < start || !validDate(date)) return false;
  if (cadence === 'once') return date === start;
  if (cadence === 'daily') return true;
  if (cadence === 'weekly')
    return (
      (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) % (7 * 86400000) === 0
    );
  const lastDay = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0),
  ).getUTCDate();
  return Number(date.slice(8)) === Math.min(Number(start.slice(8)), lastDay);
}
/** Resolve a wall-clock minute through IANA timezone data; DST gaps move to the next valid minute. */
export function wallTime(date: string, time: string, zone: string): Date {
  const wall = Date.parse(`${date}T${time}:00Z`);
  let guess = wall;
  for (let i = 0; i < 4; i++) {
    const parts = localParts(new Date(guess), zone);
    const adjustment = wall - Date.parse(`${parts.date}T${parts.time}:00Z`);
    if (adjustment === 0) return new Date(guess);
    guess += adjustment;
  }
  // Ambiguous/nonexistent DST minutes: choose first instant whose local wall time is at/after target.
  const candidates = [guess, guess + 3600000, guess - 3600000].sort((a, b) => a - b);
  return new Date(
    candidates.find((v) => {
      const p = localParts(new Date(v), zone);
      return `${p.date}T${p.time}` >= `${date}T${time}`;
    }) ?? guess,
  );
}
export function nextReminder(
  plan: {
    start_date: string;
    cadence: Cadence;
    time: string;
    time_zone: string;
    remind_minutes: number;
  },
  after: Date,
): { at: string; date: string } | null {
  if (plan.remind_minutes < 0) return null;
  let date = localParts(after, plan.time_zone).date;
  if (date < plan.start_date) date = plan.start_date;
  for (let i = 0; i < 370; i++, date = addDays(date, 1)) {
    if (!occurs(plan.start_date, plan.cadence, date)) {
      if (plan.cadence === 'once' && date > plan.start_date) return null;
      continue;
    }
    const at = new Date(
      wallTime(date, plan.time, plan.time_zone).getTime() - plan.remind_minutes * 60000,
    );
    if (at.getTime() > after.getTime()) return { at: at.toISOString(), date };
  }
  return null;
}
