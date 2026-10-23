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
