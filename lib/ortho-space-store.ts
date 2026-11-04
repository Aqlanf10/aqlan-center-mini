import type { DbClient } from "./db";
import { authorizeJourney, assertJourneyCurrent, discoverJourneyOwner, lockJourneyOwner, journeyFail, journeyTransaction, type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { journeyHistory, insertJourneyRevision, replayJourney, journeyContentHash } from "./ortho-case-journey-history";
import { journeyClinicalSources } from "./ortho-case-journey-clinical-sources";
import { createStudyAssessmentAccess, prepareStudyAssessmentAccess, lockStudySourceUnion, requirePreparedAssessmentAccess } from "./ortho-case-study-assessment-access";
import { readSpaceCommand, projectIpr, contactKey, iprReviewNeeded, spaceBudget, type SpacePlan } from "./ortho-space-ledger";
import { readSpaceSavedContent, type SpaceSavedContent } from "./ortho-space-saved";
import { spaceBaselines } from "./ortho-space-baselines";
type Adjustment = { id: number; visit_id: number | null; done_on: string; recorded_by: string };
async function prepare(client: DbClient, input: JourneyOwnerInput, write: boolean, command?: ReturnType<typeof readSpaceCommand> & { ok: true }) {
  const authority = await authorizeJourney(client, input, write);
  if (!authority.canViewPlans || write && !authority.canEditPlans) journeyFail(403, "space_plan_access");
  const discovered = await discoverJourneyOwner(client, input);
  const history = await journeyHistory(client, "ortho_space_entries", discovered, readSpaceSavedContent);
  const cache = createStudyAssessmentAccess();
  const sources = await journeyClinicalSources(client, discovered, authority, ["assessment", "strategy"], cache, true);
  const allBaselines = spaceBaselines(sources.assessments);
  const latestAssessmentVersion = Math.max(0, ...sources.assessments.map(r => r.version), ...sources.unavailableAssessments.values());
  const latestAssessment = sources.assessments.find(r => r.version === latestAssessmentVersion);
  const plans = history.revisions.map(r => r.content.authored).filter((p): p is SpacePlan => p.kind === "plan");
  if (command?.value.content.kind === "plan") plans.push(command.value.content);
  const selected = new Set(plans.map(p => p.baseline.id));
  if (latestAssessment) selected.add(latestAssessment.id);
  const selectedAssessments = sources.assessments.filter(r => selected.has(r.id));
  if ([...selected].some(id => !selectedAssessments.some(a => a.id === id))) journeyFail(403, "space_assessment_missing");
  await prepareStudyAssessmentAccess(client, discovered, authority, selectedAssessments, cache);
  const adjustments = (await client.query<Adjustment>("SELECT id,visit_id,done_on::text,recorded_by FROM ortho_adjustments WHERE case_id=$1 ORDER BY id LIMIT 501", [discovered.orthoCaseId])).rows;
  if (adjustments.length > 500) journeyFail(409, "space_adjustment_limit");
  await lockStudySourceUnion(client, discovered, authority, cache);
  const visitIds = [...new Set(adjustments.flatMap(a => a.visit_id === null ? [] : [a.visit_id]))].sort((a,b) => a-b);
  // A canonical Ortho session is also valid when its general visit has no
  // specialty case yet. Do not silently assign the visit or treat a foreign
  // specialty link as the same case.
  const visitRows = (await client.query<{ id: number; patient_id: number | null; case_id: number | null }>(
    "SELECT id,patient_id,case_id FROM visits WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE", [visitIds])).rows;
  const readableVisits = new Set(visitRows.filter(v => v.patient_id === discovered.patientId && (v.case_id === null || v.case_id === discovered.clinicalCaseId)).map(v => v.id));
  const owner = await lockJourneyOwner(client, input, write);
  if (owner.clinicalCaseId !== discovered.clinicalCaseId) journeyFail(409, "space_owner_changed");
  // Match session writer order: patient -> visits -> case -> adjustment.
  const locked = (await client.query<Adjustment>("SELECT id,visit_id,done_on::text,recorded_by FROM ortho_adjustments WHERE case_id=$1 ORDER BY id FOR SHARE", [owner.orthoCaseId])).rows;
  if (journeyContentHash(locked) !== journeyContentHash(adjustments)) journeyFail(409, "space_sessions_changed");
  for (const p of plans) {
    const source = allBaselines.find(b => journeyContentHash(b.ref) === journeyContentHash(p.baseline) && b.arch === p.arch);
    if (!source) journeyFail(409, "space_baseline_changed");
    requirePreparedAssessmentAccess(cache, source.revision, authority, false);
    const strategy = sources.strategies.find(s => s.id === p.strategyRevisionId);
    if (!strategy || !sources.readableStrategy(strategy)) journeyFail(403, "space_strategy_missing");
  }
  for (const r of history.revisions) {
    const p = r.content.authored;
    if (p.kind === "plan") {
      const b = allBaselines.find(b => journeyContentHash(b.ref) === journeyContentHash(p.baseline))!;
      if (journeyContentHash(r.content.baseline) !== journeyContentHash({ discrepancyMm: b.discrepancyMm, estimated: b.estimated })) journeyFail(500, "space_snapshot_mismatch");
    } else {
      const a = locked.find(a => a.id === p.adjustmentId);
      if (!a?.visit_id || !readableVisits.has(a.visit_id) || a.visit_id !== r.content.adjustment?.visitId) journeyFail(403, "space_session_unavailable");
    }
  }
  const events = history.revisions.map(r => ({ id: r.id, version: r.version, content: r.content.authored }));
  const projection = projectIpr(events); if (!projection.ok) journeyFail(500, projection.code);
  const currentBaselines = allBaselines.filter(b => b.revision.id === latestAssessment?.id);
  const baselineChoices = currentBaselines.filter(b => {
    try { requirePreparedAssessmentAccess(cache, b.revision, authority, true); return true; } catch { return false; }
  }).map(({ revision: _revision, ...b }) => b);
  assertJourneyCurrent(authority);
  return { authority, owner, history, sources, allBaselines, baselineChoices, adjustments: locked.filter(a => a.visit_id !== null && readableVisits.has(a.visit_id)), events, projection: projection.value };
}
export async function getOrthoSpaceLedger(input: JourneyOwnerInput) {
  return journeyTransaction(false, async client => {
    const p = await prepare(client, input, false);
    const plans = (["upper", "lower"] as const).flatMap(arch => {
      const r = p.history.revisions.find(r => r.content.authored.kind === "plan" && r.content.authored.arch === arch);
      if (!r || r.content.authored.kind !== "plan" || !r.content.baseline) return [];
      const plan = r.content.authored;
      return [{ entryId: r.id, arch, sourceCurrent: p.baselineChoices.some(b => journeyContentHash(b.ref) === journeyContentHash(plan.baseline)),
        strategyCurrent: plan.strategyRevisionId === p.sources.strategies[0]?.id,
        budget: spaceBudget(plan, r.content.baseline.discrepancyMm), estimatedBaseline: r.content.baseline.estimated,
        contacts: plan.contacts.map(c => { const total = p.projection.totals.find(t => t.arch === arch && t.contact === contactKey(c.teeth)); return { ...c, performedUm: total ? total.performedUm : 0, review: iprReviewNeeded(c, total ? total.performedUm : 0) }; }) }];
    });
    return { ok: true as const, patientId: p.owner.patientId, orthoCaseId: p.owner.orthoCaseId, clinicalCaseId: p.owner.clinicalCaseId,
      writable: p.authority.canWrite && p.authority.canEditPlans, headId: p.history.revisions[0]?.id ?? null, history: p.history.revisions,
      plans, ipr: p.projection, choices: { baselines: p.baselineChoices, strategy: p.sources.strategies[0] ?? null,
        adjustments: p.adjustments.map(a => ({ id: a.id, visitId: a.visit_id!, occurredOn: a.done_on, recordedBy: a.recorded_by })) } };
  });
}
export async function appendOrthoSpaceEntry(input: JourneyOwnerInput & { command: unknown }) {
  const parsed = readSpaceCommand(input.command);
  if (!parsed.ok) return { ok: false as const, status: 400, code: parsed.code, message: "راجع بيانات المسافات والتماس والمقادير؛ المجهول لا يعامل كصفر." };
  return journeyTransaction(true, async client => {
    const p = await prepare(client, input, true, parsed), command = parsed.value, c = command.content;
    const fingerprint = journeyContentHash(command);
    const replay = replayJourney(p.history.rows, p.history.revisions, p.authority, command.clientRequestId, fingerprint);
    if (replay) return { ok: true as const, replayed: true, revision: replay, commandId: command.clientRequestId, requestFingerprint: fingerprint };
    let content: SpaceSavedContent;
    if (c.kind === "plan") {
      const b = p.baselineChoices.find(b => b.arch === c.arch && journeyContentHash(b.ref) === journeyContentHash(c.baseline));
      if (!b || p.sources.strategies[0]?.id !== c.strategyRevisionId) journeyFail(409, "space_sources_changed", "تغير مصدر القياس أو الخطة؛ راجع النسخة الحالية قبل الحفظ.");
      content = { authored: c, baseline: { discrepancyMm: b.discrepancyMm, estimated: b.estimated }, adjustment: null };
    } else {
      if (!["active", "retention", "completed", "discontinued"].includes(p.owner.status)) journeyFail(409, "ipr_case_not_treatment");
      const a = p.adjustments.find(a => a.id === c.adjustmentId);
      if (!a?.visit_id) journeyFail(409, "ipr_session_missing", "اختر جلسة تقويم فعلية مرتبطة بزيارة المريض؛ لم تُنشأ زيارة جديدة.");
      const plan = p.history.revisions.find(r => r.id === c.planEntryId)?.content.authored;
      if (!plan || plan.kind !== "plan" || plan.arch !== c.arch) journeyFail(409, "ipr_plan_missing");
      const latestPlan = p.history.revisions.find(r => r.content.authored.kind === "plan" && r.content.authored.arch === c.arch);
      if (c.supersedesEntryId === null && latestPlan?.id !== c.planEntryId) journeyFail(409, "ipr_plan_changed");
      content = { authored: c, baseline: null, adjustment: { visitId: a.visit_id, occurredOn: a.done_on, recordedBy: a.recorded_by } };
    }
    const revision = await insertJourneyRevision(client, { table: "ortho_space_entries", owner: p.owner, authority: p.authority, head: p.history.revisions[0] ?? null,
      expectedHeadId: command.expectedHeadId, commandId: command.clientRequestId, fingerprint, reason: command.reason, content, decode: readSpaceSavedContent });
    const projection = projectIpr([...p.events, { id: revision.id, version: revision.version, content: c }]);
    if (!projection.ok) journeyFail(409, projection.code);
    if (c.kind === "ipr") {
      const plan = p.history.revisions.find(r => r.id === c.planEntryId)!.content.authored as SpacePlan;
      const contact = plan.contacts.find(k => contactKey(k.teeth) === contactKey(c.teeth))!;
      const total = projection.value.totals.find(t => t.arch === c.arch && t.contact === contactKey(c.teeth))!;
      if (iprReviewNeeded(contact, total.performedUm).length && !c.reviewReason) journeyFail(409, "ipr_review_required", "الكمية تتجاوز المخطط أو الحد الذي سجله الطبيب، أو يوجد مقدار مجهول؛ اكتب مراجعتك قبل توثيق الحدث.");
    }
    assertJourneyCurrent(p.authority);
    return { ok: true as const, replayed: false, revision, commandId: command.clientRequestId, requestFingerprint: fingerprint };
  });
}
export type SpaceLedgerRead = Extract<Awaited<ReturnType<typeof getOrthoSpaceLedger>>, { ok: true }>;
