import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { checkOrthoSessionDraft, resolveOrthoWire } from '../lib/ortho-baseline';

// Execute the production transaction writer against a query witness, without
// initializing the application's database or claiming a PostgreSQL integration run.
const source = readFileSync('lib/db.ts', 'utf8');
const start = source.indexOf('async function writeOrthoSessionInTx(');
const end = source.indexOf('\nexport type OrthoBaselineRefusal', start);
const javascript = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const audit = vi.fn();
const write = new Function('checkOrthoSessionDraft', 'resolveOrthoWire', 'insertAuditRow',
  `${javascript}; return writeOrthoSessionInTx;`)(checkOrthoSessionDraft, resolveOrthoWire, audit);
const draft = { caseId: 7, visitId: 11, doneOn: '2026-10-25', phase: null,
  upperWire: null, lowerWire: null, elastics: 'none', elasticNote: null,
  done: 'Explicit synthetic review without change', nextWeeks: 4, note: null,
  recordedBy: 'synthetic-doctor', source: 'visit_sign', expectPatientId: 3 };
function client(existing = false) {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM ortho_cases')) return { rows: [{ status: 'active', patient_id: 3, upper_wire: 'upper-before', lower_wire: 'lower-before' }] };
    if (sql.includes('SELECT id FROM ortho_adjustments')) return { rows: existing ? [{ id: 42 }] : [] };
    if (sql.includes('SELECT patient_id FROM visits')) return { rows: [{ patient_id: 3 }] };
    if (sql.includes('INSERT INTO ortho_adjustments')) return { rows: [{ id: 42 }] };
    return { rows: [] };
  }) };
}
describe('new ortho transaction write integrity', () => {
  it.each([{ done: ' ' }, { nextWeeks: 0 }, { nextWeeks: 1.5 }, { upperWireAction: 'remove', upperWire: 'conflict' }])('refuses invalid new insert %j', async patch => {
    const db = client();
    expect(await write(db, { ...draft, ...patch })).toEqual({ ok: false, reason: 'invalid_session' });
    expect(db.query.mock.calls.some(([sql]) => /^\s*(INSERT|UPDATE)\b/.test(sql))).toBe(false);
  });
  it('retains both legacy blank wire values in adjustment and current case', async () => {
    const db = client();
    expect(await write(db, draft)).toMatchObject({ ok: true, created: true });
    const calls = db.query.mock.calls as unknown as [string, unknown[]][];
    expect(calls.find(([sql]) => sql.includes('INSERT INTO ortho_adjustments'))?.[1].slice(4, 6)).toEqual(['upper-before', 'lower-before']);
    expect(calls.find(([sql]) => sql.includes('UPDATE ortho_cases'))?.[1]).toEqual([7, 'upper-before', 'lower-before', null]);
  });
  it('persists and audits explicit removal while leaving the other arch unchanged', async () => {
    const db = client();
    await write(db, { ...draft, upperWireAction: 'remove' });
    const calls = db.query.mock.calls as unknown as [string, unknown[]][];
    expect(calls.find(([sql]) => sql.includes('INSERT INTO ortho_adjustments'))?.[1].slice(4, 6)).toEqual([null, 'lower-before']);
    expect(calls.find(([sql]) => sql.includes('UPDATE ortho_cases'))?.[1]).toEqual([7, null, 'lower-before', null]);
    expect(audit).toHaveBeenLastCalledWith(db, expect.objectContaining({ details: expect.objectContaining({ إجراء_السلك_العلوي: 'إزالة' }) }));
  });
  it('keeps legacy retry idempotency without rewriting the old blank actual', async () => {
    const db = client(true);
    expect(await write(db, { ...draft, done: null })).toEqual({ ok: true, id: 42, created: false });
    expect(db.query.mock.calls.some(([sql]) => /^\s*(INSERT|UPDATE)\b/.test(sql))).toBe(false);
  });
});
