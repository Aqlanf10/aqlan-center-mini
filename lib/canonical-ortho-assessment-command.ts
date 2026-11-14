import "server-only";
import { doctorOwnsPatient, getPool, patientInDoctorScopeWith } from "./db";
import { assessmentFail } from "./ortho-assessment-authority";
import { checkAnyAssessmentCommand, assessmentDraftSources } from "./ortho-assessment-command-v2";
import { assessmentRevisionSources } from "./ortho-assessment-persisted-v2";
import { appendOrthoAssessmentWith } from "./ortho-assessment-store";
import { collectAssessmentSourceClosure, captureAssessmentExternalSources, assessmentSourceStates } from "./ortho-assessment-versioned-sources";
import { PATIENT_CARE_CAPABILITIES } from "./canonical-patient-reads";
import type { AssessmentSourceV2 } from "./ortho-assessment-v2";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

const missing = () => assessmentFail(404, "ortho_case_not_found", "حالة التقويم غير متاحة ضمن مرضاك.");
const sourceDenied = () => assessmentFail(403, "source_restricted", "التقييم أو مصادره محجوبة بالصلاحية الحالية.");
export function parseCanonicalOrthoAssessmentCommand(rawId: string, body: unknown) {
  const id = Number(rawId), checked = checkAnyAssessmentCommand(body);
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || id > 2147483647) assessmentFail(400, "invalid_scope", "معرّف حالة التقويم غير صالح.");
  if (!checked.ok || checked.value.schemaVersion !== 2) assessmentFail(400, checked.ok ? "unsupported_schema" : checked.code, "طلب التقييم غير صالح أو غير مدعوم.");
  return { id, command: checked.value };
}

/** One owning canonical transaction, using the existing immutable append protocol.
 * Admission never manufactures a legacy identity. Positive patient witnesses and
 * every historical/new source are held before acknowledging a write or receipt. */
export async function commandCanonicalOrthoAssessment(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalOrthoAssessmentCommand(rawId, body), action = "clinical.ortho.edit" as const;
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      let patientScope = await staffOperationPatientScope(client, handle, action);
      if (patientScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      const initial = (await client.query<{ patient_id: number }>("SELECT patient_id FROM ortho_cases WHERE id=$1", [input.id])).rows[0];
      if (!initial || patientScope.kind === "own" && !await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, initial.patient_id)) missing();
      const patient = await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [initial.patient_id]);
      patientScope = await staffOperationPatientScope(client, handle, action);
      if (patientScope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (!patient.rows.length || patientScope.kind === "own" && !await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, initial.patient_id)) missing();
      const actor = await staffOperationIdentity(client, handle, action);
      const grants = await staffOperationCapabilities(client, handle, action, ["clinical.xrays.view", ...PATIENT_CARE_CAPABILITIES]);
      const imaging = grants.has("clinical.xrays.view"), care = PATIENT_CARE_CAPABILITIES.some(capability => grants.has(capability));
      const assertCurrent = async () => {
        await assertStaffOperation(client, handle, action);
        const fresh = await staffOperationPatientScope(client, handle, action);
        if (fresh.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
        if (fresh.kind === "own" && !await doctorOwnsPatient(fresh.clinicianPartyId, initial.patient_id, client, "nowait")) missing();
      };
      return appendOrthoAssessmentWith(client, { patientId: initial.patient_id, orthoCaseId: input.id }, input.command, {
        actorId: actor.userId, actorName: actor.username, actorRole: actor.role, imagingVisible: imaging,
        assertCurrent, nowait: true,
        async prepareSources(scope, revisions, command) {
          // Same limits and all-history source policy as accepted canonical slice31.
          // No head-only check, cleared new draft or cached receipt bypasses an ancestor.
          const union = new Map<string, Pick<AssessmentSourceV2, "kind" | "id">>();
          const historical = new Set<string>();
          const admit = (sources: AssessmentSourceV2[], saved: boolean) => {
            for (const source of sources) {
              if ((source.kind === "document" || source.kind === "ceph_study") ? !imaging : !care) sourceDenied();
              const key = `${source.kind}:${source.id}`;
              union.set(key, { kind: source.kind, id: source.id });
              if (saved) historical.add(key);
              if (union.size > 128) assessmentFail(409, "source_reference_limit", "مراجع السجل تتجاوز حد القراءة الآمنة؛ لم يُختصر السجل.");
            }
          };
          for (const revision of revisions) {
            const closure = await collectAssessmentSourceClosure(client, scope, assessmentRevisionSources(revision));
            if ([...closure.revisions.values()].some(parent => parent.version >= revision.version)) assessmentFail(409, "future_assessment_source", "تسلسل مراجع التقييم غير صالح.");
            admit(closure.external, true);
          }
          const proposed = await collectAssessmentSourceClosure(client, scope, assessmentDraftSources(command.content));
          admit(proposed.external, false);
          // Preserve source ordering before Ortho/bridge locks. The fresh positive
          // patient witnesses acquired afterwards use NOWAIT, avoiding an inversion.
          const current = await captureAssessmentExternalSources(client, scope, [...union.values()], imaging);
          if ([...historical].some(key => !current.historicallyReadable.has(key))) sourceDenied();
          await assertCurrent();
          return { ...proposed, states: assessmentSourceStates(proposed, current), historicallyReadable: current.historicallyReadable };
        },
      });
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001"].includes(String(error.code))) {
      assessmentFail(409, "assessment_conflict", "تغيرت الحالة أو تعذّر تثبيت مصادرها. حدّث السجل قبل طلب جديد.");
    }
    throw error;
  }
}
