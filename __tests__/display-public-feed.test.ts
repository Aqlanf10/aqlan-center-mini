import { expect, it, vi } from "vitest";
import { GET } from "../app/api/display/route";

// Exercise the real public projection, with synthetic data and no database.
// The retired display.show_ortho option must never restore an aggregate.
vi.mock("@/lib/staff-entry-mode", () => ({
  currentStaffEntryMode: async () => "legacy",
}));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  activeAnnouncementsForScreen: async () => [],
  getSettings: async () => ({
    "clinic.name": "مركز تجريبي", "clinic.chairs": "2", "display.show_ortho": "true",
  }),
  listAppointmentsByDate: async () => [],
  listTodayVisits: async () => ["called", "waiting", "in_chair", "done"].map((status, index) => ({
    id: index + 1, patientName: "نداء تجريبي", status,
    chair: status === "called" ? 1 : status === "in_chair" ? 2 : null,
    arrivedAt: "2026-01-01T09:00:00Z",
    calledAt: status === "waiting" ? null : "2026-01-01T09:10:00Z",
  })),
}));

it("serves masked call guidance but no operational counters or specialty totals", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  const feed = await response.json();
  expect(Object.keys(feed).sort()).toEqual([
    "announcements", "called", "delayNotice", "now", "speech", "tagline", "voice", "welcomeText",
  ]);
  expect(feed.called).toEqual([{
    at: "2026-01-01T09:10:00Z", chair: 1, name: "نداء ت.", speechName: "نداء",
  }]);
});
