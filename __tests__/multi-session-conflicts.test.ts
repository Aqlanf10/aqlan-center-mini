import { describe, expect, it } from "vitest";
import { unlinkedSessionConflicts, type SessionPlanItem } from "../lib/plans";

/** (P1-D) إجراءٌ حرّ لبندٍ متعدد الجلسات أو جارٍ = تعارضٌ مسمّى؛ البند أحادي الجلسة المخطَّط ليس تعارضًا. */
describe("(P1-D) unlinkedSessionConflicts", () => {
  const rct: SessionPlanItem = { id: 1, serviceId: 10, toothCode: 36, serviceName: "علاج عصب", status: "in_progress", sessionCount: 3, doneSessions: 1 };
  const crown: SessionPlanItem = { id: 2, serviceId: 20, toothCode: 21, serviceName: "تاج", status: "planned", sessionCount: 2, doneSessions: 0 };
  const scaling: SessionPlanItem = { id: 3, serviceId: 30, toothCode: null, serviceName: "تنظيف", status: "planned", sessionCount: 1, doneSessions: 0 };

  it("names the item and the next session for an in-progress or multi-session item", () => {
    expect(unlinkedSessionConflicts([rct], [{ serviceId: 10, toothCode: 36 }])).toEqual([
      expect.stringMatching(/«علاج عصب — سن 36».*جلسة 2 من 3/),
    ]);
    expect(unlinkedSessionConflicts([crown], [{ serviceId: 20, toothCode: 21 }])).toEqual([
      expect.stringMatching(/جلسة 1 من 2/),
    ]);
  });

  it("ignores another tooth, another service and a planned single-session item", () => {
    expect(unlinkedSessionConflicts([rct, crown, scaling], [
      { serviceId: 10, toothCode: 46 }, { serviceId: 99, toothCode: 36 }, { serviceId: 30, toothCode: null },
    ])).toEqual([]);
  });

  it("an in-progress single-session item is still a conflict, and each item is named once", () => {
    const started = { ...scaling, status: "in_progress" };
    expect(unlinkedSessionConflicts([started], [{ serviceId: 30, toothCode: null }, { serviceId: 30, toothCode: null }])).toHaveLength(1);
  });

  it("(review) a planned single-session item with the same service and tooth takes the procedure first", () => {
    const singleCrown: SessionPlanItem = { id: 9, serviceId: 20, toothCode: 21, serviceName: "تاج", status: "planned", sessionCount: 1, doneSessions: 0 };
    expect(unlinkedSessionConflicts([crown, singleCrown], [{ serviceId: 20, toothCode: 21 }])).toEqual([]);
    /* إجراءان: الأول للبند أحادي الجلسة، والثاني يصطدم بالبند متعدد الجلسات. */
    expect(unlinkedSessionConflicts([crown, singleCrown], [{ serviceId: 20, toothCode: 21 }, { serviceId: 20, toothCode: 21 }]))
      .toEqual([expect.stringMatching(/جلسة 1 من 2/)]);
  });
});
