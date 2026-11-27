/** Owner decision #483 6888146935: what the owner pays from their own money is owed to the owner (account 2108),
 * changeable in the settings by the owner only. The legacy runtime cannot prove the owner, so a legacy session
 * (the admin included) may neither change nor reset this treatment; nothing is written. Built server, shared
 * synthetic database. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

const KEY = "finance.owner_private_funding_account";
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
const stored = async () => (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [KEY])).rows[0]?.value ?? null;
const audits = async () => Number((await db.query("SELECT count(*) AS n FROM audit_log WHERE entity = 'clinic_setting' AND entity_id = $1", [KEY])).rows[0].n);

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 240_000);
afterAll(async () => { await db?.end(); });

describe("the owner-funding treatment on the legacy runtime", () => {
  it("shows the owner's decision as the default", async () => {
    const settings = await (await authedGet("/api/settings", h.sessions.admin)).json();
    expect(settings[KEY]).toBe("2108");
  });

  it("refuses a legacy change or reset, even by the admin, and writes nothing", async () => {
    const before = await stored(), auditBefore = await audits();
    const current = await (await authedGet("/api/settings", h.sessions.admin)).json() as { __versions?: Record<string, unknown> };
    const patch = await authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({
      [KEY]: "3101", __versions: { [KEY]: current.__versions?.[KEY] ?? null }, __reason: "محاولة من جلسة قديمة",
    }));
    expect(patch.status).toBe(403);
    expect((await patch.json()).message).toMatch(/المالك/);
    const reset = await authedMutation("/api/settings", h.sessions.admin, "POST", JSON.stringify({
      action: "reset", keys: [KEY], __versions: { [KEY]: current.__versions?.[KEY] ?? null }, reason: "محاولة إعادة",
    }));
    expect(reset.status).toBe(403);
    expect(await stored()).toBe(before);
    expect(await audits()).toBe(auditBefore);
  });

  it("still lets the admin save other finance settings", async () => {
    const current = await (await authedGet("/api/settings", h.sessions.admin)).json() as { __versions?: Record<string, unknown>; "finance.locked_before"?: string };
    const response = await authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({
      "finance.locked_before": current["finance.locked_before"] ?? "", __versions: { "finance.locked_before": current.__versions?.["finance.locked_before"] ?? null },
      __reason: "حفظ إعداد مالي آخر",
    }));
    expect(response.status).not.toBe(403);
  });
});
