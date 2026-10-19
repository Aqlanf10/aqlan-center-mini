import { describe, expect, it } from "vitest";
import { postgresDateOnly } from "../lib/postgres-date-only";

describe("PostgreSQL DATE preserves civil calendar fields", () => {
  it.each(["UTC", "Asia/Aden", "Asia/Kathmandu", "Pacific/Kiritimati", "America/New_York", "Europe/Berlin"])(
    "retains dates in the database driver's local representation: %s", (zone) => {
      const previous = process.env.TZ;
      try {
        process.env.TZ = zone;
        for (const [year, month, day] of [[2026, 0, 1], [2026, 10, 1], [2026, 10, 5], [2028, 1, 29], [2026, 2, 8], [2026, 2, 29]]) {
          const expected = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          expect(postgresDateOnly(new Date(year, month, day))).toBe(expected);
          expect(postgresDateOnly(expected)).toBe(expected);
        }
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    },
  );

  it.each([null, undefined, 0, {}, new Date(NaN), "2026-02-29", "2026-04-31", "2026-13-01", "2026-01-00", "2026-1-1", "2026-01-01T00:00:00Z"])(
    "refuses malformed values rather than moving a civil day: %s", (value) => {
      expect(() => postgresDateOnly(value)).toThrow("Invalid PostgreSQL calendar date");
    },
  );
});
