import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import JSZip from "jszip";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { syntheticStudyCommand } from "../fixtures/ortho-case-study";
import { authedGet, authedMutation, baseUrl, harness, type Session } from "./_server";

let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });

async function createStudy(patientId: number) {
  const caseId = (await db.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'completed','secadmin') RETURNING id", [patientId])).rows[0].id as number;
  await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic export grant',$2,'secadmin')", [patientId, caseId]);
  const route = `/api/ortho/${caseId}/case-study`;
  const recovery = await authedGet(`${route}/recovery?patientId=${patientId}`, h.sessions.admin);
  expect(recovery.status).toBe(200);
  const binding = await recovery.json();
  const command = syntheticStudyCommand();
  const marker = `SYNTHETIC-EXPORT-${randomUUID()}`;
  command.content.comment = marker;
  const scope = { patientId, clinicalCaseId: binding.scope.clinicalCaseId as number, actorId: binding.actorId as number };
  const response = await authedMutation(route, h.sessions.admin, "POST", JSON.stringify({ ...scope, command }));
  const saved = await response.json();
  expect(response.status, JSON.stringify(saved)).toBe(201);
  const revisionId = saved.revision.id as number;
  const receiptResponse = await authedGet(`${route}/recovery?patientId=${patientId}`, h.sessions.admin);
  expect(receiptResponse.status).toBe(200);
  const receipt = (await receiptResponse.json()).recovery;
  expect(receipt).toMatchObject({ state: "committed", identity: { commandId: command.clientRequestId } });
  const ack = await authedMutation(`${route}/recovery`, h.sessions.admin, "POST", JSON.stringify({ ...scope,
    commandId: command.clientRequestId, requestFingerprint: receipt.identity.requestFingerprint, action: "acknowledge" }));
  expect(ack.status).toBe(200);
  const query = `patientId=${patientId}&revisionId=${revisionId}`;
  return { caseId, revisionId, marker, read: `${route}?${query}`,
    outputs: [`${route}/text-pptx?${query}`, `${route}/illustrated-pptx?${query}`,
      `/print/ortho-study/${caseId}?${query}`, `/print/ortho-study/${caseId}?${query}&mode=illustrated`] };
}

async function rejectOutputs(study: Awaited<ReturnType<typeof createStudy>>, session: Session) {
  for (const url of study.outputs) {
    const response = await authedGet(url, session);
    const illustratedPrint = url.endsWith("&mode=illustrated");
    expect(response.status, url).toBe(url.startsWith("/api/") ? 403 : illustratedPrint ? 200 : 404);
    expect(response.headers.get("content-type")).not.toContain("presentationml");
    const body = await response.text();
    expect(body).not.toContain(study.marker);
    // Illustrated print intentionally renders its existing fail-closed error page.
    if (illustratedPrint) {
      expect(body).toContain("تعذر تجهيز الدراسة المصورة كاملة");
      expect(body).not.toContain('class="study-sheet');
      expect(body).not.toContain("data:image/png;base64,");
      expect(body).not.toContain("طباعة / حفظ PDF");
    }
  }
}

const money = async () => (await db.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM patient_opening_balances) opening")).rows;

it.each(["doctorA", "reception"] as const)("%s keeps saved-study access while four exports require a current grant", async role => {
  const username = role === "doctorA" ? "secdoctora" : "secreception";
  const original = (await db.query("SELECT permissions FROM users WHERE username=$1", [username])).rows[0].permissions as string | null;
  const base = original ? JSON.parse(original) as Record<string, unknown> : {};
  const grant = async (value: unknown) => db.query("UPDATE users SET permissions=$2 WHERE username=$1", [username, JSON.stringify({ ...base, canExportOrthoStudies: value })]);
  const study = await createStudy(h.seeded.patientAId), beforeMoney = await money();
  const beforeRevision = (await db.query("SELECT to_jsonb(r)::text value FROM ortho_case_study_revisions r WHERE id=$1", [study.revisionId])).rows;
  try {
    await grant(false);
    const saved = await authedGet(study.read, h.sessions[role]);
    expect(saved.status).toBe(200); expect(await saved.text()).toContain(study.marker);
    await rejectOutputs(study, h.sessions[role]);
    await grant("true");
    await rejectOutputs(study, h.sessions[role]);
    await grant(true);
    // The same already-issued cookie sees the current database grant.
    for (const url of study.outputs) {
      const response = await authedGet(url, h.sessions[role]);
      expect(response.status, url).toBe(200);
      if (url.startsWith("/api/")) {
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("content-type")).toContain("presentationml");
        const zip = await JSZip.loadAsync(await response.arrayBuffer());
        const slides = await Promise.all(Object.values(zip.files).filter(file => /^ppt\/slides\/slide\d+\.xml$/.test(file.name)).map(file => file.async("string")));
        expect(slides.join("\n")).toContain(study.marker);
      } else expect(await response.text()).toContain(study.marker);
    }
    await grant(false);
    await rejectOutputs(study, h.sessions[role]);
    const stillSaved = await authedGet(study.read, h.sessions[role]);
    expect(stillSaved.status).toBe(200); expect(await stillSaved.text()).toContain(study.marker);
    expect((await db.query("SELECT to_jsonb(r)::text value FROM ortho_case_study_revisions r WHERE id=$1", [study.revisionId])).rows).toEqual(beforeRevision);
    expect(await money()).toEqual(beforeMoney);
  } finally { await db.query("UPDATE users SET permissions=$2 WHERE username=$1", [username, original]); }
});

it("an export grant cannot open another doctor's patient", async () => {
  const original = (await db.query("SELECT permissions FROM users WHERE username='secdoctora'")).rows[0].permissions as string;
  const study = await createStudy(h.seeded.patientBId);
  try {
    await db.query("UPDATE users SET permissions=$1 WHERE username='secdoctora'", [JSON.stringify({ ...JSON.parse(original), canExportOrthoStudies: true })]);
    await rejectOutputs(study, h.sessions.doctorA);
    const admin = await authedGet(study.outputs[0], h.sessions.admin);
    expect(admin.status).toBe(200);
    expect(admin.headers.get("content-type")).toContain("presentationml");
  } finally { await db.query("UPDATE users SET permissions=$1 WHERE username='secdoctora'", [original]); }
});

it.each(["doctorA", "reception"] as const)("the settings API persists the %s grant only for an administrator", async role => {
  const username = role === "doctorA" ? "secdoctora" : "secreception";
  const user = (await db.query("SELECT id,permissions FROM users WHERE username=$1", [username])).rows[0] as { id: number; permissions: string | null };
  const base = user.permissions ? JSON.parse(user.permissions) as Record<string, unknown> : {};
  try {
    await db.query("UPDATE users SET permissions=$2 WHERE id=$1", [user.id, JSON.stringify({ ...base, canExportOrthoStudies: false })]);
    const unauthorized = await authedMutation(`/api/users/${user.id}`, h.sessions[role], "PATCH", JSON.stringify({ permissions: { ...base, canExportOrthoStudies: true } }));
    expect(unauthorized.status).toBe(403);
    expect(JSON.parse((await db.query("SELECT permissions FROM users WHERE id=$1", [user.id])).rows[0].permissions).canExportOrthoStudies).toBe(false);
    for (const value of [true, false]) {
      const changed = await authedMutation(`/api/users/${user.id}`, h.sessions.admin, "PATCH", JSON.stringify({ permissions: { ...base, canExportOrthoStudies: value } }));
      expect(changed.status).toBe(200);
      expect((await changed.json()).permissions.canExportOrthoStudies).toBe(value);
      const read = await authedGet("/api/users", h.sessions.admin);
      expect(read.status).toBe(200);
      const users = await read.json() as { id: number; permissions: { canExportOrthoStudies?: boolean } }[];
      expect(users.find(row => row.id === user.id)?.permissions.canExportOrthoStudies).toBe(value);
    }
  } finally { await db.query("UPDATE users SET permissions=$2 WHERE id=$1", [user.id, user.permissions]); }
});

it.each([390, 1280])("shows current export controls on the saved case only after a grant at %ipx", async width => {
  const original = (await db.query("SELECT permissions FROM users WHERE username='secdoctora'")).rows[0].permissions as string;
  const study = await createStudy(h.seeded.patientAId);
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
  const [name, ...cookie] = h.sessions.doctorA.cookie.split("=");
  await context.addCookies([{ name, value: cookie.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [];
  await context.route("**/*", route => {
    const request = route.request();
    if (new URL(request.url()).origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      unexpected.push(`${request.method()} ${new URL(request.url()).pathname}`); return route.abort();
    }
    return route.continue();
  });
  const labels = ["طباعة النسخة المحفوظة / PDF نصي", "PowerPoint نصي قابل للتحرير", "PowerPoint مصور قابل للتحرير", "معاينة الدراسة المصورة / PDF"];
  try {
    const setGrant = (value: boolean) => db.query("UPDATE users SET permissions=$1 WHERE username='secdoctora'", [JSON.stringify({ ...JSON.parse(original), canExportOrthoStudies: value })]);
    await setGrant(false);
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=treatment&sub=ortho&patientId=${h.seeded.patientAId}&orthoCaseId=${study.caseId}`);
    await page.getByRole("button", { name: "دراسة الحالة المحفوظة" }).click();
    const denied = page.getByRole("status").filter({ hasText: "التصدير يحتاج صلاحية مستقلة" });
    await denied.waitFor({ timeout: 20000 }).catch(async error => {
      console.error("Synthetic export UI diagnostic", JSON.stringify({ url: page.url(), text: (await page.locator("body").innerText()).slice(-14000), errors, unexpected }));
      throw error;
    });
    for (const label of labels) expect(await page.getByRole("link", { name: label, exact: true }).count()).toBe(0);
    await setGrant(true); await page.reload();
    await page.getByRole("button", { name: "دراسة الحالة المحفوظة" }).click();
    for (const label of labels) {
      const link = page.getByRole("link", { name: label, exact: true }); await link.waitFor();
      const target = new URL((await link.getAttribute("href"))!, baseUrl);
      expect(target.searchParams.get("patientId")).toBe(String(h.seeded.patientAId));
      expect(target.searchParams.get("revisionId")).toBe(String(study.revisionId));
      expect(target.pathname).toContain(`/${study.caseId}`);
    }
    const controls = page.getByRole("link", { name: labels[1], exact: true }).locator("..");
    await controls.scrollIntoViewIfNeeded();
    expect(await controls.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await controls.screenshot({ path: `.settings-ui-artifacts/ortho-study-export-grant-${width}.png` });
    await setGrant(false); await page.reload();
    await page.getByRole("button", { name: "دراسة الحالة المحفوظة" }).click();
    await denied.waitFor({ timeout: 20000 });
    for (const label of labels) expect(await page.getByRole("link", { name: label, exact: true }).count()).toBe(0);
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  } finally {
    await context.close();
    await db.query("UPDATE users SET permissions=$1 WHERE username='secdoctora'", [original]);
  }
});
