import { PURCHASE_RESET_FENCE } from "./clinic-reset";
import { insertAuditRow, type DbClient } from "./db";
import { assertJourneyCurrent, authorizeJourney, discoverJourneyOwner, journeyFail, journeyTransaction, lockJourneyOwner, type JourneyAuthority, type JourneyOwner, type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { problemSourceIdentity, readProblemSourceCommand, readProblemSourceRef, type ProblemSourceCommand, type ProblemSourceCandidate, type ProblemSourceRead, type ProblemSourceReceipt, type ProblemSourceReview } from "./ortho-problem-sources";
import { readProblemSourceCandidates } from "./ortho-problem-source-candidates";

type Saved = { id: number; patient_id: number; ortho_case_id: number; clinical_case_id: number; problem_id: number; actor_user_id: number;
  created_by: string; created_at: Date; source_identity: string; source_version: string; source_snapshot: ProblemSourceCandidate; problem_label: string;
  reason: string; supersedes_review_id: number | null; command_id: string; request_fingerprint: string };
function matchOwner(a: JourneyOwner, b: JourneyOwner) {
  if (a.patientId !== b.patientId || a.orthoCaseId !== b.orthoCaseId || a.clinicalCaseId !== b.clinicalCaseId || a.recordingContext !== b.recordingContext) journeyFail(409, "case_changed");
}
async function savedReviews(client: DbClient, owner: JourneyOwner, actor: JourneyAuthority): Promise<Saved[]> {
  const meta = (await client.query<{ n: string; bytes: string; images: boolean; assessments: boolean }>(`SELECT count(*)::text n,coalesce(sum(octet_length(source_snapshot::text)),0)::text bytes,
    coalesce(bool_or(source_snapshot->>'requiresImages'='true'),false) images,
    coalesce(bool_or(source_snapshot->'ref'->>'kind' IN ('assessment_observation','assessment_analysis')),false) assessments FROM ortho_problem_source_reviews WHERE ortho_case_id=$1`, [owner.orthoCaseId])).rows[0];
  if (Number(meta.n) > 500 || Number(meta.bytes) > 2097152) journeyFail(409, "problem_history_budget");
  // An immutable review can retain clinical assessment text after its current
  // source disappears. Deny before loading snapshots, not only candidates.
  if (meta.assessments && actor.session.role !== "admin" && actor.session.role !== "doctor") journeyFail(403, "problem_assessment_clinical_restricted");
  if (meta.images && !actor.canViewImages) journeyFail(403, "problem_images_restricted");
  const rows = (await client.query<Saved>("SELECT * FROM ortho_problem_source_reviews WHERE ortho_case_id=$1 ORDER BY id DESC LIMIT 501", [owner.orthoCaseId])).rows;
  if (rows.length !== Number(meta.n)) journeyFail(409, "problem_history_changed");
  for (const row of rows) {
    const source = row.source_snapshot, ref = readProblemSourceRef(source?.ref);
    if (row.patient_id !== owner.patientId || row.clinical_case_id !== owner.clinicalCaseId || !ref || source.identity !== row.source_identity
      || problemSourceIdentity(ref) !== row.source_identity || ref.version !== row.source_version || typeof source.requiresImages !== "boolean"
      || typeof source.summary !== "string" || typeof source.sourceActor !== "string") journeyFail(409, "invalid_problem_history");
    if (row.supersedes_review_id !== null) {
      const prior = rows.find(r => r.id === row.supersedes_review_id);
      if (!prior || prior.id >= row.id || prior.source_identity !== row.source_identity) journeyFail(409, "invalid_problem_lineage");
    }
  }
  return rows;
}
async function problems(client: DbClient, owner: JourneyOwner, lock = false): Promise<ProblemSourceRead["problems"]> {
  const rows = (await client.query<ProblemSourceRead["problems"][number]>(`SELECT id,label,site,status FROM patient_problems WHERE patient_id=$1 AND case_id=$2 AND specialty='orthodontics' ORDER BY id DESC LIMIT 501 ${lock ? "FOR SHARE" : ""}`, [owner.patientId, owner.clinicalCaseId])).rows;
  if (rows.length > 500) journeyFail(409, "problem_list_budget");
  return rows;
}
export async function getOrthoProblemSources(input: JourneyOwnerInput) {
  return journeyTransaction(false, async client => {
    const actor = await authorizeJourney(client, input, false), before = await discoverJourneyOwner(client, input);
    const saved = await savedReviews(client, before, actor), candidates = await readProblemSourceCandidates(client, before, actor);
    const currentProblems = await problems(client, before, true), owner = await lockJourneyOwner(client, input, false); matchOwner(before, owner);
    const reviews: ProblemSourceReview[] = saved.map(row => {
      const current = candidates.find(c => c.identity === row.source_identity);
      return { id: row.id, problemId: row.problem_id, sourceIdentity: row.source_identity, sourceVersion: row.source_version,
        source: row.source_snapshot, problemLabel: row.problem_label, createdBy: row.created_by, createdAt: row.created_at.toISOString(), reason: row.reason,
        supersedesReviewId: row.supersedes_review_id, currentSourceState: !current?.available ? "unavailable" : current.ref.version === row.source_version ? "current" : "newer_version" };
    });
    assertJourneyCurrent(actor);
    return { ok: true as const, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId, writable: actor.canWrite,
      candidates, problems: currentProblems, reviews } satisfies ProblemSourceRead;
  });
}
/** Shared transaction implementation; reservation validates without creating clinical facts. */
export async function runProblemSourceCommand(client: DbClient, input: JourneyOwnerInput, command: ProblemSourceCommand, validateOnly = false, revalidateReplay = false, write = true) {
    const fingerprint = journeyContentHash(command);
    const actor = await authorizeJourney(client, input, write), before = await discoverJourneyOwner(client, input);
    const saved = await savedReviews(client, before, actor);
    const duplicateCommand = (await client.query<Saved>("SELECT * FROM ortho_problem_source_reviews WHERE patient_id=$1 AND actor_user_id=$2 AND command_id=$3", [input.patientId, actor.userId, command.commandId])).rows[0];
    const receipt = (row: Saved, replayed: boolean): ProblemSourceReceipt => ({ ok: true, patientId: before.patientId, orthoCaseId: before.orthoCaseId,
      clinicalCaseId: before.clinicalCaseId, actorId: actor.userId, commandId: command.commandId, requestFingerprint: fingerprint, reviewId: row.id, problemId: row.problem_id,
      sourceIdentity: row.source_identity, sourceVersion: row.source_version, replayed });
    if (duplicateCommand) {
      if (duplicateCommand.ortho_case_id !== before.orthoCaseId || duplicateCommand.clinical_case_id !== before.clinicalCaseId || duplicateCommand.request_fingerprint !== fingerprint) journeyFail(409, "request_key_conflict");
      if (duplicateCommand.source_snapshot.requiresImages && !actor.canViewImages) journeyFail(403, "problem_images_restricted");
      if (revalidateReplay) {
        const candidates = await readProblemSourceCandidates(client, before, actor);
        if (!candidates.some(c => c.available && journeyContentHash(c.ref) === journeyContentHash(command.source))) journeyFail(409, "problem_source_changed");
      }
      if (!(await problems(client, before, true)).some(p => p.id === duplicateCommand.problem_id)) journeyFail(409, "problem_unavailable");
      matchOwner(before, await lockJourneyOwner(client, input, write)); assertJourneyCurrent(actor); return { ok: true as const, receipt: receipt(duplicateCommand, true) };
    }
    const identity = problemSourceIdentity(command.source), previous = saved.find(r => r.source_identity === identity);
    if ((previous?.id ?? null) !== command.expectedReviewId) journeyFail(409, "problem_review_changed", "تغيرت مراجعة المصدر؛ بقيت مسودتك دون تحويلها إلى النسخة الجديدة.");
    if (saved.some(r => r.source_identity === identity && r.source_version === command.source.version)) journeyFail(409, "problem_source_already_reviewed", "هذا المصدر مرتبط بالفعل بمشكلة؛ راجع الرابط الموجود دون إنشاء نسخة مكررة.");
    if (previous && command.action === "create") journeyFail(409, "problem_source_has_problem", "لهذا المصدر مشكلة سابقة؛ راجعها واربط النسخة الجديدة بمشكلة موجودة دون تكرارها.");
    const candidates = await readProblemSourceCandidates(client, before, actor);
    const candidate = candidates.find(c => c.identity === identity && journeyContentHash(c.ref) === journeyContentHash(command.source));
    if (!candidate?.available) journeyFail(409, "problem_source_changed", "المصدر تغير أو لم يعد متاحاً. لم تتغير قائمة المشاكل؛ راجع النسخة الحالية صراحة.");
    const currentProblems = await problems(client, before, true), owner = await lockJourneyOwner(client, input, write); matchOwner(before, owner);
    // Reject an append before it can strand every later read or exact replay.
    // PostgreSQL jsonb text spacing differs from JSON.stringify: budget the stored form.
    const budget = (await client.query<{ count: number; bytes: string; candidate_bytes: number }>(
      `SELECT count(*)::int count, (coalesce(sum(octet_length(source_snapshot::text)),0)+octet_length($2::jsonb::text))::text bytes,
        octet_length($2::jsonb::text) candidate_bytes FROM ortho_problem_source_reviews WHERE ortho_case_id=$1`,
      [owner.orthoCaseId,JSON.stringify(candidate)])).rows[0];
    if (budget.count >= 500 || Number(budget.bytes) > 2097152 || budget.candidate_bytes > 262144) journeyFail(409, "problem_history_budget");
    if (command.action === "create" && currentProblems.length >= 500) journeyFail(409, "problem_list_budget");
    let problemId: number, label: string;
    if (command.action === "link") {
      const existing = currentProblems.find(p => p.id === command.problemId);
      if (!existing || existing.status !== "active") journeyFail(409, "problem_not_active_in_case", "اختر مشكلة نشطة تخص الحالة نفسها؛ لا يُعاد تفعيل مشكلة قديمة تلقائياً.");
      problemId = existing.id; label = existing.label;
    } else {
      label = command.label!.trim();
      if (currentProblems.some(p => p.status === "active" && p.label.normalize("NFKC").trim().toLowerCase() === label.normalize("NFKC").toLowerCase() && p.site === candidate.site))
        journeyFail(409, "matching_problem_exists", "توجد مشكلة بنفس الوصف والموضع؛ اختر ربطها بالمصدر الحالي لتجنب التكرار.");
      if (validateOnly) { assertJourneyCurrent(actor); return { ok: true as const, receipt: null }; }
      problemId = (await client.query<{ id: number }>(`INSERT INTO patient_problems(patient_id,label,site,specialty,case_id,noted_by)
        VALUES($1,$2,$3,'orthodontics',$4,$5) RETURNING id`, [owner.patientId, label, candidate.site, owner.clinicalCaseId, actor.name])).rows[0].id;
    }
    if (validateOnly) { assertJourneyCurrent(actor); return { ok: true as const, receipt: null }; }
    if (Buffer.byteLength(JSON.stringify(candidate)) > 262144) journeyFail(409, "problem_source_budget");
    const row = (await client.query<Saved>(`INSERT INTO ortho_problem_source_reviews(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,problem_id,
      actor_user_id,created_by,source_identity,source_version,source_snapshot,problem_label,reason,supersedes_review_id,command_id,request_fingerprint)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14) RETURNING *`,
    [owner.patientId, owner.orthoCaseId, owner.clinicalCaseId, problemId, actor.userId, actor.name, identity, candidate.ref.version, JSON.stringify(candidate), label,
      command.reason, previous?.id ?? null, command.commandId, fingerprint])).rows[0];
    await insertAuditRow(client, { action: "ortho.problem_source.review", entity: "ortho_problem_source_reviews", entityId: row.id, actor: actor.name, actorRole: actor.session.role,
      details: { patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, problemId, sourceIdentity: identity, sourceVersion: candidate.ref.version, action: command.action, requestFingerprint: fingerprint } });
    assertJourneyCurrent(actor); return { ok: true as const, receipt: receipt(row, false) };

}
export async function appendOrthoProblemSource(input: JourneyOwnerInput & { command: unknown }) {
  const command = readProblemSourceCommand(input.command);
  if (!command) return { ok: false as const, status: 400, code: "invalid_problem_review", message: "لم يُقبل الطلب." };
  return journeyTransaction(true, async client => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [PURCHASE_RESET_FENCE]);
    await client.query("LOCK TABLE ortho_problem_source_reviews IN ROW EXCLUSIVE MODE");
    // Legacy internal callers cannot bypass a reserved or cancelled journal command.
    const actor = await authorizeJourney(client, input, true);
    const journal = await client.query("SELECT id FROM ortho_problem_source_submissions WHERE (ortho_case_id=$1 AND acknowledged_at IS NULL) OR (patient_id=$2 AND actor_user_id=$3 AND command_id=$4) LIMIT 1", [input.orthoCaseId,input.patientId,actor.userId,command.commandId]);
    if (journal.rows.length) journeyFail(409, "problem_submission_requires_journal");
    const result = await runProblemSourceCommand(client, input, command);
    if (!result.receipt) journeyFail(500, "missing_problem_receipt");
    return result.receipt;
  });
}
