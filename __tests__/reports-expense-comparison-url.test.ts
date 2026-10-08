import { describe, expect, it } from "vitest";
import { assertLocalExpenseComparisonUrl } from "./postgres/_expense-comparison-fixture-url";

// No pg/application import, environment lookup, database creation, or connection.
describe("expense comparison fixture URL guard", () => {
  it.each([
    "postgresql://ci@127.0.0.1:5432/aqlan_p1_test?sslmode=disable",
    "postgres://ci@localhost/aqlan_p1_test",
    "postgresql://ci@[::1]:5432/aqlan_p1_test",
  ])("accepts an explicit local PostgreSQL authority unchanged: %s", (url) => {
    expect(assertLocalExpenseComparisonUrl(url)).toBe(url);
  });

  it.each([
    "postgresql://ci@remote.example/aqlan_p1_test",
    "postgresql://ci@localhost/aqlan_p1_test?host=remote.example",
    "postgresql://ci@localhost/aqlan_p1_test?%68ost=remote.example",
    "postgresql://ci@localhost/aqlan_p1_test?sslmode=disable&host=remote.example",
    "postgresql://ci@localhost/aqlan_p1_test?host=%2Fvar%2Frun%2Fpostgresql",
    "postgresql://ci@localhost/aqlan_p1_test?hostaddr=203.0.113.1",
    "postgresql://ci@localhost/aqlan_p1_test?port=6432",
    "postgresql://ci@localhost/aqlan_p1_test?service=production",
    "postgresql://ci@localhost/aqlan_p1_test?options=-csearch_path%3Dpublic",
    "socket:/var/run/postgresql?db=aqlan_p1_test",
    "https://localhost/aqlan_p1_test",
    "not-a-postgres-url",
  ])("rejects remote or unsupported routing before any connection: %s", (url) => {
    expect(() => assertLocalExpenseComparisonUrl(url)).toThrow(/explicitly local PostgreSQL/);
  });

  it("does not expose malformed connection input or a parser error cause", () => {
    try {
      assertLocalExpenseComparisonUrl("postgresql://synthetic:never-print-fixture-secret@[");
      expect.unreachable("The malformed URL must be rejected.");
    } catch (error) {
      expect(error).toMatchObject({
        message: "Expense comparison fixtures require an explicitly local PostgreSQL test target.",
      });
      expect(String(error)).not.toContain("never-print-fixture-secret");
      expect(error).not.toHaveProperty("input");
      expect(error).not.toHaveProperty("cause");
    }
  });
});
