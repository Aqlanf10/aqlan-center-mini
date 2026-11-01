import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness, type Session } from "./_server";

// Hosted isolated harness only: no browser, screenshots, real portraits or session exports.
const ASSET = "clinic.login_photo_asset";
const VISIBLE = "clinic.login_photo_visible";
const KEYS = [ASSET, VISIBLE];
const PRIVATE = "/api/settings/login-photo";
const PUBLIC = "/api/branding/login-photo";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
type Versions = Record<string, string | null>;
type Snapshot = { __versions: Versions } & Record<string, unknown>;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => { h = await harness(); }, 240_000);

function upload(session: Session | null, versions: Versions, svg = false) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(svg ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') : PNG)],
    svg ? "synthetic.svg" : "synthetic.png", { type: svg ? "image/svg+xml" : "image/png" }));
  form.set("__versions", JSON.stringify(versions));
  return fetch(`${baseUrl}${PRIVATE}`, { method: "POST", redirect: "manual", body: form,
    headers: { Origin: baseUrl, "Sec-Fetch-Site": "same-origin", ...(session ? { Cookie: session.cookie } : {}) } });
}
const toggle = (visible: boolean, versions: Versions, session = h.sessions.admin) =>
  authedMutation(PRIVATE, session, "PATCH", JSON.stringify({ visible, __versions: versions }));
async function hidden() {
  const response = await fetch(`${baseUrl}${PUBLIC}`, { redirect: "manual" });
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("owner-controlled login photo over actual isolated HTTP", () => {
  it("enforces authorization, explicit publication, version conflicts and private hiding", async () => {
    // Refuse all fixture mutation unless this is precisely the harness's disposable local DB.
    const url = new URL(h.seeded.dbUrl);
    expect(["postgres:", "postgresql:"]).toContain(url.protocol);
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
    expect(url.pathname).toBe("/aqlan_sec_http");
    const db = new Client({ host: url.hostname === "[::1]" ? "::1" : url.hostname,
      port: Number(url.port || "5432"), database: "aqlan_sec_http", ssl: false,
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) });
    await db.connect();
    const { rows: saved } = await db.query("SELECT key,value,updated_at FROM settings WHERE key=ANY($1::text[])", [KEYS]);
    try {
      await db.query("DELETE FROM settings WHERE key=ANY($1::text[])", [KEYS]);
      const initial: Versions = { [ASSET]: null, [VISIBLE]: null };
      expect((await fetch(`${baseUrl}${PRIVATE}`, { redirect: "manual" })).status).toBe(401);
      expect((await upload(null, initial)).status).toBe(401);
      expect((await fetch(`${baseUrl}${PRIVATE}`, { method: "PATCH", headers: { Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ visible: true, __versions: initial }) })).status).toBe(401);
      expect((await authedGet(PRIVATE, h.sessions.reception)).status).toBe(403);
      expect((await upload(h.sessions.reception, initial)).status).toBe(403);
      expect((await toggle(true, initial, h.sessions.reception)).status).toBe(403);
      expect((await authedGet(PRIVATE, h.sessions.admin)).status).toBe(404);
      await hidden();
      expect((await upload(h.sessions.admin, initial, true)).status).toBe(400);
      expect((await toggle(true, { [ASSET]: null })).status).toBe(409);

      const uploaded = await upload(h.sessions.admin, initial);
      expect(uploaded.status).toBe(200);
      const first = await uploaded.json() as Snapshot;
      expect(first[VISIBLE]).toBe("false");
      expect(first.__versions[ASSET]).toBeTruthy();
      expect(first.__versions[VISIBLE]).toBeTruthy();
      await hidden();
      const preview = await authedGet(PRIVATE, h.sessions.admin);
      expect(preview.status).toBe(200);
      expect(Buffer.from(await preview.arrayBuffer()).equals(PNG)).toBe(true);
      expect((await toggle(true, initial)).status).toBe(409);
      await hidden();

      const shown = await toggle(true, first.__versions);
      expect(shown.status).toBe(200);
      const second = await shown.json() as Snapshot;
      const published = await fetch(`${baseUrl}${PUBLIC}`, { redirect: "manual" });
      expect(published.status).toBe(200);
      expect(published.headers.get("content-type")).toBe("image/png");
      expect(published.headers.get("cache-control")).toContain("no-store");
      expect(published.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await published.arrayBuffer()).equals(PNG)).toBe(true);
      expect((await toggle(false, first.__versions)).status).toBe(409);
      const concealed = await toggle(false, second.__versions);
      expect(concealed.status).toBe(200);
      const third = await concealed.json() as Snapshot;
      expect(third[ASSET]).toBe(first[ASSET]); // Hiding preserves the configured original.
      await hidden();
      expect((await authedGet(PRIVATE, h.sessions.admin)).status).toBe(200);
    } finally {
      // Restore only these two fixture rows. Immutable synthetic bytes belong to the
      // global harness temporary storage lifecycle; never delete shared file keys here.
      try {
        await db.query("DELETE FROM settings WHERE key=ANY($1::text[])", [KEYS]);
        for (const row of saved) await db.query("INSERT INTO settings(key,value,updated_at) VALUES($1,$2,$3)",
          [row.key, row.value, row.updated_at]);
      } finally { await db.end(); }
    }
  }, 60_000);
});
