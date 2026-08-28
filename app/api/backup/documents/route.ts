import { NextResponse } from "next/server";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { documentsForArchive, recordAudit } from "@/lib/db";
import { readFileByKey, storageStatus } from "@/lib/files";
import { isAdmin } from "@/lib/roles";
import { safeEntryName, tarEnd, tarHeader, tarPadding } from "@/lib/tar";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * أرشيف الأشعة — لأن النسخة الاحتياطية SQL لا تحملها.
 *
 * الملفّات خارج القاعدة بحكم الدستور، فنسخةُ القاعدة وحدها **ليست نسخةً كاملة**.
 * وأسوأ من غياب الأرشيف أن يظنّ صاحب العيادة أن ملفّ SQL يحمل كل شيء، فيكتشف
 * يوم الكارثة أن سنواتٍ من الأشعة ليست فيه.
 *
 * والأسماء داخل الأرشيف تُقرأ بلا البرنامج: مجلّدٌ لكل مريض برقم ملفّه واسمه، وفي
 * كل ملفٍّ تاريخُه ونوعُه. فلو ضاع البرنامج كلّه بقيت الأشعة مفهومة.
 */

export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "النسخ الاحتياطي للمدير وحده." }, { status: 403 });
  }

  const storage = await storageStatus();
  if (!storage.ready) return NextResponse.json({ message: storage.message }, { status: 503 });

  const rows = await documentsForArchive();
  if (rows.length === 0) {
    return NextResponse.json({ message: "لا توجد أشعة أو مستندات بعد." }, { status: 404 });
  }

  const stamp = new Date().toISOString().slice(0, 10);

  /*
   * يُبنى في تدفّق لا في الذاكرة.
   *
   * أرشيفُ أشعةِ عيادةٍ عاملة قد يبلغ غيغابايتات، وجمعُه قبل الإرسال يُسقط الخادم
   * في اللحظة التي يُحتاج فيها أكثر من غيرها.
   */
  const missing: string[] = [];
  async function* blocks() {
    for (const row of rows) {
      const bytes = await readFileByKey(row.storageKey);
      if (!bytes) { missing.push(`${row.patientNumber} · ${row.title}`); continue; }
      const folder = safeEntryName(`${row.patientNumber} ${row.patientName}`, row.patientNumber);
      const extension = row.storageKey.split(".").pop() ?? "bin";
      const base = safeEntryName(`${row.takenOn ?? stamp} ${row.kind} ${row.title}`, String(row.id));
      const name = `أشعة-${stamp}/${folder}/${row.id}-${base}.${extension}`;
      yield tarHeader(name, bytes.length, row.uploadedAt);
      yield new Uint8Array(bytes);
      yield tarPadding(bytes.length);
    }

    // ملفّاتٌ موصوفة في القاعدة ومفقودة من القرص تُذكر داخل الأرشيف نفسه — لا في
    // سجلٍّ لا يقرؤه أحد. من يفتح الأرشيف بعد سنة يجب أن يعرف ما الذي لم يصله.
    if (missing.length > 0) {
      const notice = new TextEncoder().encode(
        ["ملفّات موصوفة في السجل ومفقودة من التخزين:", "", ...missing, ""].join("\n"),
      );
      yield tarHeader(`أشعة-${stamp}/ملفات-مفقودة.txt`, notice.length, new Date());
      yield notice;
      yield tarPadding(notice.length);
    }
    yield tarEnd();
  }

  void recordAudit({
    action: "backup.download",
    entity: "patient_documents",
    entityLabel: `أرشيف الأشعة — ${rows.length} ملفًّا`,
    details: { عدد_الملفات: rows.length },
    actor: session.username,
    actorRole: session.role,
  });

  const gzip = createGzip();
  const stream = Readable.from(blocks()).pipe(gzip);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="aqlan-documents-${stamp}.tar.gz"`,
      "Cache-Control": "private, no-store",
    },
  });
}
