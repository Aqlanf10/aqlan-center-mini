/** Internal identity command only. No HTTP, UI, CLI, startup or migration caller.
 * The unregistered proposal schema is installed explicitly by isolated tests. */
import { randomUUID } from 'node:crypto';
import type { DbPool, DbClient } from './db';
import { insertAuditRow } from './db';
import type { SessionPayload } from './auth';
import { withTransaction } from './transactions';
import { IdentityPreviewError } from './hr-identity-preview';
import { authorizeIdentityAdmin, readHrIdentitySources } from './hr-identity-sources';
import { buildPersonIdentityPlan, identityDigest, parsePersonIdentityPlan, type PersonIdentityDecision, type PersonIdentityPlan } from './hr-person-identity-plan';
import { readPersonIdentitySchema } from './hr-person-identity-schema-state';

export interface PersonIdentityReceipt {
  runId: string; requestId: string; planDigest: string; actorUserId: number;
  people: { key: string; staffId: number; revision: number; action: string; eventIds: string[] }[];
}
export async function reviewHrPersonIdentity(pool: DbPool, session: SessionPayload | null, decisions: unknown) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await authorizeIdentityAdmin(client,session);
    const result = buildPersonIdentityPlan(await readHrIdentitySources(client), decisions);
    if (!session || session.expiresAt <= Date.now()) throw new IdentityPreviewError(401,'انتهت الجلسة.');
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function recordIdentityEvent(client: DbClient, runId: string, staffId: number, revision: number, actor: SessionPayload,
  decision: PersonIdentityDecision, action: string, details: Record<string, unknown>): Promise<string> {
  const { rows: [event] } = await client.query(`INSERT INTO hr_identity_events(run_id,staff_id,revision,actor_user_id,action,reason,source_ref,details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id::text`,
  [runId,staffId,revision,actor.userId,action,decision.reason,decision.sourceRef,JSON.stringify(details)]);
  return event.id;
}

/** Locked snapshot, one receipt, all-or-nothing. Identity never writes users,
 * parties, contracts, employment history, permissions, commissions or money. */
export async function applyHrPersonIdentityPlan(pool: DbPool, session: SessionPayload | null,
  input: { requestId: string; plan: PersonIdentityPlan }): Promise<PersonIdentityReceipt> {
  if (!input || Object.keys(input).some(k => !['requestId','plan'].includes(k))
    || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) {
    throw new IdentityPreviewError(400,'مفتاح طلب الهوية غير صالح.');
  }
  const supplied = parsePersonIdentityPlan(input.plan);
  const operation = supplied.decisions.some(d => d.closeAccountLinkIds.length || d.closePartyLinkId !== null) ? 'correct' : 'apply';
  const intentDigest = identityDigest({ operation,plan:supplied });
  try { return await withTransaction(pool,async client => {
    if (!(await readPersonIdentitySchema(client))) throw new IdentityPreviewError(503,'نموذج الهوية غير مسجل؛ التطبيق غير متاح.');
    await authorizeIdentityAdmin(client,session);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('hr-person-identity-v1',0))");
    // These source table SHARE locks also protect absence/phantom references from
    // legacy writers that do not know identity locks. There is no live caller.
    // They precede all source row locks; activation requires operational review.
    await client.query('LOCK TABLE users,parties,hr_staff,hr_contracts,hr_payroll_items,payables IN SHARE MODE');
    const actor = await authorizeIdentityAdmin(client,session,true);
    const prior = (await client.query(`SELECT intent_digest,response FROM hr_identity_import_runs
      WHERE actor_user_id=$1 AND operation=$2 AND request_id=$3`,[actor.userId,operation,input.requestId])).rows[0];
    if (prior) {
      if (prior.intent_digest !== intentDigest) throw new IdentityPreviewError(409,'استُخدم مفتاح الطلب لمحتوى مختلف.');
      if (actor.expiresAt <= Date.now()) throw new IdentityPreviewError(401,'انتهت الجلسة أثناء قراءة الإيصال.');
      return projectReceipt(prior.response);
    }
    if ((await client.query('SELECT id FROM hr_identity_import_runs WHERE plan_digest=$1',[supplied.planDigest])).rows.length) {
      throw new IdentityPreviewError(409,'طُبقت هذه الخطة سابقًا؛ استخدم إيصال الطلب الأصلي.');
    }
    const sources = await readHrIdentitySources(client);
    const plan = buildPersonIdentityPlan(sources,supplied.decisions);
    if (plan.planDigest !== supplied.planDigest) throw new IdentityPreviewError(409,'تغيّرت المصادر أو المخطط؛ أعد المعاينة والمراجعة.');
    if (plan.steps.some(s => s.action === 'conflict')) throw new IdentityPreviewError(409,'الخطة تتضمن تعارضات؛ لم يُطبّق أي قرار.');
    const runId = randomUUID(), people: PersonIdentityReceipt['people'] = [];
    for (const [index,decision] of plan.decisions.entries()) {
      const step = plan.steps[index];
      if (step.action === 'skip') {
        people.push({ key:step.key,staffId:step.staffId!,revision:step.revision,action:'skip',eventIds:[] });
        continue;
      }
      let staffId = step.staffId;
      const revision = step.revision + 1, eventIds: string[] = [];
      if (staffId === null) {
        const { rows: [created] } = await client.query(`INSERT INTO hr_staff(full_name,work_status,contract_kind,identity_revision,created_by)
          VALUES($1,'unconfirmed','unspecified',1,$2) RETURNING id`,[decision.fullName,actor.username]);
        staffId = created.id as number;
      } else {
        const updated = await client.query('UPDATE hr_staff SET identity_revision=$2,updated_at=clock_timestamp() WHERE id=$1 AND identity_revision=$3',
          [staffId,revision,step.revision]);
        if (updated.rowCount !== 1) throw new IdentityPreviewError(409,'تغيّرت مراجعة هوية الشخص.');
      }
      const event = async (action: string,details: Record<string,unknown>) => {
        const eventId = await recordIdentityEvent(client,runId,staffId,revision,actor,decision,action,details);
        eventIds.push(eventId); return eventId;
      };
      await event(step.action === 'create' ? 'create' : 'confirm',{ previousRevision:step.revision });
      for (const linkId of decision.closeAccountLinkIds) {
        const eventId = await event('close_account',{linkId});
        const updated = await client.query(`UPDATE hr_staff_account_links SET closed_at=clock_timestamp(),closed_event_id=$3
          WHERE id=$1 AND staff_id=$2 AND closed_at IS NULL`,[linkId,staffId,eventId]);
        if (updated.rowCount !== 1) throw new IdentityPreviewError(409,'تغيّر رابط الحساب.');
      }
      if (decision.closePartyLinkId !== null) {
        const eventId = await event('close_party',{linkId:decision.closePartyLinkId});
        const updated = await client.query(`UPDATE hr_staff_party_links SET closed_at=clock_timestamp(),closed_event_id=$3
          WHERE id=$1 AND staff_id=$2 AND closed_at IS NULL`,[decision.closePartyLinkId,staffId,eventId]);
        if (updated.rowCount !== 1) throw new IdentityPreviewError(409,'تغيّر رابط الجهة.');
      }
      for (const userId of step.userIds) {
        if ((sources.accountLinks ?? []).some(l => l.staffId === staffId && l.userId === userId && !l.closed)) continue;
        const eventId = await event('link_account',{userId});
        await client.query('INSERT INTO hr_staff_account_links(staff_id,user_id,opened_event_id) VALUES($1,$2,$3)',[staffId,userId,eventId]);
      }
      if (step.partyId !== null && !(sources.partyLinks ?? []).some(l => l.staffId === staffId && l.partyId === step.partyId && !l.closed)) {
        const eventId = await event('link_party',{partyId:step.partyId});
        await client.query('INSERT INTO hr_staff_party_links(staff_id,party_id,opened_event_id) VALUES($1,$2,$3)',[staffId,step.partyId,eventId]);
      }
      await insertAuditRow(client,{action:step.action === 'create' ? 'hr.staff.create' : 'hr.staff.update',entity:'hr_identity',
        entityId:String(staffId),entityLabel:`هوية الشخص ${staffId}`,actor:actor.username,actorRole:actor.role,
        details:{runId,revision,eventIds,planDigest:plan.planDigest,reason:decision.reason,sourceRef:decision.sourceRef}});
      people.push({key:step.key,staffId,revision,action:step.action,eventIds});
    }
    const response: PersonIdentityReceipt = {runId,requestId:input.requestId,planDigest:plan.planDigest,actorUserId:actor.userId,people};
    await client.query(`INSERT INTO hr_identity_import_runs(id,actor_user_id,operation,request_id,plan_digest,intent_digest,response)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[runId,actor.userId,operation,input.requestId,plan.planDigest,intentDigest,JSON.stringify(response)]);
    if (actor.expiresAt <= Date.now()) throw new IdentityPreviewError(401,'انتهت الجلسة أثناء العملية؛ لم تُحفظ التغييرات.');
    return response;
  }); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['23505','40001','40P01'].includes(String(error.code))) {
      throw new IdentityPreviewError(409,'تغيّرت الروابط بالتزامن؛ أعد قراءة الإيصال أو المعاينة دون إعادة تطبيق تلقائية.');
    }
    throw error;
  }
}

function projectReceipt(raw: PersonIdentityReceipt): PersonIdentityReceipt {
  return {runId:raw.runId,requestId:raw.requestId,planDigest:raw.planDigest,actorUserId:raw.actorUserId,
    people:raw.people.map(p => ({key:p.key,staffId:p.staffId,revision:p.revision,action:p.action,eventIds:[...p.eventIds]}))};
}
