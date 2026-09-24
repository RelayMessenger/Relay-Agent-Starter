import { TIME_ZONE, WEEKLY_HOURS } from "./business";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface LocalClock {
  /** 0 = Sunday. */
  day: number;
  /** Minutes since local midnight. */
  minutes: number;
  /** YYYY-MM-DD in the store's time zone. */
  date: string;
  /** e.g. "Thursday, September 24, 2026, 3:05 PM". */
  label: string;
}

export function localClock(now: Date, timeZone = TIME_ZONE): LocalClock {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone,
      weekday: "short",
      year: "numeric",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const label = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(now);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    day: WEEKDAY_INDEX[parts.weekday!]!,
    label,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours! * 60 + minutes!;
}

export function formatTime(time: string): string {
  const minutes = toMinutes(time);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0
    ? `${hour12} ${suffix}`
    : `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export interface StoreStatus {
  isOpen: boolean;
  now: string;
  today: string;
  /** Human sentence the model can repeat. */
  summary: string;
}

export function storeStatus(now: Date): StoreStatus {
  const clock = localClock(now);
  const today = WEEKLY_HOURS[clock.day]!;
  const todayText =
    `${DAY_NAMES[clock.day]} ${formatTime(today.open)}–${formatTime(today.close)}`;
  const open = toMinutes(today.open);
  const close = toMinutes(today.close);

  if (clock.minutes >= open && clock.minutes < close) {
    return {
      isOpen: true,
      now: clock.label,
      summary: `Open now until ${formatTime(today.close)}.`,
      today: todayText,
    };
  }
  if (clock.minutes < open) {
    return {
      isOpen: false,
      now: clock.label,
      summary: `Closed right now. Opens today at ${formatTime(today.open)}.`,
      today: todayText,
    };
  }
  const tomorrow = (clock.day + 1) % 7;
  const next = WEEKLY_HOURS[tomorrow]!;
  return {
    isOpen: false,
    now: clock.label,
    summary:
      `Closed for the day. Opens tomorrow (${DAY_NAMES[tomorrow]}) at ${formatTime(next.open)}.`,
    today: todayText,
  };
}

export function weeklyHoursText(): string {
  return [1, 2, 3, 4, 5, 6, 0]
    .map((day) => {
      const hours = WEEKLY_HOURS[day]!;
      return `${DAY_NAMES[day]}: ${formatTime(hours.open)}–${formatTime(hours.close)}`;
    })
    .join("\n");
}

/**
 * Convert a store-local wall time ("2026-10-10T12:30") to a UTC ISO string.
 * Detroit observes DST, so the offset is resolved for that exact instant.
 */
export function localToUtcIso(local: string, timeZone = TIME_ZONE): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(local);
  if (!match) throw new RangeError("Expected local time as YYYY-MM-DDTHH:MM");
  const [, y, mo, d, h, mi] = match.map(Number) as number[];
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  const offsetAt = (instant: number): number => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        month: "2-digit",
        timeZone,
        year: "numeric",
      })
        .formatToParts(new Date(instant))
        .map((part) => [part.type, part.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    return asUtc - instant;
  };
  let instant = guess - offsetAt(guess);
  instant = guess - offsetAt(instant);
  return new Date(instant).toISOString();
}
