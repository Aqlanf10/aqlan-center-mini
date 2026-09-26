import { describe, expect, it } from "vitest";
import { likeContains, normalizeSearchText, patientSearchCondition, searchTokens } from "../lib/patient-search";

/** (PAT-1) تطبيع البحث العربي — «احمد» يجد «أحمد». */
describe("Arabic search normalization", () => {
  it("unifies hamza forms, taa marbuta, alef maqsura, strips diacritics and tatweel", () => {
    expect(normalizeSearchText("أحمد")).toBe(normalizeSearchText("احمد"));
    expect(normalizeSearchText("إبراهيم")).toBe("ابراهيم");
    expect(normalizeSearchText("آمنة")).toBe("امنه");
    expect(normalizeSearchText("فاطمة")).toBe(normalizeSearchText("فاطمه"));
    expect(normalizeSearchText("مصطفى")).toBe("مصطفي");
    expect(normalizeSearchText("مُحَمَّد")).toBe("محمد");
    expect(normalizeSearchText("عـبـدالله")).toBe("عبدالله");
    expect(normalizeSearchText("لؤي")).toBe("لوي");
    expect(normalizeSearchText("٧٧٠١٢٣٤٥٦")).toBe("770123456");
    expect(normalizeSearchText("P-00012")).toBe("p-00012");
  });

  it("splits words in any order and strips phone prefixes", () => {
    expect(searchTokens("  علي   محمد ")).toEqual(["علي", "محمد"]);
    expect(searchTokens("0770123456")).toEqual(["770123456"]);
    expect(searchTokens("+967 770123456")).toEqual(["770123456"]);
    expect(searchTokens("00967770123456")).toEqual(["770123456"]);
    expect(searchTokens("٠٧٧٠١٢٣٤٥٦")).toEqual(["770123456"]);
    expect(searchTokens("")).toEqual([]);
  });

  it("escapes LIKE wildcards and builds one AND-ed condition per word", () => {
    expect(likeContains("50%_!")).toBe("%50!%!_!!%");
    const condition = patientSearchCondition(["علي", "محمد"], 3);
    expect(condition.params).toEqual(["%علي%", "%محمد%"]);
    expect(condition.sql).toContain("$3");
    expect(condition.sql).toContain("$4");
    expect(condition.sql).toContain(" AND ");
    expect(patientSearchCondition([], 1).sql).toBe("FALSE");
  });
});
