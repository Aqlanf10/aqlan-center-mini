import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeLabBacklog, labBacklogAge, labBacklogNextAction, labBacklogPatientHref, parseLabBacklogQuery } from "../lib/lab-backlog";
import { backlogItem, backlogSnapshot } from "./fixtures/lab-backlog";

describe("lab backlog read contract", () => {
  it("requires an explicit current all-open scope and internally consistent counts", () => {
    const good = backlogSnapshot(); expect(decodeLabBacklog(good, "all")).toEqual(good);
    for (const bad of [{ ...good, scope: "selected_day" }, { ...good, today: "2026-10-24" }, { ...good, timeZone: "Unknown/Zone" },
      { ...good, counts: { ...good.counts, orders: 2 } }, { ...good, total: 2 }, { ...good, items: [] }, { ...good, hasMore: true },
      { ...good, items: [backlogItem({ status: "delivered" as never })] }, { ...good, items: [backlogItem({ visibleTaskCount: 1 })] }]) {
      expect(decodeLabBacklog(bad, "all")).toBeNull();
    }
    expect(decodeLabBacklog(good, "overdue")).toBeNull();
  });
  it.each(["patientId=1", "day=2026-01-01", "filter=all&filter=overdue", "page=-1", "page=1e2", "page=9999999", "filter=delivered"])("rejects invalid or expanded scope %s", query => {
    expect(parseLabBacklogQuery(new URLSearchParams(query))).toBeNull();
  });
  it("accepts bounded pages and default all-open filter", () => {
    expect(parseLabBacklogQuery(new URLSearchParams())).toEqual({ filter: "all", page: 0 });
    expect(parseLabBacklogQuery(new URLSearchParams("filter=awaiting_fitting&page=2"))).toEqual({ filter: "awaiting_fitting", page: 2 });
  });
  it("ages arrival only from actual recorded arrival in clinic timezone, never sent/due dates", () => {
    expect(labBacklogAge(backlogItem(), "2026-10-25", "Asia/Aden")).toEqual({ label: "من الوصول المسجّل", days: 23 });
    expect(labBacklogAge(backlogItem({ receivedAt: null }), "2026-10-25", "Asia/Aden").days).toBeNull();
    expect(labBacklogAge(backlogItem({ receivedAt: "2026-10-26T00:00:00Z" }), "2026-10-25", "Asia/Aden").days).toBeNull();
    expect(labBacklogAge(backlogItem({ receivedAt: "2026-10-24T22:00:00Z" }), "2026-10-25", "Asia/Aden").days).toBe(0);
  });
  it("keeps preparation age separate from overdue-at-lab and avoids clinical completion inference", () => {
    expect(labBacklogAge(backlogItem({ status: "needed", createdAt: "2026-10-23T23:00:00Z" }), "2026-10-25", "Asia/Aden")).toEqual({ label: "من تسجيل الطلب", days: 1 });
    expect(labBacklogAge(backlogItem({ status: "sent", dueDate: "2026-10-23" }), "2026-10-25", "Asia/Aden").days).toBe(2);
    expect(labBacklogAge(backlogItem({ status: "sent", dueDate: "2026-10-26" }), "2026-10-25", "Asia/Aden").days).toBe(0);
    expect(labBacklogNextAction("received")).toContain("الوصول ليس اكتمال العلاج");
    expect(labBacklogPatientHref(21)).toBe("/patients/21?tab=treatment&sub=lab");
  });
  it("keeps patient summary count aligned with all five known open states", () => {
    const source = readFileSync("lib/db.ts", "utf8");
    expect(source).toContain("status IN ('needed', 'sent', 'in_progress', 'remake', 'received'))::text AS open_lab");
  });
});
