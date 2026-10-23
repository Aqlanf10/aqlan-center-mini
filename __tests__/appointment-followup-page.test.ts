import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFollowupPage, encodeFollowupCursor } from '../lib/appointment-followup-page';
import { APPOINTMENT_FOLLOWUP_SQL } from '../lib/appointment-followup-schema';
it('uses bounded defaults and rejects unknown, duplicated and malformed options', () => {
  expect(parseFollowupPage(new URLSearchParams())).toEqual({limit:25,patientId:null,cursor:null});
  for (const value of ['limit=0','limit=101','limit=1&limit=2','patientId=0','patientId=2147483648','cursor=','limit=1e2','role=admin','cursor=abcd']) expect(parseFollowupPage(new URLSearchParams(value))).toBeNull();
});
it('roundtrips exact microseconds and binds patient scope', () => {
  const cursor = {due:'2026-10-23T10:00:00.123456Z',id:7,generation:'a'.repeat(32),patientId:9};
  const token = encodeFollowupCursor(cursor);
  expect(parseFollowupPage(new URLSearchParams({cursor:token,patientId:'9'}))?.cursor).toEqual(cursor);
  expect(parseFollowupPage(new URLSearchParams({cursor:token,patientId:'8'}))).toBeNull();
  expect(parseFollowupPage(new URLSearchParams({cursor:token}))).toBeNull();
});
it('numbered migration and runtime DDL are byte identical', () => {
  expect(readFileSync('migrations/0070_appointment_followups.sql','utf8')).toBe(APPOINTMENT_FOLLOWUP_SQL);
});
it('0071 has byte-identical runtime SQL, preserving 0070 as a separate predecessor', async () => {
  const { APPOINTMENT_FOLLOWUP_QUERY_SQL } = await import('../lib/appointment-followup-query-schema');
  expect(readFileSync('migrations/0071_appointment_followup_query_indexes.sql','utf8')).toBe(APPOINTMENT_FOLLOWUP_QUERY_SQL);
  expect(APPOINTMENT_FOLLOWUP_QUERY_SQL).toContain('DROP INDEX appointment_followups_queue_idx');
  expect(APPOINTMENT_FOLLOWUP_QUERY_SQL).not.toMatch(/\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\b/);
});

it('0072 runtime registration exactly matches the additive retirement migration',async()=>{
 const { APPOINTMENT_FOLLOWUP_RETIREMENT_SQL }=await import('../lib/appointment-followup-retirement-schema');
 expect(readFileSync('migrations/0072_appointment_followup_retirements.sql','utf8')).toBe(APPOINTMENT_FOLLOWUP_RETIREMENT_SQL);
});
