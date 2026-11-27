import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { getPool, insertAuditRow, recordAudit } from "@/lib/db";
import { withIsolation } from "@/lib/transactions";
import { executeAiChatWithFallback, listAiProviders } from "@/lib/ai-providers/registry";
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
  CLINICAL_EXTERNAL_LOCKED,
  EXTERNAL_ASSISTANT_SETTING_KEY,
  EXTERNAL_GEMINI_SETTING_KEY,
  runLocalClinicalAssistant,
  validateExternalGeminiPayload,
  type LocalAssistantAction,
} from "@/lib/aqlan-ai-local";

export const dynamic = "force-dynamic";

/**
 * Strict fail-closed evaluation of external non-clinical AI (Charter §21):
 * - Defaults strictly to FALSE when unset or unreadable.
 * - Requires `ai.external_assistant === "true"` AND (if legacy ortho key exists) not `"false"`.
 */
async function readExternalAssistantStatus(): Promise<{
  externalAssistantEnabled: boolean;
  hasConfiguredProvider: boolean;
}> {
  try {
    const pool = getPool();
    const [{ rows }, providers] = await Promise.all([
      pool.query<{ key: string; value: string }>(
        "SELECT key, value FROM settings WHERE key = ANY($1::text[])",
        [[EXTERNAL_ASSISTANT_SETTING_KEY, EXTERNAL_GEMINI_SETTING_KEY]],
      ),
      listAiProviders().catch(() => []),
    ]);
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const globalEnabled = map.get(EXTERNAL_ASSISTANT_SETTING_KEY) === "true";
    const orthoOverride = map.get(EXTERNAL_GEMINI_SETTING_KEY);
    const externalAssistantEnabled = globalEnabled && orthoOverride !== "false";
    const hasConfiguredProvider = providers.some((p) => p.enabled);
    return { externalAssistantEnabled, hasConfiguredProvider };
  } catch {
    return { externalAssistantEnabled: false, hasConfiguredProvider: false };
  }
}

export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });
  }

  const [aiEval, manageCheck, extStatus] = await Promise.all([
    evaluateOrthoPermission(session, { permission: "ai.use", section: "ai_assistant" }),
    canSessionManageOrthoPrivacy(session),
    readExternalAssistantStatus(),
  ]);

  return NextResponse.json(
    {
      brand: AQLAN_AI_BRAND,
      canUseAi: aiEval.allowed,
      canManageExternalConfig: manageCheck.allowed && manageCheck.actor?.isOwner === true,
      externalGeminiEnabled: extStatus.externalAssistantEnabled,
      externalAssistantEnabled: extStatus.externalAssistantEnabled,
      clinicalExternalLocked: CLINICAL_EXTERNAL_LOCKED,
      hasServerApiKey: extStatus.hasConfiguredProvider,
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

/** Owner-only control to enable or disable external non-clinical AI (OFF by default, atomic audit). */
export async function PUT(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });
  }

  const manageCheck = await canSessionManageOrthoPrivacy(session);
  if (!manageCheck.allowed || !manageCheck.actor?.isOwner) {
    return orthoForbiddenResponse("تفعيل أو تعطيل المساعد الخارجي محصور بمالك المركز فقط.");
  }

  let body: { externalGeminiEnabled?: boolean; externalAssistantEnabled?: boolean; reason?: string };
  try {
    body = await readJsonBody(req, JSON_BODY_LIMIT_BYTES);
  } catch (err) {
    const errRes = bodyErrorResponse(err);
    if (errRes) return errRes;
    return NextResponse.json({ message: "بيانات الطلب غير صالحة." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const enabled =
    typeof body.externalAssistantEnabled === "boolean"
      ? body.externalAssistantEnabled
      : body.externalGeminiEnabled === true;
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";

  await withIsolation(getPool(), "READ COMMITTED", async (client) => {
    for (const key of [EXTERNAL_ASSISTANT_SETTING_KEY, EXTERNAL_GEMINI_SETTING_KEY]) {
      await client.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, enabled ? "true" : "false"],
      );
    }
    await insertAuditRow(client, {
      action: "ortho.privacy_policy_update",
      entity: "clinic_setting",
      entityId: EXTERNAL_ASSISTANT_SETTING_KEY,
      entityLabel: AQLAN_AI_BRAND.full,
      details: {
        تفعيل_المساعد_الخارجي_غير_السريري: enabled,
        السريري_الخارجي_مقفل: true,
        ...(reason ? { السبب: reason } : {}),
      },
      actor: session.username,
      actorRole: session.role,
    });
  });

  return NextResponse.json(
    { ok: true, externalGeminiEnabled: enabled, externalAssistantEnabled: enabled },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });
  }

  let rawBody: Record<string, unknown>;
  try {
    rawBody = await readJsonBody<Record<string, unknown>>(req, JSON_BODY_LIMIT_BYTES);
  } catch (err) {
    const errRes = bodyErrorResponse(err);
    if (errRes) return errRes;
    return NextResponse.json({ message: "بيانات الطلب غير صالحة." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const requestedExternal =
    rawBody.engine === "external_gemini" || rawBody.engine === "external";

  const aiEval = await evaluateOrthoPermission(
    session,
    { permission: "ai.use", section: "ai_assistant" },
    {
      patientId:
        !requestedExternal && typeof rawBody.patientId === "number" ? rawBody.patientId : null,
      orthoCaseId:
        !requestedExternal && typeof rawBody.orthoCaseId === "number" ? rawBody.orthoCaseId : null,
    },
  );
  if (!aiEval.allowed || !aiEval.access) {
    return orthoForbiddenResponse("استخدام عقلان — المساعد الذكي يتطلب صلاحية «استخدام AQLAN AI Assistant».", {
      reason: aiEval.reason,
    });
  }

  // Engine 1: Local Deterministic Clinical Engine (Zero External Calls)
  if (!requestedExternal) {
    const allowedActions: readonly LocalAssistantAction[] = [
      "audit_completeness",
      "approved_summary",
      "presentation_checklist",
      "scientific_references",
    ];
    const requestedAction = rawBody.action as LocalAssistantAction;
    const chosenAction: LocalAssistantAction = allowedActions.includes(requestedAction)
      ? requestedAction
      : "audit_completeness";

    let filteredRecord = null;
    const pid =
      typeof rawBody.patientId === "number" && Number.isSafeInteger(rawBody.patientId) && rawBody.patientId > 0
        ? rawBody.patientId
        : null;
    const cid =
      typeof rawBody.orthoCaseId === "number" && Number.isSafeInteger(rawBody.orthoCaseId) && rawBody.orthoCaseId > 0
        ? rawBody.orthoCaseId
        : null;

    if (pid && chosenAction !== "scientific_references") {
      if (!aiEval.access.permissions["records.read"]) {
        return orthoForbiddenResponse("تدقيق ملف المريض محليًا يتطلب صلاحية قراءة سجلات التقويم.");
      }
      const rawRecord = await loadOrthoWorkspaceRecord(pid, cid);
      filteredRecord = filterWorkspaceByPrivacy(rawRecord, aiEval.access).filtered;
    }

    const result = runLocalClinicalAssistant(chosenAction, filteredRecord);

    await recordAudit({
      action: "ortho.ai_query",
      entity: pid ? "patient" : "clinic_setting",
      entityId: pid ? String(pid) : "local_library",
      entityLabel: AQLAN_AI_BRAND.full,
      details: { المحرك: "محلي_سريري", الإجراء: chosenAction },
      actor: session.username,
      actorRole: session.role,
    });

    return NextResponse.json({ ok: true, result }, { status: 200, headers: NO_STORE_HEADERS });
  }

  // Engine 2: External Non-Clinical Provider Layer (Disabled by default + Structural Zero-PHI)
  const firewall = validateExternalGeminiPayload(rawBody);
  if (!firewall.ok) {
    await recordAudit({
      action: "ortho.access_denied",
      entity: "clinic_setting",
      entityId: "aqlan_ai_external_firewall",
      entityLabel: "جدار حماية خصوصية المرضى — عقلان المساعد الذكي",
      details: { الرمز: firewall.code, السبب: firewall.reasonAr },
      actor: session.username,
      actorRole: session.role,
    });
    return NextResponse.json(
      { code: firewall.code, message: firewall.reasonAr, reason: "phi_firewall_blocked" },
      { status: firewall.code === "PHI_EXTERNAL_BLOCKED" ? 422 : 400, headers: NO_STORE_HEADERS },
    );
  }

  const extStatus = await readExternalAssistantStatus();
  if (!extStatus.externalAssistantEnabled) {
    return orthoForbiddenResponse(
      "المساعد الخارجي معطّل افتراضيًا بقرار سياسة المركز (`ai.external_assistant = false`). يعمل المحرك السريري المحلي والمكتبة المرجعية بصورة كاملة.",
      { reason: "external_assistant_disabled" },
    );
  }

  const systemInstruction =
    firewall.intent === "educational_literature"
      ? "You are AQLAN AI Assistant (عقلان — المساعد الذكي) in STRICT NON-CLINICAL EDUCATIONAL MODE. Answer general orthodontic textbook/literature questions in Arabic with verifiable peer-reviewed references (author, source, year). NEVER diagnose any patient, NEVER recommend treatment for a specific case, and REFUSE if any patient data is supplied."
      : "You are AQLAN AI Assistant (عقلان — المساعد الذكي) in STRICT ADMINISTRATIVE TEMPLATE MODE. Help organize generic dental clinic checklists, educational slide outlines, or administrative templates in Arabic. NEVER process patient data or provide clinical advice.";

  const aiResult = await executeAiChatWithFallback({
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: firewall.query },
    ],
    temperature: 0.2,
    maxTokens: 1200,
  });

  if (!aiResult.ok) {
    return NextResponse.json(
      {
        message:
          aiResult.error ||
          "تعذّر الاتصال بمزود الذكاء الخارجي؛ المحرك المحلي والمكتبة المرجعية يعملان بصورة مستقلة تمامًا.",
      },
      { status: 502, headers: NO_STORE_HEADERS },
    );
  }

  await recordAudit({
    action: "ortho.ai_query",
    entity: "clinic_setting",
    entityId: "external_non_clinical",
    entityLabel: AQLAN_AI_BRAND.full,
    details: {
      المحرك: "مزود_خارجي_غير_سريري",
      المزود: aiResult.providerId,
      النطاق: firewall.intent,
      طول_الاستعلام: firewall.query.length,
    },
    actor: session.username,
    actorRole: session.role,
  });

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
        textAr: aiResult.content.trim(),
      },
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
