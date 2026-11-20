import { createHash, randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { chromium, expect as browserExpect } from "playwright/test";
import { expect, it, vi } from "vitest";
import * as db from "../../lib/db";
import { parseCsv } from "../../lib/patient-import";
import { withPatientNumberingInsertScope, type PatientNumberingQueryClient } from "../../lib/patient-numbering-insert-scope";
import { admitNumberingRecovery } from "../../lib/patient-numbering-recovery";
import { validateLocalVerificationTarget } from "../../lib/verification-target-policy.mjs";
import { validatePostgresTestTarget } from "../postgres/_safe-target";
import { NumberingPgFixture } from "../postgres/fixtures/patient-numbering-adapter";
import { bootstrapLegacyFixture, prepareLegacyFixture } from "../postgres/fixtures/patient-numbering-bootstrap";
import { startNumberingBrowserFixture } from "../fixtures/numbering-browser/server";

const input = (label: string) => ({
  fullName: "SYNTHETIC NUMBERING " + label, phone: null, altPhone: null,
  gender: "unknown" as const, birthYear: null, address: null, medicalAlert: null, note: null,
});
const lineage = "ba3f640b-1234-4b62-9c16-d9f49f5c8d19";
const target = validatePostgresTestTarget(process.env);
async function runProof(mode: "browser" | "http") {
  const name = "aqlan_numbering_browser_" + randomUUID().replaceAll("-", "");
  const url = new URL(target.testUrl);
  url.pathname = "/" + name;
  validateLocalVerificationTarget(url.toString(), process.env, { varName: "SYNTHETIC_NUMBERING_BROWSER", databaseName: name });
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  const identitySql = "SELECT oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1";
  let owned: { oid: string; owner: string } | undefined;
  let server: Awaited<ReturnType<typeof startNumberingBrowserFixture>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const failures: unknown[] = [];
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    owned = (await admin.query<{ oid: string; owner: string }>(identitySql, [name])).rows[0];
    if (!owned) throw new Error("Browser fixture ownership is unproven");

    await db.resetPoolForTesting();
    vi.stubEnv("DATABASE_URL", url.toString());
    vi.stubEnv("SKIP_SEED", "true");
    const pool = db.getPool() as unknown as Pool;
    const current = await pool.query(
      "SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()",
    );
    expect(current.rows).toEqual([{ name, ...owned }]);
    await db.ensureSchema();
    const legacy = await db.createPatient(input("HISTORICAL"));
    expect(legacy.patientNumber).toBe("P-07000");

    const fixture = new NumberingPgFixture(pool, "numbering_fixture_" + randomUUID().replaceAll("-", ""), async () => null);
    await fixture.initialize();
    const legacyCounter = await pool.query<{ last_value: string; is_called: boolean }>(
      "SELECT last_value::text, is_called FROM public.patient_number_seq",
    );
    await prepareLegacyFixture(fixture, legacyCounter.rows[0].last_value, legacyCounter.rows[0].is_called, [legacy.patientNumber]);
    await bootstrapLegacyFixture(fixture);
    await pool.query(`CREATE TABLE ${fixture.schema}.retired_aliases (number text PRIMARY KEY, patient_id bigint NOT NULL)`);

    const allocate = async (client: PatientNumberingQueryClient) => {
      if ((await client.query("SELECT current_database() AS name")).rows[0]?.name !== name) {
        throw new Error("Synthetic transaction has unexpected target");
      }
      return fixture.allocateInExistingTransaction(client);
    };
    const scoped = <T>(work: () => Promise<T>) => withPatientNumberingInsertScope(allocate, work);
    const older = await fixture.exportRecoverySidecar(lineage);
    server = await startNumberingBrowserFixture({
      pool, schema: fixture.schema, databaseName: name,
      ordinary: async () => (await db.createPatient(input("BROWSER"))).patientNumber,
    });

    const origin = server.origin;
    if (mode === "browser") {
      browser = await chromium.launch({ executablePath: process.env.NUMBERING_BROWSER_CHROMIUM ?? "/usr/bin/chromium", chromiumSandbox: true });
      const context = await browser.newContext({ extraHTTPHeaders: { "x-synthetic-numbering-token": server.ownerToken } });
      await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage();
      await page.goto(origin);
      await browserExpect(page.getByRole("heading", { name: "ترقيم ملفات المرضى" })).toBeVisible();
      await page.getByLabel("حرف السلسلة").selectOption("A");
      await page.getByLabel("رقم البداية / الرقم التالي").fill("١٥٠٠");
      await page.getByLabel("سبب التغيير").fill("Synthetic browser configuration");
      const previewResponse = page.waitForResponse(r => r.url().endsWith("/test/preview"));
      await page.getByRole("button", { name: "فحص المعاينة" }).click();
      const preview = await (await previewResponse).json();
      expect(preview).toMatchObject({ ok: true, ticket: { prefix: "A", next: "1500", preview: "A-01500" } });
      await page.getByLabel("أؤكد حرف السلسلة ورقم البداية وسبب التغيير في هذه المعاينة.").check();

      const saveResponse = page.waitForResponse(r => r.url().endsWith("/test/save"));
      await page.getByRole("button", { name: "حفظ القيم المعاينة" }).click();
      const first = await saveResponse;
      expect(await first.json()).toMatchObject({ ok: true, replay: false, value: { preview: "A-01500" } });
      await browserExpect(page.getByText("أكد المصدر نجاح طلب الحفظ لهذه المعاينة.", { exact: false })).toBeVisible();
      const exact = first.request().postDataJSON();
      const replay = await context.request.post(origin + "/test/save", { data: exact, headers: { origin } });
      expect(await replay.json()).toMatchObject({ ok: true, replay: true, value: { preview: "A-01500" } });
      const ordinaryAdmin = await browser.newContext({ extraHTTPHeaders: { "x-synthetic-numbering-token": server.adminToken } });
      const denied = await ordinaryAdmin.request.post(origin + "/test/save", { data: exact, headers: { origin } });
      expect(denied.status()).toBe(403);
      expect(await denied.json()).toEqual({ ok: false, reason: "owner-required" });
      await ordinaryAdmin.close();
      await page.getByRole("button", { name: "تسجيل مريض اصطناعي" }).click();
      await browserExpect(page.getByText("A-01500", { exact: true }).last()).toBeVisible();
      await context.close();
    } else {
      const call = (path: string, token: string, body: unknown) => fetch(origin + "/test/" + path, {
        method: "POST", headers: { "content-type": "application/json", origin, "x-synthetic-numbering-token": token },
        body: JSON.stringify(body),
      });
      expect(await (await call("read", server.ownerToken, {})).json()).toMatchObject({
        ok: true, current: { prefix: "P", next: "7001" },
      });
      const { ticket } = await (await call("preview", server.ownerToken, {
        prefix: "A", next: "1500", reason: "Synthetic HTTP configuration",
      })).json();
      expect(ticket).toMatchObject({ prefix: "A", next: "1500", preview: "A-01500" });
      const { preview: _preview, ...exact } = ticket;
      const first = await call("save", server.ownerToken, exact);
      expect(await first.json()).toMatchObject({ ok: true, replay: false, value: { preview: "A-01500" } });
      const retry = await call("save", server.ownerToken, exact);
      expect(await retry.json()).toMatchObject({ ok: true, replay: true, value: { preview: "A-01500" } });
      const denied = await call("save", server.adminToken, exact);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ ok: false, reason: "owner-required" });
      expect(await (await call("ordinary", server.ownerToken, {})).json()).toEqual({ ok: true, number: "A-01500" });
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${fixture.schema}.audit`)).rows).toEqual([{ n: 1 }]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${fixture.schema}.receipts`)).rows).toEqual([{ n: 1 }]);

    expect((await pool.query("SELECT patient_number FROM patients WHERE full_name=$1", [input("BROWSER").fullName])).rows)
      .toEqual([{ patient_number: "A-01500" }]);

    const visit = await db.addVisit({ patientName: "SYNTHETIC NUMBERING WALK IN", patientPhone: null, note: null });
    const booking = await db.createBookingRequest({
      fullName: "SYNTHETIC NUMBERING BOOKING", phone: "999900001", reason: null,
      preferredDate: null, preferredPeriod: "any",
    }, "synthetic-numbering-browser");
    const csv = "الاسم,الهاتف,رقم الملف\nSYNTHETIC NUMBERING IMPORT,,900000";
    const bookingInput = { id: booking.id, date: "2026-11-19", time: "12:00", durationMinutes: 30 };
    const importInput = {
      rows: parseCsv(csv), fileSha256: createHash("sha256").update(csv).digest("hex"),
      fileName: "synthetic-numbering.csv", today: "2026-11-19", includePossibleDuplicates: false,
      actor: "Synthetic fixture", actorRole: "admin",
    };
    const [walked, booked, imported] = await Promise.all([
      scoped(() => db.openVisitPatientFile(visit.id)),
      scoped(() => db.confirmBookingRequest(bookingInput)),
      scoped(() => db.commitPatientImport(importInput)),
    ]);
    if (!walked.ok || !booked || !imported.ok) throw new Error("Synthetic real allocator path failed");
    expect(walked.created).toBe(true);
    const opened = await scoped(() => db.openVisitPatientFile(visit.id));
    expect(opened).toMatchObject({ ok: true, created: false, patientId: walked.patientId });
    expect(await scoped(() => db.confirmBookingRequest(bookingInput))).toBeNull();
    expect(await scoped(() => db.commitPatientImport(importInput))).toMatchObject({ ok: false, reason: "already_imported" });
    const numbers = [
      (await db.getPatient(walked.patientId))?.patientNumber,
      (await db.getPatient(booked.patientId))?.patientNumber,
      imported.created[0]?.patientNumber,
    ].sort();
    expect(numbers).toEqual(["A-01501", "A-01502", "A-01503"]);
    expect((await db.getPatient(legacy.id))?.patientNumber).toBe("P-07000");
    expect((await pool.query("SELECT last_value::text, is_called FROM public.patient_number_seq")).rows).toEqual(legacyCounter.rows);

    const latest = await fixture.exportRecoverySidecar(lineage);
    const witness = { expectedLineage: lineage, readCurrent: async () => ({
      version: 1 as const, lineage, stateSha256: latest.manifest.sha256,
    }) };
    expect(await admitNumberingRecovery(older.bytes, older.manifest, witness))
      .toEqual({ ok: false, reason: "freshness-mismatch" });
    expect(await admitNumberingRecovery(latest.bytes, latest.manifest, witness)).toMatchObject({ ok: true });
    expect(await admitNumberingRecovery(latest.bytes, latest.manifest, null))
      .toEqual({ ok: false, reason: "trusted-witness-unavailable" });
    // The product has no installation. Outside the synthetic request scope,
    // ordinary creation uses the exactly unchanged legacy path.
    expect((await db.createPatient(input("AFTER SCOPE"))).patientNumber).toBe("P-07001");
  } catch (error) { failures.push(error); }
  finally {
    try { await browser?.close(); } catch (error) { failures.push(error); }
    try { await server?.close(); } catch (error) { failures.push(error); }
    try { await db.resetPoolForTesting(); } catch (error) { failures.push(error); }
    vi.unstubAllEnvs();
    if (owned) {
      try {
        const current = (await admin.query(identitySql, [name])).rows[0];
        if (JSON.stringify(current) === JSON.stringify(owned)) await admin.query(`DROP DATABASE "${name}"`);
        else failures.push(new Error("Owned browser database identity changed; cleanup refused"));
      } catch (error) { failures.push(error); }
    }
    try { await admin.end(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Owned browser numbering integration or cleanup failed");
}
it("owns A + 1500 in the actual Playwright UI and all real allocation paths", () => runProof("browser"));
it("separately exercises real HTTP, the controller, and all real PG allocation paths", () => runProof("http"));
