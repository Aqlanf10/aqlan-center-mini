import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../lib/auth";
import { authedGet, baseUrl, harness, loginStaff } from "./_server";

// Pure fetch against the real built app/proxy and isolated harness database.
// No browser, schema installation, clinical payload or production connection.
const path = "/api/lab/work-intents/capability";
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let assistant: Awaited<ReturnType<typeof loginStaff>>;
let revoked: Awaited<ReturnType<typeof loginStaff>>;
let expectedSupported: boolean;
let proposalMarker: string | null;

beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(target.hostname).toBe("127.0.0.1");
  expect(target.pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  proposalMarker = (await db.query<{ name: string | null }>("SELECT to_regclass('public.lab_work_intent_schema')::text AS name")).rows[0].name;
  const versions = proposalMarker ? (await db.query<{ version: number }>("SELECT version FROM lab_work_intent_schema WHERE singleton=TRUE")).rows : [];
  expectedSupported = versions.length === 1 && versions[0].version === 1;
  const password = "SyntheticCapability#Pass1";
  const hash = await hashPassword(password);
  const prefix = `capability-${randomUUID()}`;
  for (const [suffix, role] of [["assistant", "assistant"], ["revoked", "doctor"]]) {
    const username = `${prefix}-${suffix}`;
    await db.query("INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, 'Synthetic capability actor', $2, $3)", [username, hash, role]);
    const session = await loginStaff(username, password);
    if (suffix === "assistant") assistant = session;
    else {
      revoked = session;
      // Revoke only our new synthetic account; never alter shared seeded users.
      await db.query("UPDATE users SET is_active = FALSE WHERE username = $1", [username]);
    }
  }
}, 240_000);
afterAll(async () => { await db?.end(); });

async function assertDenial(response: Response, status: number, reachesHandler = false) {
  expect(response.status).toBe(status);
  const body = await response.json() as Record<string, unknown>;
  expect(body.message).toEqual(expect.stringMatching(/[\u0600-\u06ff]/));
  expect(Object.keys(body).every(key => key === "message" || key === "supported")).toBe(true);
  if (reachesHandler) {
    expect(body.supported).toBe(false);
    expect(response.headers.get("cache-control")).toContain("no-store");
  } else if ("supported" in body) expect(body.supported).toBe(false);
}

describe("lab work capability role contract through HTTP", () => {
  it.each(["admin", "doctorA", "doctorB"] as const)("%s reads only the installed proposal boolean", async role => {
    const response = await authedGet(path, h.sessions[role]);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ supported: expectedSupported });
    expect((await db.query("SELECT to_regclass('public.lab_work_intent_schema')::text AS name")).rows[0].name).toBe(proposalMarker);
  });
  it("reception is explicitly denied, not a successful disabled capability", async () => {
    await assertDenial(await authedGet(path, h.sessions.reception), 403, true);
  });
  it("an active assistant remains denied by the real proxy", async () => {
    await assertDenial(await authedGet(path, assistant), 403);
  });
  it.each(["cashier", "accountant"] as const)("%s remains denied by the real proxy", async role => {
    await assertDenial(await authedGet(path, h.sessions[role]), 403);
  });
  it("a revoked staff session is unauthorized, not a 200 capability response", async () => {
    await assertDenial(await authedGet(path, revoked), 401, true);
  });
  it("anonymous and portal sessions do not authenticate as staff", async () => {
    await assertDenial(await fetch(`${baseUrl}${path}`, { redirect: "manual" }), 401);
    await assertDenial(await authedGet(path, h.sessions.portalA), 401);
  });
});
