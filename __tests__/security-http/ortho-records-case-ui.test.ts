import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { Client } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { authedGet, authedMutation, baseUrl, harness, TEST_USERS } from "./_server";
import { computeAll, REQUIRED_LANDMARKS, type LandmarkMap } from "../../lib/ceph";
import type { CephSourceIdentity } from "../../lib/ceph-source-review";

// Built-app acceptance in the existing isolated CI harness. Source links and
// case records are real synthetic DB rows; image bytes alone are intercepted.
// All browser mutations are blocked. No Production records/storage are used.
let browser: Browser, db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let patient: number, caseA: number, caseB: number;
let submittedSources: CephSourceIdentity;
let syntheticImage: { sha256: string; byteLength: number };
let currentPhoto: number, historicalPhoto: number, unassignedPhoto: number, currentXray: number, referenceStudy: number, pretreatmentStudy: number, historicalStudy: number;
const stamp = Date.now();
// Existing verify-ceph synthetic geometry, never patient measurements. A signed
// pretreatment reference has calibration, confirmed landmarks and stamped values.
const originalLandmarks: LandmarkMap = {
  S: { x: 0, y: 0 }, N: { x: 69, y: -8 }, A: { x: 67.57, y: 51.98 }, B: { x: 63.84, y: 79.85 },
  Pog: { x: 64.03, y: 86.87 }, Me: { x: 60, y: 105 }, Gn: { x: 61.5, y: 95.5 }, Go: { x: -17.03, y: 69.08 },
  Or: { x: 60, y: -25 }, Po: { x: 0, y: -25 }, U1A: { x: 60, y: 34 }, U1: { x: 74.08, y: 71.44 },
  L1A: { x: 68, y: 64 }, L1: { x: 49, y: 99.2 }, OcclA: { x: 70, y: 48 }, OcclP: { x: 0, y: 35.3 },
  D: { x: 62, y: 95 }, Co: { x: -45, y: 38 }, ANS: { x: 78, y: 44 }, PNS: { x: -5, y: 36 },
};
// Translation preserves geometry while keeping every point inside the source.
const signedLandmarks: LandmarkMap = Object.fromEntries(Object.entries(originalLandmarks).map(([code, point]) => {
  if (!point) throw new Error(`Missing synthetic landmark ${code}`);
  return [code, { x: point.x + 80, y: point.y + 60 }];
}));
const historicalMeasurements = [{ code: "ANB", value: 2 }, { code: "FMA", value: 25 }, { code: "WITS", value: -1 }];
const historicalDiagnosis = "استنتاج تاريخي تجريبي محفوظ بلا شاهد إصدار — ليس تشخيص مريض";
const snapshot = async () => ({
  documents: (await db.query("SELECT * FROM patient_documents WHERE patient_id=$1 ORDER BY id", [patient])).rows,
  analyses: (await db.query("SELECT * FROM ceph_analyses WHERE patient_id=$1 ORDER BY id", [patient])).rows,
  landmarks: (await db.query(`SELECT l.* FROM ceph_landmarks l JOIN ceph_analyses a ON a.id=l.analysis_id
    WHERE a.patient_id=$1 ORDER BY l.analysis_id,l.id`, [patient])).rows,
  measurements: (await db.query(`SELECT m.* FROM ceph_measurements m JOIN ceph_analyses a ON a.id=m.analysis_id
    WHERE a.patient_id=$1 ORDER BY m.analysis_id,m.id`, [patient])).rows,
  diagnoses: (await db.query(`SELECT d.* FROM ceph_diagnoses d JOIN ceph_analyses a ON a.id=d.analysis_id
    WHERE a.patient_id=$1 ORDER BY d.analysis_id`, [patient])).rows,
  provenance: (await db.query(`SELECT p.* FROM ceph_completion_provenance p JOIN ceph_analyses a ON a.id=p.analysis_id
    WHERE a.patient_id=$1 ORDER BY p.analysis_id`, [patient])).rows,
  cases: (await db.query("SELECT * FROM ortho_cases WHERE patient_id=$1 ORDER BY id", [patient])).rows,
  plans: (await db.query("SELECT * FROM treatment_plans WHERE patient_id=$1 ORDER BY id", [patient])).rows,
});

beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http"); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username=$1", [TEST_USERS.doctorA.username])).rows[0].party_id;
  patient = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number,full_name,primary_doctor_id)
    VALUES ($1,'مريض سجلات تقويم تجريبي — ليس حقيقياً',$2) RETURNING id`, [`RECUI-${stamp}`, doctor])).rows[0].id;
  const cases = await db.query<{ id: number }>(`INSERT INTO ortho_cases (patient_id,status,bracket_system,created_by)
    VALUES ($1,'active','RECORD-CASE-A','synthetic-records-ui'),($1,'completed','RECORD-CASE-B','synthetic-records-ui') RETURNING id`, [patient]);
  [caseA, caseB] = cases.rows.map(row => row.id);
  const insertDocument = async (caseId: number | null, title: string, view: string, day: string) => (
    await db.query<{ id: number }>(`INSERT INTO patient_documents
      (patient_id,ortho_case_id,kind,title,mime_type,size_bytes,sha256,storage_key,taken_on,uploaded_by,photo_stage,photo_view)
      VALUES ($1,$2,'photo',$3,'image/png',68,$4,$5,$6::date,'synthetic-records-ui','initial',$7) RETURNING id`,
    [patient, caseId, title, "0".repeat(64), `synthetic-records-ui/${stamp}/${view}-${caseId ?? "none"}.png`, day, view])
  ).rows[0].id;
  currentPhoto = await insertDocument(caseA, "صورة الحالة الحالية التجريبية", "profile", "2026-10-01");
  historicalPhoto = await insertDocument(caseB, "صورة الحالة السابقة التجريبية", "profile", "2026-10-03");
  unassignedPhoto = await insertDocument(null, "صورة مرجعية غير مرتبطة تجريبية", "lateral_ceph", "2026-10-04");
  currentXray = await insertDocument(caseA, "أشعة الحالة الحالية التجريبية", "lateral_ceph", "2026-10-01");
  // Completion captures stored image metadata, not file bytes. Seed a real PNG
  // too: the HTTP test independently verifies its hash-bound download. Browser
  // tiles remain intercepted only for the visual acceptance tests.
  const bytes = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#dbeafe" } }).png().toBuffer();
  const hash = createHash("sha256").update(bytes).digest("hex");
  syntheticImage = { sha256: hash, byteLength: bytes.byteLength };
  const key = `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.png`;
  const file = join(process.cwd(), ".sec-http-storage", "documents", key);
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes);
  await db.query("UPDATE patient_documents SET sha256=$2,storage_key=$3,size_bytes=$4,width=256,height=256 WHERE id=$1",
    [unassignedPhoto, hash, key, bytes.length]);
  // Deliberately keep a separate legacy completion without a witness. It must
  // never acquire findings just because another study has verified provenance.
  historicalStudy = (await db.query<{ id: number }>(`INSERT INTO ceph_analyses
    (patient_id,document_id,ortho_case_id,status,phase,created_by,completed_by,completed_at)
    VALUES ($1,$2,$3,'completed','pretreatment',$4,$4,NOW()) RETURNING id`,
    [patient, historicalPhoto, caseB, TEST_USERS.doctorA.username])).rows[0].id;
  for (const row of historicalMeasurements) {
    await db.query("INSERT INTO ceph_measurements (analysis_id,code,value) VALUES ($1,$2,$3)",
      [historicalStudy, row.code, row.value]);
  }
  await db.query("INSERT INTO ceph_diagnoses (analysis_id,final_dx,created_by) VALUES ($1,$2,$3)",
    [historicalStudy, historicalDiagnosis, TEST_USERS.doctorA.username]);
  // Complete the synthetic T1 before inserting the reference draft, respecting
  // the patient-wide one-draft index. Only the application stamps measurements
  // and provenance; SQL seeds draft inputs, never a manufactured witness.
  expect(REQUIRED_LANDMARKS.every(code => signedLandmarks[code] !== undefined)).toBe(true);
  for (const point of Object.values(signedLandmarks)) {
    expect(point).toBeDefined();
    expect(point!.x).toBeGreaterThan(0); expect(point!.x).toBeLessThan(256);
    expect(point!.y).toBeGreaterThan(0); expect(point!.y).toBeLessThan(256);
  }
  const originalMeasurements = computeAll(originalLandmarks, 1);
  const translatedMeasurements = computeAll(signedLandmarks, 1);
  expect(translatedMeasurements.map(row => row.code)).toEqual(originalMeasurements.map(row => row.code));
  translatedMeasurements.forEach((row, index) => {
    const original = originalMeasurements[index];
    if (original.value === null) expect(row.value).toBeNull();
    else {
      expect(row.value).not.toBeNull();
      expect(row.value!).toBeCloseTo(original.value, 10);
    }
  });
  const measurements = translatedMeasurements.filter(row => row.value !== null);
  expect(measurements.map(row => row.code)).toEqual(expect.arrayContaining(["ANB", "FMA", "WITS"]));
  await db.query("BEGIN");
  try {
    pretreatmentStudy = (await db.query<{ id: number }>(`INSERT INTO ceph_analyses
      (patient_id,document_id,ortho_case_id,status,phase,created_by,
       cal_x1,cal_y1,cal_x2,cal_y2,cal_mm,mm_per_pixel)
      VALUES ($1,$2,NULL,'draft','pretreatment',$3,80,60,180,60,100,1) RETURNING id`,
    [patient, unassignedPhoto, TEST_USERS.doctorA.username])).rows[0].id;
    for (const [code, point] of Object.entries(signedLandmarks)) {
      if (!point) throw new Error(`Missing synthetic landmark ${code}`);
      await db.query(`INSERT INTO ceph_landmarks (analysis_id,code,x,y,source,confirmed_by)
        VALUES ($1,$2,$3,$4,'manual',$5)`, [pretreatmentStudy, code, point.x, point.y, TEST_USERS.doctorA.username]);
    }
    await db.query(`INSERT INTO ceph_diagnoses (analysis_id,final_dx,created_by)
      VALUES ($1,'استنتاج تجريبي محفوظ — ليس تشخيص مريض',$2)`, [pretreatmentStudy, TEST_USERS.doctorA.username]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  const draftRead = await authedGet(`/api/ceph/${pretreatmentStudy}`, h.sessions.doctorA);
  expect(draftRead.status).toBe(200);
  const draft = await draftRead.json();
  expect(draft.completionSources.state).toBe("available");
  expect(draft.provenance.state).toBe("not_completed");
  submittedSources = draft.completionSources.identity;
  const { patientId, documentId, refSet, calibration, mmPerPixel } = draft.analysis;
  const completion = await authedMutation(`/api/ceph/${pretreatmentStudy}/complete`, h.sessions.doctorA, "POST", JSON.stringify({
    expectedSnapshot: { patientId, documentId, refSet, calibration, mmPerPixel,
      landmarks: draft.landmarks, diagnosis: draft.diagnosis },
    expectedSources: submittedSources,
  }));
  expect(completion.status, await completion.text()).toBe(200);
  referenceStudy = (await db.query<{ id: number }>(`INSERT INTO ceph_analyses
    (patient_id,document_id,ortho_case_id,status,created_by)
    VALUES ($1,$2,$3,'draft','synthetic-records-ui') RETURNING id`, [patient, currentXray, caseB])).rows[0].id;
  const seeded = await snapshot();
  expect(seeded.analyses.filter(row => row.status === "draft")).toHaveLength(1);
  expect(seeded.analyses.find(row => String(row.id) === String(pretreatmentStudy))).toMatchObject({
    status: "completed", phase: "pretreatment", ortho_case_id: null,
    completed_by: TEST_USERS.doctorA.username, completed_at: expect.any(Date), mm_per_pixel: 1,
  });
  expect(seeded.landmarks).toHaveLength(Object.keys(signedLandmarks).length);
  expect(seeded.measurements.filter(row => String(row.analysis_id) === String(pretreatmentStudy))).toHaveLength(measurements.length);
  expect(seeded.measurements.filter(row => String(row.analysis_id) === String(historicalStudy))
    .map(({ code, value }) => ({ code, value })).sort((a, b) => a.code.localeCompare(b.code)))
    .toEqual(historicalMeasurements);
  expect(seeded.diagnoses.filter(row => String(row.analysis_id) === String(pretreatmentStudy))).toHaveLength(1);
  expect(seeded.diagnoses.filter(row => String(row.analysis_id) === String(historicalStudy)))
    .toEqual([expect.objectContaining({ final_dx: historicalDiagnosis })]);
  expect(seeded.provenance).toHaveLength(1);
  expect(String(seeded.provenance[0].analysis_id)).toBe(String(pretreatmentStudy));
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

function caseCard(page: Page, key: "A" | "B") {
  return page.locator("li").filter({ has: page.getByText(new RegExp(`^RECORD-CASE-${key}\\s*·`)) });
}
const captureBounds: unknown[] = [];
async function captureViewport(page: Page, target: Locator, filename: string) {
  // A tall element screenshot can place viewport-sticky chrome across the
  // stitched panel. Capture bounded targets in the real viewport instead:
  // no hidden chrome, injected CSS, resized viewport or modified application UI.
  await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const bounds = await target.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const rectangle = (box: DOMRect) => ({ x: box.x, y: box.y, width: box.width, height: box.height,
      top: box.top, right: box.right, bottom: box.bottom, left: box.left });
    const chrome = [...document.querySelectorAll<HTMLElement>("body *")].filter(node => {
      if (node.contains(element) || element.contains(node)) return false;
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      return ["fixed", "sticky"].includes(style.position) && style.display !== "none" && style.visibility !== "hidden"
        && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
    }).map(node => ({ tag: node.tagName, label: node.getAttribute("aria-label"), position: getComputedStyle(node).position,
      rect: rectangle(node.getBoundingClientRect()) }));
    const overlaps = chrome.filter(item => item.rect.left < rect.right && item.rect.right > rect.left
      && item.rect.top < rect.bottom && item.rect.bottom > rect.top);
    const points = [[rect.left + 8, rect.top + 8], [rect.right - 8, rect.top + 8],
      [rect.left + 8, rect.bottom - 8], [rect.right - 8, rect.bottom - 8],
      [rect.left + rect.width / 2, rect.top + rect.height / 2]].map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return { x, y, clear: hit !== null && (hit === element || element.contains(hit)) };
    });
    return { target: element.getAttribute("data-testid") ?? element.getAttribute("role"),
      rect: rectangle(rect), viewport: { width: innerWidth, height: innerHeight }, chrome, overlaps, points };
  });
  await mkdir(".settings-ui-artifacts", { recursive: true });
  captureBounds.push({ filename, ...bounds });
  await writeFile(".settings-ui-artifacts/ortho-records-capture-bounds.json", JSON.stringify(captureBounds, null, 2));
  expect(bounds.rect.width).toBeGreaterThan(0); expect(bounds.rect.height).toBeGreaterThan(0);
  expect(bounds.rect.left).toBeGreaterThanOrEqual(0); expect(bounds.rect.top).toBeGreaterThanOrEqual(0);
  expect(bounds.rect.right).toBeLessThanOrEqual(bounds.viewport.width);
  expect(bounds.rect.bottom).toBeLessThanOrEqual(bounds.viewport.height);
  expect(bounds.overlaps).toEqual([]); expect(bounds.points.every(point => point.clear)).toBe(true);
  await page.screenshot({ path: `.settings-ui-artifacts/${filename}` });
}
async function fixture(width: number) {
  browser ??= await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [];
  const ids = [currentPhoto, historicalPhoto, unassignedPhoto, currentXray];
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(method)) {
      unexpected.push(`${method} ${url.origin}${url.pathname}`); await route.abort(); return;
    }
    if (ids.some(id => url.pathname === `/api/documents/${id}`)) {
      // A visible synthetic tile, not a medical image; its ID/src remains the real fixture link.
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#dbeafe"/><path d="M20 95L55 40L85 70L125 25L150 95Z" fill="#1e40af"/></svg>' });
      return;
    }
    await route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  const openCase = async (key: "A" | "B") => {
    const card = caseCard(page, key); await card.getByRole("button", { name: /السجلات/ }).click();
    const panel = card.getByTestId("ortho-records-grid"); await panel.waitFor(); return panel;
  };
  const open = async () => {
    await page.goto(`${baseUrl}/patients/${patient}?tab=treatment&sub=ortho`, { waitUntil: "domcontentloaded" });
    if (width < 640) {
      await page.getByTestId("patient-treatment-section").waitFor();
      await expect.poll(() => page.getByTestId("patient-treatment-section").inputValue()).toBe("ortho");
    } else await page.getByTestId("patient-subtab-ortho").waitFor(); return openCase("A");
  };
  return { context, page, open, openCase, unexpected, errors };
}

describe("exact-case orthodontic record slots on the built RTL patient page", () => {
  it("verifies the genuine completion witness and withholds historical findings through HTTP without writes", async () => {
    const before = await snapshot();
    const read = await authedGet(`/api/ceph/${pretreatmentStudy}`, h.sessions.doctorA);
    expect(read.status).toBe(200);
    const completed = await read.json();
    expect(completed.provenance.state).toBe("versioned");
    expect(completed.provenance.witness.schemaVersion).toBe(2);
    expect(completed.provenance.witness.image).toEqual({
      documentId: Number(unassignedPhoto), sha256: syntheticImage.sha256, width: 256, height: 256,
    });
    expect(completed.provenance.witness.sourceReview).toEqual({ schemaVersion: 1, identity: submittedSources });
    expect(submittedSources.documentId).toBe(Number(unassignedPhoto));
    expect(submittedSources.imageSha256).toBe(syntheticImage.sha256);
    const imageRead = await authedGet(`/api/documents/${unassignedPhoto}?cephSource=${syntheticImage.sha256}`, h.sessions.doctorA);
    expect(imageRead.status).toBe(200);
    expect(imageRead.headers.get("content-type")).toBe("image/png");
    expect(imageRead.headers.get("content-length")).toBe(String(syntheticImage.byteLength));
    const downloaded = Buffer.from(await imageRead.arrayBuffer());
    expect(downloaded.byteLength).toBe(syntheticImage.byteLength);
    expect(createHash("sha256").update(downloaded).digest("hex")).toBe(syntheticImage.sha256);
    expect(completed.provenance.witness.actor.username).toBe(TEST_USERS.doctorA.username);
    expect(completed.provenance.witness.measurements.map((row: { code: string }) => row.code))
      .toEqual(expect.arrayContaining(["ANB", "FMA", "WITS"]));
    const legacyRead = await authedGet(`/api/ceph/${historicalStudy}`, h.sessions.doctorA);
    expect(legacyRead.status).toBe(200);
    const legacy = await legacyRead.json();
    expect(legacy.provenance).toMatchObject({ state: "unversioned" });
    expect(legacy.measurements).toEqual(expect.arrayContaining(historicalMeasurements.map(row => expect.objectContaining(row))));
    expect(legacy.diagnosis.finalDx).toBe(historicalDiagnosis);
    const list = await authedGet(`/api/patients/${patient}/ceph`, h.sessions.doctorA);
    expect(list.status).toBe(200);
    const { analyses } = await list.json();
    expect(analyses.find((row: { id: number }) => String(row.id) === String(pretreatmentStudy)))
      .toMatchObject({ provenanceState: "versioned", findings: { anb: expect.any(Number), fma: expect.any(Number), wits: expect.any(Number) } });
    expect(analyses.find((row: { id: number }) => String(row.id) === String(historicalStudy)))
      .toMatchObject({ provenanceState: "unversioned", findings: null });
    expect(await snapshot()).toEqual(before);
  });
  it.each([1280, 390])("keeps historical/unassigned records explicit and captures the exact-case grid at %s", async width => {
    const before = await snapshot(), f = await fixture(width);
    try {
      const panel = await f.open();
      const profile = panel.getByTestId("ortho-record-slot-profile");
      await profile.locator("img").waitFor();
      expect(await profile.locator("img").getAttribute("src")).toBe(`/api/documents/${currentPhoto}`);
      expect(await panel.getByTestId("ortho-record-slot-smile").locator("img").count()).toBe(0);
      expect(await panel.locator(`img[src="/api/documents/${historicalPhoto}"]`).count()).toBe(0);
      expect(await panel.locator(`img[src="/api/documents/${unassignedPhoto}"]`).count()).toBe(0);
      const refs = panel.getByTestId("ortho-record-references"); await refs.locator("summary").click();
      expect(await refs.getByRole("link", { name: "صورة الحالة السابقة التجريبية", exact: true }).getAttribute("href")).toBe(`/api/documents/${historicalPhoto}`);
      expect(await refs.getByRole("link", { name: "صورة مرجعية غير مرتبطة تجريبية", exact: true }).getAttribute("href")).toBe(`/api/documents/${unassignedPhoto}`);
      expect(await refs.getByRole("link", { name: new RegExp(`تحليل مرجعي #${pretreatmentStudy}.*بلا ربط بحالة`) }).getAttribute("href")).toBe(`/ceph/${pretreatmentStudy}`);
      const xray = panel.getByTestId("ortho-record-slot-lateral_ceph");
      expect(await xray.getByRole("button", { name: /راجع التحليل المرجعي أدناه/ }).isDisabled()).toBe(true);
      expect(await xray.getByRole("link", { name: new RegExp(`تحليل مرجعي #${referenceStudy}`) }).getAttribute("href")).toBe(`/ceph/${referenceStudy}`);
      await panel.scrollIntoViewIfNeeded();
      expect(await panel.evaluate(element => getComputedStyle(element).direction)).toBe("rtl");
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await captureViewport(f.page, xray, `ortho-records-case-${width}.png`);
      if (width === 390) await captureViewport(f.page, profile, "ortho-records-profile-390.png");
      await captureViewport(f.page, refs, `ortho-records-references-${width}.png`);
      // The signed unlinked T1 is a patient-wide reference, never the current
      // case's summary. Exercise PatientCeph's real toggle and DOM at both widths.
      const card = caseCard(f.page, "A");
      await card.getByText("لا توجد دراسات سيفالومترية مسجلة بعد", { exact: true }).waitFor();
      expect(await card.getByTestId("patient-ceph-summary").count()).toBe(0);
      await card.getByRole("button", { name: `دراسات الحالة #${caseA}`, exact: true }).click();
      const cephSummary = card.getByTestId("patient-ceph-summary"); await cephSummary.waitFor();
      expect(await cephSummary.textContent()).toContain("أحدث دراسة معتمدة للمريض (كافة الحالات)");
      expect(await cephSummary.textContent()).toContain("بلا ربط بحالة");
      expect(await cephSummary.textContent()).toContain("قبل العلاج (T1)");
      expect(await cephSummary.getByRole("link", { name: "استعراض المخطط والتتبع ←", exact: true }).getAttribute("href")).toBe(`/ceph/${pretreatmentStudy}`);
      expect(await cephSummary.evaluate(element => getComputedStyle(element).direction)).toBe("rtl");
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(await cephSummary.getByTestId("patient-ceph-summary-header").evaluate(element => getComputedStyle(element).flexWrap)).toBe("wrap");
      const summaryOverflow = await cephSummary.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return Array.from(element.querySelectorAll("*")).filter(child => {
          const rect = child.getBoundingClientRect();
          return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
        }).map(child => ({ tag: child.tagName, text: child.textContent }));
      });
      expect(summaryOverflow).toEqual([]);
      await captureViewport(f.page, cephSummary, `ortho-records-ceph-summary-${width}.png`);
      await card.getByRole("button", { name: "كافة دراسات المريض", exact: true }).click();
      await card.getByText("لا توجد دراسات سيفالومترية مسجلة بعد", { exact: true }).waitFor();
      expect(await card.getByTestId("patient-ceph-summary").count()).toBe(0);
      // The historical case uses its own source and keeps the current image a reference.
      const oldPanel = await f.openCase("B");
      await oldPanel.getByTestId("ortho-record-slot-profile").locator("img").waitFor();
      expect(await oldPanel.getByTestId("ortho-record-slot-profile").locator("img").getAttribute("src")).toBe(`/api/documents/${historicalPhoto}`);
      expect(await oldPanel.locator(`img[src="/api/documents/${currentPhoto}"]`).count()).toBe(0);
      const oldCard = caseCard(f.page, "B");
      await oldCard.getByText("اعتماد تاريخي غير موثّق الإصدار", { exact: true }).waitFor();
      expect(await oldCard.getByTestId("patient-ceph-summary").count()).toBe(0);
      expect(await snapshot()).toEqual(before); expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("shows an unavailable read, retries to real links, and leaves the stored records unchanged", async () => {
    const before = await snapshot(), f = await fixture(390); let fail = true;
    try {
      await f.page.route(`**/api/patients/${patient}/documents`, async route => {
        if (fail) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic read outage" }) });
        else await route.fallback();
      });
      const panel = await f.open(); await panel.getByRole("alert").waitFor();
      expect(await panel.textContent()).toContain("هذا لا يعني عدم وجود صور أو تحليلات مسجلة");
      expect(await panel.getByTestId("ortho-record-slot-profile").count()).toBe(0);
      expect(await panel.getByRole("button", { name: /رفع السيفالو|إضافة صورة/ }).count()).toBe(0);
      await captureViewport(f.page, panel.getByRole("alert"), "ortho-records-unavailable-390.png");
      fail = false; await panel.getByRole("button", { name: "إعادة تحميل سجلات الحالة", exact: true }).click();
      await panel.getByTestId("ortho-record-slot-profile").locator("img").waitFor();
      expect(await panel.getByTestId("ortho-record-slot-profile").locator("img").getAttribute("src")).toBe(`/api/documents/${currentPhoto}`);
      expect(await snapshot()).toEqual(before); expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });
});
