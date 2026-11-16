import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ book: vi.fn(), claim: vi.fn(), release: vi.fn(), entry: vi.fn() }));
vi.mock("../lib/book-appointment", () => ({ bookAppointment: deps.book }));
vi.mock("../lib/db", () => ({ claimWaitingForBooking: deps.claim, releaseWaitingClaim: deps.release, getWaitingEntry: deps.entry,
  findAppointmentForWaiting: async () => null, markWaitingBooked: vi.fn(), recordWaitingContact: vi.fn() }));
import { convertWaitingToAppointment } from "../lib/waiting-list-booking";
beforeEach(() => {
  vi.clearAllMocks(); deps.entry.mockResolvedValue({ id: 8, patientId: 19, status: "waiting", doctorId: 999, serviceId: 42 });
  deps.claim.mockResolvedValue({ ok: true }); deps.release.mockResolvedValue(undefined);
  deps.book.mockResolvedValue({ ok: false, status: 400, message: "Current responsibility requires review" });
});
it("forwards exact current responsibility context without treating waiting preference as current owner", async () => {
  const source = { kind: "clinical_case" as const, id: 23 };
  const result = await convertWaitingToAppointment({ waitingId: 8, date: "2030-01-20", time: "16:00", doctorId: 777,
    returnBookingSource: source, returnBookingFingerprint: "a".repeat(64) }, { username: "reception", userId: 71, role: "reception", channel: "ui" });
  expect(result.ok).toBe(false);
  expect(deps.book.mock.calls[0][0]).toMatchObject({ patientId: 19, waitingListId: 8, doctorId: null,
    returnBookingSource: source, returnBookingFingerprint: "a".repeat(64) });
  expect(deps.release).toHaveBeenCalledWith(8);
});
it("preserves non-return preference behavior while canonical writer still classifies service", async () => {
  await convertWaitingToAppointment({ waitingId: 8, date: "2030-01-20", time: "16:00" }, { username: "reception", role: "reception", channel: "ui" });
  expect(deps.book.mock.calls[0][0]).toMatchObject({ doctorId: 999, returnBookingSource: null });
});
