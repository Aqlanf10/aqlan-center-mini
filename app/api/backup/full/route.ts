import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/db";
import { fullBackupBlocks } from "@/lib/fullBackup";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * النسخة الكاملة بملفٍّ واحد — قاعدة البيانات وأشعّة المرضى معًا.
 * (من مستودع الوكيل الآخر لمكوّناتنا.)
 *
 * كانت نسختنا ملفين يُنزّلان كلٌّ على حدة، ومن نسي الثاني نزّل نصف ذاكرة
 * المركز وظنّه كلّها. وهنا ملفٌ واحد: `database.sql` ثم `documents/` ثم
 * `manifest.json` أخيرًا — فالتنزيل المقطوع لا يتنكّر كنسخةٍ كاملة.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "سجّل الدخول من جديد." }, { status: 401 });
  if (!isAdmin(session.role)) return NextResponse.json({ message: "النسخة الكاملة للمدير وحده." }, { status: 403 });

  /*
   * يُسجَّل **قبل** البثّ لا بعده: الملف يحمل كل مريض وكل شععة في المركز، وهو
   * أخطر ما يخرج من النظام. ولو سُجّل بعد الاكتمال لما بقي أثرٌ لتنزيلٍ قُطع
   * في منتصفه — وقد خرج نصف الأرشيف فعلًا.
   */
  await recordAudit({
    action: "backup.full_download",
    details: { الوقت: new Date().toISOString() },
    actor: session.username, actorRole: session.role,
  });

  const source = Readable.from(fullBackupBlocks());
  const gzip = createGzip();
  source.on("error", (error) => gzip.destroy(error));
  const abort = () => { source.destroy(); gzip.destroy(); };
  request.signal.addEventListener("abort", abort, { once: true });
  gzip.on("close", () => request.signal.removeEventListener("abort", abort));
  const output = source.pipe(gzip);

  /*
   * `end` على الضاغط لا يقع إلّا بعد أن يُولَّد آخر بلوك ويُفرَّغ آخر بايت منه.
   * وانقطاعٌ في المنتصف يُهلك الضاغط فلا `end` — فلا يُسجَّل اكتمالٌ لنسخةٍ لم
   * تكتمل. و`backup.full_download` أعلاه يبقى كما هو: يشهد أنّ الأرشيف بدأ
   * بالخروج وهو ما تحتاجه المراجعة الأمنية، لا أنّ نسخةً صارت في اليد.
   */
  output.on("end", () => {
    void recordAudit({
      action: "backup.complete",
      details: { النوع: "full", الوقت: new Date().toISOString() },
      actor: session.username, actorRole: session.role,
    });
  });

  return new Response(Readable.toWeb(output) as ReadableStream, {
    headers: {
      "Content-Type": "application/gzip",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="aqlan-full-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
    },
  });
}
