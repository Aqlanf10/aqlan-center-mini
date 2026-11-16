"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  Download,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  LogOut,
  Pill,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
  UserCheck,
} from "lucide-react";
import type { PortalLang, PortalProfileSummaryView } from "@/components/PortalAccountFlow";
import { formatMoney, type Currency } from "@/lib/money";
import { friendlyDate } from "@/lib/reminders";

interface VisitProcedureItem {
  serviceName: string;
  toothCode: number | null;
  quantity: number;
}

interface SignedVisitItem {
  id: number;
  visitDate: string;
  signedAt: string;
  doctorName: string | null;
  diagnosis: string | null;
  treatmentDone: string | null;
  nextPlan: string | null;
  procedures: VisitProcedureItem[];
}

interface TreatmentPlanLineItem {
  id: number;
  serviceName: string;
  toothCode: number | null;
  quantity: number;
  status: string;
  sessionsCompleted: number;
  sessionCount: number;
  doctorName: string | null;
  totalMinor: number | null;
}

interface TreatmentPlanItem {
  id: number;
  title: string;
  status: string;
  startDate: string;
  consentAt: string | null;
  baseCurrency: string;
  totalMinor: number | null;
  paidMinor: number | null;
  itemsDone: number;
  itemsTotal: number;
  itemsPercent: number;
  items: TreatmentPlanLineItem[];
}

interface PrescriptionDrugItem {
  drug: string;
  concentration: string | null;
  form: string | null;
  dosage: string;
  frequency: string;
  duration: string;
  timing: string | null;
  instructions: string | null;
}

interface PrescriptionRecordItem {
  id: number;
  visitId: number | null;
  prescribingDoctorName: string | null;
  diagnosis: string | null;
  notes: string | null;
  instructionsLang: string;
  status: "active" | "void";
  createdAt: string;
  items: PrescriptionDrugItem[];
}

interface PortalDocumentItem {
  id: number;
  kind: string;
  kindLabel: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  takenOn: string | null;
  uploadedAt: string;
  downloadUrl: string;
}

function formatByteSize(bytes: number, lang: PortalLang): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} ${lang === "en" ? "KB" : "ك.ب"}`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${lang === "en" ? "MB" : "م.ب"}`;
}

export function PortalProfileCard({
  profile,
  lang = "ar",
}: {
  profile: PortalProfileSummaryView;
  lang?: PortalLang;
}) {
  const isEn = lang === "en";
  return (
    <section
      aria-label={isEn ? "Patient profile summary" : "ملخص بيانات المريض"}
      className="mb-5 rounded-2xl border border-sky-200/80 bg-gradient-to-br from-white via-sky-50/40 to-slate-50 p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-100 text-sky-700">
            <UserCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-bold text-sky-800">
              {isEn ? "Verified Patient Record" : "ملف مريض موثّق في المركز"}
            </p>
            <p className="text-sm font-black text-navy-900">
              {profile.fullName}{" "}
              <span className="font-mono text-xs font-bold text-slate-500">
                ({profile.patientNumber})
              </span>
            </p>
          </div>
        </div>
        {profile.primaryDoctorName && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-white px-3 py-1 text-xs font-bold text-navy-800">
            <Stethoscope className="h-3.5 w-3.5 text-sky-600" aria-hidden="true" />
            {isEn ? "Treating Doctor:" : "الطبيب المعالج:"} {profile.primaryDoctorName}
          </span>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-sky-100 pt-3 text-xs sm:grid-cols-4">
        {profile.maskedPhone && (
          <div>
            <dt className="text-slate-500">{isEn ? "Registered Phone" : "الهاتف المسجّل"}</dt>
            <dd dir="ltr" className="mt-0.5 font-mono font-bold text-slate-800">
              {profile.maskedPhone}
            </dd>
          </div>
        )}
        {profile.portalLoginName && (
          <div>
            <dt className="text-slate-500">{isEn ? "Username" : "اسم المستخدم"}</dt>
            <dd dir="ltr" className="mt-0.5 font-mono font-bold text-slate-800">
              {profile.portalLoginName}
            </dd>
          </div>
        )}
        {profile.birthYear && (
          <div>
            <dt className="text-slate-500">{isEn ? "Birth Year" : "سنة الميلاد"}</dt>
            <dd className="mt-0.5 font-bold text-slate-800 tabular-nums">{profile.birthYear}</dd>
          </div>
        )}
        {profile.lastLoginAt && (
          <div>
            <dt className="text-slate-500">{isEn ? "Last Sign-In" : "آخر دخول للبوابة"}</dt>
            <dd className="mt-0.5 font-bold text-slate-800">
              {friendlyDate(profile.lastLoginAt.slice(0, 10))}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

export function PortalClinicalSection({ lang = "ar" }: { lang?: PortalLang }) {
  const isEn = lang === "en";
  const [data, setData] = useState<{
    showVisits: boolean;
    showTreatmentPlans: boolean;
    showAmounts: boolean;
    visits: SignedVisitItem[];
    plans: TreatmentPlanItem[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/portal/clinical", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message ?? (isEn ? "Unable to load clinical records." : "تعذّر تحميل الزيارات وخطط العلاج."));
      }
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [isEn]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        {isEn ? "Loading signed visits & treatment plans…" : "جارٍ تحميل الزيارات الموقّعة وخطط العلاج…"}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-danger-200 bg-danger-50 p-4 text-sm text-danger-800">
        <div className="flex items-center justify-between gap-2">
          <p className="font-bold">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1 rounded-xl border border-danger-300 bg-white px-3 py-1.5 text-xs font-bold text-danger-800"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {isEn ? "Retry" : "إعادة المحاولة"}
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-5">
      {data.showTreatmentPlans && (
        <section aria-label={isEn ? "Treatment Plans" : "خطط العلاج المعتمدة"} className="space-y-3">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-sky-600" aria-hidden="true" />
            <h2 className="text-sm font-black text-navy-900">
              {isEn ? "Approved Treatment Plans" : "خطط العلاج المعتمدة"}
            </h2>
          </div>

          {data.plans.length === 0 ? (
            <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
              {isEn
                ? "No active or completed treatment plans recorded yet."
                : "لا توجد خطط علاج نشطة أو مكتملة مسجّلة في ملفك حاليًا."}
            </p>
          ) : (
            data.plans.map((plan) => (
              <article
                key={plan.id}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-black text-navy-900">{plan.title}</h3>
                    <p className="text-xs text-slate-500">
                      {isEn ? "Started:" : "تاريخ البدء:"} {friendlyDate(plan.startDate)}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-black ${
                      plan.status === "completed"
                        ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                        : "bg-sky-50 text-sky-800 border border-sky-200"
                    }`}
                  >
                    {plan.status === "completed"
                      ? isEn
                        ? "Completed ✓"
                        : "مكتملة ✓"
                      : isEn
                        ? "Active"
                        : "نشطة"}
                  </span>
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between text-xs font-bold text-slate-600">
                    <span>
                      {isEn ? "Clinical Progress" : "نسبة إنجاز البنود العلاجية"} ({plan.itemsDone}/
                      {plan.itemsTotal})
                    </span>
                    <span className="tabular-nums text-sky-700">{plan.itemsPercent}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-gradient-to-l from-sky-500 to-navy-800 transition-all"
                      style={{ width: `${Math.min(100, Math.max(0, plan.itemsPercent))}%` }}
                    />
                  </div>
                </div>

                {data.showAmounts && plan.totalMinor !== null && (
                  <p className="text-xs text-slate-600">
                    {isEn ? "Plan Total:" : "إجمالي الخطة:"}{" "}
                    <strong className="tabular-nums text-navy-900">
                      {formatMoney(plan.totalMinor, plan.baseCurrency as Currency)}
                    </strong>
                    {plan.paidMinor !== null && (
                      <>
                        {" · "}
                        {isEn ? "Paid:" : "المسدّد:"}{" "}
                        <strong className="tabular-nums text-emerald-800">
                          {formatMoney(plan.paidMinor, plan.baseCurrency as Currency)}
                        </strong>
                      </>
                    )}
                  </p>
                )}

                {plan.items.length > 0 && (
                  <ul className="divide-y divide-slate-100 border-t border-slate-100 pt-2 text-xs">
                    {plan.items.map((item) => (
                      <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div>
                          <span className="font-bold text-slate-800">{item.serviceName}</span>
                          {item.toothCode && (
                            <span className="mx-1.5 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                              {isEn ? `Tooth #${item.toothCode}` : `سن ${item.toothCode}`}
                            </span>
                          )}
                          {item.sessionCount > 1 && (
                            <span className="text-[11px] text-slate-500">
                              {" · "}
                              {isEn
                                ? `Sessions ${item.sessionsCompleted}/${item.sessionCount}`
                                : `الجلسات ${item.sessionsCompleted}/${item.sessionCount}`}
                            </span>
                          )}
                        </div>
                        <span
                          className={`font-bold ${
                            item.status === "done" || item.status === "completed"
                              ? "text-emerald-700"
                              : "text-sky-700"
                          }`}
                        >
                          {item.status === "done" || item.status === "completed"
                            ? isEn
                              ? "Done ✓"
                              : "منجز ✓"
                            : isEn
                              ? "Planned"
                              : "قيد المتابعة"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))
          )}
        </section>
      )}

      {data.showVisits && (
        <section aria-label={isEn ? "Signed Clinical Visits" : "الزيارات السريرية الموقّعة"} className="space-y-3">
          <div className="flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-sky-600" aria-hidden="true" />
            <h2 className="text-sm font-black text-navy-900">
              {isEn ? "Signed Clinical Visits" : "الزيارات السريرية الموقّعة"}
            </h2>
          </div>

          {data.visits.length === 0 ? (
            <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
              {isEn
                ? "No signed clinical visits yet. Draft visits appear only after doctor sign-off."
                : "لا توجد زيارات سريرية موقّعة بعد. لا تظهر الزيارة هنا إلا بعد اعتماد الطبيب وتوقيعها رسميًا."}
            </p>
          ) : (
            data.visits.map((visit) => (
              <article
                key={visit.id}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-black text-navy-900">{friendlyDate(visit.visitDate)}</p>
                    {visit.doctorName && (
                      <p className="text-xs font-bold text-slate-600">{visit.doctorName}</p>
                    )}
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {isEn ? "Signed by Doctor" : "معتمدة وموقّعة"}
                  </span>
                </div>

                {visit.procedures.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {visit.procedures.map((proc, idx) => (
                      <span
                        key={idx}
                        className="rounded-lg border border-sky-200 bg-sky-50/70 px-2.5 py-1 text-xs font-bold text-navy-900"
                      >
                        {proc.serviceName}
                        {proc.toothCode ? ` (${isEn ? "Tooth" : "سن"} ${proc.toothCode})` : ""}
                        {proc.quantity > 1 ? ` ×${proc.quantity}` : ""}
                      </span>
                    ))}
                  </div>
                )}

                {visit.diagnosis && (
                  <p className="text-xs text-slate-700">
                    <strong className="text-navy-900">{isEn ? "Diagnosis:" : "التشخيص:"}</strong>{" "}
                    {visit.diagnosis}
                  </p>
                )}
                {visit.treatmentDone && (
                  <p className="text-xs text-slate-700">
                    <strong className="text-navy-900">
                      {isEn ? "Procedure Summary:" : "ما تم إنجازه:"}
                    </strong>{" "}
                    {visit.treatmentDone}
                  </p>
                )}
                {visit.nextPlan && (
                  <p className="rounded-xl bg-slate-50 p-2.5 text-xs text-slate-700">
                    <strong className="text-sky-900">
                      {isEn ? "Next Step / Follow-up:" : "الخطوة القادمة / المتابعة:"}
                    </strong>{" "}
                    {visit.nextPlan}
                  </p>
                )}
              </article>
            ))
          )}
        </section>
      )}
    </div>
  );
}

export function PortalPrescriptionsSection({ lang = "ar" }: { lang?: PortalLang }) {
  const isEn = lang === "en";
  const [items, setItems] = useState<PrescriptionRecordItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/portal/prescriptions", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message ?? (isEn ? "Unable to load prescriptions." : "تعذّر تحميل الروشتات الطبية."));
      }
      setItems(payload?.prescriptions ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [isEn]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        {isEn ? "Loading prescriptions…" : "جارٍ تحميل الروشتات الطبية…"}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-danger-200 bg-danger-50 p-4 text-sm text-danger-800">
        <div className="flex items-center justify-between gap-2">
          <p className="font-bold">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1 rounded-xl border border-danger-300 bg-white px-3 py-1.5 text-xs font-bold text-danger-800"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {isEn ? "Retry" : "إعادة المحاولة"}
          </button>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        {isEn
          ? "No medical prescriptions issued in your record yet."
          : "لا توجد روشتات طبية صادرة في ملفك حاليًا."}
      </p>
    );
  }

  return (
    <section aria-label={isEn ? "Medical Prescriptions" : "الروشتات الطبية"} className="space-y-4">
      {items.map((rx) => (
        <article
          key={rx.id}
          className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-2.5">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-sky-50 text-sky-700 font-black text-xs">
                Rx
              </span>
              <div>
                <h3 className="text-sm font-black text-navy-900">
                  {rx.prescribingDoctorName || (isEn ? "Attending Doctor" : "الطبيب المعالج")}
                </h3>
                <p className="text-xs text-slate-500">
                  {friendlyDate(rx.createdAt.slice(0, 10))}
                </p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-0.5 text-[11px] font-bold text-sky-800">
              <Pill className="h-3.5 w-3.5" aria-hidden="true" />
              {rx.items.length} {isEn ? "medications" : "أدوية"}
            </span>
          </div>

          {rx.diagnosis && (
            <p className="text-xs text-slate-600">
              <strong className="text-navy-900">{isEn ? "Indication:" : "التشخيص:"}</strong>{" "}
              {rx.diagnosis}
            </p>
          )}

          <ul className="space-y-2">
            {rx.items.map((drug, idx) => (
              <li
                key={idx}
                className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 text-xs space-y-1"
              >
                <p className="font-black text-navy-900" dir="auto">
                  {drug.drug}
                  {drug.concentration ? ` — ${drug.concentration}` : ""}
                  {drug.form ? ` (${drug.form})` : ""}
                </p>
                <p className="font-semibold text-slate-700">
                  {[drug.dosage, drug.frequency, drug.duration, drug.timing]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {drug.instructions && (
                  <p className="text-sky-900 font-bold">{drug.instructions}</p>
                )}
              </li>
            ))}
          </ul>

          {rx.notes && (
            <p className="rounded-xl border border-amber-200 bg-amber-50/60 p-2.5 text-xs text-amber-950">
              <strong>{isEn ? "Doctor Instructions:" : "تعليمات عامة من الطبيب:"}</strong>{" "}
              {rx.notes}
            </p>
          )}
        </article>
      ))}
    </section>
  );
}

export function PortalDocumentsSection({ lang = "ar" }: { lang?: PortalLang }) {
  const isEn = lang === "en";
  const [includeXrays, setIncludeXrays] = useState(false);
  const [documents, setDocuments] = useState<PortalDocumentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/portal/documents", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message ?? (isEn ? "Unable to load documents." : "تعذّر تحميل المستندات والتقارير."));
      }
      setIncludeXrays(Boolean(payload?.includeXrays));
      setDocuments(payload?.documents ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [isEn]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        {isEn ? "Loading documents…" : "جارٍ تحميل المستندات والتقارير…"}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-danger-200 bg-danger-50 p-4 text-sm text-danger-800">
        <div className="flex items-center justify-between gap-2">
          <p className="font-bold">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1 rounded-xl border border-danger-300 bg-white px-3 py-1.5 text-xs font-bold text-danger-800"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {isEn ? "Retry" : "إعادة المحاولة"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <section aria-label={isEn ? "Documents & Reports" : "المستندات والتقارير"} className="space-y-3">
      {!includeXrays && (
        <p className="rounded-xl border border-sky-200 bg-sky-50/70 p-3 text-xs text-sky-950">
          {isEn
            ? "Approved reports and documents are listed below. Clinical X-rays are reviewed directly with your doctor at the center."
            : "تُعرض هنا التقارير والمستندات المعتمدة في ملفك. تُراجع صور الأشعة والصور السريرية مباشرةً مع الطبيب في المركز."}
        </p>
      )}

      {documents.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
          {isEn
            ? "No downloadable documents or reports available in your file right now."
            : "لا توجد مستندات أو تقارير متاحة للتنزيل في ملفك حاليًا."}
        </p>
      ) : (
        documents.map((doc) => (
          <article
            key={doc.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-700">
                <FileText className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-sm font-black text-navy-900">{doc.title}</h3>
                <p className="text-xs text-slate-500">
                  {doc.kindLabel} · {formatByteSize(doc.sizeBytes, lang)} ·{" "}
                  {friendlyDate((doc.takenOn ?? doc.uploadedAt).slice(0, 10))}
                </p>
              </div>
            </div>
            <a
              href={doc.downloadUrl}
              className="inline-flex items-center gap-1.5 rounded-xl bg-navy-800 px-3.5 py-2 text-xs font-black text-white hover:bg-navy-900"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {isEn ? "Download" : "تنزيل"}
            </a>
          </article>
        ))
      )}
    </section>
  );
}

export function PortalSecuritySection({
  readOnly = false,
  lang = "ar",
  onSignedOutAll,
}: {
  readOnly?: boolean;
  lang?: PortalLang;
  onSignedOutAll: () => void;
}) {
  const isEn = lang === "en";
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revokingAll, setRevokingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const hasMinLen = newPassword.length >= 10;
  const hasLetter = /[A-Za-z\u0600-\u06FF]/.test(newPassword);
  const hasDigit = /\d/.test(newPassword);
  const matchesConfirm = newPassword.length > 0 && newPassword === confirmPassword;

  const submitChangePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (readOnly || busy) return;
    setError(null);
    setNotice(null);

    if (!hasMinLen || !hasLetter || !hasDigit) {
      setError(
        isEn
          ? "New password must be at least 10 characters and contain letters and numbers."
          : "يجب ألا تقل كلمة المرور الجديدة عن 10 أحرف وأن تجمع بين حروف وأرقام.",
      );
      return;
    }
    if (!matchesConfirm) {
      setError(
        isEn
          ? "New password and confirmation do not match."
          : "تأكيد كلمة المرور الجديدة غير مطابق.",
      );
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/portal/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          payload?.message ??
            (isEn ? "Unable to update password." : "تعذّر تحديث كلمة المرور."),
        );
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice(
        payload?.message ??
          (isEn
            ? "Password updated and other device sessions were signed out."
            : "تم تحديث كلمة المرور بنجاح وإبطال جميع الجلسات السابقة على الأجهزة الأخرى."),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر تحديث كلمة المرور.");
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeAllSessions = async () => {
    if (readOnly || revokingAll) return;
    setRevokingAll(true);
    setError(null);
    try {
      const response = await fetch("/api/portal/sessions/revoke", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          payload?.message ??
            (isEn ? "Unable to revoke active sessions." : "تعذّر إنهاء الجلسات النشطة."),
        );
      }
      onSignedOutAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر إنهاء الجلسات.");
    } finally {
      setRevokingAll(false);
    }
  };

  return (
    <section aria-label={isEn ? "Account Security" : "أمان الحساب والجلسات"} className="space-y-4">
      {readOnly && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-2xl border border-amber-300 bg-amber-50 p-3.5 text-xs font-bold text-amber-950"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
          <p>
            {isEn
              ? "Admin Read-Only Preview: Changing the patient's password or revoking sessions from this preview is strictly disabled."
              : "هذا عرضٌ إداري للقراءة فقط باسم الموظف — لا يُسمح بتغيير كلمة مرور المريض أو إدارة جلساته نيابةً عنه من هذا العرض."}
          </p>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-xs font-bold text-danger-800"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-bold text-emerald-900"
        >
          {notice}
        </p>
      )}

      <form
        onSubmit={submitChangePassword}
        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-3"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-sky-600" aria-hidden="true" />
            <h2 className="text-sm font-black text-navy-900">
              {isEn ? "Change Password" : "تغيير كلمة المرور"}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setShowPasswords((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50"
          >
            {showPasswords ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {showPasswords
              ? isEn
                ? "Hide"
                : "إخفاء"
              : isEn
                ? "Show"
                : "إظهار"}
          </button>
        </div>

        <p className="text-xs text-slate-500">
          {isEn
            ? "Changing your password automatically signs out any older sessions on other devices."
            : "يؤدي تغيير كلمة المرور إلى إبطال جميع الجلسات المفتوحة سابقًا على أي أجهزة أخرى فورًا."}
        </p>

        <div className="grid gap-3">
          <label className="block text-xs">
            <span className="mb-1 block font-bold text-slate-700">
              {isEn ? "Current Password" : "كلمة المرور الحالية"}
            </span>
            <input
              type={showPasswords ? "text" : "password"}
              dir="ltr"
              autoComplete="current-password"
              disabled={readOnly || busy}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </label>

          <label className="block text-xs">
            <span className="mb-1 block font-bold text-slate-700">
              {isEn ? "New Password" : "كلمة المرور الجديدة"}
            </span>
            <input
              type={showPasswords ? "text" : "password"}
              dir="ltr"
              autoComplete="new-password"
              disabled={readOnly || busy}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </label>

          <label className="block text-xs">
            <span className="mb-1 block font-bold text-slate-700">
              {isEn ? "Confirm New Password" : "تأكيد كلمة المرور الجديدة"}
            </span>
            <input
              type={showPasswords ? "text" : "password"}
              dir="ltr"
              autoComplete="new-password"
              disabled={readOnly || busy}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </label>
        </div>

        <ul className="grid gap-1 rounded-xl bg-slate-50 p-2.5 text-[11px] font-semibold text-slate-600 sm:grid-cols-2">
          <li className={hasMinLen ? "text-emerald-700" : ""}>
            {hasMinLen ? "✓" : "•"} {isEn ? "At least 10 characters" : "10 أحرف على الأقل"}
          </li>
          <li className={hasLetter && hasDigit ? "text-emerald-700" : ""}>
            {hasLetter && hasDigit ? "✓" : "•"}{" "}
            {isEn ? "Letters & numbers" : "تجمع بين حروف وأرقام"}
          </li>
        </ul>

        <button
          type="submit"
          disabled={readOnly || busy || !currentPassword || !newPassword || !confirmPassword}
          className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-black text-white hover:bg-navy-900 disabled:opacity-50"
        >
          {busy
            ? isEn
              ? "Updating…"
              : "جارٍ التحديث…"
            : isEn
              ? "Save New Password"
              : "حفظ كلمة المرور الجديدة"}
        </button>
      </form>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs space-y-2.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-sky-600" aria-hidden="true" />
          <h2 className="text-sm font-black text-navy-900">
            {isEn ? "Active Device Sessions" : "إدارة الجلسات النشطة"}
          </h2>
        </div>
        <p className="text-xs text-slate-600">
          {isEn
            ? "Opened your portal on a shared phone or browser? Sign out from every device immediately."
            : "إذا فتحت حسابك على جهاز مشترك أو متصفح آخر، يمكنك إنهاء جميع الجلسات النشطة فورًا على كافة الأجهزة."}
        </p>
        <button
          type="button"
          disabled={readOnly || revokingAll}
          onClick={() => void handleRevokeAllSessions()}
          className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs font-black text-rose-800 hover:bg-rose-100 disabled:opacity-50"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          {revokingAll
            ? isEn
              ? "Signing out all devices…"
              : "جارٍ إنهاء الجلسات…"
            : isEn
              ? "Sign Out All Devices"
              : "إنهاء الجلسات على جميع الأجهزة"}
        </button>
      </div>
    </section>
  );
}
