import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../lib/db";
import { readOrthoAdjustmentBookingContext } from "../lib/ortho-adjustment-booking-context";

const target = { patientId: 1, caseId: 2, adjustmentId: 3 };
function fixtures() {
  const ortho = { id: 2, patient_id: 1, responsible_doctor_id: 30 as number | null, status: "active", revision: "400" };
  const adjustment = { id: 3, case_id: 2, revision: "401", past_performer: 20, invoice_doctor: 10 };
  let bridge: { id: number; patient_id: number; responsible_party_id: number; specialty: string; status: string; revision: string } | undefined;
  let doctorActive = true;
  const query = vi.fn(async (sql: string, params: number[]) => {
    if (sql.includes("FROM ortho_cases")) return { rows: params[0] === 2 && params[1] === 1 ? [ortho] : [] };
    if (sql.includes("FROM ortho_adjustments")) return { rows: params[0] === 3 && params[1] === 2 ? [adjustment] : [] };
    if (sql.includes("FROM clinical_cases")) return { rows: bridge ? [bridge] : [] };
    if (sql.includes("FROM parties")) return { rows: doctorActive ? [{ id: params[0], name: "Synthetic doctor", revision: "402" }] : [] };
    throw new Error("Unexpected read");
  });
  return { ortho, query, client: { query } as unknown as DbClient,
    newBridge: (patient_id: number) => { bridge = { id: 4, patient_id, responsible_party_id: 40, specialty: "orthodontics", status: "active", revision: "500" }; },
    deactivate: () => { doctorActive = false; },
  };
}

describe("responsible doctor for a saved ortho adjustment", () => {
  it("uses case responsibility, not invoice or past performer, and invalidates A→B→A", async () => {
    const f = fixtures();
    const old = await readOrthoAdjustmentBookingContext(f.client, target);
    expect(old).toMatchObject({ ok: true, doctorId: 30 });
    f.ortho.responsible_doctor_id = 40; f.ortho.revision = "503";
    expect(await readOrthoAdjustmentBookingContext(f.client, target, true)).toMatchObject({ ok: true, doctorId: 40 });
    f.ortho.responsible_doctor_id = 30; f.ortho.revision = "504";
    const current = await readOrthoAdjustmentBookingContext(f.client, target, true);
    expect(current).toMatchObject({ ok: true, doctorId: 30 });
    expect(current).not.toEqual(old);
    expect(f.query.mock.calls.slice(-3).map(([sql]) => sql.match(/FOR (UPDATE|SHARE)/)?.[1])).toEqual(["UPDATE", "SHARE", "SHARE"]);
  });

  it("rejects an unrelated patient or adjustment before resolving a doctor", async () => {
    const f = fixtures();
    expect(await readOrthoAdjustmentBookingContext(f.client, { ...target, patientId: 8 })).toEqual({ ok: false, code: "unavailable" });
    expect(await readOrthoAdjustmentBookingContext(f.client, { ...target, adjustmentId: 8 })).toEqual({ ok: false, code: "unavailable" });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("FROM parties"))).toBe(false);
  });

  it("falls back to an active exact bridge only when case responsibility is absent", async () => {
    const f = fixtures(); f.newBridge(1);
    expect(await readOrthoAdjustmentBookingContext(f.client, target)).toMatchObject({ ok: true, doctorId: 30 });
    f.ortho.responsible_doctor_id = null;
    expect(await readOrthoAdjustmentBookingContext(f.client, target)).toMatchObject({ ok: true, doctorId: 40 });
    f.deactivate();
    expect(await readOrthoAdjustmentBookingContext(f.client, target)).toEqual({ ok: false, code: "responsibility_missing" });
    f.newBridge(8);
    expect(await readOrthoAdjustmentBookingContext(f.client, target)).toEqual({ ok: false, code: "unavailable" });
  });
});
