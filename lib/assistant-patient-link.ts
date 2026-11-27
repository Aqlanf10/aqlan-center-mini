import { searchPatients } from "./db";
import { canAccessPatient } from "./patient-access";
import { normalizeName } from "./duplicates";
import type { AiToolContext, ToolExecutionResult } from "./ai-tools/types";

export async function findAuthorizedPatientLink(term: string, context: AiToolContext): Promise<ToolExecutionResult> {
  const missing = { success: false, textSummary: "لم أجد ملفًا مطابقًا ومتاحًا لك. جرّب رقم الملف كاملًا." };
  if (!context.userId || !context.username || term.length > 150) return missing;
  const scoped = context.role === "doctor" && !context.canViewAllPatients;
  if (scoped && !context.doctorPartyId) return missing;
  const candidates = await searchPatients(term, 8, scoped ? context.doctorPartyId : null);
  const file = candidates.find(row => row.patientNumber.toLowerCase() === term.toLowerCase());
  const exactName = candidates.filter(row => normalizeName(row.fullName) === normalizeName(term));
  if (!file && (exactName.length > 1 || candidates.length === 8)) {
    return { success: false, textSummary: "الاسم لا يحدد ملفًا واحدًا. اكتب رقم الملف الكامل لفتحه." };
  }
  const patient = file ?? exactName[0];
  if (!patient || !await canAccessPatient({
    userId: context.userId,
    username: context.username,
    role: context.role,
    partyId: context.doctorPartyId ?? undefined,
    expiresAt: Date.now() + 30_000,
  }, patient.id)) return missing;
  return { success: true, textSummary: "وجدت الملف. اضغط «فتح ملف المريض».", actions: [
    { label: "فتح ملف المريض", href: `/patients/${patient.id}`, actionType: "navigate" },
  ] };
}
