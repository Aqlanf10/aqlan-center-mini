import { beforeAll, describe, expect, it } from "vitest";
import {
  baseUrl,
  harness,
  authedGet,
  authedMutation,
} from "./_server";

/**
 * مصفوفة هجوم RBAC/BOLA على HTTP الحقيقي (P2/S15) — الأدوار الثمانية
 * مطروقة مباشرة عبر API لا عبر أزرار الواجهة: طبيب أ ضد مريض ب،
 * الاستقبال ضد CDS السريري، المحاسب ضد الكتابة السريرية، الطبيب ضد
 * المالية، بوابة أ ضد ب، مجهول ضد كل شيء، ولا توكن يتحول بين المجالين.
 */

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
}, 240_000);

describe("عزل الأطباء (BOLA)", () => {
  it("الطبيب أ لا يقرأ ملف مريض الطبيب ب (GET patients/{B})", async () => {
    const response = await authedGet(`/api/patients/${h.seeded.patientBId}`, h.sessions.doctorA);
    expect(response.status).toBe(403);
  });

  it("الطبيب أ لا يرى مستندات مريض الطبيب ب", async () => {
    const response = await authedGet(`/api/patients/${h.seeded.patientBId}/documents`, h.sessions.doctorA);
    expect(response.status).toBe(403);
  });

  it("الطبيب أ يقرأ ملف مريضه (السلوك المشروع لا يُكسر)", async () => {
    const response = await authedGet(`/api/patients/${h.seeded.patientAId}`, h.sessions.doctorA);
    expect(response.status).toBe(200);
  });

  it("الطبيب ب لا يكتب على مريض الطبيب أ (PATCH)", async () => {
    const response = await authedMutation(
      `/api/patients/${h.seeded.patientAId}`,
      h.sessions.doctorB,
      "PATCH",
      JSON.stringify({ address: "محاولة كتابة عبر الحدود" }),
    );
    expect(response.status).toBe(403);
  });

  it("صفحات الطباعة تحترم العزل نفسه: dossier مريض ب من طبيب أ ⇒ 404", async () => {
    const blocked = await fetch(`${baseUrl}/print/dossier/${h.seeded.patientBId}`, {
      headers: { Cookie: h.sessions.doctorA.cookie },
      redirect: "manual",
    });
    expect(blocked.status).toBe(404);
    const allowed = await fetch(`${baseUrl}/print/dossier/${h.seeded.patientAId}`, {
      headers: { Cookie: h.sessions.doctorA.cookie },
      redirect: "manual",
    });
    expect([200, 404]).toContain(allowed.status);
  });
});

describe("حدود الأدوار الوظيفية", () => {
  it("الاستقبال لا يكتب التوثيق السريري (clinical CDS) — الكتابة للطبيب والمدير", async () => {
    const response = await authedMutation(
      `/api/visits/${h.seeded.visitId}/clinical`,
      h.sessions.reception,
      "POST",
      JSON.stringify({ action: "save", chiefComplaint: "محاولة كتابة سريرية" }),
    );
    expect(response.status).toBe(403);
  });

  it("الطبيب ب لا يقرأ توثيق زيارة مريض الطبيب أ (عزل CDS)", async () => {
    const response = await authedGet(`/api/visits/${h.seeded.visitId}/clinical`, h.sessions.doctorB);
    expect(response.status).toBe(403);
  });

  it("المحاسب لا يحصل على كتابة سريرية (clinical POST)", async () => {
    const response = await authedMutation(
      `/api/visits/${h.seeded.visitId}/clinical`,
      h.sessions.accountant,
      "POST",
      JSON.stringify({ action: "save", data: {} }),
    );
    expect(response.status).toBe(403);
  });

  it("الطبيب بلا صلاحية مالية لا يرى الدفعات (canHandleMoney)", async () => {
    const response = await authedGet("/api/payments", h.sessions.doctorA);
    expect(response.status).toBe(403);
  });

  it("الاستقبال (صاحب المالية في هذا النظام) يصل الدفعات — والسلوك المشروع لا يُكسر", async () => {
    const response = await authedGet("/api/payments", h.sessions.reception);
    expect(response.status).toBe(200);
  });

  it("المحاسب (بلا canHandleMoney في نظام الأدوار الثلاثة) ممنوع من الدفعات أيضًا", async () => {
    const response = await authedGet("/api/payments", h.sessions.accountant);
    expect(response.status).toBe(403);
  });

  it("صفحة طباعة فاتورة (مالية) للطبيب ⇒ 404 — canHandleMoney محترم", async () => {
    const response = await fetch(`${baseUrl}/print/invoice/1`, {
      headers: { Cookie: h.sessions.doctorA.cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(404);
  });
});

describe("عزل بوابة المريض", () => {
  it("بوابة أ ترى هويتها وبياناتها فقط — لا معرف مريض من العميل يبدل الهوية", async () => {
    const me = await fetch(`${baseUrl}/api/portal/me`, {
      headers: { Cookie: h.sessions.portalA.cookie },
    });
    expect(me.status).toBe(200);
    const identity = await me.text();
    expect(identity).toContain("SECA-001");
    expect(identity).not.toContain("SECB-002");

    const statement = await fetch(`${baseUrl}/api/portal/statement`, {
      headers: { Cookie: h.sessions.portalA.cookie },
    });
    expect(statement.status).toBe(200);

    // محاولة انتحال معرف ب على كشف الحساب:
    const spoofed = await fetch(`${baseUrl}/api/portal/statement?patientId=${h.seeded.patientBId}`, {
      headers: { Cookie: h.sessions.portalA.cookie },
    });
    expect(spoofed.status).toBe(200);
    const spoofedMe = await fetch(`${baseUrl}/api/portal/me?patientId=${h.seeded.patientBId}`, {
      headers: { Cookie: h.sessions.portalA.cookie },
    });
    const spoofedIdentity = await spoofedMe.text();
    expect(spoofedIdentity).toContain("SECA-001");
    expect(spoofedIdentity).not.toContain("SECB-002");
  });

  it("توكن البوابة لا يفتح مسارات الطاقم (session domain separation)", async () => {
    const response = await fetch(`${baseUrl}/api/patients/${h.seeded.patientAId}`, {
      headers: { Cookie: h.sessions.portalA.cookie },
    });
    expect(response.status).toBe(401);
  });

  it("توكن الطاقم لا يفتح بوابة المريض", async () => {
    const response = await fetch(`${baseUrl}/api/portal/statement`, {
      headers: { Cookie: h.sessions.admin.cookie },
    });
    expect(response.status).toBe(401);
  });
});

describe("المجهول والذكاء الاصطناعي", () => {
  it("المجهول لا يصل أي مسار طاقم ⇒ 401", async () => {
    for (const path of [
      "/api/patients/1",
      "/api/payments",
      "/api/settings/readiness",
      "/api/users",
      "/api/invoices",
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(401);
    }
  });

  it("المحاسب (بلا صلاحية AI) لا يستخدم المساعد الذكي", async () => {
    const response = await authedMutation(
      "/api/ai/chat",
      h.sessions.accountant,
      "POST",
      JSON.stringify({ message: "مرحبا" }),
    );
    expect(response.status).toBe(403);
  });

  it("AI لا يتجاوز المتصل: الطبيب أ يسأل عن مريض ب ⇒ سياق مسموم يُسقط", async () => {
    const response = await authedMutation(
      "/api/ai/chat",
      h.sessions.doctorA,
      "POST",
      JSON.stringify({
        message: "ما حال ملف رقم " + h.seeded.patientBId + "؟",
        conversationPatientId: h.seeded.patientBId,
      }),
    );
    // الطلب نفسه يمر (صلاحية AI للطبيب) — والسياق المسموم أُسقط داخليًّا:
    expect([200, 503]).toContain(response.status);
    if (response.status === 200) {
      const payload = (await response.json()) as { warnings?: string[] };
      // النص الفعلي للتحذير يحمل تشكيلًا (أُسقط) — نطابق على الجذر الصرفي:
      expect(payload.warnings?.some((w) => w.includes("سقط") && w.includes("مريض")) ?? false).toBe(true);
    }
  });

  it("المجهول لا يستخدم المساعد الذكي ⇒ 401", async () => {
    const response = await fetch(`${baseUrl}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ message: "مرحبا" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("توكن لا يتحول بين المجالين عبر Bearer", () => {
  it("Bearer توكن الطاقم على مسار بوابة ⇒ 401 (المجال منفصل)", async () => {
    const response = await fetch(`${baseUrl}/api/portal/statement`, {
      headers: { Authorization: `Bearer ${h.sessions.admin.token}` },
    });
    expect(response.status).toBe(401);
  });
});
