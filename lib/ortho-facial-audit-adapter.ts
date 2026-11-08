import 'server-only';
import { insertAuditRow, type DbClient } from './db';
import { facialFail, facialId, facialHash, type FacialActor, type FacialAuditPort } from './ortho-facial-core-contract';

/** INACTIVE. Mandatory same-transaction audit, with no pool/fallback writer. */
export function createFacialAuditAdapter(client: DbClient, assertCurrent: (actor: FacialActor) => Promise<FacialActor>): FacialAuditPort {
  return {
    async append(passed, event) {
      if (passed !== client) facialFail(403, 'facial_authority_changed');
      // Snapshot only whitelisted scalar fields before the first await.
      const actor = Object.freeze({ userId: event.actor.userId, name: event.actor.name, role: event.actor.role });
      const check = async () => {
        const actual = await assertCurrent(actor);
        if (actual.userId !== actor.userId || actual.name !== actor.name || actual.role !== actor.role) facialFail(401, 'facial_authority_changed');
      };
      const entityId = event.entityId;
      if (!facialId(entityId) || !facialId(actor.userId) || typeof actor.name !== 'string' || !actor.name.trim() || typeof actor.role !== 'string' || !actor.role.trim()) facialFail(500, 'facial_core_port_invalid');
      let input;
      if (event.action === 'ortho.facial_revision' && event.entity === 'ortho_facial_revisions') {
        const d = event.details;
        if (![d.patientId, d.orthoCaseId, d.documentId, d.version].every(facialId) || !['draft', 'reviewed'].includes(d.review) || !facialHash(d.requestFingerprint)) facialFail(500, 'facial_core_port_invalid');
        input = { action: event.action, entity: event.entity, entityId, actor: actor.name, actorRole: actor.role,
          details: { patientId: d.patientId, orthoCaseId: d.orthoCaseId, documentId: d.documentId, version: d.version, review: d.review, requestFingerprint: d.requestFingerprint } };
      } else if (event.action === 'ortho.facial_submission' && event.entity === 'ortho_facial_submissions') {
        const d = event.details;
        if (!facialId(d.orthoCaseId) || !facialHash(d.requestFingerprint) || !['reserved', 'committed', 'cancelled_before_arrival', 'cancelled', 'acknowledged'].includes(d.event) || !['pending', 'committed', 'cancelled'].includes(d.state)) facialFail(500, 'facial_core_port_invalid');
        input = { action: event.action, entity: event.entity, entityId, actor: actor.name, actorRole: actor.role,
          details: { event: d.event, orthoCaseId: d.orthoCaseId, requestFingerprint: d.requestFingerprint, state: d.state } };
      } else facialFail(500, 'facial_core_port_invalid');
      await check();
      await insertAuditRow(client, input);
      await check();
    },
  };
}
