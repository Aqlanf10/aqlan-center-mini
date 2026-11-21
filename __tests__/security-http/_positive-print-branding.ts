import type { Client } from "pg";

export const fictionalPrintBrand = {
  "clinic.name": "مركز تجريبي للطباعة SYNCLINIC",
  "clinic.lead_doctor": "طبيب افتراضي SYNLEAD",
  "clinic.lead_doctor_title": "تخصص افتراضي SYNTITLE",
  "clinic.lead_doctor_credentials": "مؤهل افتراضي SYNCREDENTIAL",
  "clinic.address": "عنوان تجريبي SYNADDRESS",
  "clinic.phone": "202-555-0148", // Reserved fictional number, not dialed.
} as const;

const keys = Object.keys(fictionalPrintBrand);
// Startup seeds five identity keys; credentials may exist only as a default.
const optionalKey = "clinic.lead_doctor_credentials";
type SettingsRow = { key: string; value: string; updated_at: string };

async function rowsForUpdate(db: Client) {
  return (await db.query<SettingsRow>(`SELECT key, value, updated_at::text AS updated_at FROM settings
    WHERE key = ANY($1::text[]) ORDER BY key FOR UPDATE`, [keys])).rows;
}

function sameRows(left: SettingsRow[], right: SettingsRow[]) {
  return left.length === right.length && left.every((row, i) => row.key === right[i].key
    && row.value === right[i].value && row.updated_at === right[i].updated_at);
}

async function transaction<T>(db: Client, action: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    const result = await action();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

/** This is a seed in the serial, disposable security-HTTP fixture, not an
 * application Settings write. Restore both values and exact PostgreSQL
 * version timestamps before the next test file uses the built server. */
export async function installFictionalPrintBrand(db: Client): Promise<() => Promise<void>> {
  if ((await db.query("SELECT current_database() AS name")).rows[0]?.name !== "aqlan_sec_http") {
    throw new Error("Print branding fixture requires the disposable security-HTTP database");
  }
  const { original, installed } = await transaction(db, async () => {
    const original = await rowsForUpdate(db);
    if (keys.some(key => key !== optionalKey && !original.some(row => row.key === key))) {
      throw new Error("Missing baseline print branding keys");
    }
    await db.query(`INSERT INTO settings(key, value, updated_at)
      SELECT key, value, clock_timestamp() FROM unnest($1::text[], $2::text[]) AS f(key,value)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [keys, Object.values(fictionalPrintBrand)]);
    const installed = await rowsForUpdate(db);
    if (installed.length !== keys.length || installed.some(row =>
      row.value !== fictionalPrintBrand[row.key as keyof typeof fictionalPrintBrand])) {
      throw new Error("Fictional print branding was not installed");
    }
    return { original, installed };
  });

  return () => transaction(db, async () => {
    if (!sameRows(await rowsForUpdate(db), installed)) {
      throw new Error("Print branding fixture was changed unexpectedly; refusing to overwrite it");
    }
    if (!original.some(row => row.key === optionalKey)) {
      await db.query("DELETE FROM settings WHERE key=$1", [optionalKey]);
    }
    await db.query(`UPDATE settings AS s SET value = f.value, updated_at = f.updated_at
      FROM unnest($1::text[], $2::text[], $3::timestamptz[]) AS f(key,value,updated_at) WHERE s.key = f.key`,
    [original.map(row => row.key), original.map(row => row.value), original.map(row => row.updated_at)]);
    if (!sameRows(await rowsForUpdate(db), original)) throw new Error("Could not verify restored print branding versions");
  });
}
