import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, backupSqlLines, recordAudit } from "@/lib/db";
import { backupFileName } from "@/lib/backup";
import { clinicDateString } from "@/lib/schedule";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * تنزيل نسخة احتياطية كاملة — من داخل البرنامج.
 *
 * **للمدير وحده**: الملف يحمل كل مريض وكل مبلغ في العيادة، فهو أخطر ما يمكن أن يخرج
 * من النظام. ولا يُعطى لمن يلمس المال حتى — الاستقبال تقبض وتصرف بسند، ولا شأن لها
 * بنسخة تحمل الأرشيف كله.
 *
 * ويُبثّ سطرًا سطرًا لا يُبنى في الذاكرة أولًا: قاعدة تكبر بمرور الشهور تجعل بناءه
 * دفعةً واحدة يُسقط الخدمة عند أول نسخة كبيرة — وأسوأ وقت لسقوطها هو لحظة أخذ نسخة.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "النسخة الاحتياطية للمدير وحده." }, { status: 403 });
  }

  const now = new Date();
  const date = clinicDateString(now, CLINIC_TIME_ZONE);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: CLINIC_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);

  /*
   * يُسجَّل **قبل** البثّ لا بعده: الملف يحمل كل مريض وكل مبلغ في المركز، وهو أخطر
   * ما يخرج من النظام. ولو سُجّل بعد الاكتمال لما بقي أثرٌ لتنزيلٍ قُطع في منتصفه —
   * وقد خرج نصف الأرشيف فعلًا.
   */
  await recordAudit({
    action: "backup.download",
    details: { التاريخ: date, الوقت: time },
    actor: session.username, actorRole: session.role,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const line of backupSqlLines()) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      } catch {
        // الملف الناقص أخطر من غيابه: من ينزّله يظنّه نسخة. فيُختم بسطر يُفشل
        // الاستعادة صراحةً — المعاملة تبقى مفتوحة بلا COMMIT ويقولها التعليق.
        controller.enqueue(encoder.encode(
          "\n-- !!! انقطعت النسخة قبل اكتمالها — هذا الملف ناقص ولا يصلح للاستعادة !!!\nROLLBACK;\n",
        ));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/sql; charset=utf-8",
      "Content-Disposition": `attachment; filename="${backupFileName(date, time)}"`,
      "Cache-Control": "no-store",
    },
  });
}
