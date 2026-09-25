import type { CaloEvent } from "./event.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const utf8 = new TextEncoder();

/**
 * Builds the merged feed that Apple, Notion, or any ICS client subscribes to.
 * `now` fills DTSTAMP, which RFC 5545 requires on every event; taking it as an
 * argument keeps the output a function of the inputs alone.
 */
export function generateIcs(events: CaloEvent[], now: Date): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Calo//Calo//EN",
    // Not in RFC 5545, but it's what Apple and Notion name the subscription.
    "X-WR-CALNAME:Calo",
  ];
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      // The "@calo" suffix is RFC 5545's suggested way to keep UIDs globally unique.
      `UID:${escapeText(event.id)}@calo`,
      `DTSTAMP:${formatDateTime(now)}`,
    );
    if (event.allDay) {
      // A DATE start with no end means one whole day. Canvas's own feed
      // writes all-day items the same way.
      lines.push(`DTSTART;VALUE=DATE:${formatDate(event.start)}`);
    } else {
      lines.push(`DTSTART:${formatDateTime(new Date(event.start))}`);
      // DTEND must be after DTSTART. Without one, a timed start is an
      // instant, which is exactly what a deadline is.
      if (event.end !== null && Date.parse(event.end) > Date.parse(event.start)) {
        lines.push(`DTEND:${formatDateTime(new Date(event.end))}`);
      }
    }
    const summary = event.course ? `${event.title} [${event.course}]` : event.title;
    lines.push(
      `SUMMARY:${escapeText(summary)}`,
      // A URI, not TEXT: escaping would corrupt a link with a comma in it.
      `URL:${event.url}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// 2026-10-03T06:59:59.000Z -> 20261003T065959Z
function formatDateTime(date: Date): string {
  return date.toISOString().replace(/[-:]|\.\d{3}/g, "");
}

// Canvas stores an all-day date as midnight in the creator's timezone.
// For UTC-11:59 through UTC+12 that's within 12h of the date's UTC midnight
// (Math.round sends the +12 half-day tie upward, to the right date).
// Known and accepted misses: UTC-12 (uninhabited) and UTC+13/+14 (NZ
// summer time, Tonga, Samoa, eastern Kiribati). That only affects events
// whose creator's Canvas timezone is set there.
function formatDate(iso: string): string {
  const midnight = Math.round(Date.parse(iso) / DAY_MS) * DAY_MS;
  return new Date(midnight).toISOString().slice(0, 10).replaceAll("-", "");
}

// RFC 5545 TEXT escaping. Backslashes go first, or the backslashes added
// for the other characters would be escaped again.
function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Lines may be at most 75 octets (UTF-8 bytes, not JS characters), continued
// with CRLF and a space. Breaking only between code points keeps multi-byte
// characters whole; Apple Calendar garbles one that's split.
function fold(line: string): string {
  let folded = "";
  let octets = 0;
  for (const char of line) {
    const size = utf8.encode(char).length;
    if (octets + size > 75) {
      folded += "\r\n ";
      octets = 1; // the leading space counts
    }
    folded += char;
    octets += size;
  }
  return folded;
}
