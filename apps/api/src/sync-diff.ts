import { createHash } from "node:crypto";
import type { CaloEvent } from "@calo/core";

/** The columns of a synced_events row that the diff reads. */
export interface StoredEvent {
  eventId: string;
  contentHash: string;
  start: Date;
  deletedAt: Date | null;
}

// Every field, since each one reaches the calendar. The keys are sorted so the
// hash depends only on the values, not on the order a normalizer built the
// object in.
export function contentHash(event: CaloEvent): string {
  const json = JSON.stringify(event, Object.keys(event).sort());
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Compares a fresh pull from Canvas with what's stored. `added` includes
 * tombstoned events that came back, since the calendar has to recreate them.
 *
 * A live event missing from the pull is deleted only if its start is within
 * `window` (inclusive), the span the pull is known to cover. Anything outside
 * it may have just moved out of range, so it's left as is. So are
 * `ambiguousIds`: items the feed has but couldn't be read (see
 * parseCanvasFeed), which are missing from the pull without being gone.
 */
export function diffEvents(
  stored: StoredEvent[],
  pulled: CaloEvent[],
  window: { start: Date; end: Date },
  ambiguousIds: string[],
): { added: CaloEvent[]; changed: CaloEvent[]; deleted: string[] } {
  const storedById = new Map(stored.map((row) => [row.eventId, row]));
  const added: CaloEvent[] = [];
  const changed: CaloEvent[] = [];
  for (const event of pulled) {
    const row = storedById.get(event.id);
    if (!row || row.deletedAt !== null) {
      added.push(event);
    } else if (row.contentHash !== contentHash(event)) {
      changed.push(event);
    }
  }

  const pulledIds = new Set(pulled.map((event) => event.id));
  const ambiguous = new Set(ambiguousIds);
  const deleted = stored
    .filter(
      (row) =>
        row.deletedAt === null &&
        !pulledIds.has(row.eventId) &&
        !ambiguous.has(row.eventId) &&
        row.start >= window.start &&
        row.start <= window.end,
    )
    .map((row) => row.eventId);

  return { added, changed, deleted };
}
