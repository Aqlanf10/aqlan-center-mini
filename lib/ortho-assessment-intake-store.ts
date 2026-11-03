import { CLINIC_TIME_ZONE, insertAuditRow, type DbClient } from "./db";
import { clinicDateString } from "./schedule";
import { authorizeJourneyPatient, authorizeJourney, assertJourneyCurrent, journeyFail, journeyTransaction, lockJourneyOwner, type JourneyOwnerInput, type JourneyAuthority } from "./ortho-case-journey-authority";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { readOpenAssessmentCommand, readStartTreatmentCommand, type OpenAssessmentCommand, type StartTreatmentCommand, type IntakeReceipt } from "./ortho-assessment-intake";
type PatientOwner = Pick<JourneyOwnerInput, "session" | "patientId">;
async function replay(client: DbClient, input: PatientOwner, actor: JourneyAuthority, command: OpenAssessmentCommand | StartTreatmentCommand, kind: string, orthoCaseId?: number) {
    const row = (await client.query("SELECT * FROM ortho_case_intake_events WHERE patient_id=$1 AND actor_user_id=$2 AND command_id=$3", [input.patientId, actor.userId, command.clientRequestId])).rows[0];
    if (!row)
        return null;
    if (row.event_kind !== kind || row.request_fingerprint !== journeyContentHash(command) || orthoCaseId !== undefined && row.ortho_case_id !== orthoCaseId)
        journeyFail(409, "request_key_conflict");
    const owner = await lockJourneyOwner(client, { ...input, orthoCaseId: row.ortho_case_id }, true);
    if (owner.clinicalCaseId !== row.clinical_case_id || row.request_fingerprint !== journeyContentHash(row.command))
        journeyFail(409, "intake_owner_changed");
    assertJourneyCurrent(actor);
    return receipt(input.patientId, owner.orthoCaseId, owner.clinicalCaseId, actor.userId, command, "replayed");
}
function receipt(patientId: number, orthoCaseId: number, clinicalCaseId: number, actorId: number, command: OpenAssessmentCommand | StartTreatmentCommand, mode: IntakeReceipt["mode"]): IntakeReceipt {
    return { ok: true, patientId, orthoCaseId, clinicalCaseId, actorId, commandId: command.clientRequestId, requestFingerprint: journeyContentHash(command), mode };
}
async function event(client: DbClient, input: PatientOwner, actor: JourneyAuthority, ids: {
    orthoCaseId: number;
    clinicalCaseId: number;
}, kind: "opened" | "treatment_started", command: OpenAssessmentCommand | StartTreatmentCommand) {
    const saved = (await client.query(`INSERT INTO ortho_case_intake_events(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,event_kind,actor_user_id,created_by,command_id,request_fingerprint,command)
 VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`, [input.patientId, ids.orthoCaseId, ids.clinicalCaseId, kind, actor.userId, actor.name, command.clientRequestId, journeyContentHash(command), JSON.stringify(command)])).rows[0];
    await insertAuditRow(client, { action: kind === "opened" ? "ortho.assessment_open" : "ortho.treatment_start", actor: actor.name, actorRole: actor.session.role, entity: "ortho_case_intake_events", entityId: saved.id, details: { patientId: input.patientId, ...ids, requestFingerprint: journeyContentHash(command) } });
}
export async function openOrthoAssessment(input: PatientOwner & {
    command: unknown;
}) {
    return journeyTransaction(true, async (client) => {
        let command;
        try {
            command = readOpenAssessmentCommand(input.command);
        }
        catch {
            journeyFail(400, "invalid_intake_command");
        }
        const actor = await authorizeJourneyPatient(client, input, true);
        const previous = await replay(client, input, actor, command, "opened");
        if (previous)
            return previous;
        const existing = (await client.query("SELECT id FROM ortho_cases WHERE patient_id=$1 AND status IN ('assessment','active','retention') ORDER BY id FOR UPDATE", [input.patientId])).rows;
        if (existing.length > 1)
            journeyFail(409, "ambiguous_open_case");
        if (existing[0]) {
            const owner = await lockJourneyOwner(client, { ...input, orthoCaseId: existing[0].id }, true);
            assertJourneyCurrent(actor);
            return receipt(input.patientId, owner.orthoCaseId, owner.clinicalCaseId, actor.userId, command, "existing");
        }
        // An invoice/legacy/manual shell needs an explicit owner/scope decision, never a duplicate or silent rebind.
        const unlinked = (await client.query("SELECT id FROM clinical_cases WHERE patient_id=$1 AND specialty='orthodontics' AND ortho_case_id IS NULL AND status IN ('active','waiting') ORDER BY id FOR UPDATE", [input.patientId])).rows;
        if (unlinked.length)
            journeyFail(409, "unlinked_ortho_case", "توجد حالة تخصصية سابقة تحتاج ربطاً ومراجعة نطاقها. افتحها من قائمة الحالات؛ لم تنشأ حالة ثانية أو اتفاق جديد.");
        const row = (await client.query(`INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by)
 VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,$2) RETURNING id`, [input.patientId, actor.name])).rows[0];
        const bridge = (await client.query(`INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by,started_on)
 VALUES($1,'orthodontics','تقييم حالة تقويم',$2,$3,$4::date) RETURNING id`, [input.patientId, row.id, actor.name, clinicDateString(new Date(), CLINIC_TIME_ZONE)])).rows[0];
        const ids = { orthoCaseId: row.id, clinicalCaseId: bridge.id };
        await event(client, input, actor, ids, "opened", command);
        assertJourneyCurrent(actor);
        return receipt(input.patientId, row.id, bridge.id, actor.userId, command, "created");
    });
}
export async function startOrthoTreatment(input: JourneyOwnerInput & {
    command: unknown;
}) {
    return journeyTransaction(true, async (client) => {
        let command;
        try {
            command = readStartTreatmentCommand(input.command);
        }
        catch {
            journeyFail(400, "invalid_treatment_start");
        }
        const actor = await authorizeJourney(client, input, true), previous = await replay(client, input, actor, command, "treatment_started", input.orthoCaseId);
        if (previous)
            return previous;
        const owner = await lockJourneyOwner(client, input, true);
        if (owner.status !== "assessment")
            journeyFail(409, "assessment_already_transitioned", "الحالة ليست في مرحلة التقييم. أعد قراءتها قبل توثيق بدء العلاج.");
        if (command.startDate < "1900-01-01" || command.startDate > clinicDateString(new Date(), CLINIC_TIME_ZONE))
            journeyFail(400, "invalid_start_date");
        const bridge = (await client.query("SELECT status FROM clinical_cases WHERE id=$1", [owner.clinicalCaseId])).rows[0];
        if (!bridge || !["active", "waiting"].includes(bridge.status))
            journeyFail(409, "clinical_case_closed");
        await client.query(`UPDATE ortho_cases SET status='active',phase='aligning',appliance=$2,arches=$3,slot=$4,start_date=$5,planned_months=$6,bracket_system=$7 WHERE id=$1`, [owner.orthoCaseId, command.appliance, command.arches, command.slot, command.startDate, command.plannedMonths, command.bracketSystem.trim() || null]);
        await event(client, input, actor, owner, "treatment_started", command);
        assertJourneyCurrent(actor);
        return receipt(input.patientId, owner.orthoCaseId, owner.clinicalCaseId, actor.userId, command, "started");
    });
}
