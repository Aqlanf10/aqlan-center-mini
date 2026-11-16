import {
  CLINIC_TIME_ZONE,
  ensureSchema,
  getDocumentForDownload,
  getPatient,
  getPool,
  getSettingsSafe,
  listPatientDocuments,
  listPatientPlans,
  listPatientPrescriptions,
  portalUpcomingAppointments,
} from "./db";
import { readFileByKey } from "./files";
import { parseLoginPhotoAsset } from "./login-photo";
import type { PortalAppointmentView } from "./portal";
import {
  listPortalAnnouncementsForPublic,
  readPortalSettings,
  visibleSectionsFromSettings,
  type PortalAnnouncementItem,
  type PortalOperatingMode,
  type PortalSettingsConfig,
  type PortalVisibleSections,
} from "./portal-settings";
import { clinicDateString } from "./schedule";
import { ALLOWED_TYPES, KIND_LABEL, type DocumentKind } from "./storage";

export interface PortalPublicClinicIdentity {
  name: string;
  englishName: string;
  leadDoctor: string;
  leadDoctorTitle: string;
  phone: string;
  address: string;
  hours: string;
  hoursSummary: string;
  loginPhotoVisible: boolean;
}

export interface PortalPublicBootstrap {
  clinic: PortalPublicClinicIdentity;
  operatingMode: PortalOperatingMode;
  showBookingLink: boolean;
  showAnnouncements: boolean;
  announcements: PortalAnnouncementItem[];
}

export async function getPortalPublicBootstrap(): Promise<PortalPublicBootstrap> {
  const [clinicSettings, portalSettings] = await Promise.all([
    getSettingsSafe(),
    readPortalSettings(),
  ]);
  const announcements = await listPortalAnnouncementsForPublic(portalSettings);
  const openTime = clinicSettings["clinic.day_start"] || "09:00";
  const closeTime = clinicSettings["clinic.day_end"] || "21:00";
  const hoursSummary = `${openTime} – ${closeTime}`;

  return {
    clinic: {
      name: clinicSettings["clinic.name"],
      englishName: "Dr. Aqlan Dental Center",
      leadDoctor: clinicSettings["clinic.lead_doctor"],
      leadDoctorTitle: clinicSettings["clinic.lead_doctor_title"],
      phone: clinicSettings["clinic.phone"],
      address: clinicSettings["clinic.address"],
      hours: hoursSummary,
      hoursSummary,
      loginPhotoVisible:
        Boolean(parseLoginPhotoAsset(clinicSettings["clinic.login_photo_asset"])) &&
        clinicSettings["clinic.login_photo_visible"] === "true",
    },
    operatingMode: portalSettings.effectiveOperatingMode,
    showBookingLink: portalSettings.showBookingLink,
    showAnnouncements: portalSettings.showAnnouncements,
    announcements,
  };
}

export function maskPhoneForPortalDisplay(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return null;
  const last3 = digits.slice(-3);
  const prefix = digits.startsWith("967") ? "+967 " : "";
  return `${prefix}••• ••• ${last3}`;
}

export interface PortalPatientProfileView {
  patientNumber: string;
  fullName: string;
  maskedPhone: string | null;
  gender: "male" | "female" | "unknown";
  genderLabel: string | null;
  birthYear: number | null;
  registeredOn: string;
  primaryDoctorName: string | null;
  portalLoginName: string | null;
  lastLoginAt: string | null;
  passwordUpdatedAt: string | null;
}

export async function getPortalPatientProfileSummary(
  patientId: number,
): Promise<PortalPatientProfileView | null> {
  await ensureSchema();
  const patient = await getPatient(patientId);
  if (!patient) return null;

  const [{ rows: [docRow] }, { rows: [acctRow] }] = await Promise.all([
    getPool().query<{ doctor_name: string | null }>(
      `SELECT d.name AS doctor_name
         FROM visits v
         JOIN parties d ON d.id = v.doctor_id AND d.kind = 'doctor'
        WHERE v.patient_id = $1 AND v.signed_at IS NOT NULL
        ORDER BY v.arrived_at DESC
        LIMIT 1`,
      [patientId],
    ),
    getPool().query<{
      login_name: string | null;
      last_login_at: Date | null;
      password_updated_at: Date | null;
    }>(
      `SELECT login_name, last_login_at, password_updated_at
         FROM patient_portal_accounts
        WHERE patient_id = $1
        LIMIT 1`,
      [patientId],
    ),
  ]);

  return {
    patientNumber: patient.patientNumber,
    fullName: patient.fullName,
    maskedPhone: maskPhoneForPortalDisplay(patient.phone),
    gender: patient.gender,
    genderLabel:
      patient.gender === "male"
        ? "ذكر"
        : patient.gender === "female"
          ? "أنثى"
          : null,
    birthYear: patient.birthYear,
    registeredOn: patient.createdAt.slice(0, 10),
    primaryDoctorName: docRow?.doctor_name ?? null,
    portalLoginName: acctRow?.login_name ?? null,
    lastLoginAt: acctRow?.last_login_at ? acctRow.last_login_at.toISOString() : null,
    passwordUpdatedAt: acctRow?.password_updated_at
      ? acctRow.password_updated_at.toISOString()
      : null,
  };
}

export interface PortalPastAppointmentView {
  id: number;
  scheduledDate: string;
  scheduledTime: string;
  durationMinutes: number;
  appointmentType: string | null;
  status: string;
}

export async function getPortalAppointmentsBundle(
  patientId: number,
  settings?: PortalSettingsConfig,
): Promise<{
  today: string;
  allowConfirm: boolean;
  showBookingLink: boolean;
  appointments: PortalAppointmentView[];
  pastAppointments: PortalPastAppointmentView[];
}> {
  const cfg = settings ?? (await readPortalSettings());
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const rawUpcoming = await portalUpcomingAppointments(patientId, today, 20);
  const appointments = rawUpcoming.map((item) => ({
    ...item,
    confirmable: cfg.allowAppointmentConfirm ? item.confirmable : false,
  }));

  const { rows: pastRows } = await getPool().query<{
    id: number;
    scheduled_date: Date;
    scheduled_time: string;
    duration_minutes: number;
    appointment_type: string | null;
    status: string;
  }>(
    `SELECT id, scheduled_date, scheduled_time, duration_minutes, appointment_type, status
       FROM appointments
      WHERE patient_id = $1
        AND (scheduled_date < $2::date OR status <> 'booked')
      ORDER BY scheduled_date DESC, scheduled_time DESC
      LIMIT 25`,
    [patientId, today],
  );

  const pastAppointments: PortalPastAppointmentView[] = pastRows.map((row) => ({
    id: row.id,
    scheduledDate: `${row.scheduled_date.getFullYear()}-${String(row.scheduled_date.getMonth() + 1).padStart(2, "0")}-${String(row.scheduled_date.getDate()).padStart(2, "0")}`,
    scheduledTime: String(row.scheduled_time).slice(0, 5),
    durationMinutes: row.duration_minutes,
    appointmentType: row.appointment_type,
    status: row.status,
  }));

  return {
    today,
    allowConfirm: cfg.allowAppointmentConfirm,
    showBookingLink: cfg.showBookingLink,
    appointments,
    pastAppointments,
  };
}

export interface PortalVisitProcedureView {
  serviceName: string;
  toothCode: number | null;
  quantity: number;
}

export interface PortalSignedVisitView {
  id: number;
  visitDate: string;
  signedAt: string;
  doctorName: string | null;
  diagnosis: string | null;
  treatmentDone: string | null;
  nextPlan: string | null;
  procedures: PortalVisitProcedureView[];
}

export interface PortalTreatmentPlanItemView {
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

export interface PortalTreatmentPlanView {
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
  items: PortalTreatmentPlanItemView[];
}

export async function getPortalSignedVisits(
  patientId: number,
): Promise<PortalSignedVisitView[]> {
  await ensureSchema();
  const pool = getPool();
  const { rows: visitRows } = await pool.query<{
    id: number;
    visit_date: string;
    signed_at: Date;
    doctor_name: string | null;
    diagnosis: string | null;
    treatment_done: string | null;
    next_plan: string | null;
  }>(
    `SELECT v.id,
            (v.arrived_at AT TIME ZONE $2)::date::text AS visit_date,
            v.signed_at,
            d.name AS doctor_name,
            v.diagnosis,
            v.treatment_done,
            v.next_plan
       FROM visits v
       LEFT JOIN parties d ON d.id = v.doctor_id AND d.kind = 'doctor'
      WHERE v.patient_id = $1
        AND v.signed_at IS NOT NULL
      ORDER BY v.arrived_at DESC
      LIMIT 30`,
    [patientId, CLINIC_TIME_ZONE],
  );

  if (visitRows.length === 0) return [];
  const visitIds = visitRows.map((v) => v.id);
  const { rows: procRows } = await pool.query<{
    visit_id: number;
    service_name: string;
    tooth_code: number | null;
    quantity: number;
  }>(
    `SELECT p.visit_id, s.name AS service_name, p.tooth_code, p.quantity
       FROM visit_procedures p
       JOIN services s ON s.id = p.service_id
      WHERE p.visit_id = ANY($1::int[])
      ORDER BY p.id ASC`,
    [visitIds],
  );

  const procsByVisit = new Map<number, PortalVisitProcedureView[]>();
  for (const p of procRows) {
    const list = procsByVisit.get(p.visit_id) ?? [];
    list.push({
      serviceName: p.service_name,
      toothCode: p.tooth_code,
      quantity: p.quantity,
    });
    procsByVisit.set(p.visit_id, list);
  }

  return visitRows.map((row) => ({
    id: row.id,
    visitDate: row.visit_date,
    signedAt: row.signed_at.toISOString(),
    doctorName: row.doctor_name,
    diagnosis: row.diagnosis,
    treatmentDone: row.treatment_done,
    nextPlan: row.next_plan,
    procedures: procsByVisit.get(row.id) ?? [],
  }));
}

export async function getPortalTreatmentPlans(
  patientId: number,
  includeMoney: boolean,
): Promise<PortalTreatmentPlanView[]> {
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const plans = await listPatientPlans(patientId, today);
  return plans
    .filter((plan) => plan.status === "active" || plan.status === "completed")
    .map((plan) => {
      const visibleItems = plan.items.filter((item) => item.status !== "cancelled");
      return {
        id: plan.id,
        title: plan.title,
        status: plan.status,
        startDate: plan.startDate,
        consentAt: plan.consentAt,
        baseCurrency: plan.baseCurrency,
        totalMinor: includeMoney ? plan.totalMinor : null,
        paidMinor: includeMoney ? plan.progress.paidMinor : null,
        itemsDone: plan.itemsProgress.doneCount,
        itemsTotal: plan.itemsProgress.count,
        itemsPercent:
          plan.itemsProgress.count > 0
            ? Math.round((plan.itemsProgress.doneCount / plan.itemsProgress.count) * 100)
            : 0,
        items: visibleItems.map((item) => ({
          id: item.id,
          serviceName: item.serviceName,
          toothCode: item.toothCode,
          quantity: item.quantity,
          status: item.status,
          sessionsCompleted: item.sessionsCompleted,
          sessionCount: item.sessionCount,
          doctorName: item.doctorName,
          totalMinor: includeMoney ? item.totalMinor : null,
        })),
      };
    });
}

export interface PortalPrescriptionItemView {
  drug: string;
  concentration: string | null;
  form: string | null;
  dosage: string;
  frequency: string;
  duration: string;
  timing: string | null;
  instructions: string | null;
  instructionsEn: string | null;
}

export interface PortalPrescriptionView {
  id: number;
  visitId: number | null;
  prescribingDoctorName: string | null;
  diagnosis: string | null;
  notes: string | null;
  instructionsLang: string;
  status: "active" | "void";
  createdAt: string;
  voidedAt: string | null;
  items: PortalPrescriptionItemView[];
}

export async function getPortalPrescriptions(
  patientId: number,
): Promise<PortalPrescriptionView[]> {
  const records = await listPatientPrescriptions(patientId, 50);
  return records
    .filter((rx) => rx.status === "active" && !rx.voidedAt)
    .map((rx) => ({
      id: rx.id,
      visitId: rx.visitId,
      prescribingDoctorName: rx.prescribingDoctorName ?? null,
      diagnosis: rx.diagnosis,
      notes: rx.notes,
      instructionsLang: rx.instructionsLang,
      status: rx.status,
      createdAt: rx.createdAt,
      voidedAt: rx.voidedAt,
      items: rx.items.map((item) => ({
        drug: item.name,
        concentration: item.dose || null,
        form: item.form || null,
        dosage: item.dose,
        frequency: item.frequency,
        duration: item.duration,
        timing: null,
        instructions: item.instructions || null,
        instructionsEn: item.instructionsEn || null,
      })),
    }));
}

export function isClinicalImagingDocumentKind(kind: DocumentKind): boolean {
  return kind === "xray" || kind === "photo";
}

export interface PortalDocumentItemView {
  id: number;
  kind: DocumentKind;
  kindLabel: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  takenOn: string | null;
  uploadedAt: string;
  downloadUrl: string;
}

export async function getPortalDocuments(
  patientId: number,
  settings: PortalSettingsConfig,
): Promise<PortalDocumentItemView[]> {
  if (!settings.showDocuments) return [];
  const docs = await listPatientDocuments(patientId, false);
  return docs
    .filter((doc) => {
      if (doc.removedAt) return false;
      if (isClinicalImagingDocumentKind(doc.kind) && !settings.showXrayDocuments) {
        return false;
      }
      return true;
    })
    .map((doc) => ({
      id: doc.id,
      kind: doc.kind,
      kindLabel: KIND_LABEL[doc.kind] ?? "مستند",
      title: doc.title,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      isImage: doc.isImage,
      takenOn: doc.takenOn,
      uploadedAt: doc.uploadedAt,
      downloadUrl: `/api/portal/documents/download?id=${doc.id}`,
    }));
}

export async function resolvePortalDocumentDownload(
  documentId: number,
  patientId: number,
  settings?: PortalSettingsConfig,
): Promise<
  | {
      ok: true;
      bytes: Buffer;
      safeMime: string;
      title: string;
      forceAttachment: boolean;
    }
  | { ok: false; status: number; code: string; message: string }
> {
  const cfg = settings ?? (await readPortalSettings());
  if (!cfg.showDocuments) {
    return {
      ok: false,
      status: 403,
      code: "section_disabled_by_clinic_policy",
      message: "قسم المستندات غير متاح حاليًا وفق إعدادات المركز.",
    };
  }

  const found = await getDocumentForDownload(documentId);
  // عدم كشف وجود مستندات المرضى الآخرين أو المستندات المخفية: 404 موحّدة
  if (!found || found.document.patientId !== patientId || found.document.removedAt) {
    return {
      ok: false,
      status: 404,
      code: "document_not_found",
      message: "المستند غير موجود في ملفك.",
    };
  }

  if (isClinicalImagingDocumentKind(found.document.kind) && !cfg.showXrayDocuments) {
    return {
      ok: false,
      status: 403,
      code: "xray_documents_disabled",
      message: "عرض صور الأشعة والصور السريرية غير مفعّل في البوابة حاليًا.",
    };
  }

  const bytes = await readFileByKey(found.storageKey);
  if (!bytes) {
    return {
      ok: false,
      status: 410,
      code: "document_storage_missing",
      message: "ملف المستند غير متوفّر في التخزين حاليًا. راجع استقبال العيادة.",
    };
  }

  const normalizedMime = (found.document.mimeType ?? "").trim().toLowerCase();
  const isAllowedMime = Object.hasOwn(ALLOWED_TYPES, normalizedMime);
  const safeMime = isAllowedMime ? normalizedMime : "application/octet-stream";
  return {
    ok: true,
    bytes,
    safeMime,
    title: found.document.title,
    forceAttachment: !isAllowedMime,
  };
}

export { visibleSectionsFromSettings, type PortalVisibleSections };
