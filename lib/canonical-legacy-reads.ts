import "server-only";
import { patientLegacyHistoryWith, type DbClient } from "./db";
import { readCanonicalPatientRecord } from "./canonical-patient-reads";
import type { CanonicalSnapshotScope } from "./canonical-read-snapshot";
import { patientLegacyOnboardingWith } from "./legacy-onboarding-db";
import { listLegacyTreatmentsWith, type LegacyAgreementView } from "./legacy-treatment-db";
import { listHistoricalDocumentsWith } from "./legacy-treatment-document-db";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * The historical onboarding reads on the canonical runtime (M2 slice 95a; owner decision G4-2;
 * contract section 15). One read-only snapshot under `read:patients.history`, inside the patient
 * scope (outside reads like missing). The clinical description comes with the record read;
 * every amount, balance, term and source hash needs `finance.patient-ledger.view`; the plan
 * sources of the onboarding need `clinical.plans.view`. Action flags come from canonical grants,
 * never from a label or the reception setting (G4-6). No file is returned here.
 */
const READ = "read:patients.history" as const;

/** The archive needs the ledger view: the legacy 403, with a bounded code. */
export class CanonicalLegacyArchiveRefusal extends Error {
  readonly code = "ledger_view_required" as const;
  constructor() { super("غير مصرّح لك بالاطلاع على السجل المالي السابق لهذا المريض."); this.name = "CanonicalLegacyArchiveRefusal"; }
}
const MAX_BYTES = 2 * 1024 * 1024;
const LEDGER = "finance.patient-ledger.view" as const;

/** Clinical identity of a pre-system agreement: no amount, currency, opening or free text. */
const AGREEMENT_IDENTITY = ["id", "documentId", "patientId", "planItemId", "planId", "caseId", "caseTitle", "serviceId", "serviceName",
  "specialty", "specialtyLabel", "toothCode", "historicalAsOf", "createdBy", "createdAt", "status", "voidedBy", "voidedAt",
  "coverageState", "coverageSite"] as const satisfies readonly (keyof LegacyAgreementView)[];

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) if (Object.hasOwn(source, key)) out[key] = source[key];
  return out;
}

/** Action flags by explicit grants (contract section 15, 95b–95d). */
function legacyAccess(scope: CanonicalSnapshotScope) {
  const record = scope.granted("finance.legacy.record");
  return { add: record, edit: record && scope.granted("finance.opening-balances.manage"), void: scope.granted("finance.legacy.void") };
}

/** GET /api/patients/[id]/legacy: the old system's archive is money throughout. */
export async function readCanonicalLegacyArchive(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, READ, patientId, async (query, scope) => {
    if (!scope.granted(LEDGER)) throw new CanonicalLegacyArchiveRefusal();
    return patientLegacyHistoryWith(query, patientId);
  }, MAX_BYTES);
}

/** GET /api/patients/[id]/legacy-treatments. */
export async function readCanonicalLegacyTreatments(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, READ, patientId, async (query, scope) => {
    const rows = (await listLegacyTreatmentsWith(query, patientId)).filter(agreement => agreement.documentId === null);
    const agreements = scope.granted(LEDGER) ? rows : rows.map(row => pick(row, AGREEMENT_IDENTITY));
    return { agreements, access: legacyAccess(scope) };
  }, MAX_BYTES);
}

type HistoricalDocument = Awaited<ReturnType<typeof listHistoricalDocumentsWith>>[number];
const DOCUMENT_IDENTITY = ["id", "version", "revisionId", "patientId", "createdBy", "historicalAsOf"] as const satisfies readonly (keyof HistoricalDocument)[];
const LINE_IDENTITY = ["agreementId", "planItemId", "planId", "caseId", "serviceId", "doctorId", "description", "toothCode", "site"] as const;

/** GET /api/patients/[id]/historical-documents. */
export async function readCanonicalHistoricalDocuments(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, READ, patientId, async (query, scope) => {
    const documents = await listHistoricalDocumentsWith(query as DbClient, patientId);
    const ledger = scope.granted(LEDGER);
    // Correction rewrites the opening: patients.history.correct and finance.opening-balances.manage.
    const canCorrect = scope.granted("patients.history.correct") && scope.granted("finance.opening-balances.manage");
    return {
      documents: documents.map(document => {
        const correctionAvailable = canCorrect && document.correctionAvailable;
        if (ledger) return { ...document, correctionAvailable };
        return {
          ...pick(document, DOCUMENT_IDENTITY),
          lines: document.lines.map(line => pick(line, LINE_IDENTITY)),
          history: document.history.map(entry => pick(entry as Record<string, unknown>, ["version", "created_by", "created_at"])),
          correctionAvailable,
        };
      }),
    };
  }, MAX_BYTES);
}

/** GET /api/patients/[id]/legacy-onboarding: no amounts; plan sources by clinical.plans.view. */
export async function readCanonicalLegacyOnboarding(session: VerifiedDurableSession, patientId: number, caseId: number | undefined) {
  return readCanonicalPatientRecord(session, READ, patientId, async (query, scope) => {
    const onboarding = await patientLegacyOnboardingWith(query as DbClient, patientId, caseId);
    if (onboarding && !scope.granted("clinical.plans.view")) {
      onboarding.financialReference = { state: "restricted", sources: [], clinicalCaseIds: [], hasRecordedSchedule: false };
      onboarding.steps = onboarding.steps.filter(step => step.key === "baseline");
      onboarding.complete = false;
      onboarding.warning = "تفاصيل المرجع المالي غير متاحة بصلاحيتك؛ لا يمكن تأكيد اكتمال التهيئة من هذه الشاشة.";
    }
    return { onboarding };
  }, MAX_BYTES);
}
