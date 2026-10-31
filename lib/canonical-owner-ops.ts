import "server-only";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { NextResponse } from "next/server";
import { backupFileName } from "./backup";
import {
  isResetPhrase,
  ProtectedAgreementHistoryError,
  ProtectedCollectionAttemptHistoryError,
  ProtectedInvoiceActionHistoryError,
  ProtectedLabHistoryError,
  ProtectedOrthoFollowupHistoryError,
  ProtectedPatientNumberHistoryError,
  ProtectedPurchaseHistoryError,
  RESET_CONFIRM_PHRASE,
  RESET_PREVIEW_GROUPS,
} from "./clinic-reset";
import { csvFile, exportFileName } from "./csv";
import {
  allPatientCandidates,
  applyLegacyAssignments,
  backupSqlLines,
  CLINIC_TIME_ZONE,
  clinicResetPreview,
  commitLegacyImport,
  commitPatientImport,
  documentsForArchive,
  existingOpeningKeys,
  expenseAttachmentsForArchive,
  findLegacyImport,
  findPatientImport,
  insertAuditRow,
  journalEntries,
  legacyPatientRefs,
  resetClinicData,
} from "./db";
import { readFileByKey, removeFileByKey, storageStatus } from "./files";
import { fullBackupBlocks } from "./fullBackup";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { ProtectedInventoryHistoryError } from "./inventory-domain/reset-protection";
import {
  JOURNAL_REVIEW_RESPONSE,
  JournalReadIntegrityError,
} from "./journal-read-integrity";
import {
  parseLegacySessions,
  parseLegacyTreatments,
  planLegacyImport,
} from "./legacy-import";
import { runVerifiedManualBackup } from "./manual-backup";
import {
  classifyImportRows,
  importSummary,
  looksLikeBrokenEncoding,
  parseCsv,
  type ImportRow,
} from "./patient-import";
import { clinicDateString } from "./schedule";
import {
  IMPORT_BODY_LIMIT_BYTES,
  SETTINGS_BODY_LIMIT_BYTES,
} from "./security-limits";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { withCanonicalOwnerOperation } from "./staff-session-admission";
import { safeEntryName, tarEnd, tarHeader, tarPadding } from "./tar";

const OWNER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const ownerNoStore = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

function ownerAdmissionFailure(
  reason: "unauthenticated" | "forbidden" | "unavailable",
  forbiddenMessage: string,
  unauthMessage = "انتهت الجلسة. سجّل الدخول من جديد.",
): NextResponse {
  if (reason === "forbidden") return ownerNoStore({ message: forbiddenMessage }, 403);
  if (reason === "unavailable") return ownerNoStore({ message: "الهوية الموحّدة غير متاحة الآن." }, 503);
  return ownerNoStore({ message: unauthMessage }, 401);
}

export async function canonicalBackupSqlGet(
  session: VerifiedDurableSession,
): Promise<Response> {
  const now = new Date();
  const date = clinicDateString(now, CLINIC_TIME_ZONE);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: CLINIC_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);

  const admitted = await withCanonicalOwnerOperation(
    session,
    "clinic.backup.manage",
    async (client, view) => {
      await insertAuditRow(client, {
        action: "backup.download",
        details: { التاريخ: date, الوقت: time },
        actor: view.username,
        actorRole: view.roleLabel,
      });
      return true;
    },
  );
  if (!admitted.ok) {
    return ownerAdmissionFailure(admitted.reason, "النسخة الاحتياطية للمدير وحده.");
  }

  const encoder = new TextEncoder();
  const iterator = backupSqlLines();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/sql; charset=utf-8",
      "Content-Disposition": `attachment; filename="${backupFileName(date, time)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function canonicalBackupDocumentsGet(
  session: VerifiedDurableSession,
): Promise<Response> {
  const admitted = await withCanonicalOwnerOperation(
    session,
    "clinic.backup.manage",
    async (client, view) => {
      const storage = await storageStatus();
      if (!storage.ready) {
        return { kind: "storage_unready" as const, message: storage.message };
      }
      const rows = await documentsForArchive();
      const expenseRows = await expenseAttachmentsForArchive();
      const totalCount = rows.length + expenseRows.length;
      if (totalCount === 0) {
        return { kind: "empty" as const };
      }
      await insertAuditRow(client, {
        action: "backup.download",
        entity: "patient_documents",
        entityLabel: `أرشيف الأشعة والمرفقات — ${totalCount} ملفًّا`,
        details: {
          عدد_الملفات: totalCount,
          أشعة_المرضى: rows.length,
          مرفقات_المصروفات: expenseRows.length,
        },
        actor: view.username,
        actorRole: view.roleLabel,
      });
      return { kind: "ok" as const, rows, expenseRows };
    },
  );
  if (!admitted.ok) {
    return ownerAdmissionFailure(admitted.reason, "النسخ الاحتياطي للمدير وحده.");
  }
  if (admitted.value.kind === "storage_unready") {
    return ownerNoStore({ message: admitted.value.message }, 503);
  }
  if (admitted.value.kind === "empty") {
    return ownerNoStore({ message: "لا توجد أشعة أو مستندات بعد." }, 404);
  }

  const { rows, expenseRows } = admitted.value;
  const stamp = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const missing: string[] = [];

  async function* canonicalDocumentArchiveBlocks() {
    for (const row of rows) {
      const bytes = await readFileByKey(row.storageKey);
      if (!bytes) {
        missing.push(`${row.patientNumber} · ${row.title}`);
        continue;
      }
      const folder = safeEntryName(`${row.patientNumber} ${row.patientName}`, row.patientNumber);
      const extension = row.storageKey.split(".").pop() ?? "bin";
      const base = safeEntryName(`${row.takenOn ?? stamp} ${row.kind} ${row.title}`, String(row.id));
      const name = `أشعة-${stamp}/${folder}/${row.id}-${base}.${extension}`;
      yield tarHeader(name, bytes.length, row.uploadedAt);
      yield new Uint8Array(bytes);
      yield tarPadding(bytes.length);
    }
    for (const att of expenseRows) {
      const bytes = await readFileByKey(att.storageKey);
      if (!bytes) {
        missing.push(`${att.voucherNumber} · ${att.title}`);
        continue;
      }
      const folder = safeEntryName(att.voucherNumber, `EXP-${att.expenseId}`);
      const extension = att.storageKey.split(".").pop() ?? "bin";
      const base = safeEntryName(att.title, String(att.id));
      const name = `أشعة-${stamp}/مرفقات-المصروفات/${folder}/${att.id}-${base}.${extension}`;
      yield tarHeader(name, bytes.length, att.uploadedAt);
      yield new Uint8Array(bytes);
      yield tarPadding(bytes.length);
    }
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

  const gzip = createGzip();
  const stream = Readable.from(canonicalDocumentArchiveBlocks()).pipe(gzip);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="aqlan-documents-${stamp}.tar.gz"`,
      "Cache-Control": "private, no-store",
    },
  });
}

export async function canonicalBackupFullGet(
  session: VerifiedDurableSession,
  request: Request,
): Promise<Response> {
  const admitted = await withCanonicalOwnerOperation(
    session,
    "clinic.backup.manage",
    async (client, view) => {
      await insertAuditRow(client, {
        action: "backup.full_download",
        details: { الوقت: new Date().toISOString() },
        actor: view.username,
        actorRole: view.roleLabel,
      });
      return view;
    },
  );
  if (!admitted.ok) {
    return ownerAdmissionFailure(admitted.reason, "النسخة الكاملة للمدير وحده.", "سجّل الدخول من جديد.");
  }

  const source = Readable.from(fullBackupBlocks());
  const gzip = createGzip();
  source.on("error", (error) => gzip.destroy(error));
  const abort = () => {
    source.destroy();
    gzip.destroy();
  };
  request.signal.addEventListener("abort", abort, { once: true });
  gzip.on("close", () => request.signal.removeEventListener("abort", abort));
  const output = source.pipe(gzip);

  const stamp = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  return new NextResponse(Readable.toWeb(output) as ReadableStream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="aqlan-full-backup-${stamp}.tar.gz"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const EXPORT_TABLES: Record<
  string,
  {
    label: string;
    headers: string[];
    sql: string;
    dated: boolean;
    tz: boolean;
  }
> = {
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
    headers: ["رقم الملف", "المريض", "الجوال", "المبلغ", "العملة", "تاريخ الرصيد", "ملاحظة", "أدخله"],
    sql: `SELECT p.patient_number, p.full_name, p.phone, o.amount_minor, o.currency,
                 o.as_of_date, o.note, o.created_by
            FROM patient_opening_balances o JOIN patients p ON p.id = o.patient_id
           WHERE o.as_of_date BETWEEN $1::date AND $2::date
           ORDER BY o.currency, o.amount_minor DESC`,
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

export async function canonicalExportGet(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const table = params.get("table") ?? "";
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const from = OWNER_DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : `${today.slice(0, 4)}-01-01`;
  const to = OWNER_DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;

  try {
    const admitted = await withCanonicalOwnerOperation(
      session,
      "clinic.data.export",
      async (client, view) => {
        if (table === "journal") {
          const entries = await journalEntries(from, to, client);
          const rows = entries.flatMap((entry) =>
            entry.lines.map((line) => [
              entry.date,
              entry.source,
              entry.reference,
              entry.description,
              line.accountCode,
              line.currency,
              line.side === "debit" ? line.amountMinor : "",
              line.side === "credit" ? line.amountMinor : "",
            ]),
          );
          const body = csvFile(
            ["التاريخ", "المصدر", "المرجع", "البيان", "الحساب", "العملة", "مدين (وحدات صغرى)", "دائن (وحدات صغرى)"],
            rows,
          );
          await insertAuditRow(client, {
            action: "export.download",
            details: { الجدول: "journal", من: from, إلى: to, عدد_الأسطر: rows.length },
            actor: view.username,
            actorRole: view.roleLabel,
          });
          return new NextResponse(body, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="${exportFileName("journal", from, to)}"`,
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }

        const definition = EXPORT_TABLES[table];
        if (!definition) {
          return ownerNoStore({ message: "جدول غير معروف." }, 400);
        }
        const values = definition.tz
          ? definition.dated
            ? [CLINIC_TIME_ZONE, from, to]
            : [CLINIC_TIME_ZONE]
          : [from, to];
        const { rows } = await client.query(definition.sql, values);
        const body = csvFile(
          definition.headers,
          rows.map((row) =>
            Object.values(row).map((value) =>
              value instanceof Date ? value.toISOString().slice(0, 19).replace("T", " ") : value,
            ),
          ),
        );
        await insertAuditRow(client, {
          action: "export.download",
          details: { الجدول: table, من: from, إلى: to, عدد_الأسطر: rows.length },
          actor: view.username,
          actorRole: view.roleLabel,
        });
        return new NextResponse(body, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${exportFileName(table, from, to)}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    );
    if (!admitted.ok) {
      return ownerAdmissionFailure(admitted.reason, "التصدير للمدير وحده.");
    }
    return admitted.value;
  } catch (error) {
    if (error instanceof JournalReadIntegrityError) {
      return ownerNoStore(JOURNAL_REVIEW_RESPONSE, 409);
    }
    return ownerNoStore({ message: "تعذّر التصدير." }, 500);
  }
}

function publicCanonicalImportRow(row: ImportRow) {
  return {
    line: row.line,
    status: row.status,
    reason: row.reason,
    fullName: row.patient?.fullName ?? null,
    phone: row.patient?.phone ?? null,
    birthYear: row.patient?.birthYear ?? null,
    legacyNumber: row.legacyNumber,
    openingMinor: row.openingMinor,
    openingCurrency: row.openingCurrency,
    matchedPatient: row.matchedPatient,
  };
}

export async function canonicalPatientsImportPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, IMPORT_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return ownerNoStore({ message: "طلب غير صالح." }, 400);
  }

  try {
    const admitted = await withCanonicalOwnerOperation(
      session,
      "clinic.data.import",
      async (_client, view) => {
        const csv = typeof body.csv === "string" ? body.csv : "";
        const fileName =
          typeof body.fileName === "string" && body.fileName.trim()
            ? body.fileName.trim().slice(0, 120)
            : "ملف بلا اسم";
        const mode = body.mode === "commit" ? "commit" : body.mode === "preview" ? "preview" : null;
        if (!mode) return ownerNoStore({ message: "حدّد المعاينة أو الحفظ." }, 400);
        if (!csv.trim()) return ownerNoStore({ message: "الملف فارغ." }, 400);
        if (looksLikeBrokenEncoding(csv)) {
          return ownerNoStore(
            {
              message: "الحروف العربية في الملف مكسورة. احفظه من Excel بصيغة «CSV UTF-8 (محدد بفاصلة)» ثم أعد رفعه.",
            },
            400,
          );
        }

        const rows = parseCsv(csv);
        const fileSha256 = createHash("sha256").update(csv, "utf8").digest("hex");
        const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);

        if (mode === "preview") {
          const existing = await allPatientCandidates();
          const previous = await findPatientImport(fileSha256);
          const classified = classifyImportRows(rows, existing, today);
          if (classified.rows.length === 0) {
            return ownerNoStore(
              { message: classified.problems[0] ?? "الملف غير صالح.", problems: classified.problems },
              400,
            );
          }
          return ownerNoStore({
            fileSha256,
            alreadyImported: previous,
            problems: classified.problems,
            summary: importSummary(classified.rows),
            rows: classified.rows.map(publicCanonicalImportRow),
          });
        }

        if (body.fileSha256 !== fileSha256) {
          return ownerNoStore({ message: "تغيّر الملف بعد المعاينة. عاينه من جديد قبل الاستيراد." }, 409);
        }
        const result = await commitPatientImport({
          rows,
          fileSha256,
          fileName,
          today,
          includePossibleDuplicates: body.includePossibleDuplicates === true,
          actor: view.username,
          actorRole: view.roleLabel,
        });
        if (!result.ok && result.reason === "already_imported") {
          return ownerNoStore(
            {
              message: "هذا الملف استُورد من قبل — لا يُستورد مرتين.",
              alreadyImported: { at: result.at, actor: result.actor },
            },
            409,
          );
        }
        if (!result.ok) {
          return ownerNoStore(
            { message: result.problems[0] ?? "الملف غير صالح.", problems: result.problems },
            400,
          );
        }
        return ownerNoStore(
          {
            created: result.created,
            summary: importSummary(result.rows),
          },
          201,
        );
      },
    );
    if (!admitted.ok) {
      return ownerAdmissionFailure(admitted.reason, "استيراد المرضى للمدير وحده.");
    }
    return admitted.value;
  } catch {
    return ownerNoStore({ message: "تعذّر الاستيراد. لم يُحفظ شيء — أعد المحاولة." }, 500);
  }
}

function canonicalLegacyAssignmentsOf(value: unknown): Record<number, number> {
  const result: Record<number, number> = {};
  if (!value || typeof value !== "object") return result;
  for (const [key, patient] of Object.entries(value as Record<string, unknown>)) {
    const treatment = Number(key);
    const patientId = Number(patient);
    if (Number.isInteger(treatment) && treatment > 0 && Number.isInteger(patientId) && patientId > 0) {
      result[treatment] = patientId;
    }
  }
  return result;
}

export async function canonicalPatientsLegacyImportPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, IMPORT_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return ownerNoStore({ message: "طلب غير صالح." }, 400);
  }

  try {
    const admitted = await withCanonicalOwnerOperation(
      session,
      "clinic.data.import",
      async (_client, view) => {
        const mode = body.mode === "commit" ? "commit" : body.mode === "preview" ? "preview" : null;
        if (!mode) return ownerNoStore({ message: "حدّد المعاينة أو الحفظ." }, 400);
        const treatmentsCsv = typeof body.treatmentsCsv === "string" ? body.treatmentsCsv : "";
        const sessionsCsv = typeof body.sessionsCsv === "string" ? body.sessionsCsv : "";
        if (!treatmentsCsv.trim()) return ownerNoStore({ message: "اختر ملف المعالجات." }, 400);
        if (mode === "commit" && !sessionsCsv.trim()) {
          return ownerNoStore(
            { message: "اختر ملف الجلسات (الدفعات) أيضًا — يُستورد الملفان معًا مرةً واحدة." },
            400,
          );
        }
        if (looksLikeBrokenEncoding(treatmentsCsv) || looksLikeBrokenEncoding(sessionsCsv)) {
          return ownerNoStore(
            { message: "الحروف العربية في الملف مكسورة. ارفع ملف Excel نفسه أو احفظه «CSV UTF-8»." },
            400,
          );
        }
        const fileNames = typeof body.fileNames === "string" ? body.fileNames.slice(0, 200) : "";

        const treatments = parseLegacyTreatments(parseCsv(treatmentsCsv));
        const sessions = sessionsCsv.trim()
          ? parseLegacySessions(parseCsv(sessionsCsv))
          : { records: [], problems: [] };
        if (treatments.records.length === 0) {
          return ownerNoStore(
            { message: treatments.problems[0]?.reason ?? "ملف المعالجات فارغ.", problems: treatments.problems },
            400,
          );
        }
        if (sessionsCsv.trim() && sessions.records.length === 0) {
          return ownerNoStore(
            { message: sessions.problems[0]?.reason ?? "ملف الدفعات فارغ.", problems: sessions.problems },
            400,
          );
        }
        const fileSha256 = createHash("sha256")
          .update(`${treatmentsCsv}\n--\n${sessionsCsv}`, "utf8")
          .digest("hex");
        const assignments = canonicalLegacyAssignmentsOf(body.assignments);

        if (mode === "preview") {
          const patients = await legacyPatientRefs();
          const previous = await findLegacyImport(fileSha256);
          const existing = await existingOpeningKeys();
          const plan = applyLegacyAssignments(
            planLegacyImport(treatments.records, sessions.records, patients),
            assignments,
            patients,
          );
          return ownerNoStore({
            fileSha256,
            alreadyImported: previous,
            problems: [
              ...treatments.problems.map((p) => ({ ...p, file: "المعالجات" })),
              ...sessions.problems.map((p) => ({ ...p, file: "الدفعات" })),
            ],
            summary: plan.summary,
            unresolved: plan.treatments
              .filter((row) => row.match.kind !== "matched")
              .map((row) => ({
                legacyNumber: row.record.legacyNumber,
                patientName: row.record.patientName,
                phone: row.record.phone,
                treatedOn: row.record.treatedOn,
                service: row.record.service,
                currency: row.record.currency,
                remainingMinor: row.record.remainingMinor,
                candidates:
                  row.match.kind === "ambiguous"
                    ? row.match.candidates.map((patient) => ({
                        id: patient.id,
                        patientNumber: patient.patientNumber,
                        fullName: patient.fullName,
                        phone: patient.phone,
                      }))
                    : [],
              })),
            conflicts: plan.balances.filter((balance) =>
              existing.has(`${balance.patientId}:${balance.currency}`),
            ).length,
          });
        }

        if (body.fileSha256 !== fileSha256) {
          return ownerNoStore({ message: "تغيّر الملفان بعد المعاينة. عاينهما من جديد قبل الاستيراد." }, 409);
        }
        const result = await commitLegacyImport({
          treatments: treatments.records,
          sessions: sessions.records,
          assignments,
          fileSha256,
          fileNames,
          asOfDate: clinicDateString(new Date(), CLINIC_TIME_ZONE),
          actor: view.username,
          actorRole: view.roleLabel,
        });
        if (!result.ok) {
          return ownerNoStore(
            {
              message: "هذان الملفان استُوردا من قبل — لا يُستوردان مرتين.",
              alreadyImported: { at: result.at, actor: result.actor },
            },
            409,
          );
        }
        return ownerNoStore(result, 201);
      },
    );
    if (!admitted.ok) {
      return ownerAdmissionFailure(admitted.reason, "استيراد النظام القديم للمدير وحده.");
    }
    return admitted.value;
  } catch {
    return ownerNoStore({ message: "تعذّر استيراد النظام القديم. لم يُحفظ شيء — أعد المحاولة." }, 500);
  }
}

export async function canonicalClinicResetGet(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const admitted = await withCanonicalOwnerOperation(
      session,
      "clinic.reset",
      async () => clinicResetPreview(),
    );
    if (!admitted.ok) {
      return ownerAdmissionFailure(admitted.reason, "إعادة الضبط للمدير وحده.");
    }
    return ownerNoStore(
      {
        phrase: RESET_CONFIRM_PHRASE,
        groups: RESET_PREVIEW_GROUPS.map((group) => ({
          label: group.label,
          count: admitted.value[group.table] ?? 0,
        })),
      },
      200,
    );
  } catch {
    return ownerNoStore({ message: "تعذّر حساب ما سيُمسح. أعد المحاولة." }, 500);
  }
}

export async function canonicalClinicResetPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProtectedLabHistoryError) {
      return ownerNoStore({ message: error.message, code: "protected-lab-history" }, 409);
    }
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return ownerNoStore({ message: "طلب غير صالح." }, 400);
  }

  const password = typeof body.password === "string" ? body.password : "";

  // IMPORTANT: Verify canonical owner + password inside the admission transaction,
  // then COMMIT and release `pg_advisory_xact_lock_shared` BEFORE calling `resetClinicData`,
  // because `resetClinicData` rotates the staff execution epoch on its own transaction!
  const admitted = await withCanonicalOwnerOperation(
    session,
    "clinic.reset",
    async (_client, view, verifyOwnPassword) => {
      if (!isResetPhrase(body.phrase)) {
        return { kind: "bad_phrase" as const };
      }
      const validPassword = await verifyOwnPassword(password);
      return validPassword
        ? { kind: "verified" as const, actor: view.username, actorRole: view.roleLabel }
        : { kind: "bad_password" as const };
    },
  );
  if (!admitted.ok) {
    return ownerAdmissionFailure(admitted.reason, "إعادة الضبط للمدير وحده.");
  }
  if (admitted.value.kind === "bad_phrase") {
    return ownerNoStore({ message: `اكتب عبارة التأكيد كما هي: «${RESET_CONFIRM_PHRASE}».` }, 400);
  }
  if (admitted.value.kind === "bad_password") {
    return ownerNoStore({ message: "كلمة المرور غير صحيحة." }, 400);
  }

  let result: Awaited<ReturnType<typeof resetClinicData<Record<string, unknown>>>>;
  try {
    result = await resetClinicData<Record<string, unknown>>(
      { actor: admitted.value.actor, actorRole: admitted.value.actorRole },
      async (client) => {
        const backup = await runVerifiedManualBackup({ client });
        return backup.ok
          ? { ok: true, backupId: backup.backup.backupId }
          : { ok: false, failure: backup.body };
      },
    );
  } catch (error) {
    if (error instanceof ProtectedLabHistoryError) return ownerNoStore({ message: error.message, code: "protected-lab-history" }, 409);
    if (error instanceof ProtectedPurchaseHistoryError) return ownerNoStore({ message: error.message, code: "protected-purchase-history" }, 409);
    if (error instanceof ProtectedOrthoFollowupHistoryError) return ownerNoStore({ message: error.message, code: "protected-ortho-followup-history" }, 409);
    if (error instanceof ProtectedInvoiceActionHistoryError) return ownerNoStore({ message: error.message, code: "protected-invoice-action-history" }, 409);
    if (error instanceof ProtectedAgreementHistoryError) return ownerNoStore({ message: error.message, code: "protected-agreement-history" }, 409);
    if (error instanceof ProtectedPatientNumberHistoryError) return ownerNoStore({ message: error.message, code: "protected-patient-number-history" }, 409);
    if (error instanceof ProtectedCollectionAttemptHistoryError) return ownerNoStore({ message: error.message, code: "protected-collection-attempt-history" }, 409);
    if (error instanceof ProtectedInventoryHistoryError) return ownerNoStore({ message: error.message, code: "protected-inventory-history" }, 409);
    return ownerNoStore(
      { message: "تعذّرت إعادة الضبط ولم يُمسح شيء. أعد المحاولة بعد قليل (قد يكون أحدٌ يُدخل بيانات الآن)." },
      500,
    );
  }
  if (!result.ok) {
    const failure = result.failure;
    const reason =
      typeof failure.message === "string"
        ? failure.message
        : failure.reason === "backup-disabled"
          ? "النسخ الاحتياطي غير مفعَّل."
          : "تعذّرت النسخة الاحتياطية.";
    return ownerNoStore(
      {
        message: `لم يُمسح شيء: ${reason} إعادة الضبط لا تتم إلا بعد نسخة احتياطية ناجحة — فعّل النسخ من الإعدادات ثم أعد المحاولة.`,
      },
      409,
    );
  }

  let filesRemoved = 0;
  let filesFailed = 0;
  for (const key of result.storageKeys) {
    try {
      if (await removeFileByKey(key)) filesRemoved += 1;
    } catch {
      filesFailed += 1;
    }
  }
  return ownerNoStore(
    {
      ok: true,
      backupId: result.backupId,
      filesRemoved,
      filesFailed,
      groups: RESET_PREVIEW_GROUPS.map((group) => ({
        label: group.label,
        count: result.counts[group.table] ?? 0,
      })),
    },
    200,
  );
}
