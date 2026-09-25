import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { clinicResetPreview, findUserByUsername, resetClinicData } from "@/lib/db";
import { verifyPassword } from "@/lib/auth";
import { RESET_CONFIRM_PHRASE, RESET_PREVIEW_GROUPS, isResetPhrase } from "@/lib/clinic-reset";
import { removeFileByKey } from "@/lib/files";
import { runVerifiedManualBackup } from "@/lib/manual-backup";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * إعادة الضبط — مسح البيانات التجريبية (قرار المالك). للمدير وحده.
 *
 * GET: عدد ما سيُمسح من كل نوع — لشاشة التأكيد.
 * POST: بعبارة التأكيد حرفيًّا وكلمة مرور المدير، ثم **نسخة احتياطية متحقَّق منها
 * أولًا** — وإن تعذّرت لا يُمسح شيء — ثم المسح في معاملةٍ واحدة، ثم حذف ملفات الأشعة
 * والمرفقات الممسوحة من القرص.
 */

const noStore = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function adminSession() {
  const session = await requireSession();
  if (!session) return { error: noStore({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401) } as const;
  if (!isAdmin(session.role)) return { error: noStore({ message: "إعادة الضبط للمدير وحده." }, 403) } as const;
  return { session } as const;
}

export async function GET() {
  const auth = await adminSession();
  if ("error" in auth) return auth.error;
  try {
    const counts = await clinicResetPreview();
    return noStore({
      phrase: RESET_CONFIRM_PHRASE,
      groups: RESET_PREVIEW_GROUPS.map((group) => ({ label: group.label, count: counts[group.table] ?? 0 })),
    }, 200);
  } catch {
    return noStore({ message: "تعذّر حساب ما سيُمسح. أعد المحاولة." }, 500);
  }
}

export async function POST(request: Request) {
  const auth = await adminSession();
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return noStore({ message: "طلب غير صالح." }, 400);
  }

  if (!isResetPhrase(body.phrase)) {
    return noStore({ message: `اكتب عبارة التأكيد كما هي: «${RESET_CONFIRM_PHRASE}».` }, 400);
  }
  const user = await findUserByUsername(auth.session.username).catch(() => null);
  const password = typeof body.password === "string" ? body.password : "";
  if (!user || !password || !(await verifyPassword(password, user.passwordHash).catch(() => false))) {
    return noStore({ message: "كلمة المرور غير صحيحة." }, 400);
  }

  // تجميد الكتابة ← نسخةٌ متحقَّق منها ← مسح: في معاملةٍ واحدة؛ لا مسح بلا نسخة.
  let result: Awaited<ReturnType<typeof resetClinicData<Record<string, unknown>>>>;
  try {
    result = await resetClinicData<Record<string, unknown>>(
      { actor: auth.session.username, actorRole: auth.session.role },
      async (client) => {
        const backup = await runVerifiedManualBackup({ client });
        return backup.ok ? { ok: true, backupId: backup.backup.backupId } : { ok: false, failure: backup.body };
      },
    );
  } catch {
    return noStore({ message: "تعذّرت إعادة الضبط ولم يُمسح شيء. أعد المحاولة بعد قليل (قد يكون أحدٌ يُدخل بيانات الآن)." }, 500);
  }
  if (!result.ok) {
    const failure = result.failure;
    const reason = typeof failure.message === "string" ? failure.message
      : failure.reason === "backup-disabled" ? "النسخ الاحتياطي غير مفعَّل." : "تعذّرت النسخة الاحتياطية.";
    return noStore({
      message: `لم يُمسح شيء: ${reason} إعادة الضبط لا تتم إلا بعد نسخة احتياطية ناجحة — فعّل النسخ من الإعدادات ثم أعد المحاولة.`,
    }, 409);
  }

  // المسح تمّ؛ حذف الملفات بعده — ملفٌّ يتعذّر حذفه يُعدّ ولا يُفشل ما تمّ.
  let filesRemoved = 0;
  let filesFailed = 0;
  for (const key of result.storageKeys) {
    try {
      if (await removeFileByKey(key)) filesRemoved += 1;
    } catch {
      filesFailed += 1;
    }
  }
  return noStore({
    ok: true,
    backupId: result.backupId,
    filesRemoved,
    filesFailed,
    groups: RESET_PREVIEW_GROUPS.map((group) => ({ label: group.label, count: result.counts[group.table] ?? 0 })),
  }, 200);
}
