import type { CaloEvent } from "./event.js";

// UIDs are "event-" + the Canvas record's class, dashed, + its id. Checkpoints
// ("sub-assignment") and anything else are skipped, like the planner types
// normalizePlannerItems drops.
const UID = /^event-(assignment|assignment-override|calendar-event)-(\d+)$/;

// Canvas writes every time in UTC with the seconds zeroed, and all-day items
// (including assignments due at 11:59 PM) as a bare date.
const UTC_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const DATE = /^(\d{4})(\d{2})(\d{2})$/;

/**
 * Parses the calendar feed Canvas exports (Calendar -> Calendar Feed), the
 * low-fidelity fallback ingest path. It accepts only the shapes Canvas's
 * serializer produces and throws on anything else, since guessing could put a
 * deadline at the wrong time.
 *
 * The exception is two items resolving to the same id. That's local to those
 * items, so all of them are left out and the id is reported in `ambiguousIds`,
 * while the rest of the feed still comes through.
 */
export function parseCanvasFeed(ics: string): {
  events: CaloEvent[];
  ambiguousIds: string[];
} {
  const events = new Map<string, CaloEvent>();
  const ambiguousIds = new Set<string>();
  for (const props of readVEvents(ics)) {
    const event = toCaloEvent(props);
    if (!event) continue;
    if (events.has(event.id) || ambiguousIds.has(event.id)) {
      // No way to tell which is which, so keep none of them.
      events.delete(event.id);
      ambiguousIds.add(event.id);
    } else {
      events.set(event.id, event);
    }
  }
  return { events: [...events.values()], ambiguousIds: [...ambiguousIds] };
}

function toCaloEvent(props: Map<string, string>): CaloEvent | null {
  const read = (name: string): string => {
    const value = props.get(name);
    if (value === undefined) {
      throw new Error(
        `Canvas feed item ${props.get("UID") ?? "(no UID)"} has no ${name}`,
      );
    }
    return value;
  };

  const uid = read("UID");
  const match = UID.exec(uid);
  if (!match) return null;
  const url = read("URL");
  const kind = match[1] === "calendar-event" ? "event" : "assignment";

  // An override's UID carries the override's id, which would change the
  // event's id whenever an instructor adds or removes one. Its URL still ends
  // in the assignment's id.
  let canvasId = match[2];
  if (match[1] === "assignment-override") {
    canvasId = /#assignment_(\d+)$/.exec(url)?.[1];
    if (!canvasId) {
      throw new Error(`Canvas feed override ${uid} has no assignment id in ${url}`);
    }
  }

  // Canvas appends " [course code]" to anything that belongs to a course.
  // Titles can contain brackets too, so the course is the last bracketed part.
  const summary = unescapeText(read("SUMMARY"));
  const open = summary.lastIndexOf(" [");
  const hasCourse = open !== -1 && summary.endsWith("]");

  const start = readDate(read("DTSTART"), uid);
  const dtend = props.get("DTEND");
  return {
    id: `${kind}-${canvasId}`,
    kind,
    title: hasCourse ? summary.slice(0, open) : summary,
    course: hasCourse ? summary.slice(open + 2, -1) : "",
    url,
    start: start.iso,
    // Canvas repeats an assignment's due time as its DTEND; it's still a
    // deadline. An event with no DTEND (all-day) ends where it starts.
    end:
      kind === "event"
        ? dtend === undefined
          ? start.iso
          : readDate(dtend, uid).iso
        : null,
    allDay: start.allDay,
  };
}

function readDate(value: string, uid: string): { iso: string; allDay: boolean } {
  if (UTC_TIME.test(value)) {
    return { iso: value.replace(UTC_TIME, "$1-$2-$3T$4:$5:$6Z"), allDay: false };
  }
  if (DATE.test(value)) {
    return { iso: value.replace(DATE, "$1-$2-$3T00:00:00Z"), allDay: true };
  }
  throw new Error(`Canvas feed item ${uid} has an unexpected date: ${value}`);
}

// Each VEVENT as property name -> raw value. Nothing outside a VEVENT matters.
function readVEvents(ics: string): Map<string, string>[] {
  const vevents: Map<string, string>[] = [];
  let current: Map<string, string> | null = null;
  // Unfold first: a line break followed by a space or tab continues the line.
  for (const line of ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    const property = splitLine(line);
    if (!property) continue; // blank line
    const [name, value] = property;
    if (name === "BEGIN" && value === "VEVENT") {
      current = new Map();
    } else if (name === "END" && value === "VEVENT") {
      if (current) vevents.push(current);
      current = null;
    } else {
      current?.set(name, value);
    }
  }
  return vevents;
}

// A content line is NAME, optional ;PARAM=value pairs, then :VALUE. The value
// starts at the first colon that isn't inside a quoted parameter value.
function splitLine(line: string): [name: string, value: string] | null {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      quoted = !quoted;
    } else if (line[i] === ":" && !quoted) {
      const head = line.slice(0, i);
      const semicolon = head.indexOf(";");
      return [semicolon === -1 ? head : head.slice(0, semicolon), line.slice(i + 1)];
    }
  }
  return null;
}

// One left-to-right pass, so an escaped backslash followed by "n" stays a
// backslash and an "n" rather than becoming a newline.
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}
