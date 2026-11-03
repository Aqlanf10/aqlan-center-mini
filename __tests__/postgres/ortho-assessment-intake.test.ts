import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ORTHO_ASSESSMENT_INTAKE_SQL } from "../../lib/ortho-assessment-intake-schema";
import { runBaselineSchemaProbe } from "../../lib/baseline-probe";
import { commandOrthoPlanLink, readOrthoPlanLink } from "../../lib/ortho-plan-link-command";
vi.mock("server-only", () => ({}));
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { openOrthoAssessment, startOrthoTreatment } from "../../lib/ortho-assessment-intake-store";
import { verifyIntakeReceipt } from "../../lib/ortho-assessment-intake";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, session: SessionPayload;
beforeAll(async () => { f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema(); const password = "synthetic-intake-credential", u = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('intake-admin','Synthetic intake clinician',$1,'admin') RETURNING id", [password])).rows[0]; session = { userId: u.id, username: "intake-admin", role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600000 }; request.token = createSessionToken(session); });
afterAll(async () => { await f?.close(); });
const command = () => ({ schemaVersion: 1 as const, clientRequestId: randomUUID(), reason: "Synthetic diagnostic intake" });
const patient = async () => (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic new diagnostic case') RETURNING id", [randomUUID()])).rows[0].id;
const unrelated = async () => (await f.pool.query("SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM patient_opening_balances) opening,(SELECT count(*)::int FROM visits) visits,(SELECT count(*)::int FROM appointments) appointments")).rows;
describe("diagnostic case identity before actual treatment", () => {
    it("links an existing plan before treatment through the authorized versioned financial command", async () => {
        const patientId = await patient(), foreign = await patient();
        const opened = await openOrthoAssessment({ patientId, session, command: command() });
        if (!opened.ok) throw Error(opened.code);
        const planId = (await f.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor) VALUES($1,'Synthetic existing plan',900000) RETURNING id", [patientId])).rows[0].id;
        const otherPlanId = (await f.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor) VALUES($1,'Synthetic foreign plan',900000) RETURNING id", [foreign])).rows[0].id;
        const before = await unrelated(), observation = await readOrthoPlanLink(session, opened.orthoCaseId);
        expect(observation.status).toBe("assessment");
        await expect(commandOrthoPlanLink(session, opened.orthoCaseId, { planId: otherPlanId, expectedVersion: observation.observedVersion })).rejects.toThrow();
        await expect(commandOrthoPlanLink(session, opened.orthoCaseId, { planId, expectedVersion: observation.observedVersion })).resolves.toMatchObject({ ok: true, planId });
        await expect(commandOrthoPlanLink(session, opened.orthoCaseId, { planId: null, expectedVersion: observation.observedVersion })).rejects.toThrow();
        expect((await f.pool.query("SELECT status,plan_id,start_date FROM ortho_cases WHERE id=$1", [opened.orthoCaseId])).rows[0]).toEqual({ status: "assessment", plan_id: planId, start_date: null });
        expect(await unrelated()).toEqual(before);
        expect((await f.pool.query("SELECT total_minor::text amount FROM treatment_plans WHERE id=$1", [planId])).rows[0].amount).toBe("900000");
    });
    it("registers exact migration bytes and permits only the guarded baseline evolution", async () => {
        expect(readFileSync("migrations/0103_ortho_assessment_intake.sql", "utf8")).toBe(ORTHO_ASSESSMENT_INTAKE_SQL);
        expect((await f.pool.query("SELECT checksum,adopted FROM schema_migrations WHERE version='0103'")).rows).toEqual([{ checksum: createHash("sha256").update(ORTHO_ASSESSMENT_INTAKE_SQL).digest("hex"), adopted: false }]);
        const { loadMigrationFiles } = await import("../../lib/migration-files");
        expect((await runBaselineSchemaProbe(f.pool, (await loadMigrationFiles())[0].sql)).ok).toBe(true);
    });
    it("creates one linked case with no assumed treatment facts, replays and reopens its identity", async () => {
        const patientId = await patient(), cmd = command(), before = await unrelated();
        const saved = await openOrthoAssessment({ patientId, session, command: cmd });
        expect(saved).toMatchObject({ ok: true, mode: "created" });
        if (!saved.ok)
            throw Error(saved.code);
        await expect(verifyIntakeReceipt(saved, { patientId, actorId: session.userId!, command: cmd }, 201)).resolves.toEqual(saved);
        expect((await f.pool.query("SELECT status,phase,appliance,arches,slot,start_date,planned_months,plan_id FROM ortho_cases WHERE id=$1", [saved.orthoCaseId])).rows[0]).toEqual({ status: "assessment", phase: "assessment", appliance: null, arches: null, slot: null, start_date: null, planned_months: null, plan_id: null });
        expect(await openOrthoAssessment({ patientId, session, command: cmd })).toEqual({ ...saved, mode: "replayed" });
        expect(await openOrthoAssessment({ patientId, session, command: command() })).toMatchObject({ ok: true, mode: "existing", orthoCaseId: saved.orthoCaseId, clinicalCaseId: saved.clinicalCaseId });
        expect(await openOrthoAssessment({ patientId, session, command: { ...cmd, reason: "different" } })).toMatchObject({ ok: false, code: "request_key_conflict" });
        const cases = await f.db.listPatientOrthoCases(patientId, "2026-11-03");
        expect(cases).toHaveLength(1);
        expect(cases[0]).toMatchObject({ id: saved.orthoCaseId, status: "assessment", progress: null, startDate: null });
        expect((await f.db.listPatientCases(patientId))[0]).toMatchObject({ id: saved.clinicalCaseId, orthoCaseId: saved.orthoCaseId, status: "active" });
        expect(await unrelated()).toEqual(before);
    });
    it("serializes two entry points without duplicate cases or bridges", async () => {
        const patientId = await patient();
        const replies = await Promise.all([openOrthoAssessment({ patientId, session, command: command() }), openOrthoAssessment({ patientId, session, command: command() })]);
        expect(replies.every(r => r.ok)).toBe(true);
        if (!replies[0].ok || !replies[1].ok)
            throw Error("unexpected");
        expect(replies[0].orthoCaseId).toBe(replies[1].orthoCaseId);
        expect(replies.map(r => r.ok ? r.mode : "failed").sort()).toEqual(["created", "existing"]);
        expect((await f.pool.query("SELECT count(*)::int n FROM clinical_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(1);
    });
    it("starts treatment explicitly on the same case; exact retry does not recreate or reopen", async () => {
        const patientId = await patient(), opened = await openOrthoAssessment({ patientId, session, command: command() });
        if (!opened.ok)
            throw Error(opened.code);
        const before = await unrelated(), cmd = { ...command(), confirmed: true as const, appliance: "aligners" as const, arches: "upper" as const, slot: null, startDate: "2026-10-01", plannedMonths: 12, bracketSystem: "" }, owner = { patientId, session, orthoCaseId: opened.orthoCaseId };
        const saved = await startOrthoTreatment({ ...owner, command: cmd });
        expect(saved).toMatchObject({ ok: true, mode: "started", orthoCaseId: opened.orthoCaseId, clinicalCaseId: opened.clinicalCaseId });
        expect(await startOrthoTreatment({ ...owner, command: cmd })).toMatchObject({ ok: true, mode: "replayed" });
        expect(await startOrthoTreatment({ ...owner, command: { ...cmd, clientRequestId: randomUUID() } })).toMatchObject({ ok: false, status: 409 });
        expect(await unrelated()).toEqual(before);
        expect((await f.db.listPatientOrthoCases(patientId, "2026-11-03"))[0]).toMatchObject({ status: "active", appliance: "aligners", slot: null, startDate: "2026-10-01" });
        await f.pool.query("UPDATE ortho_cases SET status='completed',closed_at=now() WHERE id=$1", [opened.orthoCaseId]);
        expect(await startOrthoTreatment({ ...owner, command: cmd })).toMatchObject({ ok: true, mode: "replayed" });
        expect((await f.pool.query("SELECT status FROM ortho_cases WHERE id=$1", [opened.orthoCaseId])).rows[0].status).toBe("completed");
    });
    it("blocks unlinked existing shells and audit failure without creating a second context", async () => {
        const patientId = await patient();
        await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES($1,'orthodontics','Synthetic existing shell','synthetic')", [patientId]);
        expect(await openOrthoAssessment({ patientId, session, command: command() })).toMatchObject({ ok: false, code: "unlinked_ortho_case" });
        expect((await f.pool.query("SELECT count(*)::int n FROM ortho_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(0);
        const empty = await patient();
        await f.pool.query("CREATE FUNCTION synthetic_intake_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.assessment_open' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_intake_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_intake_audit_fail()");
        try {
            await expect(openOrthoAssessment({ patientId: empty, session, command: command() })).rejects.toThrow("synthetic audit failure");
        }
        finally {
            await f.pool.query("DROP TRIGGER synthetic_intake_audit_fail ON audit_log;DROP FUNCTION synthetic_intake_audit_fail()");
        }
        expect((await f.pool.query("SELECT count(*)::int n FROM clinical_cases WHERE patient_id=$1", [empty])).rows[0].n).toBe(0);
    });
    it("permits a clinician without finance rights, but rejects reception and stale credentials", async () => {
        const password = "synthetic-intake-doctor-credential";
        const user = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES('intake-doctor','Synthetic doctor',$1,'doctor',$2) RETURNING id", [password, JSON.stringify({ canViewAllPatients: true, canViewPlans: false, canEditPlans: false })])).rows[0];
        const doctor: SessionPayload = { userId: user.id, username: "intake-doctor", role: "doctor", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600000 };
        request.token = createSessionToken(doctor);
        try {
            const patientId = await patient();
            expect(await openOrthoAssessment({ patientId, session: doctor, command: command() })).toMatchObject({ ok: true, actorId: user.id });
            await f.pool.query("UPDATE users SET role='reception' WHERE id=$1", [user.id]);
            const reception: SessionPayload = { ...doctor, role: "reception" };
            request.token = createSessionToken(reception);
            expect(await openOrthoAssessment({ patientId, session: reception, command: command() })).toMatchObject({ ok: false, status: 403 });
            await f.pool.query("UPDATE users SET password_hash='synthetic-changed-credential' WHERE id=$1", [user.id]);
            expect(await openOrthoAssessment({ patientId, session: reception, command: command() })).toMatchObject({ ok: false, status: 401 });
        }
        finally {
            request.token = createSessionToken(session);
        }
    });
    it("refuses foreign scope and future dates, and serializes competing treatment starts", async () => {
        const patientId = await patient(), other = await patient(), opened = await openOrthoAssessment({ patientId, session, command: command() });
        if (!opened.ok)
            throw Error(opened.code);
        const cmd = { ...command(), confirmed: true as const, appliance: "fixed_metal" as const, arches: "both" as const, slot: "022" as const, startDate: "2026-10-01", plannedMonths: 18, bracketSystem: "" }, owner = { patientId, session, orthoCaseId: opened.orthoCaseId };
        expect(await startOrthoTreatment({ ...owner, patientId: other, command: cmd })).toMatchObject({ ok: false, status: 404 });
        expect(await startOrthoTreatment({ ...owner, command: { ...cmd, startDate: "2999-01-01" } })).toMatchObject({ ok: false, status: 400 });
        const results = await Promise.all([startOrthoTreatment({ ...owner, command: cmd }), startOrthoTreatment({ ...owner, command: { ...cmd, clientRequestId: randomUUID() } })]);
        expect(results.filter(r => r.ok)).toHaveLength(1);
        expect(results.find(r => !r.ok)).toMatchObject({ status: 409 });
        expect((await f.pool.query("SELECT count(*)::int n FROM ortho_case_intake_events WHERE ortho_case_id=$1 AND event_kind='treatment_started'", [opened.orthoCaseId])).rows[0].n).toBe(1);
    });
    it("keeps events immutable, scope fixed and treatment facts absent until an explicit start", async () => {
        const patientId = await patient(), other = await patient(), opened = await openOrthoAssessment({ patientId, session, command: command() });
        if (!opened.ok)
            throw Error(opened.code);
        await expect(f.pool.query("UPDATE ortho_case_intake_events SET command='{}' WHERE ortho_case_id=$1", [opened.orthoCaseId])).rejects.toThrow("append-only");
        await expect(f.pool.query("DELETE FROM ortho_case_intake_events WHERE ortho_case_id=$1", [opened.orthoCaseId])).rejects.toThrow("append-only");
        await expect(f.pool.query("UPDATE ortho_cases SET patient_id=$2 WHERE id=$1", [opened.orthoCaseId, other])).rejects.toThrow();
        await expect(f.pool.query("UPDATE clinical_cases SET patient_id=$2 WHERE id=$1", [opened.clinicalCaseId, other])).rejects.toThrow();
        await expect(f.pool.query("UPDATE ortho_cases SET start_date=current_date WHERE id=$1", [opened.orthoCaseId])).rejects.toThrow("ortho_assessment_state_check");
        await expect(f.pool.query("UPDATE ortho_cases SET status='active',phase='aligning' WHERE id=$1", [opened.orthoCaseId])).rejects.toThrow("ortho_assessment_state_check");
    });
});
