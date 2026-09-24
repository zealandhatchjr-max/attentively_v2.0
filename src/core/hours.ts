import type { OpeningHours } from "./types.js";

/** Local weekday (0 = Sunday) and minutes-since-midnight for `at` in `timezone`. */
export function localClock(at: Date, timezone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

/** Margin so we don't ring a shop in its last few minutes. */
const CLOSING_BUFFER_MIN = 20;

export function isOpen(hours: OpeningHours | null | undefined, at: Date, timezone: string): boolean {
  if (!hours || hours.length === 0) return false; // unknown hours: never call blind
  const { day, minutes } = localClock(at, timezone);
  return hours.some(
    (h) => h.day === day && minutes >= toMin(h.open) && minutes < toMin(h.close) - CLOSING_BUFFER_MIN,
  );
}

/** Next moment (at or after `from`) the vendor is open, scanning up to 8 days ahead. */
export function nextOpening(hours: OpeningHours | null | undefined, from: Date, timezone: string): Date | null {
  if (!hours || hours.length === 0) return null;
  if (isOpen(hours, from, timezone)) return from;
  const step = 5 * 60_000;
  let t = new Date(Math.ceil(from.getTime() / step) * step);
  const end = from.getTime() + 8 * 24 * 3600_000;
  // Coarse scan in 5-minute steps; cheap enough for a handful of vendors.
  while (t.getTime() < end) {
    if (isOpen(hours, t, timezone)) return t;
    t = new Date(t.getTime() + step);
  }
  return null;
}
