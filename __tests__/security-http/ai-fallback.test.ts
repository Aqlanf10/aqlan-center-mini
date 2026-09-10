import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  baseUrl,
  harness,
  authedMutation,
  TEST_PATIENTS,
  TEST_USERS,
} from "./_server";

/**
 * اختبارات إجبار فشل المزودين على HTTP حقيقي (P2-FIX-3):
 *
 * تُبذر قاعدة الاختبار المعزولة بمزودٍ سحابي مُعطَّل عمداً (مفتاح غير قابل
 * للفك) وتُفعَّل الخدمة — فيمرّ كل سؤال سريري بالمحاولة السحابية ثم فشلها
 * المحتم. المطلوب المُثبت: **ردّ processAssistantQuery المُصرّح به يبقى**،
 * ولا يظهر في أي سيناريو:
 *   • محرك أسنان قديم بسياق admin مصطنع (userRole=admin / كل المرضى / كل المالية)
 *   • ملف مريضٍ رقميّ يُفتح بلا حاجز مركزي (getPatientFile مباشرة)
 *   • أرصدة/فواتير/تكاليف خطط لطبيبٍ بلا صلاحية مالية
 *   • أنظمة الأدوية الثابتة القديمة لحسابٍ بلا هوية سريرية
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;

interface AiChatPayload {
  ok?: boolean;
  reply?: string;
  answer?: string;
  intent?: string;
  model?: string;
  sourceType?: string;
  warnings?: string[];
  message?: string;
}

function chatText(payload: AiChatPayload): string {
  return `${payload.reply ?? ""}\n${payload.answer ?? ""}\n${(payload.warnings ?? []).join("\n")}`;
}

async function ask(
  session: (typeof h)["sessions"]["doctorA"],
  message: string,
): Promise<{ status: number; payload: AiChatPayload }> {
  const response = await authedMutation("/api/ai/chat", session, "POST", JSON.stringify({ message }));
  const payload = (await response.json().catch(() => ({}))) as AiChatPayload;
  return { status: response.status, payload };
}

beforeAll(async () => {
  h = await harness();
  const state = JSON.parse(
    readFileSync(join(process.cwd(), ".sec-http-state.json"), "utf8"),
  ) as { dbUrl: string };

  db = new Client({ connectionString: state.dbUrl, ssl: false });
  await db.connect();

  /* مزودٌ مُعطَّل عمداً: المفتاح غير قابل للفك ⇒ المحول يفشل فوراً وبشكل
     حتمي قبل أي شبكة، والسلسلة كاملة تنفد ⇒ executeAiChatWithFallback
     يعيد ok:false (بعد P2-FIX-3). */
  await db.query(
    `INSERT INTO ai_providers (
       id, name, protocol_type, base_url, model, models, api_key_enc,
       enabled, is_default, priority, timeout_ms, max_tokens, temperature,
       custom_headers, task_models, created_at, updated_at
     )
     VALUES (
       'sec-forced-fail', 'مزود الفشل الإجباري (اختبار)', 'openai-compatible',
       'https://sec-forced-failure.invalid', 'test-model', ARRAY['test-model'],
       'not-a-valid-encrypted-secret', TRUE, TRUE, 1, 15000, 256, 0.2,
       '{}', '{}', NOW(), NOW()
     )
     ON CONFLICT (id) DO UPDATE SET
       enabled = TRUE, is_default = TRUE, priority = 1,
       api_key_enc = 'not-a-valid-encrypted-secret'`,
  );

  /* الخدمة مفعّلة بمفتاح (hasKey=true) — لتبدأ المحاولة السحابية أصلًا.
     الصف نفسه هو المستهلك في settings.hasKey لا في السلسلة. */
  await db.query(
    `INSERT INTO ai_settings (
       id, enabled, provider, base_url, model, api_key_enc, updated_by, updated_at
     )
     VALUES (1, TRUE, 'zai', 'https://sec-forced-failure.invalid', 'test-model',
             'not-a-valid-encrypted-secret', 'sec-http-test', NOW())
     ON CONFLICT (id) DO UPDATE SET
       enabled = TRUE, api_key_enc = 'not-a-valid-encrypted-secret',
       base_url = 'https://sec-forced-failure.invalid', model = 'test-model'`,
  );
}, 240_000);

afterAll(async () => {
  if (db) {
    await db.query(`DELETE FROM ai_providers WHERE id = 'sec-forced-fail'`).catch(() => null);
    await db.query(`UPDATE ai_settings SET enabled = FALSE, api_key_enc = NULL WHERE id = 1`).catch(() => null);
    await db.end().catch(() => null);
  }
});

describe("(P2-FIX-3) طبيب أ ضد مريض الطبيب ب — لا بيانات مهما كان السؤال", () => {
  it("A) سؤال برقم مريض ب (ملف رقمي) ⇒ لا اسم ولا هاتف ولا مالية — رفض عزل صريح", async () => {
    // رقم ملف مريض ب بصيغة رقمية مباشرة (0-pad يضمن اكتشاف النمط الرقمي) —
    // الرقم وحده لا يثبت تصريحاً: الحاجز المركزي يرفض قبل فتح أي ملف.
    const { status, payload } = await ask(
      h.sessions.doctorA,
      `ما حال المريض رقم 00${h.seeded.patientBId}؟`,
    );
    expect(status).toBe(200);
    const text = chatText(payload);
    expect(text).not.toContain(TEST_PATIENTS.patientB.phone); // هاتف ب
    expect(text).not.toContain(TEST_PATIENTS.patientB.patientNumber); // SECB-002
    expect(text).not.toContain("المفوتر"); // لا مالية
    expect(text).not.toContain("المسدد");
    // الرد المُصرّح: رفض عزل مركزي لا بطاقة مريض (ولا صدى للمعرف المطلوب)
    expect(text).toContain("ليس لديك صلاحية");
  });

  it("B) سؤال باسم مريض ب ⇒ النتيجة نفسها (البحث المقيد لا يفتح ملف غير مسند)", async () => {
    const { status, payload } = await ask(
      h.sessions.doctorA,
      `أين ملف ${TEST_PATIENTS.patientB.fullName}؟`,
    );
    expect(status).toBe(200);
    const text = chatText(payload);
    expect(text).not.toContain(TEST_PATIENTS.patientB.phone);
    expect(text).not.toContain(TEST_PATIENTS.patientB.patientNumber);
    expect(text).not.toContain("بطاقة المريض");
    expect(text).not.toContain("المفوتر");
  });

  it("C) طبيب أ يسأل عن مريضه أصلًا ⇒ الرد بالحقول المسموحة (السلوك المشروع سليم)", async () => {
    const { status, payload } = await ask(
      h.sessions.doctorA,
      `ما حال المريض ${TEST_PATIENTS.patientA.fullName}؟`,
    );
    expect(status).toBe(200);
    const text = chatText(payload);
    expect(text).toContain(TEST_PATIENTS.patientA.patientNumber); // SECA-001 ظاهر (مسموح)
  });

  it("D) طبيب أ (بلا صلاحية مالية) يسأل حساب مريضه ⇒ لا رصيد ولا فواتير ولا تكاليف خطط", async () => {
    const { status, payload } = await ask(
      h.sessions.doctorA,
      `كم باقي على المريض ${TEST_PATIENTS.patientA.fullName}؟`,
    );
    expect(status).toBe(200);
    const text = chatText(payload);
    expect(text).not.toContain("المفوتر");
    expect(text).not.toContain("المسدد");
    expect(text).not.toContain("الحساب الحالي");
    // إعلان الحجب لا تمرير صامت:
    expect(text).toContain("محجوب");
  });
});

describe("(P2-FIX-3) حدود الأدوار مع فشل المزودين", () => {
  it("E) الاستقبال (بلا صلاحية AI) ⇒ 403 — لا معلومات سريرية إطلاقًا", async () => {
    const { status, payload } = await ask(
      h.sessions.reception,
      "كم جرعة أموكسيسيلين للبالغين؟",
    );
    expect(status).toBe(403);
    expect(chatText(payload)).not.toContain("مجم/كجم");
  });

  it("F) المدير يسأل عن مريض ب ⇒ سياسة المدير الطبيعية تعمل (رؤية كاملة مسموحة)", async () => {
    const { status, payload } = await ask(
      h.sessions.admin,
      `ما حال المريض رقم 00${h.seeded.patientBId}؟`,
    );
    expect(status).toBe(200);
    const text = chatText(payload);
    expect(text).toContain(TEST_PATIENTS.patientB.patientNumber); // المدير يرى كما في المسار الرسمي
  });

  it("G) فشل المزود إجباريًا ⇒ ردّ المحرك المحلي المُصرّح به يبقى — لا fallback مسمّى احتياطيًا", async () => {
    const { status, payload } = await ask(
      h.sessions.doctorA,
      "ما بروتوكول التخدير الموضعي لحالة التهاب عصب حاد؟",
    );
    expect(status).toBe(200);
    expect(payload.ok).toBe(true);
    const text = chatText(payload);
    // ردّ محلي حقيقي (المحرك المُصرّح به بسياق الطبيب أ) لا فارغ ولا اختراع:
    expect(text.length).toBeGreaterThan(80);
    expect(payload.sourceType).toBe("internal_engine");
    // بصمة الـfallback القديم (محرك المركز الداخلي الاحتياطي) غائبة كليًا:
    expect(payload.model ?? "").not.toContain("الاحتياطي");
    expect(payload.model ?? "").not.toContain("Aqlan Internal Engine");
  });

  it("H) فشل المزود + سؤال دوائي من حسابٍ بلا هوية سريرية (مدير بلا جهة طبيب) ⇒ لا أنظمة أدوية قديمة", async () => {
    const { status, payload } = await ask(
      h.sessions.admin,
      "كم جرعة أموكسيسيلين وفلاجيل للبالغين؟",
    );
    expect(status).toBe(200);
    const text = chatText(payload);
    // بوابة الهوية السريرية تمنع المحرك قبل أي نظام دوائي ثابت:
    expect(text).toContain("الهوية السريرية");
    expect(text).not.toContain("مجم/كجم");
    expect(text).not.toContain("Disulfiram");
    expect(payload.intent).toBe("clinical_scope_rejection");
  });
});

describe("(P2-FIX-3) عقود الانحدار المباشرة", () => {
  it("توكنات الاختبار موقّعة للمستخدمين الصحيحين (لا تسريب بين الأدوار عبر Bearer)", async () => {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${h.sessions.doctorA.token}` },
    });
    const identity = (await response.json()) as { username?: string };
    expect(identity.username).toBe(TEST_USERS.doctorA.username);
  });
});
