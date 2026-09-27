import type { CaloEvent } from "@calo/core";
import { describe, expect, it } from "vitest";
import { contentHash, diffEvents, type StoredEvent } from "./sync-diff.ts";

const WINDOW = {
  start: new Date("2026-09-14T00:00:00Z"),
  end: new Date("2026-12-25T00:00:00Z"),
};

function assignment(id: number, start: string, title = `Assignment ${id}`): CaloEvent {
  return {
    id: `assignment-${id}`,
    kind: "assignment",
    title,
    course: "CMPT 225 D100",
    url: `https://canvas.sfu.ca/courses/62841/assignments/${id}`,
    start,
    end: null,
    allDay: false,
  };
}

// The row a previous sync would have stored for `event`.
function stored(event: CaloEvent, deletedAt: Date | null = null): StoredEvent {
  return {
    eventId: event.id,
    contentHash: contentHash(event),
    start: new Date(event.start),
    deletedAt,
  };
}

const TOMBSTONED = new Date("2026-09-20T00:00:00Z");

describe("diffEvents", () => {
  it("writes nothing when Canvas returns what's stored", () => {
    const events = [assignment(1, "2026-10-02T06:59:00Z"), assignment(2, "2026-10-09T06:59:00Z")];
    expect(diffEvents(events.map((e) => stored(e)), events, WINDOW, [])).toEqual({
      added: [],
      changed: [],
      deleted: [],
    });
  });

  it("adds new events and updates changed ones", () => {
    const before = assignment(1, "2026-10-02T06:59:00Z");
    const extended = { ...before, start: "2026-10-04T06:59:00Z" };
    const fresh = assignment(2, "2026-10-09T06:59:00Z");
    expect(diffEvents([stored(before)], [extended, fresh], WINDOW, [])).toEqual({
      added: [fresh],
      changed: [extended],
      deleted: [],
    });
  });

  it("tombstones a missing event only if it starts inside the window", () => {
    const rows = [
      assignment(1, "2026-10-02T06:59:00Z"),
      assignment(2, "2026-09-14T00:00:00Z"), // on the start edge
      assignment(3, "2026-12-25T00:00:00Z"), // on the end edge
      // Just outside: rolled out of range, not deleted.
      assignment(4, "2026-09-13T23:59:59Z"),
      assignment(5, "2026-12-25T00:00:01Z"),
    ].map((e) => stored(e));
    expect(diffEvents(rows, [], WINDOW, []).deleted).toEqual([
      "assignment-1",
      "assignment-2",
      "assignment-3",
    ]);
  });

  it("revives a tombstoned event that comes back", () => {
    const event = assignment(1, "2026-10-02T06:59:00Z");
    expect(diffEvents([stored(event, TOMBSTONED)], [event], WINDOW, [])).toEqual({
      added: [event],
      changed: [],
      deleted: [],
    });
  });

  it("leaves a tombstoned event that's still missing alone", () => {
    const event = assignment(1, "2026-10-02T06:59:00Z");
    expect(diffEvents([stored(event, TOMBSTONED)], [], WINDOW, []).deleted).toEqual([]);
  });

  it("doesn't tombstone an event the feed couldn't read", () => {
    const event = assignment(1, "2026-10-02T06:59:00Z");
    expect(diffEvents([stored(event)], [], WINDOW, ["assignment-1"]).deleted).toEqual([]);
  });
});

describe("contentHash", () => {
  it("doesn't depend on the order the object's keys were set in", () => {
    const event = assignment(1, "2026-10-02T06:59:00Z");
    const { id, ...rest } = event;
    expect(contentHash({ ...rest, id })).toBe(contentHash(event));
  });
});
