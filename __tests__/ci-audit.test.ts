import { describe, expect, it } from "vitest";
import {
  decideAuditOutcome,
  describeBlockingVulnerabilities,
} from "../lib/ci-audit";

const cleanReport = {
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  },
};

describe("بوابة تدقيق الاعتماديات — قرار التقرير", () => {
  it("تمرّ البوابة عند تقريرٍ نظيف صفر الثغرات", () => {
    expect(decideAuditOutcome(cleanReport)).toBe("pass");
  });

  it("تمرّ البوابة عند ثغراتٍ منخفضة فقط — العتبة moderate فأعلى", () => {
    const report = {
      metadata: { vulnerabilities: { info: 2, low: 3, moderate: 0, high: 0, critical: 0 } },
    };
    expect(decideAuditOutcome(report)).toBe("pass");
  });

  it("تُفشل البوابة عند أول ثغرة moderate", () => {
    const report = {
      metadata: { vulnerabilities: { low: 1, moderate: 1, high: 0, critical: 0 } },
    };
    expect(decideAuditOutcome(report)).toBe("fail");
  });

  it("تُفشل البوابة عند ثغرة high أو critical", () => {
    expect(
      decideAuditOutcome({ metadata: { vulnerabilities: { high: 1 } } }),
    ).toBe("fail");
    expect(
      decideAuditOutcome({ metadata: { vulnerabilities: { critical: 2 } } }),
    ).toBe("fail");
  });

  it("تعدّ التقرير غير مكتمل عند خطأ السجل (503/400) — ليس ثغرة", () => {
    const registryError = { error: { code: "E500", summary: "Service Unavailable" } };
    expect(decideAuditOutcome(registryError)).toBe("unavailable");
  });

  it("تعدّ التقرير غير مكتمل عند خرجٍ لا يُحلَّل أو ناقصٍ بلا إحصاءات", () => {
    expect(decideAuditOutcome(null)).toBe("unavailable");
    expect(decideAuditOutcome(undefined)).toBe("unavailable");
    expect(decideAuditOutcome("garbage")).toBe("unavailable");
    expect(decideAuditOutcome({})).toBe("unavailable");
    expect(decideAuditOutcome({ metadata: {} })).toBe("unavailable");
    expect(decideAuditOutcome({ metadata: { vulnerabilities: null } })).toBe(
      "unavailable",
    );
  });
});

describe("بوابة تدقيق الاعتماديات — وصف الثغرات الحاجبة", () => {
  it("تسرد المستويات التي بلغت العتبة وحدها", () => {
    const report = {
      metadata: { vulnerabilities: { low: 4, moderate: 1, high: 2, critical: 0 } },
    };
    expect(describeBlockingVulnerabilities(report)).toBe("moderate: 1، high: 2");
  });

  it("تذكر انتفاء الحاجبة عند تقريرٍ نظيف", () => {
    expect(describeBlockingVulnerabilities(cleanReport)).toBe("لا ثغرات حاجبة");
  });

  it("تذكر غياب الإحصاءات عند تقريرٍ غير مكتمل", () => {
    expect(describeBlockingVulnerabilities({ error: {} })).toBe(
      "لا إحصاءات في التقرير",
    );
  });
});
