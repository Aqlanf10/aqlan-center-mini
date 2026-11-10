import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canExportOrthoStudy } from '../lib/ortho-study-export-access';
import { parseDoctorPermissions } from '../lib/doctor-permissions';
import type { DbClient } from '../lib/db';
const state = vi.hoisted(() => ({ grant: false, patientAccess: true }));
const session = { userId: 7, username: 'synthetic', role: 'doctor' as const, expiresAt: Number.MAX_SAFE_INTEGER };
vi.mock('../lib/session', () => ({ requireSession: async () => ({ userId: 7, username: 'synthetic', role: 'doctor', expiresAt: Number.MAX_SAFE_INTEGER }) }));
vi.mock('../lib/db', () => ({ findUserByUsername: async () => ({ id: 7, username: 'synthetic', displayName: 'Synthetic', role: 'doctor', isActive: true,
  permissions: { canExportOrthoStudies: state.grant } }) }));
vi.mock('../lib/patient-access', () => ({ canAccessPatient: async () => state.patientAccess }));
import { authorizeJourney } from '../lib/ortho-case-journey-authority';

beforeEach(() => { state.grant = false; state.patientAccess = true; });
describe('independent study export grant', () => {
  it.each(['doctor', 'reception'])('requires a literal, explicit grant for %s', role => {
    for (const value of [undefined, null, false, 'true', 1]) {
      expect(canExportOrthoStudy({ role, permissions: parseDoctorPermissions({ canExportOrthoStudies: value, canViewXrays: true, canEditPlans: true }, role) })).toBe(false);
    }
    expect(canExportOrthoStudy({ role, permissions: parseDoctorPermissions(null, role) })).toBe(false);
    expect(canExportOrthoStudy({ role, permissions: parseDoctorPermissions({ canExportOrthoStudies: true }, role) })).toBe(true);
  });
  it('retains admin authority and denies unrelated roles even with a grant', () => {
    expect(canExportOrthoStudy({ role: 'admin' })).toBe(true);
    expect(parseDoctorPermissions(null, 'admin').canExportOrthoStudies).toBe(true);
    for (const role of ['cashier', 'accountant', 'unknown']) expect(canExportOrthoStudy({ role, permissions: { canExportOrthoStudies: true } })).toBe(false);
    expect(canExportOrthoStudy(null)).toBe(false);
  });
  it('takes the grant from the current database user, never incoming session fields', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: 11 }] }) } as unknown as DbClient;
    const incoming = { ...session, permissions: { canExportOrthoStudies: true } };
    expect((await authorizeJourney(client, { session: incoming, patientId: 11, orthoCaseId: 21 }, false)).canExportStudies).toBe(false);
    state.grant = true;
    expect((await authorizeJourney(client, { session, patientId: 11, orthoCaseId: 21 }, false)).canExportStudies).toBe(true);
    state.patientAccess = false;
    await expect(authorizeJourney(client, { session, patientId: 11, orthoCaseId: 21 }, false)).rejects.toMatchObject({ status: 403, code: 'patient_access_denied' });
  });
});
