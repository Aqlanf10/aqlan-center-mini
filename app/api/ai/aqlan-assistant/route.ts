import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import * as db from "@/lib/db";
import {
  canSessionManageOrthoPrivacy,
  evaluateOrthoPermission,
  NO_STORE_HEADERS,
  orthoForbiddenResponse,
} from "@/lib/ortho-privacy-server";
import {
  filterWorkspaceByPrivacy,
  loadOrthoWorkspaceRecord,
} from "@/lib/ortho-workspace-store";
import {
  AQLAN_AI_BRAND,
  EXTERNAL_GEMINI_SETTING_KEY,
  runLocalClinicalAssistant,
  validateExternalGeminiPayload,
  type LocalAssistantAction,
} from "@/lib/aqlan-ai-local";

export const dynamic = "force-dynamic";

async function isExternalGeminiEnabled(): Promise<boolean> {
  try {
    if (typeof db.ensureSchema === "function") await db.ensureSchema();
    const pool = typeof db.getPool === "function" ? db.getPool() : null;
    if (!pool) return false;
    const { rows } = await pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = $1 LIMIT 1",
      [EXTERNAL_GEMINI_SETTING_KEY],
    );
    return rows[0]?.value === "true";
  } catch {
    return false; // Fail-closed: disabled by default
  }
}

export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });
  }

  const [aiEval, manageCheck, externalGeminiEnabled] = await Promise.all([
    evaluateOrthoPermission(session, { permission: "ai.use", section: "ai_assistant" }),
    canSessionManageOrthoPrivacy(session),
    isExternalGeminiEnabled(),
  ]);

  return NextResponse.json(
    {
      brand: AQLAN_AI_BRAND,
      canUseAi: aiEval.allowed,
      canManageExternalConfig: manageCheck.allowed && manageCheck.actor?.isOwner === true,
      externalGeminiEnabled,
      hasServerApiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0),
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

/** Owner-only control to enable or disable the external non-clinical Gemini engine (OFF by default). */
export async function PUT(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });
  }

  const manageCheck = await canSessionManageOrthoPrivacy(session);
  if (!manageCheck.allowed || !manageCheck.actor?.isOwner) {
    return orthoForbiddenResponse("تفعيل أو تعطيل محرك Gemini الخارجي محصور بمالك المركز فقط.");
  }

  let body: { externalGeminiEnabled?: boolean };
  try {
    body = await readJsonBody(req, 8 * 1024);
  } catch (err) {
    const errRes = bodyErrorResponse(err);
    if (errRes) return errRes;
    return NextResponse.json({ message: "بيانات الطلب غير صالحة." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const enabled = body.externalGeminiEnabled === true;
  if (typeof db.ensureSchema === "function") await db.ensureSchema();
  const pool = typeof db.getPool === "function" ? db.getPool() : null;
  if (!pool) {
    return NextResponse.json({ message: "قاعدة البيانات غير متاحة." }, { status: 503, headers: NO_STORE_HEADERS });
  }

  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [EXTERNAL_GEMINI_SETTING_KEY, enabled ? "true" : "false"],
  );

  await db
    .recordAudit({
      action: "ortho.privacy_policy_update",
      entity: "clinic_setting",
      entityId: EXTERNAL_GEMINI_SETTING_KEY,
      entityLabel: AQLAN_AI_BRAND.full,
      details: { تفعيل_Gemini_الخارجي_غير_السريري: enabled },
      actor: session.username,
      actorRole: session.role,
    })
    .catch(() => {});

  return NextResponse.json({ ok: true, externalGeminiEnabled: enabled }, { status: 200, headers: NO_STORE_HEADERS });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });
  }

  let rawBody: Record<string, unknown>;
  try {
    rawBody = await readJsonBody<Record<string, unknown>>(req, 32 * 1024);
  } catch (err) {
    const errRes = bodyErrorResponse(err);
    if (errRes) return errRes;
    return NextResponse.json({ message: "بيانات الطلب غير صالحة." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const engine = rawBody.engine === "external_gemini" ? "external_gemini" : "local";

  const aiEval = await evaluateOrthoPermission(
    session,
    { permission: "ai.use", section: "ai_assistant" },
    {
      patientId:
        engine === "local" && typeof rawBody.patientId === "number" ? rawBody.patientId : null,
    },
  );
  if (!aiEval.allowed || !aiEval.access) {
    return orthoForbiddenResponse("استخدام عقلان — المساعد الذكي يتطلب صلاحية «استخدام AQLAN AI Assistant».", {
      reason: aiEval.reason,
    });
  }

  // Engine 1: Local Deterministic Clinical Engine (Zero External Calls)
  if (engine === "local") {
    const allowedActions: readonly LocalAssistantAction[] = [
      "audit_completeness",
      "approved_summary",
      "presentation_checklist",
      "scientific_references",
    ];
    const action: LocalAssistantAction = allowedActions.includes(rawBody.action as LocalAssistantAction)
      ? (rawBody.action as LocalAssistantAction)
      : "audit_completeness";

    let filteredRecord = null;
    const pid = typeof rawBody.patientId === "number" && Number.isSafeInteger(rawBody.patientId) && rawBody.patientId > 0
      ? rawBody.patientId
      : null;

    if (pid && action !== "scientific_references") {
      if (!aiEval.access.permissions["records.read"]) {
        return orthoForbiddenResponse("تدقيق ملف المريض محليًا يتطلب صلاحية قراءة سجلات التقويم.");
      }
      const rawRecord = await loadOrthoWorkspaceRecord(pid);
      filteredRecord = filterWorkspaceByPrivacy(rawRecord, aiEval.access).filtered;
    }

    const result = runLocalClinicalAssistant(action, filteredRecord);

    await db
      .recordAudit({
        action: "ortho.ai_query",
        entity: pid ? "patient" : "clinic_setting",
        entityId: pid ? String(pid) : "local_library",
        entityLabel: AQLAN_AI_BRAND.full,
        details: { المحرك: "محلي_سريري", الإجراء: action },
        actor: session.username,
        actorRole: session.role,
      })
      .catch(() => {});

    return NextResponse.json({ ok: true, result }, { status: 200, headers: NO_STORE_HEADERS });
  }

  // Engine 2: External Non-Clinical Gemini Engine (Disabled by default + Zero-PHI Firewall)
  const externalEnabled = await isExternalGeminiEnabled();
  if (!externalEnabled) {
    return orthoForbiddenResponse(
      "المحرك الخارجي (Gemini) معطّل افتراضيًا بقرار سياسة المركز. يعمل المحرك السريري المحلي فقط ما لم يفعّله المالك للاستخدام التعليمي غير السريري.",
      { reason: "external_gemini_disabled" },
    );
  }

  const firewall = validateExternalGeminiPayload(rawBody);
  if (!firewall.ok) {
    await db
      .recordAudit({
        action: "ortho.access_denied",
        entity: "clinic_setting",
        entityId: "aqlan_ai_external_firewall",
        entityLabel: "جدار حماية خصوصية المرضى — عقلان المساعد الذكي",
        details: { السبب: firewall.reasonAr },
        actor: session.username,
        actorRole: session.role,
      })
      .catch(() => {});
    return orthoForbiddenResponse(firewall.reasonAr, { reason: "phi_firewall_blocked" });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        message:
          "مفتاح GEMINI_API_KEY غير مضبوط في أسرار الخادم. يمكنك الاستمرار باستخدام المحرك المحلي والمكتبة المرجعية المحلية.",
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const systemInstruction =
    firewall.intent === "educational_literature"
      ? "You are AQLAN AI Assistant (عقلان — المساعد الذكي) in STRICT NON-CLINICAL EDUCATIONAL MODE. Answer general orthodontic textbook/literature questions in Arabic with verifiable peer-reviewed references (author, source, year, DOI/URL). NEVER diagnose any patient, NEVER recommend treatment for a specific case, and REFUSE if any patient data is supplied."
      : "You are AQLAN AI Assistant (عقلان — المساعد الذكي) in STRICT ADMINISTRATIVE TEMPLATE MODE. Help organize generic dental clinic checklists, educational slide outlines, or administrative templates in Arabic. NEVER process patient data or provide clinical advice.";

  try {
    const geminiRes = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        model: "gemini-4-hydrogen",
        system_instruction: systemInstruction,
        input: firewall.query,
      }),
    });

    const data = (await geminiRes.json().catch(() => null)) as {
      outputs?: Array<{ type?: string; text?: string }>;
      error?: { message?: string };
    } | null;

    if (!geminiRes.ok) {
      return NextResponse.json(
        {
          message:
            data?.error?.message ??
            "تعذّر الاتصال بمحرك Gemini الخارجي؛ المحرك المحلي يعمل بصورة مستقلة تمامًا.",
        },
        { status: 502, headers: NO_STORE_HEADERS },
      );
    }

    const answerText =
      data?.outputs
        ?.filter((o) => o.type === "text" && typeof o.text === "string")
        .map((o) => o.text)
        .join("\n")
        .trim() || "لم يرد نص من المحرك الخارجي.";

    await db
      .recordAudit({
        action: "ortho.ai_query",
        entity: "clinic_setting",
        entityId: "external_gemini_non_clinical",
        entityLabel: AQLAN_AI_BRAND.full,
        details: { المحرك: "Gemini_خارجي_غير_سريري", النطاق: firewall.intent, طول_الاستعلام: firewall.query.length },
        actor: session.username,
        actorRole: session.role,
      })
      .catch(() => {});

    return NextResponse.json(
      {
        ok: true,
        result: {
          engine: "external_gemini_non_clinical",
          intent: firewall.intent,
          titleAr:
            firewall.intent === "educational_literature"
              ? "إجابة المكتبة العلمية الخارجية (غير سريرية)"
              : "تنظيم قالب إداري عام (غير سريري)",
          disclaimerAr:
            "تنبيه: هذا الرد تعليمي/إداري عام فقط دون أي بيانات مرضى ولا يُعد قرارًا تشخيصيًا أو علاجيًا.",
          textAr: answerText,
        },
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch {
    return NextResponse.json(
      { message: "تعذّر الوصول إلى الخدمة الخارجية. المحرك المحلي والمكتبة المرجعية يعملان بصورة كاملة." },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }
}
