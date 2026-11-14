/** M2 slice 75: canonical patient documents and X-rays on real PostgreSQL with a
 * temporary storage directory, synthetic data only. clinical.xrays.view/upload inside
 * the patient scope; admission before any disk write; signature mismatch audited
 * without a file; request-key receipt; hide by patients.documents.delete with reason;
 * photo by patients.edit; revocation. */
vi.mock("server-only", () => ({}));
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-documents-2026");
const storageDir = mkdtempSync(join(tmpdir(), "syn-docs-"));
vi.stubEnv("DOCUMENTS_DIR", storageDir);
const db = await import("../../lib/db");
const docs = await import("../../lib/canonical-documents");

const ACCOUNTS = {
  owner: { username: "SYN-DOC-OWNER", role: "admin" },
  doctor: { username: "SYN-DOC-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.xrays.view": true, "clinical.xrays.upload": true } },
  viewer: { username: "SYN-DOC-VIEW", role: "reception", patientScope: "all", grants: { "clinical.xrays.view": true } },
  hider: { username: "SYN-DOC-HIDE", role: "reception", patientScope: "all", grants: { "clinical.xrays.view": true, "patients.documents.delete": true, "patients.edit": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number }) => error);
const ids = { mine: 0, other: 0 };
// A minimal valid PNG (signature + IHDR 1x1).
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c489" + "0000000d49444154789c626001000000050001a5f645400000000049454e44ae426082", "hex");
const files = () => readdirSync(storageDir, { recursive: true }).filter(name => !String(name).endsWith("/")).length;
function form(fields: Record<string, string>, bytes: Buffer = PNG, type = "image/png") {
  const data = new FormData();
  data.set("file", new File([new Uint8Array(bytes)], "syn.png", { type }));
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return docs.parseCanonicalDocumentUpload(data);
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000941',$3) RETURNING id", [number, `SYN Doc ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-DOC-1", fx.parties.doctor!);
  ids.other = await patient("SYN-DOC-2", null);
}, 180_000);
afterAll(async () => { await fx?.close(); rmSync(storageDir, { recursive: true, force: true }); });

describe("upload", () => {
  it("stores the file and its row with the audit; a double press with one key keeps one document", async () => {
    const input = form({ kind: "xray", title: "أشعة اصطناعية", requestKey: "syn-doc-upload-key-0001" });
    const [a, b] = await Promise.all([
      docs.commandCanonicalDocumentUpload(await fx.session("doctor"), String(ids.mine), input),
      docs.commandCanonicalDocumentUpload(await fx.session("doctor"), String(ids.mine), form({ kind: "xray", title: "أشعة اصطناعية", requestKey: "syn-doc-upload-key-0001" })),
    ]);
    expect(a.kind).toBe("stored");
    expect(b.kind).toBe("stored");
    if (a.kind !== "stored" || b.kind !== "stored") return;
    expect(a.document.id).toBe(b.document.id);
    expect([a.document.replayed, b.document.replayed].sort()).toEqual([false, true]);
    expect((await q("SELECT count(*)::int AS n FROM patient_documents WHERE patient_id=$1", [ids.mine]))[0].n).toBe(1);
    expect((await q("SELECT actor FROM audit_log WHERE action='document.upload' AND entity_id=$1::text", [a.document.id])).map(row => row.actor)).toEqual(["SYN-DOC-DOC"]);
    expect(JSON.stringify(a)).not.toMatch(/storage_?key/i);
  });
  it("refuses outside the scope, without the grant and on a forged signature — and writes no file", async () => {
    const before = files();
    expect(await refusal(docs.commandCanonicalDocumentUpload(await fx.session("doctor"), String(ids.other), form({ kind: "xray" }))))
      .toMatchObject({ code: "patient_not_found", status: 404 });
    await expect(docs.commandCanonicalDocumentUpload(await fx.session("viewer"), String(ids.mine), form({ kind: "xray" }))).rejects.toThrow("CAPABILITY_DENIED");
    const forged = await docs.commandCanonicalDocumentUpload(await fx.session("doctor"), String(ids.mine), form({ kind: "xray" }, Buffer.from("MZ not an image at all"), "image/png"));
    expect(forged).toEqual({ kind: "rejected_signature" });
    expect((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='document.upload.rejected_signature' AND entity_id=$1::text", [ids.mine]))[0].n).toBe(1);
    expect(files()).toBe(before);
  });
});

describe("reads, hide and photo", () => {
  it("lists and opens inside the scope; hidden ones only for the hider; hide needs a reason and its grant", async () => {
    const stored = await docs.commandCanonicalDocumentUpload(await fx.session("doctor"), String(ids.mine), form({ kind: "photo", title: "صورة اصطناعية" }));
    if (stored.kind !== "stored") throw new Error("not stored");
    const id = stored.document.id;
    expect((await docs.readCanonicalDocumentFile(await fx.session("viewer"), String(id))).bytes.equals(PNG)).toBe(true);
    expect(await refusal(docs.readCanonicalDocumentFile(await fx.session("doctor"), "999999"))).toMatchObject({ code: "document_not_found", status: 404 });
    await expect(docs.commandCanonicalDocumentHide(await fx.session("viewer"), String(id), { note: "مكرر" })).rejects.toThrow("CAPABILITY_DENIED");
    expect(await refusal(docs.commandCanonicalDocumentHide(await fx.session("hider"), String(id), { note: "x" }))).toMatchObject({ status: 400, field: "note" });
    // The photo points at it, then the hide clears the pointer in the same transaction.
    expect(await docs.commandCanonicalPatientPhoto(await fx.session("hider"), String(ids.mine), { documentId: id })).toEqual({ id: ids.mine, photoDocumentId: id });
    expect(await docs.commandCanonicalDocumentHide(await fx.session("hider"), String(id), { note: "صورة مكررة" })).toEqual({ ok: true });
    expect((await q("SELECT photo_document_id FROM patients WHERE id=$1", [ids.mine]))[0].photo_document_id).toBeNull();
    expect((await q("SELECT actor FROM audit_log WHERE action='document.remove' AND entity_id=$1::text", [id])).map(row => row.actor)).toEqual(["SYN-DOC-HIDE"]);
    expect((await docs.readCanonicalPatientDocuments(await fx.session("viewer"), ids.mine)).documents.map(row => row.id)).not.toContain(id);
    expect((await docs.readCanonicalPatientDocuments(await fx.session("hider"), ids.mine)).documents.map(row => row.id)).toContain(id);
    expect(await refusal(docs.readCanonicalDocumentFile(await fx.session("viewer"), String(id)))).toMatchObject({ code: "document_hidden" });
  });
  it("a document of a patient outside the scope reads as missing; revocation refuses an earlier session", async () => {
    const otherDoc = await docs.commandCanonicalDocumentUpload(await fx.session("owner"), String(ids.other), form({ kind: "xray" }));
    if (otherDoc.kind !== "stored") throw new Error("not stored");
    expect(await refusal(docs.readCanonicalDocumentFile(await fx.session("doctor"), String(otherDoc.document.id)))).toMatchObject({ code: "document_not_found" });
    expect(await refusal(docs.readCanonicalPatientDocuments(await fx.session("doctor"), ids.other))).toMatchObject({ code: "patient_not_found" });
    const issued = await fx.session("hider");
    await fx.setGrants("hider", { "clinical.xrays.view": true }, { patientScope: "all" });
    try {
      await expect(docs.commandCanonicalDocumentHide(issued, String(otherDoc.document.id), { note: "بعد السحب" })).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT|CAPABILITY_DENIED/);
    } finally { await fx.setGrants("hider", { "clinical.xrays.view": true, "patients.documents.delete": true, "patients.edit": true }, { patientScope: "all" }); }
    expect((await q("SELECT removed_at FROM patient_documents WHERE id=$1", [otherDoc.document.id]))[0].removed_at).toBeNull();
  });
});
