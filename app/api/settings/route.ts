import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getSettings, readStoredSettings, saveSettingsAudited } from "@/lib/db";
import { ALL_SETTING_KEYS, SETTING_DEFAULTS, type SettingKey } from "@/lib/settings";
import { settingDefinition } from "@/lib/settings-definitions";
import { canManageCategory, denialMessage, roleCan } from "@/lib/settings-permissions";
import { validateSettingSet, validateTypedSetting } from "@/lib/settings-validate";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/**
 * القراءة: القيم المحسومة ومعها طوابعُ ما هو مخزَّن.
 *
 * الطوابع لازمةٌ للحماية من الكتابة الضائعة: من لا يعرف ما رآه لا يستطيع أن يُثبت
 * أنه لم يمحُ عمل غيره. والسرّ لا تُعاد قيمته أبدًا — تُعاد حالته وحدها.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  if (!roleCan(session.role, "settings.view")) {
    return NextResponse.json({ message: "عرض الإعدادات غير مسموح لهذا الدور." }, { status: 403 });
  }
  try {
    const [values, stored] = await Promise.all([getSettings(), readStoredSettings()]);
    const safe: Record<string, string> = {};
    const versions: Record<string, string | null> = {};
    const secrets: Record<string, boolean> = {};
    for (const key of ALL_SETTING_KEYS) {
      const definition = settingDefinition(key);
      versions[key] = stored.get(key)?.updatedAt ?? null;
      if (definition?.sensitivity === "secret") {
        secrets[key] = (stored.get(key)?.value ?? "").trim() !== "";
        continue;
      }
      safe[key] = values[key];
    }
    return NextResponse.json({ ...safe, __versions: versions, __secrets: secrets });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الإعدادات." }, { status: 500 });
  }
}

/**
 * التعديل: صلاحيةٌ لكل فئة، وتحقّقٌ مقيَّد بالنوع، وحراسةٌ من الكتابة الضائعة.
 *
 * الصلاحية بالفئة لا بالدور وحده: الاستقبال التي تُصحّح اسم المركز لا تُغيّر سعر
 * الصرف. والمقفل (ثابت نظام) يُرفض حتى للمدير — انظر docs/SYSTEM_INVARIANTS.md.
 */
export async function PATCH(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  let body: unknown;
  try { body = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const expectedRaw = (source.__versions ?? null) as Record<string, unknown> | null;
  const reason = typeof source.__reason === "string" ? source.__reason : null;

  const values: Record<string, string> = {};
  for (const key of ALL_SETTING_KEYS) {
    const raw = source[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") {
      return NextResponse.json({ message: "قيمة غير صالحة.", key }, { status: 400 });
    }
    const definition = settingDefinition(key);
    if (!definition) return NextResponse.json({ message: "مفتاح غير معروف.", key }, { status: 400 });
    if (!canManageCategory(session.role, definition.category)) {
      return NextResponse.json({ message: denialMessage(definition.category), key }, { status: 403 });
    }
    const problem = validateTypedSetting(key, raw);
    if (problem) return NextResponse.json({ message: problem, key }, { status: 400 });
    values[key] = raw.trim();
  }

  if (Object.keys(values).length === 0) {
    return NextResponse.json({ message: "لا يوجد ما يُحفظ." }, { status: 400 });
  }

  try {
    const current = await getSettings();
    const crossProblem = validateSettingSet(values, current);
    if (crossProblem) return NextResponse.json({ message: crossProblem }, { status: 400 });

    const expected: Record<string, string | null> | undefined = expectedRaw
      ? Object.fromEntries(Object.keys(values)
          .filter((key) => key in expectedRaw)
          .map((key) => [key, typeof expectedRaw[key] === "string" ? String(expectedRaw[key]) : null]))
      : undefined;

    const result = await saveSettingsAudited({
      values, expected, reason,
      actor: session.username, actorRole: session.role,
    });
    if (!result.ok) {
      return NextResponse.json({
        message: "غُيّر هذا الإعداد من جهازٍ آخر. حدّث الصفحة ثم أعد المحاولة.",
        key: result.conflict.key,
        currentUpdatedAt: result.conflict.currentUpdatedAt,
      }, { status: 409 });
    }
    return NextResponse.json({ ...result.settings, __changed: result.changed });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الإعدادات. أعد المحاولة." }, { status: 500 });
  }
}

/**
 * إعادة إلى الافتراضي — كتابةٌ جديدة مدقَّقة لا محوٌ للتاريخ.
 *
 * والتراجع (rollback) هو هذا المسار نفسه بقيمةٍ قديمة: حدثٌ جديد يُضاف، ولا يُعاد
 * كتابة صفِّ تدقيقٍ سابق ولا يُحذف. لذلك لا مسار خاصًّا له.
 *
 * إعادة الضبط تشارك PATCH حارس التزامن: من رأى نسخةً قديمة لا يمحو تعديلًا أحدث
 * بمجرد ضغط «إعادة الافتراضي».
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  let body: unknown;
  try { body = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  if (source.action !== "reset") {
    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  }
  const keys = Array.isArray(source.keys) ? source.keys.filter((k): k is string => typeof k === "string") : [];
  if (keys.length === 0) return NextResponse.json({ message: "حدّد المفاتيح." }, { status: 400 });

  const expectedRaw = (source.__versions ?? null) as Record<string, unknown> | null;
  const values: Record<string, string> = {};
  for (const key of keys) {
    const definition = settingDefinition(key);
    if (!definition) return NextResponse.json({ message: "مفتاح غير معروف.", key }, { status: 400 });
    if (!canManageCategory(session.role, definition.category)) {
      return NextResponse.json({ message: denialMessage(definition.category), key }, { status: 403 });
    }
    if (definition.systemLocked) {
      return NextResponse.json({ message: `${definition.label}: ثابتُ نظام.`, key }, { status: 403 });
    }
    values[key] = SETTING_DEFAULTS[key as SettingKey];
  }

  const expected: Record<string, string | null> | undefined = expectedRaw
    ? Object.fromEntries(keys
        .filter((key) => key in expectedRaw)
        .map((key) => [key, typeof expectedRaw[key] === "string" ? String(expectedRaw[key]) : null]))
    : undefined;

  try {
    const result = await saveSettingsAudited({
      values, expected, mode: "reset",
      reason: typeof source.reason === "string" ? source.reason : null,
      actor: session.username, actorRole: session.role,
    });
    if (!result.ok) {
      return NextResponse.json({
        message: "غُيّر هذا الإعداد من جهازٍ آخر. حدّث الصفحة ثم أعد المحاولة.",
        key: result.conflict.key,
        currentUpdatedAt: result.conflict.currentUpdatedAt,
      }, { status: 409 });
    }
    return NextResponse.json({ ...result.settings, __changed: result.changed });
  } catch {
    return NextResponse.json({ message: "تعذّرت الإعادة إلى الافتراضي." }, { status: 500 });
  }
}
