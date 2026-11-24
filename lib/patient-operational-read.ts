import { CLINIC_TIME_ZONE, computeDebtRows, ensureSchema, getPool } from "./db";
import { CLINIC_BASE_CURRENCY, CURRENCIES } from "./money";
import { clinicDateString } from "./schedule";

type OperationalRole = "reception" | "assistant";

/** A desk may read demographics. An assistant may see the clinical alert for today's patient. */
export async function readOperationalPatient(patientId: number, role: OperationalRole) {
  await ensureSchema();
  const assistant = role === "assistant";
  const { rows } = await getPool().query(`SELECT p.id, patient_number AS "patientNumber", full_name AS "fullName", phone,
    gender, birth_year AS "birthYear", created_at AS "createdAt",
    ${assistant ? 'medical_alert AS "medicalAlert"' : `alt_phone AS "altPhone", email, address, birth_date::text AS "birthDate",
      guardian_name AS "guardianName", guardian_phone AS "guardianPhone", referral_source AS "referralSource",
      referred_by AS "referredBy", preferred_channel AS "preferredChannel"`}
    FROM patients p WHERE p.id = $1 ${assistant ? `AND EXISTS (SELECT 1 FROM visits v WHERE v.patient_id=p.id
      AND (v.arrived_at AT TIME ZONE $2)::date = $3::date)` : ""}`,
    assistant ? [patientId, CLINIC_TIME_ZONE, clinicDateString(new Date(), CLINIC_TIME_ZONE)] : [patientId]);
  return rows[0] ?? null;
}

export async function readOperationalWorkflow(patientId: number, role: OperationalRole, today: string) {
  const patient = await readOperationalPatient(patientId, role);
  if (!patient) return null;
  const { rows: [visit] } = await getPool().query(`SELECT id, status, chair, arrived_at AS "arrivedAt", NULL::text AS "plannedTitle"
    FROM visits WHERE patient_id=$1 AND signed_at IS NULL AND (arrived_at AT TIME ZONE $2)::date=$3::date
    ORDER BY (status='done'), arrived_at DESC LIMIT 1`, [patientId, CLINIC_TIME_ZONE, today]);
  const desk = role === "reception";
  const debts = desk ? await computeDebtRows([patientId], true) : [];
  const byCurrency = Object.fromEntries(CURRENCIES.map(currency => {
    const debt = debts.find(row => row.currency === currency);
    return [currency, { balanceMinor: debt?.dueMinor ?? 0 }];
  }));
  return {
    patient: { id: patientId }, today, timeZone: CLINIC_TIME_ZONE,
    openVisit: visit ?? null, lastVisit: null, nextAppointment: null,
    activePlans: [], plannedVisits: [], alerts: [], assessmentCases: [], legacyCases: [],
    counts: { visits: 0, openLabOrders: 0, documents: 0, orthoCase: false },
    financial: desk ? { ...byCurrency[CLINIC_BASE_CURRENCY], byCurrency } : null, canSeeFinancial: desk,
  };
}
