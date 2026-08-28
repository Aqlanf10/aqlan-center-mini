import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, ensureSchema, getPool, journalEntries, recordAudit } from "@/lib/db";
import { csvFile, exportFileName } from "@/lib/csv";
import { clinicDateString } from "@/lib/schedule";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * جداول التصدير.
 *
 * الاستعلامات مكتوبة هنا بأسماء أعمدة عربية لا مشتقّة من الجداول آليًا: ملفٌ برؤوس
 * `base_amount_minor` لا يقرأه صاحب العيادة ولا محاسبه. والمبالغ تُقسم على وحدتها
 * الصغرى في الاستعلام نفسه فتظهر أرقامًا كما تُكتب.
 */
const TABLES: Record<string, {
  label: string;
  headers: string[];
  sql: string;
  dated: boolean;
  /**
   * هل يحتاج الاستعلام المنطقة الزمنية؟
   *
   * الجداول التي تُصفّى بعمود `DATE` (المواعيد، أوامر المختبر) لا تحوّل توقيتًا، فلا
   * تشير إلى المعامل الأول. وPostgres يرفض معاملًا لا يُشار إليه — «could not
   * determine data type» — فيسقط التصدير برسالة عامة لا تدلّ على السبب. لذلك
   * ترتيب المعاملات يُبنى من هذا العلم لا يُفترض.
   */
  tz: boolean;
}> = {
  patients: {
    label: "المرضى",
    headers: ["رقم الملف", "الاسم", "الجوال", "رقم بديل", "الجنس", "سنة الميلاد", "العنوان", "تنبيه طبي", "ملاحظة", "تاريخ التسجيل"],
    sql: `SELECT patient_number, full_name, phone, alt_phone, gender, birth_year, address,
                 medical_alert, note, (created_at AT TIME ZONE $1)::date
            FROM patients ORDER BY id`,
    dated: false,
    tz: true,
  },
  appointments: {
    label: "المواعيد",
    headers: ["رقم الموعد", "المريض", "الجوال", "التاريخ", "الوقت", "المدة", "الحالة", "ملاحظة"],
    sql: `SELECT a.id, p.full_name, p.phone, a.scheduled_date, a.scheduled_time,
                 a.duration_minutes, a.status, a.note
            FROM appointments a JOIN patients p ON p.id = a.patient_id
           WHERE a.scheduled_date BETWEEN $1::date AND $2::date
           ORDER BY a.scheduled_date, a.scheduled_time`,
    dated: true,
    tz: false,
  },
  visits: {
    label: "الزيارات",
    headers: ["رقم الزيارة", "المريض", "الحالة", "الكرسي", "الوصول", "النداء", "الجلوس", "الانتهاء"],
    sql: `SELECT id, patient_name, status, chair,
                 (arrived_at AT TIME ZONE $1), (called_at AT TIME ZONE $1),
                 (seated_at AT TIME ZONE $1), (finished_at AT TIME ZONE $1)
            FROM visits
           WHERE (arrived_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
           ORDER BY arrived_at`,
    dated: true,
    tz: true,
  },
  invoices: {
    label: "الفواتير",
    headers: ["رقم الفاتورة", "المريض", "التاريخ", "الإجمالي", "الخصم", "الصافي", "الحالة", "أنشأها"],
    sql: `SELECT i.invoice_number, p.full_name, (i.created_at AT TIME ZONE $1)::date,
                 i.total_minor, i.discount_minor,
                 GREATEST(0, i.total_minor - i.discount_minor), i.status, i.created_by
            FROM invoices i JOIN patients p ON p.id = i.patient_id
           WHERE (i.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
           ORDER BY i.id`,
    dated: true,
    tz: true,
  },
  invoice_items: {
    label: "بنود الفواتير",
    headers: ["رقم الفاتورة", "المريض", "التاريخ", "البند", "الكمية", "سعر الوحدة", "الإجمالي", "الطبيب"],
    sql: `SELECT i.invoice_number, p.full_name, (i.created_at AT TIME ZONE $1)::date,
                 it.description, it.quantity, it.unit_price_minor, it.total_minor, d.name
            FROM invoice_items it
            JOIN invoices i ON i.id = it.invoice_id
            JOIN patients p ON p.id = i.patient_id
            LEFT JOIN parties d ON d.id = it.doctor_id
           WHERE (i.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
           ORDER BY i.id, it.id`,
    dated: true,
    tz: true,
  },
  payments: {
    label: "سندات القبض",
    headers: ["رقم السند", "النوع", "المريض", "التاريخ", "المبلغ", "العملة", "سعر الصرف", "المكافئ", "الطريقة", "المستلم", "ملاحظة"],
    sql: `SELECT y.receipt_number, y.kind, p.full_name, (y.created_at AT TIME ZONE $1)::date,
                 y.amount_minor, y.currency, y.exchange_rate, y.base_amount_minor,
                 y.method, y.created_by, y.note
            FROM payments y JOIN patients p ON p.id = y.patient_id
           WHERE (y.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
           ORDER BY y.id`,
    dated: true,
    tz: true,
  },
  expenses: {
    label: "سندات الصرف",
    headers: ["رقم السند", "البند", "الجهة", "التاريخ", "المبلغ", "العملة", "سعر الصرف", "المكافئ", "الصارف", "بيان"],
    sql: `SELECT e.voucher_number, e.category, COALESCE(t.name, e.payee_text),
                 (e.created_at AT TIME ZONE $1)::date, e.amount_minor, e.currency,
                 e.exchange_rate, e.base_amount_minor, e.created_by, e.note
            FROM expenses e LEFT JOIN parties t ON t.id = e.party_id
           WHERE (e.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
           ORDER BY e.id`,
    dated: true,
    tz: true,
  },
  payables: {
    label: "الالتزامات",
    headers: ["الجهة", "البند", "البيان", "التاريخ", "المبلغ", "العملة", "المكافئ", "تاريخ الاستحقاق"],
    sql: `SELECT t.name, b.category, b.description, (b.created_at AT TIME ZONE $1)::date,
                 b.amount_minor, b.currency, b.base_amount_minor, b.due_date
            FROM payables b JOIN parties t ON t.id = b.party_id
           WHERE (b.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
           ORDER BY b.id`,
    dated: true,
    tz: true,
  },
  opening_balances: {
    label: "الأرصدة الافتتاحية",
    headers: ["رقم الملف", "المريض", "الجوال", "المبلغ", "تاريخ الرصيد", "ملاحظة", "أدخله"],
    sql: `SELECT p.patient_number, p.full_name, p.phone, o.amount_minor,
                 o.as_of_date, o.note, o.created_by
            FROM patient_opening_balances o JOIN patients p ON p.id = o.patient_id
           WHERE o.as_of_date BETWEEN $1::date AND $2::date
           ORDER BY o.amount_minor DESC`,
    dated: true,
    tz: false,
  },
  lab_orders: {
    label: "أعمال المختبر",
    headers: ["المريض", "المختبر", "نوع العمل", "التفاصيل", "أُرسل", "الاستحقاق", "الحالة", "التكلفة", "العملة"],
    sql: `SELECT p.full_name, l.lab_name, l.work_type, l.details, l.sent_date, l.due_date,
                 l.status, l.cost_minor, l.cost_currency
            FROM lab_orders l JOIN patients p ON p.id = l.patient_id
           WHERE l.sent_date BETWEEN $1::date AND $2::date
           ORDER BY l.id`,
    dated: true,
    tz: false,
  },
};

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  // التصدير يُخرج كل بيانات المرضى والمال في ملف واحد — للمدير وحده.
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "التصدير للمدير وحده." }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const table = params.get("table") ?? "";
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);

  if (table === "journal") {
    const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : `${today.slice(0, 4)}-01-01`;
    const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
    const entries = await journalEntries(from, to);
    const rows = entries.flatMap((entry) => entry.lines.map((line) => [
      entry.date, entry.source, entry.reference, entry.description,
      line.accountCode,
      line.side === "debit" ? line.amountMinor : "",
      line.side === "credit" ? line.amountMinor : "",
    ]));
    const body = csvFile(
      ["التاريخ", "المصدر", "المرجع", "البيان", "الحساب", "مدين", "دائن"],
      rows,
    );
    await recordAudit({
      action: "export.download",
      details: { الجدول: "journal", من: from, إلى: to, عدد_الأسطر: rows.length },
      actor: session.username, actorRole: session.role,
    });
    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFileName("journal", from, to)}"`,
      },
    });
  }

  const definition = TABLES[table];
  if (!definition) {
    return NextResponse.json({ message: "جدول غير معروف." }, { status: 400 });
  }

  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : `${today.slice(0, 4)}-01-01`;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;

  try {
    await ensureSchema();
    // الاستعلام غير المؤرَّخ لا يشير إلى $2 و$3، وPostgres يرفض معاملات زائدة عن
    // ما يستخدمه الاستعلام — فيسقط التصدير برسالة عامة لا تدلّ على السبب.
    const values = definition.tz
      ? (definition.dated ? [CLINIC_TIME_ZONE, from, to] : [CLINIC_TIME_ZONE])
      : [from, to];
    const { rows } = await getPool().query(definition.sql, values);
    const body = csvFile(
      definition.headers,
      rows.map((row) => Object.values(row).map((value) =>
        value instanceof Date ? value.toISOString().slice(0, 19).replace("T", " ") : value)),
    );
    // خروج بيانات المرضى يُسجَّل: أي جدول ومتى وكم سطرًا وبيد من.
    await recordAudit({
      action: "export.download",
      details: { الجدول: table, من: from, إلى: to, عدد_الأسطر: rows.length },
      actor: session.username, actorRole: session.role,
    });
    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFileName(table, from, to)}"`,
      },
    });
  } catch {
    return NextResponse.json({ message: "تعذّر التصدير." }, { status: 500 });
  }
}
