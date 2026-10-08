import { notFound } from "next/navigation";
import { getPatient, getSettingsSafe, getDocumentForDownload, CLINIC_TIME_ZONE } from "@/lib/db";
import { readFileByKey } from "@/lib/files";
import { ageFromBirthYear, ageText, GENDER_LABEL } from "@/lib/patient";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import {
  CONSENT_TEMPLATES,
  getConsentTemplate,
  type ConsentTemplate,
} from "@/lib/consent-templates";
import { parseStoredConsent, type StoredConsent, type StoredSection } from "@/lib/consent-record";

export const dynamic = "force-dynamic";

type SearchValue = string | string[] | undefined;

/* قيمٌ كانت الصفحة تقبلها من الرابط فتتقدّم على المستند المحفوظ. مع إقرارٍ محفوظ لا مكان لأيٍّ منها:
   الإقرار الموقّع يُعاد من سجله وحده. */
const OVERRIDE_KEYS = [
  "templateId", "template", "signatoryName", "signatoryRelation", "guardianRelation", "doctorName", "date",
] as const;

const PAGE_STYLES = `
  @media print { @page { size: A4; } }
  .consent-watermark {
    position: fixed; inset: 0; margin: auto; height: fit-content; text-align: center;
    font-size: 40pt; font-weight: 900; color: rgba(185, 28, 28, 0.10); transform: rotate(-24deg);
    pointer-events: none; z-index: 40;
  }
  @media screen and (max-width: 600px) {
    .consent-sheet { width: 100% !important; min-height: 0 !important; padding: 6mm 4mm !important; box-sizing: border-box; }
    .consent-grid { grid-template-columns: 1fr !important; }
    .consent-sheet * { min-width: 0; overflow-wrap: anywhere; }
  }
`;

type SignedResolution =
  /** `signedOn` = تاريخ التوقيع المسجَّل، أو `null` إن لم يُسجَّل — لا يُستبدل بتاريخ الرفع. */
  | { ok: true; documentId: number; stored: StoredConsent; signedOn: string | null; recordedBy: string; recordedAt: string }
  | { ok: false; reason: string };

/* رسالة واحدة لما لا يُكشف عنه: غير موجود، أو لمريضٍ آخر. */
const NOT_THIS_PATIENT = "لا يوجد إقرار موافقة محفوظ بهذا الرقم في ملف هذا المريض.";

async function resolveSignedConsent(
  session: NonNullable<Awaited<ReturnType<typeof requireSession>>>,
  patientId: number,
  query: Record<string, SearchValue>,
): Promise<SignedResolution> {
  const docId = Number(typeof query.docId === "string" ? query.docId : NaN);
  if (!Number.isInteger(docId) || docId <= 0) return { ok: false, reason: "رقم الإقرار في الرابط غير صالح." };
  if (OVERRIDE_KEYS.some((key) => query[key] !== undefined)) {
    return {
      ok: false,
      reason: "رابط إعادة الطباعة يحمل قيمًا (القالب أو الموقّع أو الطبيب أو التاريخ) لا تُقبل مع إقرارٍ محفوظ: الإقرار الموقّع يُطبع من سجله وحده.",
    };
  }
  /* الصلاحية نفسها التي يفتح بها المستند (`/api/documents/[id]`): من لا يرى صورة التوقيع لا يُعرض له إقرارٌ موقّع. */
  if (!(await canAccessPatient(session, patientId, "canViewXrays").catch(() => false))) {
    return { ok: false, reason: "لا صلاحية لك للاطلاع على الإقرارات المحفوظة في ملف هذا المريض." };
  }
  const found = await getDocumentForDownload(docId).catch(() => null);
  if (!found || found.document.patientId !== patientId) return { ok: false, reason: NOT_THIS_PATIENT };
  const { document } = found;
  if (document.kind !== "consent") return { ok: false, reason: "المستند المطلوب ليس إقرار موافقة، ولا يُعرض كتوقيع." };
  if (document.removedAt) return { ok: false, reason: "هذا الإقرار مخفيٌّ من ملف المريض، ولا يُعاد طباعته نسخةً موقّعة." };
  if (!document.isImage) return { ok: false, reason: "ملف هذا الإقرار ليس صورة توقيع." };
  const stored = parseStoredConsent(document.note);
  if (!stored) {
    return { ok: false, reason: "سجل هذا الإقرار ناقص أو غير مقروء، فلا تُبنى منه نسخةٌ موقّعة موثوقة." };
  }
  const bytes = await readFileByKey(found.storageKey).catch(() => null);
  if (!bytes) return { ok: false, reason: "ملف التوقيع لهذا الإقرار مفقود من التخزين." };
  return {
    ok: true,
    documentId: document.id,
    stored,
    signedOn: document.takenOn ?? null,
    recordedBy: document.uploadedBy,
    recordedAt: document.uploadedAt,
  };
}

function PatientBox({ patient, dateStr, dateLabel, unknownDate }: {
  patient: NonNullable<Awaited<ReturnType<typeof getPatient>>>;
  dateStr: string | null;
  dateLabel: string;
  /** إقرارٌ موقّع لم يُسجَّل تاريخ توقيعه: يُقال ذلك صراحةً، والعمر يُذكر أنه الحالي لا عمر يوم التوقيع. */
  unknownDate?: boolean;
}) {
  // للنموذج غير الموقّع يُحسب العمر بسنة اليوم كما كانت الصفحة تفعل؛ للموقّع بسنة التوقيع المحفوظ.
  const now = new Date();
  const ageDate = dateStr ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const age = ageFromBirthYear(patient.birthYear, ageDate);
  return (
    <div
      className="consent-grid"
      style={{
        display: "grid", gridTemplateColumns: "1.2fr 0.8fr 1fr 1fr", gap: "2mm", backgroundColor: "#f8fafc",
        border: "1px solid #cbd5e1", borderRadius: "2mm", padding: "2.5mm 3.5mm", marginTop: "3mm", fontSize: "8.5pt",
      }}
    >
      <div><span style={{ color: "#64748b" }}>اسم المريض: </span><strong style={{ color: "#0f172a" }}>{patient.fullName}</strong></div>
      <div>
        <span style={{ color: "#64748b" }}>رقم الملف: </span>
        <span className="num" dir="ltr" style={{ fontWeight: 800 }}>{patient.patientNumber}</span>
      </div>
      <div><span style={{ color: "#64748b" }}>{unknownDate ? "العمر الحالي / الجنس" : "العمر / الجنس"}: </span><span>{ageText(age)} · {GENDER_LABEL[patient.gender]}</span></div>
      <div><span style={{ color: "#64748b" }}>{dateLabel}: </span><span data-signing-date={unknownDate ? "unknown" : undefined}>
        {dateStr ? friendlyDateLong(dateStr) : unknownDate ? "غير مسجّل في السجل" : "...................."}</span></div>
    </div>
  );
}

function TermsSections({ terms, risks, postOpInstructions }: { terms: string[]; risks: string[]; postOpInstructions: string[] }) {
  const heading = (color: string, background: string, border?: string) => ({
    fontWeight: 800, fontSize: "9pt", color, backgroundColor: background, padding: "1mm 2.5mm",
    marginBottom: "1.5mm", ...(border ? { borderRight: `3px solid ${border}` } : { borderRadius: "1mm" }),
  });
  const list = { margin: 0, paddingRight: "5mm", fontSize: "8pt", color: "#334155", display: "grid", gap: "1.5mm" } as const;
  return (
    <>
      <div style={{ marginTop: "2mm" }}>
        <div style={heading("#0f172a", "#f1f5f9")}>أولاً: الشروط والبنود الطبية المتفق عليها:</div>
        <ol style={{ ...list, gap: "1.2mm", color: "#1e293b" }}>
          {terms.map((term, index) => <li key={index} style={{ paddingRight: "1mm" }}>{term}</li>)}
        </ol>
      </div>
      {risks.length ? (
        <div style={{ marginTop: "3mm" }}>
          <div style={heading("#991b1b", "#fff1f2", "#e11d48")}>ثانياً: المخاطر والمضاعفات المحتملة المصاحبة للإجراء:</div>
          <ul className="consent-grid" style={{ ...list, gridTemplateColumns: "1fr 1fr" }}>
            {risks.map((risk, index) => <li key={index} style={{ paddingRight: "1mm" }}>{risk}</li>)}
          </ul>
        </div>
      ) : null}
      {postOpInstructions.length ? (
        <div style={{ marginTop: "3mm" }}>
          <div style={heading("#0369a1", "#f0f9ff", "#0284c7")}>ثالثاً: تعليمات العناية والتزام المريض بعد الجلسة:</div>
          <ul className="consent-grid" style={{ ...list, gridTemplateColumns: "1fr 1fr" }}>
            {postOpInstructions.map((care, index) => <li key={index} style={{ paddingRight: "1mm" }}>{care}</li>)}
          </ul>
        </div>
      ) : null}
    </>
  );
}

/** نص الإقرار المحفوظ كما هو: القسم غير المحفوظ أو غير المقروء يُقال صراحةً، ولا يُملأ من قالب اليوم. */
function StoredTermsSections({ snapshot }: { snapshot: NonNullable<StoredConsent["snapshot"]> }) {
  const missing = (label: string, state: StoredSection["state"]) => (
    <p data-snapshot-section-missing style={{ margin: 0, fontSize: "8pt", color: "#9a3412", fontWeight: 700 }}>
      {state === "malformed" ? `${label}: محفوظ بصيغةٍ غير مقروءة — لا يُعرض ولا يُستكمل من قالب اليوم.`
        : `${label}: غير محفوظ في هذا السجل — لا يُستكمل من قالب اليوم.`}
    </p>
  );
  const items = (one: StoredSection) => (one.state === "stored" ? one.items : []);
  const termsBlank = snapshot.terms.state === "stored" && (snapshot.terms.items.length === 0 || snapshot.terms.items.some((item) => !item.trim()));
  return (
    <>
      {!snapshot.complete ? (
        <div data-snapshot-partial style={{ marginTop: "2mm", border: "1px dashed #ea580c", borderRadius: "2mm", padding: "2mm 3mm", fontSize: "8.5pt", color: "#7c2d12" }}>
          النص المحفوظ مع هذا الإقرار ناقص. يُعرض ما حُفظ فقط كما هو؛ وما لم يُحفظ لا يُعاد بناؤه من قالب اليوم ولا يُعدّ معروضًا على الموقّع.
        </div>
      ) : null}
      {snapshot.terms.state !== "stored" ? missing("الشروط والبنود", snapshot.terms.state)
        : termsBlank ? <p data-snapshot-section-missing style={{ margin: "2mm 0 0", fontSize: "8pt", color: "#9a3412", fontWeight: 700 }}>
          الشروط والبنود: محفوظة فارغة أو بسطورٍ فارغة — لا تُعدّ نصًّا كاملًا.</p> : null}
      <TermsSections terms={items(snapshot.terms).filter((item) => item.trim())} risks={items(snapshot.risks)}
        postOpInstructions={items(snapshot.postOpInstructions)} />
      {snapshot.risks.state !== "stored" ? missing("المخاطر والمضاعفات", snapshot.risks.state) : null}
      {snapshot.postOpInstructions.state !== "stored" ? missing("تعليمات العناية", snapshot.postOpInstructions.state) : null}
    </>
  );
}

const DECLARATION =
  "أقر أنا الموقع أدناه بكامل قواي العقلية وبإرادتي الحرة، بأن الطبيب المعالج قد شرح لي طبيعة الإجراء السني المذكور أعلاه، وفوائده المرجوة، والخيارات العلاجية البديلة، والمضاعفات المحتملة. وقد تم إعطائي الفرصة الكافية لطرح كافة الاستفسارات وتلقيت إجابات وافية ومرضية. وعليه، فإنني أوافق بكامل الرضا على البدء في هذا الإجراء، وأتعهد باتباع التعليمات الطبية والدوائية بدقة.";

/**
 * وثيقة الإقرار والموافقة الطبية المستنيرة — مقاس A4، بثلاث حالاتٍ لا تختلط:
 *
 *  ١. إعادة طباعة إقرارٍ موقّع (`?docId=`): من السجل المحفوظ وحده — الموقّع وصفته والقالب المسجَّل
 *     وتاريخ التوقيع وصورة التوقيع. لا يُقبل من الرابط شيءٌ يغيّرها، ولا يُبنى النص من قالب اليوم:
 *     تعديل القالب لاحقًا لا يغيّر معنى موافقةٍ قديمة. والسجل الذي لم يحفظ نصّ الإقرار يُقال عنه ذلك.
 *  ٢. نموذج غير موقّع (بلا `docId`): القالب المطلوب بعلامة «نموذج غير موقّع»، بخاناتٍ فارغة للتوقيع
 *     باليد — بلا أي توقيعٍ محفوظ ولا بيانات موقّعٍ من الرابط.
 *  ٣. رفضٌ صريح: مستندٌ لمريضٍ آخر أو ليس إقرارًا أو مخفي أو ناقص أو ملفه مفقود، أو صلاحيةٌ لا تكفي،
 *     أو رابطٌ يخالف المحفوظ — لا يتحوّل إلى نموذجٍ افتراضي يبدو موقّعًا.
 */
export default async function ConsentPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, SearchValue>>;
}) {
  const session = await requireSession();
  if (!session) notFound();

  const { id: rawId } = await params;
  const patientId = Number(rawId);
  if (!Number.isInteger(patientId) || patientId <= 0) notFound();

  const query = await searchParams;
  const [patient, settings] = await Promise.all([getPatient(patientId), getSettingsSafe()]);
  if (!patient) notFound();
  /* حرس الباب (P0.12): صفحة الطباعة تتحقق بنفسها من ملكية المريض — لا
   * تعتمد على الوكيل العام الذي يمرر /print/*. */
  if (!(await canAccessPatient(session, patientId).catch(() => false))) notFound();

  if (query.docId !== undefined) {
    const resolution = await resolveSignedConsent(session, patientId, query);
    if (!resolution.ok) {
      return (
        <>
          <style>{PAGE_STYLES}</style>
          <div className="sheet sheet-a4 consent-sheet" data-consent-mode="refused" style={{ padding: "10mm 12mm", fontSize: "9pt" }}>
            <PrintHeader settings={settings} title="إعادة طباعة إقرار موافقة موقّع" compact />
            <PatientBox patient={patient} dateStr={null} dateLabel="تاريخ الإقرار" />
            <div role="alert" data-refusal-reason
              style={{ marginTop: "6mm", border: "1.5px solid #b91c1c", borderRadius: "2mm", padding: "4mm", color: "#7f1d1d", backgroundColor: "#fef2f2" }}>
              <p style={{ fontWeight: 900, fontSize: "11pt", margin: "0 0 2mm" }}>تعذّرت إعادة طباعة نسخةٍ موقّعة</p>
              <p style={{ margin: 0 }}>{resolution.reason}</p>
            </div>
            <p style={{ marginTop: "4mm", fontSize: "8.5pt", color: "#334155" }}>
              افتح الإقرار من «مستندات المريض» لإعادة طباعته كما حُفظ، أو اطبع{" "}
              <a href={`/print/consent/${patientId}`}>نموذجًا غير موقّع</a> لتوقيعٍ جديد باليد.
            </p>
            <PrintFooter settings={settings} />
          </div>
        </>
      );
    }

    const { stored } = resolution;
    const relationText = stored.signatoryRelation === "self"
      ? "المريض شخصياً"
      : `الولي / الوصي الشرعي: ${stored.guardianRelation ?? "صلة القرابة غير مسجّلة"}`;
    const recordedAt = new Intl.DateTimeFormat("ar-YE", { dateStyle: "medium", timeStyle: "short", timeZone: CLINIC_TIME_ZONE })
      .format(new Date(resolution.recordedAt));
    return (
      <>
        <style>{PAGE_STYLES}</style>
        <PrintButton />
        <div className="sheet sheet-a4 consent-sheet" data-consent-mode="signed" style={{ padding: "10mm 12mm", fontSize: "9pt", lineHeight: "1.45" }}>
          <PrintHeader settings={settings} title="إقرار موافقة مستنيرة — نسخة معاد طباعتها من سجلٍّ محفوظ" compact />
          <PatientBox patient={patient} dateStr={resolution.signedOn} dateLabel="تاريخ التوقيع" unknownDate={resolution.signedOn === null} />

          <div style={{ marginTop: "3.5mm", borderBottom: "1.5px solid #0f172a", paddingBottom: "1.5mm" }}>
            <span style={{ fontSize: "11pt", fontWeight: 900, color: "#0f172a" }}>
              {stored.title ?? "إقرار موافقة"}{stored.procedureName ? ` (${stored.procedureName})` : ""}
            </span>
            <span style={{ fontSize: "8pt", color: "#64748b", fontWeight: 700, marginInlineStart: "3mm" }}>
              كود القالب المسجَّل: {stored.templateId}
            </span>
          </div>

          {stored.snapshot ? (
            <>
              <p style={{ margin: "2mm 0", fontSize: "8pt", color: "#334155" }}>النص أدناه هو المحفوظ مع الإقرار وقت التوقيع.</p>
              <StoredTermsSections snapshot={stored.snapshot} />
            </>
          ) : (
            <div data-no-snapshot style={{ marginTop: "3mm", border: "1px dashed #94a3b8", borderRadius: "2mm", padding: "3mm", fontSize: "8.5pt", color: "#0f172a" }}>
              لم يحفظ هذا السجل نص الإقرار كما عُرض على الموقّع وقت التوقيع. لذلك لا تُعاد كتابة البنود والمخاطر من
              قالب اليوم — فقد يكون تغيّر بعد التوقيع. المرجع المحفوظ: عنوان الإقرار والإجراء وكود القالب المسجَّلة أعلاه،
              وهوية الموقّع وتاريخ التوقيع وصورة التوقيع أدناه.
            </div>
          )}

          <div className="consent-grid" style={{ marginTop: "5mm", borderTop: "1.5px solid #0f172a", paddingTop: "3.5mm", display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: "6mm" }}>
            <div>
              <div style={{ fontSize: "8.5pt", fontWeight: 800, color: "#0f172a", marginBottom: "1mm" }}>المقر بما فيه ({relationText})</div>
              <div style={{ fontSize: "8pt", color: "#334155" }}>الاسم: <strong>{stored.signatoryName}</strong></div>
              <div style={{ height: "20mm", borderBottom: "1px dotted #94a3b8", display: "flex", alignItems: "center", justifyContent: "center", margin: "1.5mm 0" }}>
                <img data-signature-img src={`/api/documents/${resolution.documentId}`} alt="التوقيع المحفوظ للمقر"
                  style={{ maxHeight: "18mm", maxWidth: "90%", objectFit: "contain" }} />
              </div>
              <div style={{ fontSize: "7.5pt", color: "#64748b" }}>
                تاريخ التوقيع: {resolution.signedOn ? friendlyDateLong(resolution.signedOn) : "غير مسجّل في السجل (وقت التسجيل في النظام أدناه ليس تاريخ التوقيع)"}
              </div>
            </div>
            <div style={{ fontSize: "8pt", color: "#334155", lineHeight: 1.7 }}>
              <div style={{ fontWeight: 800, color: "#0f172a" }}>بيانات السجل</div>
              <div>رقم المستند: <span className="num" dir="ltr">{resolution.documentId}</span></div>
              <div>سجّله في النظام: {resolution.recordedBy}</div>
              <div>وقت التسجيل: {recordedAt}</div>
              <div style={{ marginTop: "2mm", color: "#64748b" }}>
                هذه نسخةٌ معاد طباعتها من السجل المحفوظ؛ لا تحمل توقيعًا جديدًا ولا تغيّر الأصل.
              </div>
            </div>
          </div>
          <PrintFooter settings={settings} />
        </div>
      </>
    );
  }

  /* نموذج غير موقّع: القالب المطلوب فقط — `templateId`، أو `template` الذي يمرّره المساعد الذكي. */
  const requestedTemplate = typeof query.templateId === "string" ? query.templateId
    : typeof query.template === "string" ? query.template : null;
  const template: ConsentTemplate = (requestedTemplate ? getConsentTemplate(requestedTemplate) : null) ?? CONSENT_TEMPLATES[0];
  return (
    <>
      <style>{PAGE_STYLES}</style>
      <PrintButton />
      <div className="sheet sheet-a4 consent-sheet" data-consent-mode="blank" style={{ padding: "10mm 12mm", fontSize: "9pt", lineHeight: "1.45" }}>
        <div className="consent-watermark" aria-hidden="true">نموذج غير موقّع</div>
        <PrintHeader settings={settings} title="إقرار موافقة مستنيرة على إجراء علاجي أو جراحي سني" compact />
        <div role="note" style={{ marginTop: "2mm", border: "1.5px solid #b45309", backgroundColor: "#fffbeb", color: "#78350f", borderRadius: "2mm", padding: "2mm 3mm", fontWeight: 800, fontSize: "8.5pt" }}>
          نموذج غير موقّع — للقراءة والتوقيع باليد. ليس نسخةً من إقرارٍ محفوظ، ولا يحمل توقيعًا.
        </div>
        <PatientBox patient={patient} dateStr={null} dateLabel="تاريخ الإقرار" />

        <div style={{ marginTop: "3.5mm", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1.5px solid #0f172a", paddingBottom: "1.5mm", marginBottom: "2mm" }}>
          <span style={{ fontSize: "11pt", fontWeight: 900, color: "#0f172a" }}>{template.title} ({template.procedureName})</span>
          <span style={{ fontSize: "8pt", color: "#64748b", fontWeight: 700 }}>كود الإقرار: {template.id}</span>
        </div>
        <p style={{ margin: "0 0 3mm", fontSize: "8.5pt", color: "#334155" }}>{template.summary}</p>
        <TermsSections terms={template.terms} risks={template.risks} postOpInstructions={template.postOpInstructions} />

        <div style={{ border: "1px solid #cbd5e1", backgroundColor: "#fafafa", borderRadius: "2mm", padding: "2.5mm 3.5mm", marginTop: "4mm", fontSize: "8pt", color: "#0f172a", textAlign: "justify" }}>
          <strong>إقرار وتعهد صاحب التوقيع: </strong>{DECLARATION}
        </div>

        <div className="consent-grid" style={{ display: "grid", gridTemplateColumns: "1.3fr 0.9fr 1.2fr", gap: "4mm", marginTop: "5mm", borderTop: "1.5px solid #0f172a", paddingTop: "3.5mm" }}>
          <div>
            <div style={{ fontSize: "8.5pt", fontWeight: 800, color: "#0f172a", marginBottom: "1mm" }}>المقر بما فيه (المريض / الولي: ..........)</div>
            <div style={{ fontSize: "8pt", color: "#334155" }}>الاسم: .......................................</div>
            <div style={{ height: "18mm", borderBottom: "1px dotted #94a3b8", margin: "1.5mm 0" }} />
            <div style={{ fontSize: "7.5pt", color: "#64748b" }}>التاريخ: ....................</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "8.5pt", fontWeight: 800, color: "#0f172a", marginBottom: "1mm" }}>الشاهد / التمريض المعاون</div>
            <div style={{ fontSize: "8pt", color: "#334155" }}>الاسم: .......................................</div>
            <div style={{ height: "18mm", borderBottom: "1px dotted #94a3b8", margin: "1.5mm auto 0", width: "85%" }} />
            <div style={{ fontSize: "7.5pt", color: "#64748b", marginTop: "1.5mm" }}>التوقيع</div>
          </div>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: "8.5pt", fontWeight: 800, color: "#0f172a", marginBottom: "1mm" }}>الطبيب المعالج · Attending Doctor</div>
            <div style={{ fontSize: "8pt", color: "#334155" }}>الاسم: .......................................</div>
            <div style={{ height: "18mm", borderBottom: "1px dotted #94a3b8", margin: "1.5mm 0" }} />
            <div style={{ fontSize: "7.5pt", color: "#64748b" }}>التوقيع والختم المهني</div>
          </div>
        </div>
        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
