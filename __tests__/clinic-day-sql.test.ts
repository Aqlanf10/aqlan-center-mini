import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clinicTodaySql, onClinicDaySql, onClinicDaysSql } from "@/lib/clinic-day-sql";

describe("clinic-day SQL (index-friendly day ranges)", () => {
  it("a day is [midnight, next midnight) in the clinic zone, on the raw column", () => {
    expect(onClinicDaySql("arrived_at", "$1", "$2::date")).toBe(
      "arrived_at >= (($2::date)::timestamp AT TIME ZONE $1) AND arrived_at < ((($2::date) + 1)::timestamp AT TIME ZONE $1)",
    );
    expect(onClinicDaysSql("v.arrived_at", "$1", "$2::date", "$3::date")).toContain("(($3::date) + 1)::timestamp");
    expect(clinicTodaySql("$3")).toBe("(NOW() AT TIME ZONE $3)::date");
  });

  it("guard: the polled visit paths in lib/db.ts no longer cast arrived_at per row in WHERE", () => {
    const source = readFileSync(path.resolve(__dirname, "../lib/db.ts"), "utf8");
    expect(source).not.toMatch(/WHERE \(arrived_at AT TIME ZONE \$1\)::date/);
    expect(source).not.toMatch(/AND \(busy\.arrived_at AT TIME ZONE \$3\)::date/);
  });
});
