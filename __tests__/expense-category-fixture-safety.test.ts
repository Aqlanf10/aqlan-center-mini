import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { prepareExpenseCategoryHistoryFixture } from "./postgres/_expense-category-fixture";

const boundary = vi.hoisted(() => ({
  construct: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn(), reset: vi.fn(),
}));
vi.mock("pg", () => ({
  Client: class {
    constructor(options: unknown) { boundary.construct(options); }
    connect = boundary.connect;
    query = boundary.query;
    end = boundary.end;
  },
}));
vi.mock("./postgres/_setup", () => ({ dropPublicSchema: boundary.reset }));
const target = "postgresql://synthetic@127.0.0.1:54329/aqlan_p1_test?sslmode=disable";
const safe = (): NodeJS.ProcessEnv => ({ NODE_ENV: "test", DATABASE_ENVIRONMENT: "test", TEST_DATABASE_URL: target });
beforeEach(() => { vi.clearAllMocks(); boundary.query.mockResolvedValue({ rows: [{ n: 0 }] }); });

describe("expense-category containment fixture safety", () => {
  it("allows the default proof on a fresh canonical target without resetting", async () => {
    await prepareExpenseCategoryHistoryFixture(safe());
    expect(boundary.reset).not.toHaveBeenCalled();
    expect(boundary.construct).toHaveBeenCalledExactlyOnceWith({ connectionString: target, ssl: false });
    expect(boundary.end).toHaveBeenCalledOnce();
  });

  it.each([undefined, "", "0", "true"])("refuses a nonempty schema without exact opt-in %j", async (optIn) => {
    boundary.query.mockResolvedValue({ rows: [{ n: 123 }] });
    await expect(prepareExpenseCategoryHistoryFixture({ ...safe(), CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE: optIn })).rejects.toThrow("NEW empty");
    expect(boundary.reset).not.toHaveBeenCalled();
    expect(boundary.query).toHaveBeenCalledExactlyOnceWith("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'");
    expect(boundary.end).toHaveBeenCalledOnce();
  });

  it("uses the standard disposable fixture only with an exact explicit opt-in", async () => {
    await prepareExpenseCategoryHistoryFixture({ ...safe(), CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE: "1" });
    expect(boundary.reset).toHaveBeenCalledExactlyOnceWith(target);
    expect(boundary.reset.mock.invocationCallOrder[0]).toBeLessThan(boundary.construct.mock.invocationCallOrder[0]);
  });

  it.each([
    { NODE_ENV: "production" }, { DATABASE_ENVIRONMENT: "production" }, { RAILWAY_PROJECT_ID: "synthetic" },
    { TEST_DATABASE_URL: "postgresql://synthetic@remote.invalid/aqlan_p1_test" },
    { TEST_DATABASE_URL: "postgresql://synthetic@127.0.0.1:54329/aqlan_center_mini_v2" },
    { TEST_DATABASE_URL: `${target}&hostaddr=203.0.113.1` },
  ] as const)("rejects the ORIGINAL unsafe classification/target even with fixture opt-in %j", async (unsafe) => {
    await expect(prepareExpenseCategoryHistoryFixture({ ...safe(), ...unsafe, CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE: "1" })).rejects.toThrow();
    expect(boundary.reset).not.toHaveBeenCalled(); expect(boundary.construct).not.toHaveBeenCalled();
  });

  it("standalone runner clears any inherited disposable-fixture opt-in", () => {
    const runner = readFileSync(new URL("../scripts/audits/expense-category-history-proof.sh", import.meta.url), "utf8");
    expect(runner).toContain("unset CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE");
    expect(runner.indexOf("unset CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE")).toBeLessThan(runner.indexOf('"$NODE_BIN" node_modules/vitest/vitest.mjs'));
  });
});
