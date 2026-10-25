import { describe, expect, it } from "vitest";
import { legacyCoverageStateFromSnapshot } from "../lib/legacy-treatment-coverage";
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
  it("funded single-session identity refuses even after completion and outranks an unfunded match", () => {
    const funded = { ...scaling, fundedByAgreement: true };
    for (const status of ["planned", "done", "cancelled"]) {
      expect(unlinkedSessionConflicts([{ ...scaling, id: 99 }, { ...funded, status }], [{ serviceId: 30, toothCode: null }]))
        .toEqual([expect.stringMatching(/سجل مالي قائم/)]);
    }
    expect(unlinkedSessionConflicts([funded], [{ serviceId: 31, toothCode: null }])).toEqual([]);
    expect(unlinkedSessionConflicts([{ ...funded, fundedByAgreement: false }], [{ serviceId: 30, toothCode: null }])).toEqual([]);
  });

  it("names an amended financial identity without promising unsupported clinical relinking", () => {
    const amended: SessionPlanItem = { ...crown, toothCode: null, caseSite: null, serviceId: 21, serviceName: "فرق ترقية العلاج — تاج زركون", hasInvoiceLineage: true, amendedService: true };
    const conflict = unlinkedSessionConflicts([amended], [{ serviceId: 21, toothCode: 21 }]);
    expect(conflict).toEqual([expect.stringContaining("ربط الخدمة المعدلة سريريًا غير مدعوم حاليًا")]);
    expect(conflict[0]).not.toContain("اربط العمل ببنده الأصلي");
    expect(unlinkedSessionConflicts([amended], [{ serviceId: 21, toothCode: 46 }])).toHaveLength(1);
    expect(unlinkedSessionConflicts([amended], [{ serviceId: 20, toothCode: 21 }])).toEqual([]);
    expect(unlinkedSessionConflicts([{ ...amended, toothCode: null, caseSite: null }], [{ serviceId: 21, toothCode: 21 }])).toHaveLength(1);
  });

  it("only verified immutable coverage can prove another tooth disjoint from an amended alias", () => {
    const legacyCoverage = legacyCoverageStateFromSnapshot({ agreement_id: 1, format_version: 1,
      service_id: 20, service_category: "crown", anchor_tooth_code: 21,
      snapshot_mode: "multi_tooth_episode", snapshot_tooth_codes: [21, 22], snapshot_scope: null,
      snapshot_surfaces: null, recorded_by: "synthetic", recorded_at: "2026-10-01T00:00:00Z" },
    { agreementId: 1, serviceId: 20, anchorToothCode: 21 });
    expect(legacyCoverage.kind).toBe("verified");
    const amended: SessionPlanItem = { ...crown, toothCode: null, caseSite: null, serviceId: 21,
      hasInvoiceLineage: true, amendedService: true, hasLegacyLineage: true, legacyCoverage };
    expect(unlinkedSessionConflicts([amended], [{ serviceId: 21, toothCode: 22 }])).toHaveLength(1);
    expect(unlinkedSessionConflicts([amended], [{ serviceId: 21, toothCode: 46 }])).toEqual([]);
    expect(unlinkedSessionConflicts([{ ...amended, legacyCoverage: { kind: "unknown", reason: "missing_snapshot" } }],
      [{ serviceId: 21, toothCode: 46 }])).toHaveLength(1);
  });
});
