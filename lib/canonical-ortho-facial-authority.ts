import 'server-only';
import { doctorOwnsPatient, patientInDoctorScopeWith, type DbClient } from './db';
import { staffOperationIdentity, staffOperationPatientScope, staffOperationCapabilities, type StaffOperationHandle } from './staff-operation-runtime';
import { facialFail, facialScope, type FacialActor, type FacialQuery, type FacialScope, type FacialWriteAuthority } from './ortho-facial-core-contract';

const action = 'clinical.ortho.edit' as const;
/** INACTIVE. Attribution is a drift witness, never permission. The runtime owns
 * exact handle/client/action/XID/session proof on every projection below. */
export function createCanonicalFacialWriteAuthority(client: DbClient, handle: StaffOperationHandle, input: FacialScope): FacialWriteAuthority {
  const scope = facialScope(input);
  let identity: Awaited<ReturnType<typeof staffOperationIdentity>> | undefined;
  let actor: FacialActor | undefined;
  const missing = () => facialFail(404, 'ortho_case_not_found');
  const bound = (passed: FacialQuery, requested: FacialScope) => {
    if (passed !== client || requested.patientId !== scope.patientId || requested.orthoCaseId !== scope.orthoCaseId) facialFail(403, 'facial_authority_changed');
  };
  const current = async () => {
    const fresh = await staffOperationIdentity(client, handle, action);
    if (identity && (['realmId', 'subjectId', 'generationId', 'userId', 'username', 'role'] as const).some(key => fresh[key] !== identity![key])) facialFail(401, 'facial_authority_changed');
    const membership = await staffOperationPatientScope(client, handle, action);
    if (membership.kind === 'none') missing();
    if (membership.kind === 'own' && !await doctorOwnsPatient(membership.clinicianPartyId, scope.patientId, client, 'nowait')) missing();
    return fresh;
  };
  const assertWrite: FacialWriteAuthority['assertWrite'] = async (passed, requested, expected) => {
    bound(passed, requested);
    if (!actor || !identity || expected.userId !== actor.userId || expected.name !== actor.name || expected.role !== actor.role) facialFail(401, 'facial_authority_changed');
    await current();
    return actor;
  };
  return {
    async authorizeWrite(passed, requested) {
      bound(passed, requested);
      if (actor) return assertWrite(passed, requested, actor);
      // Core table fences precede this patient wait. Re-prove after the wait.
      const initial = await staffOperationIdentity(client, handle, action);
      identity = Object.freeze({ ...initial });
      const membership = await staffOperationPatientScope(client, handle, action);
      if (membership.kind === 'none') missing();
      if (membership.kind === 'own' && !await patientInDoctorScopeWith(client, membership.clinicianPartyId, scope.patientId)) missing();
      const patient = await client.query('SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE', [scope.patientId]);
      if (!patient.rows.length) missing();
      const fresh = await current();
      actor = Object.freeze({ userId: fresh.userId, name: fresh.username, role: fresh.role });
      return actor;
    },
    assertWrite,
    async assertImages(passed, requested, expected) {
      await assertWrite(passed, requested, expected);
      const capabilities = await staffOperationCapabilities(client, handle, action, ['clinical.xrays.view']);
      if (!capabilities.has('clinical.xrays.view')) facialFail(403, 'image_access_denied');
      return assertWrite(passed, requested, expected);
    },
  };
}
