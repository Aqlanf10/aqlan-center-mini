import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConsentDocumentContent, ConsentDocumentMetadata } from "../../lib/consent-document";
import type { PatientDocument } from "../../lib/db";
import { authedGet, baseUrl, harness, TEST_USERS } from "./_server";

/**
 * AUTHORED UNRUN. Root review/integration and a separate runtime grant required.
 * Uses the existing built-server lifecycle, real multipart/cookie HTTP and its
 * disposable storage/DB. No browser, new harness, route mocks or human signature.
 */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorId: number;
const fixtureStamp = String(Date.now());
let fixtureCounter = 0;
const takenOn = "2024-02-29";
const maxNoteBytes = 16 * 1024;
const storageRoot = resolve(process.cwd(), ".sec-http-storage", "documents");

// Independently frozen reviewed signing-modal text. Do not build expectations
// with the production metadata constructor/validator being exercised by HTTP.
// This literal is a test payload, not an endorsement of the clinical wording.
const capturedContent: ConsentDocumentContent = {
  title: "إقرار وموافقة على علاج وجراحة عصب وجذور الأسنان (Endodontics)",
  procedureName: "استئصال وحشو قنوات العصب",
  summary: "أوافق على إجراء المعالجة اللبية (سحب وحشو العصب) لإنقاذ السن المصاب ومنع انتشار العدوى إلى العظم المحيط، مع إدراكي أن علاج العصب هو البديل الوحيد للخلع.",
  terms: [
    "أدرك أن علاج العصب قد يتطلب جلسة واحدة أو عدة جلسات وفقاً لشدة الالتهاب وتشريح القنوات.",
    "أعلم أن السن المعالج عصبيًا يصبح أكثر هشاشة، ويحتاج إلزامياً إلى حشوة بناء وتاج (تلبيسة) لحمايته من الكسر مستقبلاً.",
    "الالتزام بالحضور لاستكمال حشو القنوات نهائياً، حيث إن ترك الحشوة المؤقتة يسبب فشل العلاج وتلوث القنوات.",
  ],
  risks: [
    "ألم أو انزعاج خفيف إلى متوسط عند العض لعدة أيام بعد الجلسة، ويسيطر عليه بالمسكنات الموصوفة.",
    "احتمال وجود قنوات دقيقة إضافية أو تكلسات شديدة أو انحناءات غير معتادة في الجذور.",
    "في حالات نادرة جداً: احتمالية انفصال أداة تنظيف دقيقة داخل القناة بسبب ضيقها الشديد، وسيتم إبلاغي فوراً بالإجراء المناسب.",
  ],
  acknowledgement: "أقر بأنني قرأت وفهمت كافة الشروط والمضاعفات المذكورة أعلاه، وأمنح موافقتي التامة للطبيب المعالج لإجراء المعالجة المطلوبة.",
};
const unsignedOnlyInstruction = "تجنب المضغ القاسي على السن حتى الانتهاء من حشو العصب وتركيب التاج الدائم.";
const malformedMessage = "بيانات الإقرار غير مكتملة أو غير صالحة. راجع النموذج وبيانات الموقّع.";
const staleMessage = "تغيّر نص نموذج الإقرار. أعد فتح النموذج وراجع النص الحالي ثم وقّع من جديد؛ لم يُحفظ التوقيع.";

interface Fixture {
  marker: string;
  patientId: number;
  visitId: number;
  patientName: string;
}

beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(target.hostname);
  expect(target.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  expect((await db.query<{ name: string }>("SELECT current_database() AS name")).rows)
    .toEqual([{ name: "aqlan_sec_http" }]);
  const doctor = await db.query<{ party_id: number }>(
    `SELECT u.party_id FROM users u JOIN parties p ON p.id = u.party_id
       WHERE u.username = $1 AND u.role = 'doctor' AND p.kind = 'doctor'`,
    [TEST_USERS.doctorA.username],
  );
  expect(doctor.rows).toHaveLength(1);
  doctorId = doctor.rows[0].party_id;
  expect(doctorId).toBeGreaterThan(0);
});
afterAll(async () => { await db?.end(); });

async function fixture(): Promise<Fixture> {
  const marker = `SYNTHETIC-CONSENT-${randomUUID()}`;
  const patientName = `Synthetic consent patient at capture ${marker}`;
  // ensureSchema aligns patient_number_seq from all digits in patient_number.
  // Keep the UUID for labels, but use bounded numeric digits for this field.
  fixtureCounter += 1;
  expect(fixtureStamp).toMatch(/^\d{13}$/);
  expect(fixtureCounter).toBeLessThanOrEqual(999);
  const patientNumber = `SYNTHETIC-CONSENT-${fixtureStamp}-${String(fixtureCounter).padStart(3, "0")}`;
  const digits = patientNumber.replace(/\D/g, "");
  expect(digits).toMatch(/^\d{16}$/);
  expect(Number.isSafeInteger(Number(digits))).toBe(true);
  expect(BigInt(digits) > 0n && BigInt(digits) <= 9_223_372_036_854_775_807n).toBe(true);
  const patient = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
       VALUES ($1, $2, $3) RETURNING id`, [patientNumber, patientName, doctorId],
  );
  const patientId = patient.rows[0].id;
  const visit = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_id, patient_name, doctor_id, status)
       VALUES ($1, $2, $3, 'done') RETURNING id`, [patientId, patientName, doctorId],
  );
  return { marker, patientId, patientName, visitId: visit.rows[0].id };
}

function metadata(f: Fixture): ConsentDocumentMetadata {
  return {
    format: "aqlan-consent", schemaVersion: 1,
    patientId: f.patientId, visitId: f.visitId, orthoCaseId: null, adjustmentId: null,
    takenOn, patientName: f.patientName, templateId: "root_canal",
    signatoryName: `Synthetic guardian at capture ${f.marker}`,
    signatoryRelation: "guardian", guardianRelation: "Synthetic guardian relation only",
    content: structuredClone(capturedContent),
  };
}

// One-pixel fixture; an embedded PNG tEXt label makes each body unique so
// content-addressed deduplication cannot conceal a rejected-upload file write.
// Neither the pixel nor the label is a human signature or a patient document.
function syntheticPng(label: string): Buffer {
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
  const data = Buffer.from(`Comment\0SYNTHETIC TEST ONLY - NOT A HUMAN SIGNATURE - ${label}`);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write("tEXt", 4, "ascii");
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([pixel.subarray(0, -12), chunk, pixel.subarray(-12)]);
}

function upload(f: Fixture, note: string, bytes: Buffer, mime = "image/png") {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }),
    mime === "image/png" ? "SYNTHETIC-NOT-A-SIGNATURE.png" : "SYNTHETIC-NOT-A-CONSENT.pdf");
  form.set("kind", "consent");
  form.set("title", `Synthetic consent HTTP fixture ${f.marker}`);
  form.set("note", note);
  form.set("takenOn", takenOn);
  form.set("visitId", String(f.visitId));
  return fetch(`${baseUrl}/api/patients/${f.patientId}/documents`, {
    method: "POST",
    headers: { Cookie: h.sessions.doctorA.cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
    body: form, redirect: "manual",
  });
}

async function uploadCaptured(f: Fixture) {
  const captured = metadata(f);
  const note = JSON.stringify(captured);
  const bytes = syntheticPng(`${f.marker}-${randomUUID()}`);
  const response = await upload(f, note, bytes);
  expect(response.status).toBe(201);
  const document = await response.json() as PatientDocument;
  return { captured, note, bytes, document };
}

async function documents(f: Fixture): Promise<PatientDocument[]> {
  const response = await authedGet(`/api/patients/${f.patientId}/documents`, h.sessions.doctorA);
  expect(response.status).toBe(200);
  const body = await response.json() as { documents: PatientDocument[]; storageReady: boolean };
  expect(body.storageReady).toBe(true);
  return body.documents;
}

async function storedRows(f: Fixture) {
  return (await db.query<{ row: Record<string, unknown> }>(
    "SELECT to_jsonb(d) AS row FROM patient_documents d WHERE patient_id = $1 ORDER BY id", [f.patientId],
  )).rows.map(({ row }) => row);
}

async function storedFiles() {
  // Only the existing harness's disposable storage root, with no symlink escape.
  expect(await realpath(storageRoot)).toBe(storageRoot);
  const files: { path: string; size: number; sha256: string }[] = [];
  async function walk(relative: string) {
    for (const entry of await readdir(join(storageRoot, relative), { withFileTypes: true })) {
      if (relative === "" && entry.name === ".write-probe") continue;
      expect(entry.isSymbolicLink()).toBe(false);
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        expect(entry.isFile()).toBe(true);
        const bytes = await readFile(join(storageRoot, path));
        files.push({ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  }
  await walk("");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const decodeText = (html: string) => html.replace(/<[^>]*>/g, "")
  .replace(/&#x([\da-f]+);/gi, (_, value: string) => String.fromCodePoint(parseInt(value, 16)))
  .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value)))
  .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

async function print(f: Fixture, documentId: number) {
  const query = new URLSearchParams({
    docId: String(documentId), templateId: "surgical_extraction", date: "1999-01-01",
    signatoryName: "SYNTHETIC-QUERY-SIGNER", signatoryRelation: "self",
    guardianRelation: "SYNTHETIC-QUERY-RELATION", doctorName: "SYNTHETIC-QUERY-DOCTOR",
  });
  const response = await authedGet(`/print/consent/${f.patientId}?${query}`, h.sessions.doctorA);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  // Next embeds query props in RSC scripts; those are not displayed consent text.
  // Inspect server-rendered markup only, without claiming browser/layout proof.
  return (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
}

function expectCapturedPrint(html: string, captured: ConsentDocumentMetadata, documentId: number) {
  const text = decodeText(html);
  expect(text).toContain(`نسخة من نص الإقرار المحفوظ · مستند #${documentId}`);
  for (const value of [captured.patientName, captured.signatoryName, captured.guardianRelation!,
    captured.templateId, captured.content.title, captured.content.procedureName,
    captured.content.summary, captured.content.acknowledgement]) expect(text).toContain(value);
  const clauses = [...html.matchAll(/<li\b[^>]*\bclass="consent-clause"[^>]*>([\s\S]*?)<\/li>/g)]
    .map(match => decodeText(match[1]).trim());
  expect(clauses).toEqual([...captured.content.terms, ...captured.content.risks]);
  const header = decodeText(html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "");
  expect(header).toContain(`المريض: ${captured.patientName}`);
  expect(header).toContain(`معرّف المريض الداخلي: #${captured.patientId} · مستند #${documentId}`);
  expect(header).toContain(captured.takenOn);
  expect(text).toContain("29/02/2024");
  expect(text).toContain(`الولي / الوصي الشرعي: ${captured.guardianRelation}`);
  expect(html).toContain(`src="/api/documents/${documentId}"`);
  for (const wrong of ["SYNTHETIC-QUERY-SIGNER", "SYNTHETIC-QUERY-RELATION", "SYNTHETIC-QUERY-DOCTOR",
    "1999", "surgical_extraction", unsignedOnlyInstruction, "مسودة غير موقّعة"])
    expect(text).not.toContain(wrong);
}

async function seedHistoricalNote(f: Fixture, documentId: number, note: string) {
  // Fixture-only mutation of an already uploaded synthetic row, representing
  // pre-existing history. This is not an application write/repair endpoint.
  const result = await db.query<{ note: string }>(
    `UPDATE patient_documents SET note = $1
       WHERE id = $2 AND patient_id = $3 AND visit_id = $4 AND removed_at IS NULL RETURNING note`,
    [note, documentId, f.patientId, f.visitId],
  );
  expect(result.rows).toEqual([{ note }]);
}

function expectUnverified(html: string, documentId: number) {
  const text = decodeText(html);
  expect(text).toContain("بيانات الإقرار غير مكتملة أو غير قابلة للتحقق");
  expect(html).toContain('role="alert"');
  expect(html).toContain(`href="/api/documents/${documentId}"`);
  expect(html).not.toContain(`src="/api/documents/${documentId}"`);
  expect(html).not.toContain('class="consent-signatures"');
  for (const unwanted of ["نسخة من نص الإقرار المحفوظ", "مسودة غير موقّعة", "surgical_extraction",
    "SYNTHETIC-QUERY-SIGNER", capturedContent.acknowledgement]) expect(text).not.toContain(unwanted);
}

describe("built HTTP saved consent snapshot integrity on owned linked fixtures", () => {
  it("round-trips every captured field and the exact PNG, then prints the saved identity after current-patient changes", async () => {
    const f = await fixture();
    const { captured, note, bytes, document } = await uploadCaptured(f);
    expect(Buffer.byteLength(note, "utf8")).toBeGreaterThan(300);
    expect(Buffer.byteLength(note, "utf8")).toBeLessThan(maxNoteBytes);
    expect(document).toMatchObject({
      patientId: f.patientId, visitId: f.visitId, orthoCaseId: null, adjustmentId: null,
      kind: "consent", title: `Synthetic consent HTTP fixture ${f.marker}`,
      mimeType: "image/png", sizeBytes: bytes.length, isImage: true, note, takenOn,
      uploadedBy: TEST_USERS.doctorA.username, removedAt: null, removedBy: null,
      removedNote: null, photoStage: null, photoView: null, width: 1, height: 1,
    });
    expect(JSON.parse(document.note!)).toEqual(captured);
    // This collection endpoint returns note + document metadata, not file bytes.
    expect(await documents(f)).toEqual([document]);
    const rows = await storedRows(f);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: document.id, patient_id: f.patientId, visit_id: f.visitId,
      ortho_case_id: null, adjustment_id: null, note, taken_on: takenOn, sha256,
      storage_key: `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.png`,
    });
    expect(JSON.parse(String(rows[0].note))).toEqual(captured);
    // This item endpoint returns original bytes, not a metadata JSON document.
    const original = await authedGet(`/api/documents/${document.id}`, h.sessions.doctorA);
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("image/png");
    expect(original.headers.get("content-length")).toBe(String(bytes.length));
    expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);

    const currentName = `Synthetic current name after capture ${f.marker}`;
    const currentAlert = `SYNTHETIC-CURRENT-ALERT-${f.marker}`;
    expect((await db.query(
      "UPDATE patients SET full_name = $1, medical_alert = $2 WHERE id = $3 AND primary_doctor_id = $4",
      [currentName, currentAlert, f.patientId, doctorId],
    )).rowCount).toBe(1);
    const html = await print(f, document.id);
    expectCapturedPrint(html, captured, document.id);
    // Current file identity is deliberately disclosed separately, not hidden.
    expect(decodeText(html)).toContain("بيانات الملف الحالية أدناه للتعريف بالمريض");
    expect(decodeText(html)).toContain(currentName);
    expect(decodeText(html)).not.toContain(currentAlert);
    expect(decodeText(html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? "")).not.toContain(currentName);
    expect(await storedRows(f)).toEqual(rows);
    expect(await documents(f)).toEqual([document]);
  });

  it.each(["root_canal", "synthetic_retired_template"])(
    "reads a complete historical snapshot for %s without substituting current template text", async (templateId) => {
      const f = await fixture();
      const { captured, document } = await uploadCaptured(f);
      const historical = structuredClone(captured);
      historical.templateId = templateId;
      historical.content = {
        title: "SYNTHETIC HISTORICAL TITLE", procedureName: "SYNTHETIC HISTORICAL PROCEDURE",
        summary: "SYNTHETIC saved earlier text; no clinical or legal claim.",
        terms: ["SYNTHETIC HISTORICAL TERM FIRST", "SYNTHETIC HISTORICAL TERM LAST"],
        risks: ["SYNTHETIC HISTORICAL RISK ONLY"], acknowledgement: "SYNTHETIC HISTORICAL ACKNOWLEDGEMENT",
      };
      const note = JSON.stringify(historical);
      await seedHistoricalNote(f, document.id, note);
      const before = await storedRows(f);
      expect(await documents(f)).toEqual([{ ...document, note }]);
      const html = await print(f, document.id);
      expectCapturedPrint(html, historical, document.id);
      for (const value of [capturedContent.title, capturedContent.summary, capturedContent.acknowledgement,
        ...capturedContent.terms, ...capturedContent.risks]) expect(decodeText(html)).not.toContain(value);
      expect(await storedRows(f)).toEqual(before);
    },
  );

  it("refuses malformed, mismatched, truncated, oversized and stale metadata without changing document rows or content files", async () => {
    const f = await fixture();
    const { captured, note, document } = await uploadCaptured(f);
    const oversized = structuredClone(captured);
    oversized.content.terms = Array.from({ length: 8 }, () => "ع".repeat(1100));
    const oversizedNote = JSON.stringify(oversized);
    expect(oversizedNote.length).toBeLessThan(maxNoteBytes);
    expect(Buffer.byteLength(oversizedNote, "utf8")).toBeGreaterThan(maxNoteBytes);
    const stale = structuredClone(captured);
    stale.content.terms[0] = "SYNTHETIC stale displayed clause requiring fresh review";
    const cases = [
      { label: "missing-content", note: JSON.stringify({ ...captured, content: null }), status: 400, message: malformedMessage },
      { label: "unknown-schema", note: JSON.stringify({ ...captured, schemaVersion: 2 }), status: 400, message: malformedMessage },
      { label: "unknown-template", note: JSON.stringify({ ...captured, templateId: "synthetic_unknown_template" }), status: 400, message: malformedMessage },
      { label: "visit-context-mismatch", note: JSON.stringify({ ...captured, visitId: null }), status: 400, message: malformedMessage },
      { label: "date-context-mismatch", note: JSON.stringify({ ...captured, takenOn: "2024-03-01" }), status: 400, message: malformedMessage },
      { label: "invalid-date", note: JSON.stringify({ ...captured, takenOn: "2024-02-30" }), status: 400, message: malformedMessage },
      { label: "truncated-generated", note: note.slice(0, 300), status: 400, message: malformedMessage },
      { label: "oversized-utf8", note: oversizedNote, status: 400, message: "بيانات الإقرار تتجاوز الحجم المسموح. لا يمكن حفظها مختصرة." },
      { label: "stale-clauses", note: JSON.stringify(stale), status: 409, message: staleMessage },
    ];
    const beforeRows = await storedRows(f);
    const beforeFiles = await storedFiles();
    for (const entry of cases) {
      const bytes = syntheticPng(`${f.marker}-${entry.label}-${randomUUID()}`);
      expect(beforeFiles.some(file => file.sha256 === createHash("sha256").update(bytes).digest("hex"))).toBe(false);
      const response = await upload(f, entry.note, bytes);
      expect(response.status, entry.label).toBe(entry.status);
      expect(await response.json(), entry.label).toEqual({ message: entry.message });
      expect(await storedRows(f), entry.label).toEqual(beforeRows);
      expect(await storedFiles(), entry.label).toEqual(beforeFiles);
      expect(await documents(f), entry.label).toEqual([document]);
    }
  });

  it("requires PNG for a generated snapshot before retaining any PDF or document row", async () => {
    const f = await fixture();
    // GET establishes storage readiness; its .write-probe is not a document file.
    expect(await documents(f)).toEqual([]);
    const beforeRows = await storedRows(f);
    const beforeFiles = await storedFiles();
    const pdf = Buffer.from(`%PDF-1.4\nSYNTHETIC NOT A CONSENT ${f.marker}\n%%EOF\n`);
    const response = await upload(f, JSON.stringify(metadata(f)), pdf, "application/pdf");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "توقيع الإقرار المنشأ يتطلب صورة PNG." });
    expect(await storedRows(f)).toEqual(beforeRows);
    expect(await storedFiles()).toEqual(beforeFiles);
  });

  it("keeps free-text and unversioned originals available without presenting a reconstructed signed template", async () => {
    for (const note of ["SYNTHETIC ordinary original with unknown signing context", JSON.stringify({
      templateId: "root_canal", signatoryName: "SYNTHETIC UNVERIFIED LEGACY SIGNER", signatoryRelation: "self",
    })]) {
      const f = await fixture();
      const bytes = syntheticPng(`${f.marker}-legacy`);
      const response = await upload(f, note, bytes);
      expect(response.status).toBe(201);
      const document = await response.json() as PatientDocument;
      expect(document).toMatchObject({ patientId: f.patientId, visitId: f.visitId, note });
      expect(await documents(f)).toEqual([document]);
      const before = await storedRows(f);
      expectUnverified(await print(f, document.id), document.id);
      const original = await authedGet(`/api/documents/${document.id}`, h.sessions.doctorA);
      expect(original.status).toBe(200);
      expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
      expect(await storedRows(f)).toEqual(before);
    }
  });

  it("does not treat a pre-existing unknown schema version as a verified snapshot or an unsigned fallback", async () => {
    const f = await fixture();
    const { captured, bytes, document } = await uploadCaptured(f);
    const note = JSON.stringify({ ...captured, schemaVersion: 999 });
    await seedHistoricalNote(f, document.id, note);
    const before = await storedRows(f);
    expect(await documents(f)).toEqual([{ ...document, note }]);
    expectUnverified(await print(f, document.id), document.id);
    const original = await authedGet(`/api/documents/${document.id}`, h.sessions.doctorA);
    expect(original.status).toBe(200);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
    expect(await storedRows(f)).toEqual(before);
  });
});
