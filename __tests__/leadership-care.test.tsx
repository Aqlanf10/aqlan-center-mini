import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { LeadershipCareReadout } from "../components/leadership/LeadershipClinicalOverview";
import { decodeLeadershipPulse, leadershipPlanHref, parsePulseQuery, type LeadershipPulse } from "../lib/leadership-pulse";
import { readLeadershipPulse } from "../lib/leadership-pulse-db";

function fixture(): LeadershipPulse {
  return { view: "care", scope: "active_plan_work_now", day: "2026-10-26", today: "2026-10-26", timeZone: "Asia/Aden", asOf: "2026-10-26T09:00:00.000Z",
    counts: { activePlans: 1, pendingPlans: 1, patients: 1, pendingItems: 2, plannedItems: 1, inProgressItems: 1, withoutPendingItems: 0 }, total: 1, page: 0, hasMore: false,
    items: [{ id: 7, title: "خطة اصطناعية قديمة", patientId: 4, patientName: "مريض اصطناعي", startDate: "2020-01-01", status: "active", eventAt: "2020-01-01T09:00:00Z", doctorName: null, assignee: null, dueAt: null, latestAction: null, pendingItems: 2, plannedItems: 1, inProgressItems: 1 }],
  };
}
it("accepts the current all-active-plan source independently of a selected day and rejects a fake day filter", () => {
  expect(parsePulseQuery(new URLSearchParams("view=care&page=2"), new Date("2026-10-25T22:00:00Z"), "Asia/Aden")).toEqual({ view: "care", day: "2026-10-26", page: 2 });
  expect(parsePulseQuery(new URLSearchParams("view=care&day=2020-01-01"), new Date(), "Asia/Aden")).toBeNull();
  expect(decodeLeadershipPulse(fixture(), "care", null)).not.toBeNull();
});
it("rejects unknown counts, inconsistent pending work and invented task assignment or deadline", () => {
  const cases = [
    { counts: { ...fixture().counts, pendingItems: null } },
    { counts: { ...fixture().counts, pendingPlans: 2 } },
    { counts: { ...fixture().counts, pendingItems: 3 } },
    { items: [{ ...fixture().items[0], pendingItems: 3 }] },
    { items: [{ ...fixture().items[0], dueAt: "2026-01-01T00:00:00Z" }] },
    { items: [{ ...fixture().items[0], assignee: "last actor" }] },
    { items: [{ ...fixture().items[0], patientId: null }] },
    { items: [{ ...fixture().items[0], startDate: "2026-02-30" }] },
  ];
  for (const patch of cases) expect(decodeLeadershipPulse({ ...fixture(), ...patch }, "care", null)).toBeNull();
});
it("denies non-admin readers before a query and performs only one bounded query for care", async () => {
  const query = vi.fn();
  await expect(readLeadershipPulse({ query }, { view: "care", day: "2026-10-26", page: 0 }, "Asia/Aden", { role: "doctor", userId: 1 })).rejects.toThrow("leadership_forbidden");
  expect(query).not.toHaveBeenCalled();
  const data = fixture(); query.mockResolvedValue({ rows: [{ as_of: new Date(data.asOf), today: data.today, total: data.total, page: data.page, counts: data.counts, items: data.items }] });
  expect(await readLeadershipPulse({ query }, { view: "care", day: "2026-10-26", page: 0 }, "Asia/Aden", { role: "admin", userId: 1 })).toEqual(data);
  expect(query).toHaveBeenCalledTimes(1); expect(query.mock.calls[0][0]).toContain("LIMIT $4");
  expect(query.mock.calls[0][0]).not.toMatch(/hr_tasks|payments|journal|appointments/);
});
it("renders old active plans, exact current scope, plan links and uncertainty without money or inferred overdue work", () => {
  const html = renderToStaticMarkup(<LeadershipCareReadout read={fixture()} />);
  expect(html).toContain("كل الخطط الجارية"); expect(html).toContain("2020-01-01");
  expect(html).toContain("الأعداد كاملة"); expect(html).toContain("غير محدد");
  expect(html).toContain("لا موعد استحقاق مفترض"); expect(html).toContain("ليس عدد الجلسات");
  expect(leadershipPlanHref(fixture().items[0])).toBe("/patients/4?patientId=4&planId=7&tab=treatment&sub=plans");
  expect(html).toContain("patientId=4&amp;planId=7&amp;tab=treatment&amp;sub=plans");
  expect(html).not.toMatch(/ر\.س|ر\.ي|\$|متأخرة/);
});
it("keeps an active plan with no pending items visible without declaring it clinically completed", () => {
  const data = fixture(); data.counts = { activePlans: 1, pendingPlans: 0, patients: 1, pendingItems: 0, plannedItems: 0, inProgressItems: 0, withoutPendingItems: 1 };
  data.items[0] = { ...data.items[0], pendingItems: 0, plannedItems: 0, inProgressItems: 0 };
  expect(decodeLeadershipPulse(data, "care", null)).not.toBeNull();
  expect(renderToStaticMarkup(<LeadershipCareReadout read={data} />)).toContain("لكن الخطة ما زالت جارية");
});
