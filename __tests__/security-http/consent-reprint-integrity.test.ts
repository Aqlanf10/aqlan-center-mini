import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import sharp from "sharp";
import { chromium, type Browser, type Page } from "playwright";
import { authedGet, baseUrl, harness } from "./_server";
import { CONSENT_TEMPLATES } from "../../lib/consent-templates";

/**
 * إعادة طباعة الإقرار الموقّع تعتمد على الدليل المحفوظ وحده — على التطبيق المبني وبيانات اصطناعية.
 *
 * العيب على main: صفحة `/print/consent/[id]` كانت تقدّم قيم الرابط (templateId واسم الموقّع وصفته
 * والطبيب والتاريخ) على المستند المحفوظ، وتبني النص من قالب اليوم، ثم تضع تحت ذلك صورة التوقيع
 * المحفوظة. وتقبل أي مستندٍ للمريض نفسه — صورة أشعة مثلًا — كأنه «توقيع». ومستندٌ مفقود أو لمريضٍ
 * آخر يصير نموذجًا افتراضيًّا لا يقول إنه غير موقّع.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;

const stamp = Date.now();
const ARTIFACTS = join(process.cwd(), ".settings-ui-artifacts");
const [TEMPLATE_A, TEMPLATE_B] = CONSENT_TEMPLATES;
/* عنوانٌ مسجَّل يخالف عنوان القالب اليوم — يمثّل قالبًا تغيّر بعد التوقيع. */
const RECORDED_TITLE = `إقرار مسجّل قديم ${stamp}`;
const RECORDED_PROCEDURE = `إجراء مسجّل ${stamp}`;
const SIGNER = `موقّع اصطناعي ${stamp}`;
const SNAPSHOT_TERM = `بندٌ محفوظ وقت التوقيع ${stamp}`;

let doctorAParty = 0;
let doctorBParty = 0;
let patient1 = 0;
let patient2 = 0;
let signedDoc = 0;
let snapshotDoc = 0;
let foreignDoc = 0;
let photoDoc = 0;
let removedDoc = 0;
let malformedDoc = 0;
let missingFileDoc = 0;
let signatureBytes: Buffer;

type Who = "admin" | "reception" | "doctorA" | "doctorB" | "cashier" | "accountant";

async function signaturePng(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="140">
    <rect width="480" height="140" fill="white"/>
    <path d="M20 100 C 80 20, 120 140, 170 70 S 260 30, 300 95 S 400 120, 460 40" stroke="#0b3d91" stroke-width="5" fill="none"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function upload(patientId: number, input: { kind: string; note: string | null; title: string; bytes: Buffer }): Promise<number> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(input.bytes)], { type: "image/png" }), "signature.png");
  form.set("kind", input.kind);
  form.set("title", input.title);
  form.set("takenOn", "2026-03-15");
  if (input.note !== null) form.set("note", input.note);
  const response = await fetch(`${baseUrl}/api/patients/${patientId}/documents`, {
    method: "POST",
    headers: { Cookie: h.sessions.admin.cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
    body: form,
    redirect: "manual",
  });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return ((await response.json()) as { id: number }).id;
}

const consentNote = (extra: Record<string, unknown> = {}) => JSON.stringify({
  templateId: TEMPLATE_A.id,
  signatoryName: SIGNER,
  signatoryRelation: "self",
  guardianRelation: null,
  procedureName: RECORDED_PROCEDURE,
  title: RECORDED_TITLE,
  textNote: `الموقع: ${SIGNER}`,
  ...extra,
});

const printPath = (patientId: number, query: string) => `/print/consent/${patientId}?${query}`;
async function html(who: Who, path: string): Promise<{ status: number; body: string }> {
  const response = await authedGet(path, h.sessions[who]);
  return { status: response.status, body: await response.text() };
}
const showsSignatureOf = (body: string, docId: number) => body.includes(`/api/documents/${docId}"`);
/** النص المرئي فقط: يحذف سكربتات الإطار التي تردّد الرابط حرفيًّا في حمولة RSC. */
const visible = (body: string) => body.replace(/<script[\s\S]*?<\/script>/g, "");
const modeOf = (body: string) => body.match(/data-consent-mode="([a-z]+)"/)?.[1] ?? null;

async function documentDigest(docId: number): Promise<{ bytes: string; row: string }> {
  const response = await authedGet(`/api/documents/${docId}`, h.sessions.admin);
  const bytes = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
  const { rows: [row] } = await db.query(
    `SELECT kind, title, note, taken_on::text, uploaded_by, uploaded_at::text, removed_at::text, storage_key, size_bytes::text
       FROM patient_documents WHERE id = $1`, [docId]);
  return { bytes, row: JSON.stringify(row) };
}

async function setDoctorAPermissions(extra: Record<string, boolean>): Promise<string> {
  const { rows: [user] } = await db.query<{ permissions: string }>(`SELECT permissions FROM users WHERE username = 'secdoctora'`);
  const base = JSON.parse(user.permissions) as Record<string, boolean>;
  await db.query(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [JSON.stringify({ ...base, canViewAllPatients: false, ...extra })]);
  return user.permissions;
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [a] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const { rows: [b] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctorb'`);
  doctorAParty = a.party_id;
  doctorBParty = b.party_id;
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES
       ($1, $2, $3), ($4, $5, $6) RETURNING id`,
    [`CR-${stamp}-1`, `مريض إقرار أول ${stamp}`, doctorAParty, `CR-${stamp}-2`, `مريض إقرار ثانٍ ${stamp}`, doctorBParty]);
  [patient1, patient2] = rows.map((row) => row.id);

  signatureBytes = await signaturePng();
  signedDoc = await upload(patient1, { kind: "consent", note: consentNote(), title: `إقرار موافقة: ${RECORDED_PROCEDURE}`, bytes: signatureBytes });
  snapshotDoc = await upload(patient1, {
    kind: "consent", title: "إقرار بنص محفوظ", bytes: signatureBytes,
    // مسار الرفع يقصّ الملاحظة عند 300 حرف، فالنسخة الاصطناعية مضغوطة كي يبقى JSON سليمًا.
    note: JSON.stringify({ templateId: TEMPLATE_A.id, signatoryName: SIGNER, signatoryRelation: "self", terms: [SNAPSHOT_TERM], risks: ["خ"], postOpInstructions: ["ت"] }),
  });
  foreignDoc = await upload(patient2, { kind: "consent", note: consentNote(), title: "إقرار مريض آخر", bytes: signatureBytes });
  photoDoc = await upload(patient1, { kind: "photo", note: null, title: "صورة سريرية ليست توقيعًا", bytes: signatureBytes });
  removedDoc = await upload(patient1, { kind: "consent", note: consentNote(), title: "إقرار أُخفي", bytes: signatureBytes });
  malformedDoc = await upload(patient1, { kind: "consent", note: "ليس JSON", title: "إقرار بسجل ناقص", bytes: signatureBytes });
  missingFileDoc = await upload(patient1, { kind: "consent", note: consentNote(), title: "إقرار ملفه مفقود", bytes: signatureBytes });
  await db.query(`UPDATE patient_documents SET removed_at = NOW(), removed_by = 'secadmin', removed_note = 'اختبار' WHERE id = $1`, [removedDoc]);
  await db.query(`UPDATE patient_documents SET storage_key = $2 WHERE id = $1`, [missingFileDoc, `missing/${stamp}.png`]);

  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await db?.end();
});

describe("إعادة طباعة إقرارٍ موقّع — الدليل المحفوظ وحده", () => {
  it("المحفوظ يُعرض كما سُجّل، ولا يُبنى نص الإقرار من قالب اليوم", async () => {
    const { status, body } = await html("admin", printPath(patient1, `docId=${signedDoc}`));
    expect(status).toBe(200);
    expect(modeOf(body)).toBe("signed");
    expect(showsSignatureOf(body, signedDoc)).toBe(true);
    expect(body).toContain(SIGNER);
    expect(body).toContain(RECORDED_TITLE);
    expect(body).toContain(RECORDED_PROCEDURE);
    /* القالب الحالي تغيّر بعد التوقيع: لا عنوانه ولا بنوده تُقدَّم نصًّا موقّعًا. */
    expect(body).not.toContain(TEMPLATE_A.terms[0]);
    expect(body).not.toContain(TEMPLATE_A.risks[0]);
    expect(body).toContain("لم يحفظ هذا السجل نص الإقرار");
  });

  it("إن حُفظ نصّ الإقرار مع السجل يُعرض هو — لا نص القالب الحالي", async () => {
    const { body } = await html("admin", printPath(patient1, `docId=${snapshotDoc}`));
    expect(modeOf(body)).toBe("signed");
    expect(body).toContain(SNAPSHOT_TERM);
    expect(body).not.toContain(TEMPLATE_A.terms[0]);
  });

  it("كل قيمةٍ في الرابط تخالف المحفوظ تُرفض — ولا يظهر التوقيع تحتها", async () => {
    const overrides = [
      `templateId=${TEMPLATE_B.id}`, `template=${TEMPLATE_B.id}`, "signatoryName=" + encodeURIComponent("موقّع مزوّر"),
      "signatoryRelation=guardian", "guardianRelation=" + encodeURIComponent("قريب مزوّر"),
      "doctorName=" + encodeURIComponent("طبيب مزوّر"), "date=2001-01-01",
    ];
    for (const override of overrides) {
      const { status, body } = await html("admin", printPath(patient1, `docId=${signedDoc}&${override}`));
      expect(status, override).toBe(200);
      expect(modeOf(body), override).toBe("refused");
      expect(showsSignatureOf(body, signedDoc), override).toBe(false);
      expect(visible(body), override).not.toMatch(/مزوّر/);
      expect(visible(body), override).not.toContain(TEMPLATE_B.terms[0]);
    }
  });

  it("مستند مريضٍ آخر، أو ليس إقرارًا، أو مخفي، أو بسجلٍّ ناقص، أو ملفه مفقود، أو غير موجود: رفضٌ صريح بلا توقيع ولا نموذج", async () => {
    const cases: Array<[string, number, number]> = [
      ["مريض آخر", patient1, foreignDoc],
      ["المريض الآخر نفسه لمستند الأول", patient2, signedDoc],
      ["صورة ليست إقرارًا", patient1, photoDoc],
      ["مخفي", patient1, removedDoc],
      ["سجل ناقص", patient1, malformedDoc],
      ["ملف مفقود", patient1, missingFileDoc],
      ["غير موجود", patient1, 999_999_999],
    ];
    for (const [label, patientId, docId] of cases) {
      const { status, body } = await html("admin", printPath(patientId, `docId=${docId}`));
      expect(status, label).toBe(200);
      expect(modeOf(body), label).toBe("refused");
      expect(showsSignatureOf(body, docId), label).toBe(false);
      expect(body, label).not.toContain(TEMPLATE_A.terms[0]);
      expect(body, label).not.toContain("نموذج غير موقّع");
    }
    expect(modeOf((await html("admin", printPath(patient1, "docId=abc"))).body)).toBe("refused");
  });
});

describe("نموذج غير موقّع", () => {
  it("يُطبع بالقالب المطلوب وبعلامة «نموذج غير موقّع»، بلا توقيعٍ ولا بيانات موقّعٍ من الرابط", async () => {
    const { status, body } = await html("admin", printPath(patient1, `templateId=${TEMPLATE_B.id}&signatoryName=${encodeURIComponent("اسم من الرابط")}&date=2001-01-01`));
    expect(status).toBe(200);
    expect(modeOf(body)).toBe("blank");
    expect(body).toContain("نموذج غير موقّع");
    expect(body).toContain(TEMPLATE_B.terms[0]);
    expect(visible(body)).not.toContain("اسم من الرابط");
    expect(body).not.toMatch(/\/api\/documents\/\d+"/);
    /* رابط المساعد الذكي يمرّر `template=`. */
    expect((await html("admin", printPath(patient1, `template=${TEMPLATE_B.id}`))).body).toContain(TEMPLATE_B.terms[0]);
  });
});

describe("الصلاحيات — المالك والصلاحيات الحالية نفسها", () => {
  it("التوقيع يظهر فقط لمن يحقّ له فتح المستند نفسه، والممنوع لا يرى نموذجًا بديلًا", async () => {
    const original = await setDoctorAPermissions({ canViewXrays: true });
    try {
      const check = async (who: Who) => {
        const documentStatus = (await authedGet(`/api/documents/${signedDoc}`, h.sessions[who])).status;
        const page = await html(who, printPath(patient1, `docId=${signedDoc}`));
        return { who, documentStatus, pageStatus: page.status, mode: modeOf(page.body), signature: showsSignatureOf(page.body, signedDoc) };
      };
      const results = await Promise.all((["admin", "reception", "doctorA", "doctorB", "cashier", "accountant"] as Who[]).map(check));
      for (const result of results) {
        /* التوقيع يظهر إن وفقط إن فتح الدور المستند نفسه. */
        expect(result.signature, JSON.stringify(result)).toBe(result.documentStatus === 200);
        if (!result.signature) expect(result.mode === "signed", JSON.stringify(result)).toBe(false);
      }
      expect(results.find((r) => r.who === "admin")!.signature).toBe(true);
      expect(results.find((r) => r.who === "doctorA")!.signature).toBe(true);
      expect(results.find((r) => r.who === "doctorB")!.pageStatus).toBe(404);
      expect(results.find((r) => r.who === "cashier")!.signature).toBe(false);

      /* طبيبٌ مالك بلا صلاحية «الأشعة والمستندات»: لا توقيع، رفضٌ صريح. */
      await setDoctorAPermissions({ canViewXrays: false });
      const denied = await check("doctorA");
      expect(denied.documentStatus).toBe(403);
      expect(denied.signature).toBe(false);
      expect(denied.mode).toBe("refused");
    } finally {
      await db.query(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [original]);
    }
  });
});

describe("المستند التاريخي لا يتغيّر", () => {
  it("بايتات التوقيع وسجله كما هي بعد كل الطباعات والرفض", async () => {
    const before = await documentDigest(signedDoc);
    expect(before.bytes).toBe(createHash("sha256").update(signatureBytes).digest("hex"));
    for (const query of [`docId=${signedDoc}`, `docId=${signedDoc}&templateId=${TEMPLATE_B.id}`, `docId=${signedDoc}&date=2001-01-01`]) {
      await html("admin", printPath(patient1, query));
    }
    expect(await documentDigest(signedDoc)).toEqual(before);
  });
});

describe("الورق والشاشة — A4 وRTL", () => {
  async function open(path: string, width = 1280): Promise<Page> {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage();
    await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-consent-mode]").waitFor({ timeout: 60_000 });
    return page;
  }

  it("الإقرار الموقّع والنموذج غير الموقّع يُطبعان A4 بصفحةٍ واحدة، وRTL، ولقطات 390 و1280", async () => {
    await mkdir(ARTIFACTS, { recursive: true });
    for (const [name, query] of [["signed", `docId=${signedDoc}`], ["blank", `templateId=${TEMPLATE_B.id}`], ["refused", `docId=${signedDoc}&templateId=${TEMPLATE_B.id}`]] as const) {
      const page = await open(printPath(patient1, query));
      try {
        expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
        if (name === "signed") {
          await page.locator("[data-signature-img]").evaluate((img: HTMLImageElement) => img.decode());
          expect(await page.locator("[data-signature-img]").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
        }
        await page.screenshot({ path: join(ARTIFACTS, `consent-${name}-1280.png`), fullPage: true });
        await page.emulateMedia({ media: "print" });
        const path = join(ARTIFACTS, `consent-${name}.pdf`);
        await page.pdf({ path, preferCSSPageSize: true, printBackground: true });
        const info = execFileSync("pdfinfo", [path], { encoding: "utf8" });
        expect(info).toMatch(/Page size:\s+59\d\.\d+ x 84\d\.\d+/);
        if (name !== "refused") expect(info, name).toMatch(/Pages:\s+1\b/);
      } finally {
        await page.context().close();
      }
      const mobile = await open(printPath(patient1, query), 390);
      try {
        expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await mobile.screenshot({ path: join(ARTIFACTS, `consent-${name}-390.png`), fullPage: true });
      } finally {
        await mobile.context().close();
      }
    }
  });
});
