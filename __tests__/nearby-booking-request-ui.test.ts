import { describe, expect, it, vi } from "vitest";
import { requestBookingWithConfirmation } from "../lib/nearby-booking-request";
const warning = { kind: "nearby_patient_appointments", confirmationToken: "server-token", nearbyAppointments: [{ id: 12, scheduledDate: "2026-10-29", scheduledTime: "16:00", doctorName: "طبيب تجريبي" }] };
const options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: 8, date: "2026-10-28", time: "17:00" }) };
const reply = (body: unknown, status = 409) => new Response(JSON.stringify(body), { status });
describe("nearby booking UI request", () => {
  it("does not retry until explicit confirmation, and keeps the exact rejected proposal", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(warning)).mockResolvedValueOnce(reply({ id: 7 }, 200));
    const confirm = vi.fn(async () => true);
    const result = await requestBookingWithConfirmation("/api/appointments", options, confirm, () => true, fetcher);
    expect(result.ok).toBe(true); expect(confirm).toHaveBeenCalledWith(warning);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ ...JSON.parse(options.body), nearbyAppointmentConfirmation: "server-token" });
    expect(options.body).not.toContain("server-token");
  });
  it("accepts the nested reschedule/waiting-list/rebooking contract", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ message: "warning", conflict: warning })).mockResolvedValueOnce(reply({ ok: true }, 200));
    const confirm = vi.fn(async () => true);
    expect((await requestBookingWithConfirmation("/api/appointments/12", { ...options, method: "PATCH" }, confirm, () => true, fetcher)).ok).toBe(true);
    expect(confirm).toHaveBeenCalledWith(warning);
    expect(fetcher.mock.calls[1][1].method).toBe("PATCH");
  });
  it("does not send a confirmation after the request is aborted", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(reply(warning));
    await requestBookingWithConfirmation("/api/appointments", { ...options, signal: controller.signal }, async () => { controller.abort(); return true; }, () => true, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("cancel preserves the rejected response without a second write", async () => {
    const original = reply(warning); const fetcher = vi.fn().mockResolvedValue(original);
    expect(await requestBookingWithConfirmation("/api/appointments", options, async () => false, () => true, fetcher)).toBe(original);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never confirms or changes a hard overlap/capacity refusal", async () => {
    const original = reply({ message: "overlap", canOverride: false }); const fetcher = vi.fn().mockResolvedValue(original); const confirm = vi.fn();
    expect(await requestBookingWithConfirmation("/api/appointments", options, confirm, () => true, fetcher)).toBe(original);
    expect(confirm).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never retries after the patient/workflow lifetime changes while confirming", async () => {
    let current = true; const fetcher = vi.fn().mockResolvedValue(reply(warning));
    await requestBookingWithConfirmation("/api/appointments", options, async () => { current = false; return true; }, () => current, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not silently acknowledge a fresh warning after the explicit retry", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(warning)).mockResolvedValueOnce(reply({ ...warning, confirmationToken: "fresh" })); const confirm = vi.fn(async () => true);
    const result = await requestBookingWithConfirmation("/api/appointments", options, confirm, () => true, fetcher);
    expect(result.status).toBe(409); expect(fetcher).toHaveBeenCalledTimes(2); expect(confirm).toHaveBeenCalledTimes(1);
  });
});
