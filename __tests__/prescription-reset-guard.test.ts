import { expect, it, vi } from 'vitest';
import { assertNoPrescriptionIssuanceHistory, ProtectedPrescriptionHistoryError, RESET_KEEP_TABLES, RESET_WIPE_TABLES } from '../lib/clinic-reset';
it('classifies durable commands exactly once as protected KEEP, never unconditional wipe', () => { expect(RESET_KEEP_TABLES.filter(table => table === 'prescription_issuance_commands')).toHaveLength(1); expect(RESET_WIPE_TABLES as readonly string[]).not.toContain('prescription_issuance_commands'); });
it.each([true, false])('locks before checking history and only permits an empty table (%s)', async exists => {
 const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ exists }] });
 if (exists) await expect(assertNoPrescriptionIssuanceHistory({ query })).rejects.toBeInstanceOf(ProtectedPrescriptionHistoryError);
 else await expect(assertNoPrescriptionIssuanceHistory({ query })).resolves.toBeUndefined();
 expect(query.mock.calls[0][0]).toBe('LOCK TABLE prescription_issuance_commands IN EXCLUSIVE MODE'); expect(query.mock.calls).toHaveLength(2);
 expect(query.mock.calls.some(([sql]) => /DELETE|TRUNCATE|INSERT|UPDATE/.test(sql))).toBe(false);
});
