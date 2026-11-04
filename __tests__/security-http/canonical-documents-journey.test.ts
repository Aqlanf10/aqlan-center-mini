/**
 * M2 slice 75 — canonical patient documents and X-rays, built application, owned
 * database, server and storage. Synthetic data only.
 *
 * - HTTP: multipart upload under clinical.xrays.upload with a request key (a repeat keeps
 *   one document), download with no-store/nosniff, outside the scope 404, a forged
 *   signature 400 with no file, hide needs patients.documents.delete.
 * - Browser: the canonical patient file reads nothing until the documents section is
 *   opened, then lists the X-ray; no failed API call; no DDL.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";

const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
  owner: { username: "canon-doc-owner", password: "Canon#DocOwner1", role: "admin", display: "المالك التجريبي" },
  doctor: { username: "canon-doc-doc", password: "Canon#DocDoc1", role: "doctor", display: "د. أشعة تجريبي", doctor: true, patientScope: "own",
    grants: { "clinical.xrays.view": true, "clinical.xrays.upload": true } },
  viewer: { username: "canon-doc-view", password: "Canon#DocView1", role: "reception", display: "مطّلع", patientScope: "all",
    grants: { "clinical.xrays.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let journey: CanonicalJourney<Key>;
const ids = { mine: 0, other: 0, document: 0 };
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c489" + "0000000d49444154789c626001000000050001a5f645400000000049454e44ae426082", "hex");
function upload(patientId: number, cookie: string, fields: Record<string, string>, bytes: Buffer = PNG) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "syn.png", { type: "image/png" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return fetch(`${journey.baseUrl}/api/patients/${patientId}/documents`, { method: "POST", body: form, headers: { cookie, Origin: journey.baseUrl }, redirect: "manual" });
}

beforeAll(async () => {
  journey = await openCanonicalJourney({
    portOffset: 126, secret: "canonical-documents-journey-secret-0123456789abcdef", accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db, _ids, parties) {
      ids.mine = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ('SYN-DJ-1','مريض الأشعة التجريبي','0500000931',$1) RETURNING id", [parties.doctor!])).rows[0].id;
      ids.other = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-DJ-2','مريض بعيد','0500000932') RETURNING id")).rows[0].id;
    },
  });
}, 300_000);
afterAll(async () => { await journey?.close(); }, 60_000);

it("HTTP: upload by request key, download, scope, forged signature and the hide grant", async () => {
  const doctor = await journey.login("doctor");
  const fields = { kind: "xray", title: "أشعة بانورامية اصطناعية", requestKey: "journey-document-key-0001" };
  const first = await upload(ids.mine, doctor.cookie, fields);
  expect(first.status).toBe(201);
  const stored = await first.json();
  ids.document = stored.id;
  expect(JSON.stringify(stored)).not.toMatch(/storage_?key/i);
  expect(await (await upload(ids.mine, doctor.cookie, fields)).json()).toMatchObject({ id: ids.document, replayed: true });
  expect((await journey.db.query("SELECT count(*)::int AS n FROM patient_documents WHERE patient_id=$1", [ids.mine])).rows[0].n).toBe(1);

  const file = await journey.api(`/api/documents/${ids.document}`, doctor.cookie);
  expect(file.status).toBe(200);
  expect(file.headers.get("cache-control")).toContain("no-store");
  expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);

  expect((await upload(ids.other, doctor.cookie, { kind: "xray" })).status).toBe(404);
  const forged = await upload(ids.mine, doctor.cookie, { kind: "xray" }, Buffer.from("MZ not an image"));
  expect(forged.status).toBe(400);
  expect((await forged.json()).message).toMatch(ARABIC);
  expect((await journey.db.query("SELECT count(*)::int AS n FROM patient_documents WHERE patient_id=$1", [ids.mine])).rows[0].n).toBe(1);

  const viewer = await journey.login("viewer");
  const hide = await journey.api(`/api/documents/${ids.document}`, viewer.cookie, { method: "DELETE", body: JSON.stringify({ note: "مكرر" }) });
  expect(hide.status).toBe(403);
  expect((await hide.json()).message).toMatch(ARABIC);
  expect(await journey.ddlLog()).toEqual([]);
});

it("browser: the canonical patient file lists the X-ray", async () => {
  const context = await journey.browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar", timezoneId: "Asia/Aden" });
  const page = await context.newPage();
  await journey.browserLogin(page, "viewer");
  const failures: string[] = [];
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${path}`); });
  const documentCalls: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.includes("/documents")) documentCalls.push(path); });
  await page.goto(`${journey.baseUrl}/patients/${ids.mine}`);
  const section = page.getByTestId("canonical-documents");
  await section.waitFor();
  // Nothing (no list, no image) is read until the section is opened.
  expect(documentCalls).toEqual([]);
  await section.locator("summary").click();
  await section.getByText("أشعة بانورامية اصطناعية").first().waitFor();
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await context.close();
  expect(await journey.ddlLog()).toEqual([]);
});
