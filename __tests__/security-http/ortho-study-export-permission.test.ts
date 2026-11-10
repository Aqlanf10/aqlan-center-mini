import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import JSZip from "jszip";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { syntheticStudyCommand } from "../fixtures/ortho-case-study";
import { authedGet, authedMutation, baseUrl, harness, loginStaff, TEST_USERS, type Session } from "./_server";

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
  return { caseId, revisionId, capturedAt: saved.revision.content.capturedAt as string, marker, read: `${route}?${query}`,
    outputs: [`${route}/text-pptx?${query}`, `${route}/illustrated-pptx?${query}`,
      `/print/ortho-study/${caseId}?${query}`, `/print/ortho-study/${caseId}?${query}&mode=illustrated`,
      `/print/ortho-study/${caseId}?${query}&mode=full`] };
}

async function rejectOutputs(study: Awaited<ReturnType<typeof createStudy>>, session: Pick<Session, "cookie">) {
  for (const url of study.outputs) {
    const response = await authedGet(url, session);
    const illustratedPrint = url.endsWith("&mode=illustrated") || url.endsWith("&mode=full");
    expect(response.status, url).toBe(url.startsWith("/api/") ? 403 : illustratedPrint ? 200 : 404);
    expect(response.headers.get("content-type")).not.toContain("presentationml");
    const body = await response.text();
    expect(body).not.toContain(study.marker);
    // Illustrated print intentionally renders its existing fail-closed error page.
    if (illustratedPrint) {
      expect(body).toContain("تعذر تجهيز الدراسة المصورة كاملة");
      expect(body).not.toContain('class="study-sheet');
      expect(body).not.toContain('data-full-study-print');
      expect(body).not.toContain("data:image/png;base64,");
      expect(body).not.toContain("طباعة / حفظ PDF");
    }
  }
}

const money = async () => (await db.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM patient_opening_balances) opening")).rows;
// Reassemble a complete synthetic sentinel across deliberate line wrapping.
// This does not normalize clinical numbers, source hashes or stored evidence.
const joinedSentinelText = (text: string) => text.replace(/[\s\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
async function fullPrintBodyText(html: string) {
  const page = await browser.newPage();
  try {
    await page.route("**/*", route => route.abort());
    return await page.evaluate(source => {
      const document = new DOMParser().parseFromString(source, "text/html");
      return [...document.querySelectorAll('[data-print-region="body"]')].map(node => node.textContent ?? "").join("\n");
    }, html);
  } finally { await page.close(); }
}

it.each(["doctorA", "reception"] as const)("%s keeps saved-study access while all exports require a current grant", async role => {
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
        // Native editable text wraps long tokens across separate text runs.
        // Reconstruct all visible run text and require the complete original marker.
        const visibleText = slides.flatMap(xml => [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(match => match[1])).join("");
        expect(visibleText).toContain(study.marker);
        expect(slides.join("\n")).toContain("سياق التقاط الدراسة المحفوظة");
        expect(slides.join("\n")).toContain("حالة التقويم عند التقاط الدراسة: مكتملة");
      } else {
        const html = await response.text();
        if (url.endsWith("&mode=full")) expect(joinedSentinelText(await fullPrintBodyText(html))).toContain(study.marker);
        else expect(html).toContain(study.marker);
        expect(html).toContain("سياق التقاط الدراسة المحفوظة");
        expect(html).toContain("حالة التقويم عند التقاط الدراسة: مكتملة");
      }
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
    const capture = page.getByLabel("سياق التقاط الدراسة المحفوظة", { exact: true });
    expect(await capture.innerText()).toContain("حالة التقويم عند التقاط الدراسة: مكتملة");
    expect(await capture.locator("time").getAttribute("datetime")).toBe(study.capturedAt);
    await capture.scrollIntoViewIfNeeded();
    expect(await capture.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await capture.screenshot({ path: `.settings-ui-artifacts/ortho-study-capture-context-${width}.png` });
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


it("renders the saved capture context once on a separate PDF page in every print mode", async () => {
  const study = await createStudy(h.seeded.patientAId);
  const directory = await mkdtemp(join(tmpdir(), "synthetic-study-print-"));
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE" });
  const [name, ...cookie] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: cookie.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [];
  await context.route("**/*", route => {
    const request = route.request();
    if (new URL(request.url()).origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      unexpected.push(`${request.method()} ${new URL(request.url()).pathname}`); return route.abort();
    }
    return route.continue();
  });
  try {
    for (const [index, mode] of ["text", "illustrated", "full"].entries()) {
      const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
      const response = await page.goto(`${baseUrl}${study.outputs[index + 2]}`);
      expect(response?.status()).toBe(200);
      await page.getByText("سياق التقاط الدراسة المحفوظة", { exact: true }).waitFor({ timeout: 20000 });
      expect(await page.getByText("سياق التقاط الدراسة المحفوظة", { exact: true }).count()).toBe(1);
      expect(await page.locator("main").innerText()).toContain("حالة التقويم عند التقاط الدراسة: مكتملة");
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => undefined))); });
      if (mode === "full") {
        expect(response?.headers()["cache-control"]).toContain("no-store");
        await expect.poll(() => page.locator('[data-full-study-print]').getAttribute('data-print-ready')).toBe('true');
        expect(await page.locator('[data-print-sheet]').count()).toBe(2);
        expect(await page.getByRole('button', {name:'طباعة / حفظ PDF',exact:true}).isEnabled()).toBe(true);
      }
      const pdf = join(directory, `${mode}.pdf`);
      await page.pdf({ path: pdf, format: "A4", preferCSSPageSize: true, printBackground: true });
      const info = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
      const physicalPages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      if (physicalPages !== 2) {
        console.error("Synthetic print pagination", mode, JSON.stringify({ physicalPages,
          text: execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" }),
          geometry: await page.evaluate(() => ({ mainPadding: getComputedStyle(document.querySelector("main")!).padding,
            sections: [...document.querySelectorAll("main section")].map(node => ({ height: node.getBoundingClientRect().height, breakAfter: getComputedStyle(node).breakAfter })) })) }));
      }
      expect(physicalPages).toBe(2);
      const extract = (physicalPage: number) => execFileSync("pdftotext", ["-f", String(physicalPage), "-l", String(physicalPage), "-layout", pdf, "-"], { encoding: "utf8" }).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
      const first = extract(1), second = extract(2);
      expect(first).toContain(study.capturedAt); expect(first).not.toContain(study.marker);
      expect(first).toContain("1 / 2"); expect(second).toContain("2 / 2");
      expect(second).toContain(study.capturedAt);
      expect(joinedSentinelText(second)).toContain(study.marker);
      execFileSync("pdftoppm", ["-f", "1", "-singlefile", "-scale-to", "1100", "-png", pdf, `.settings-ui-artifacts/ortho-study-capture-print-${mode}`]);
      await page.close();
    }
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  } finally { await context.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each(["doctor", "reception"] as const)("an existing administrator cookie loses implicit export after downgrade to %s", async role => {
  const original = (await db.query("SELECT role,permissions FROM users WHERE username='secadmin'")).rows[0] as { role: string; permissions: string | null };
  const study = await createStudy(h.seeded.patientAId);
  const retainedReadAccess = { canViewAllPatients: true, canViewPlans: true, canViewXrays: true, canExportOrthoStudies: false };
  try {
    expect((await authedGet(study.outputs[0], h.sessions.admin)).status).toBe(200);
    await db.query("UPDATE users SET role=$1,permissions=$2 WHERE username='secadmin'", [role, JSON.stringify(retainedReadAccess)]);
    // Role changes invalidate the old cookie; they do not silently renew it.
    expect((await authedGet(study.read, h.sessions.admin)).status).toBe(401);
    for (const url of study.outputs.slice(0, 2)) {
      const denied = await authedGet(url, h.sessions.admin);
      expect(denied.status).toBe(401); expect(await denied.text()).not.toContain(study.marker);
    }
    const current = await loginStaff(TEST_USERS.admin.username, TEST_USERS.admin.password);
    expect((await authedGet(study.read, current)).status).toBe(200);
    await rejectOutputs(study, current);
    await db.query("UPDATE users SET permissions=$1 WHERE username='secadmin'", [JSON.stringify({ ...retainedReadAccess, canExportOrthoStudies: true })]);
    expect((await authedGet(study.outputs[0], current)).status).toBe(200);
  } finally { await db.query("UPDATE users SET role=$1,permissions=$2 WHERE username='secadmin'", [original.role, original.permissions]); }
});
