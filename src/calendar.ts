import ICAL from "ical.js";
import { statedTextLimits, type sourceRecordSchema, type statedItemSchema } from "@family-agenda/plugin-contract";
import type { z } from "zod";
import { PluginError } from "@family-agenda/plugin-kit";

type StatedItem = z.input<typeof statedItemSchema>;
export type StatedEvent = Extract<StatedItem, { kind: "event" }>;
export type EventSpan = StatedEvent["span"];
export type SourceRecord = z.input<typeof sourceRecordSchema>;

/** One calendar entry: its UID, the Event it states, and its own web address if it has one. */
export type FoundEntry = { uid: string; event: StatedEvent; link: string | null };

/** A downloaded calendar: the name it gives itself and its entries. */
export type Calendar = { name: string | null; entries: FoundEntry[] };

/** The one Source Attribute of a calendar, which has no subdivisions. */
export const calendarAttribute = "calendar";

export function sourceRecordOf(entry: FoundEntry): SourceRecord {
  return {
    externalId: entry.uid,
    attributes: [calendarAttribute],
    ...(entry.link ? { link: entry.link } : {}),
    content: { kind: "stated", stated: entry.event },
  };
}

/**
 * The entries of an ICS file, times read in the Family's time zone where they name none.
 * Recurring entries are left out for now; they need expanding into occurrences.
 */
export function parseCalendar(body: string, familyTimeZone: string): Calendar {
  let calendar: ICAL.Component;
  try {
    calendar = new ICAL.Component(ICAL.parse(body) as unknown[]);
  } catch {
    throw new PluginError("definite", "The ICS address returns no calendar.");
  }
  if (calendar.name !== "vcalendar") throw new PluginError("definite", "The ICS address returns no calendar.");

  const zones = new Map<string, ICAL.Timezone>();
  for (const component of calendar.getAllSubcomponents("vtimezone")) {
    const zone = new ICAL.Timezone(component);
    zones.set(zone.tzid, zone);
  }
  const instant = (property: ICAL.Property | null) => {
    const time = property?.getFirstValue();
    if (!(time instanceof ICAL.Time)) return null;
    const tzid = property?.getParameter("tzid");
    return instantOf(time, typeof tzid === "string" ? tzid : null, zones, familyTimeZone);
  };

  const entries: FoundEntry[] = [];
  for (const component of calendar.getAllSubcomponents("vevent")) {
    const entry = parseEvent(component, instant);
    if (entry) entries.push(entry);
  }
  return { name: text(calendar.getFirstPropertyValue("x-wr-calname")), entries };
}

type InstantOf = (property: ICAL.Property | null) => Date | null;

/** A single VEVENT as a FoundEntry, or null if it has no uid, no start, is recurring, or has no span. */
function parseEvent(component: ICAL.Component, instant: InstantOf): FoundEntry | null {
  const uid = text(component.getFirstPropertyValue("uid"));
  const start = component.getFirstProperty("dtstart")?.getFirstValue();
  const recurring = ["rrule", "rdate", "recurrence-id"].some((name) => component.hasProperty(name));
  if (!uid || !(start instanceof ICAL.Time) || recurring) return null;
  const event = new ICAL.Event(component);
  const span = start.isDate
    ? allDaySpan(start, event.endDate)
    : timedSpan(instant(component.getFirstProperty("dtstart")), endInstant(component, instant));
  if (!span) return null;
  return entryFrom(event, component, uid, span);
}

/** An entry's Event, its texts clipped to what an Event keeps; cancelled only by `STATUS:CANCELLED`. */
function entryFrom(event: ICAL.Event, component: ICAL.Component, uid: string, span: EventSpan): FoundEntry {
  const link = text(component.getFirstPropertyValue("url"));
  const place = text(event.location);
  return {
    uid,
    event: {
      kind: "event",
      title: clipped(text(event.summary) ?? "(No title)", statedTextLimits.event),
      span,
      place: place && clipped(place, statedTextLimits.event),
      cancelled: text(component.getFirstPropertyValue("status"))?.toUpperCase() === "CANCELLED",
    },
    link: link && /^https?:\/\//i.test(link) && URL.canParse(link) ? link : null,
  };
}

/** A text trimmed and cut to at most `limit` characters. */
export function clipped(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit).trimEnd();
}

/** The end of a timed entry: its `DTEND`, or its start plus its `DURATION`, or its start. */
function endInstant(component: ICAL.Component, instant: InstantOf): Date | null {
  if (component.hasProperty("dtend")) return instant(component.getFirstProperty("dtend"));
  const start = instant(component.getFirstProperty("dtstart"));
  if (!start) return null;
  const duration = component.getFirstPropertyValue("duration");
  return duration instanceof ICAL.Duration ? new Date(start.getTime() + duration.toSeconds() * 1000) : start;
}

function timedSpan(start: Date | null, end: Date | null): EventSpan | null {
  if (!start || !end || end < start) return null;
  return { allDay: false, start: start.toISOString(), end: end.toISOString() };
}

/** Whole days, both included; an all-day entry's `DTEND` is the day after its last. */
function allDaySpan(start: ICAL.Time, end: ICAL.Time): EventSpan | null {
  const firstDay = dateOf(start);
  const last = end.clone();
  last.adjust(-1, 0, 0, 0);
  const lastDay = end.compare(start) > 0 ? dateOf(last) : firstDay;
  return lastDay >= firstDay ? { allDay: true, firstDay, lastDay } : null;
}

function dateOf(time: ICAL.Time): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}`;
}

/**
 * The instant a calendar time stands for. ical.js knows UTC; a named zone is taken from the
 * system's time zone database where it knows the name, as Google's and Apple's are, else from the
 * calendar's own `VTIMEZONE`; a time without a zone is in the Family's.
 */
function instantOf(time: ICAL.Time, tzid: string | null, zones: Map<string, ICAL.Timezone>, familyTimeZone: string): Date {
  if (time.zone === ICAL.Timezone.utcTimezone) return time.toJSDate();
  if (tzid && isKnownTimeZone(tzid)) return zonedInstant(time, tzid);
  const zone = tzid ? zones.get(tzid) : undefined;
  if (zone) {
    const zoned = time.clone();
    zoned.zone = zone;
    return new Date(zoned.toUnixTime() * 1000);
  }
  return zonedInstant(time, familyTimeZone);
}

function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The instant a wall-clock time shows in an IANA time zone. */
function zonedInstant(time: ICAL.Time, timeZone: string): Date {
  const wallClock = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      })
        .formatToParts(instant)
        .map((part) => [part.type, Number(part.value)]),
    ) as Record<string, number>;
    const shown = Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day, parts.hour, parts.minute, parts.second);
    return shown - instant;
  };
  // The offset at the wall-clock time read as UTC is right except near a change of offset,
  // where the offset at the first guess is.
  const guess = wallClock - offsetAt(wallClock);
  return new Date(wallClock - offsetAt(guess));
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
