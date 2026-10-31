#!/usr/bin/env node
import pg from "pg";
import { inspectClinicOwnerBindingCandidate } from "../lib/clinic-owner-binding-plan.mjs";

// Explicit IDs only; SELECT-only and no ensureSchema/import of application DB.
const [user, doctor, ...extra] = process.argv.slice(2);
if (!/^[1-9][0-9]*$/.test(user ?? "") || !/^[1-9][0-9]*$/.test(doctor ?? "") || extra.length || !process.env.DATABASE_URL) {
  console.error("Usage: DATABASE_URL=… node scripts/clinic-owner-binding-plan.mjs USER_ID DOCTOR_ID (read only)");
  process.exitCode = 2;
} else {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, options: "-c default_transaction_read_only=on" });
  try {
    await client.connect();
    console.log(JSON.stringify(await inspectClinicOwnerBindingCandidate(client, { userId: Number(user), doctorId: Number(doctor) }), null, 2));
  } catch {
    console.error("OWNER_PLAN_REFUSED: unable to verify read-only candidate; no binding applied.");
    process.exitCode = 1;
  } finally { await client.end(); }
}
