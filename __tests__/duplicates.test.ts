import { describe, expect, it } from "vitest";
import {
  duplicateWarning,
  findDuplicates,
  nameOverlap,
  samePhone,
  nameTokens,
  normalizeName,
  type CandidatePatient,
} from "../lib/duplicates";

const patient = (over: Partial<CandidatePatient>): CandidatePatient => ({
  id: 1, patientNumber: "P-00001", fullName: "محمد أحمد سالم",
  phone: "967771234567", altPhone: null, birthYear: 1990, ...over,
});

describe("تطبيع الاسم العربي", () => {
  it("يوحّد الهمزات والتاء المربوطة والألف المقصورة", () => {
    expect(normalizeName("أحمد")).toBe(normalizeName("احمد"));
    expect(normalizeName("فاطمة")).toBe(normalizeName("فاطمه"));
    expect(normalizeName("يحيى")).toBe(normalizeName("يحيي"));
  });

  it("يتجاهل التشكيل والمسافات الزائدة", () => {
    expect(normalizeName("  مُحَمَّد   عَلي ")).toBe("محمد علي");
  });

  it("يوحّد «عبد الله» و«عبدالله»", () => {
    expect(nameTokens("عبد الله سالم")).toEqual(nameTokens("عبدالله سالم"));
  });
});

describe("كشف تكرار المرضى", () => {
  it("الهاتف أقوى دليل فيتصدّر", () => {
    const [match] = findDuplicates(
      { fullName: "اسم مختلف تمامًا", phone: "967771234567", altPhone: null, birthYear: null },
      [patient({})],
    );
    expect(match.reason).toBe("phone");
  });

  it("يمسك الرقم في خانة الهاتف البديل", () => {
    const [match] = findDuplicates(
      { fullName: "سالم", phone: "967700000001", altPhone: null, birthYear: null },
      [patient({ phone: null, altPhone: "967700000001" })],
    );
    expect(match.reason).toBe("phone");
  });

  it("يمسك الاسم نفسه مكتوبًا بهمزة مختلفة", () => {
    const [match] = findDuplicates(
      { fullName: "محمد احمد سالم", phone: null, altPhone: null, birthYear: null },
      [patient({ phone: null })],
    );
    expect(match.reason).toBe("same_name");
  });

  it("الاسم مع سنة الميلاد أقوى من الاسم وحده", () => {
    const withYear = findDuplicates(
      { fullName: "محمد أحمد سالم", phone: null, altPhone: null, birthYear: 1990 },
      [patient({ phone: null })],
    );
    const without = findDuplicates(
      { fullName: "محمد أحمد سالم", phone: null, altPhone: null, birthYear: null },
      [patient({ phone: null })],
    );
    expect(withYear[0].score).toBeGreaterThan(without[0].score);
  });

  it("يمسك الاسم المختصر: «محمد سالم» من «محمد أحمد سالم»", () => {
    // النسبة إلى الأقصر: اسمٌ كُتب مرة مختصرًا ومرة كاملًا شخصٌ واحد غالبًا.
    expect(nameOverlap("محمد سالم", "محمد أحمد سالم")).toBe(1);
    const [match] = findDuplicates(
      { fullName: "محمد سالم", phone: null, altPhone: null, birthYear: null },
      [patient({ phone: null })],
    );
    expect(match.reason).toBe("similar_name");
  });

  it("لا يُنبّه على اسمين مختلفين فعلًا", () => {
    expect(findDuplicates(
      { fullName: "خالد ناصر الحكيمي", phone: "967700000009", altPhone: null, birthYear: null },
      [patient({})],
    )).toEqual([]);
  });

  it("لا يزعج بأكثر من خمسة", () => {
    const many = Array.from({ length: 12 }, (_, i) => patient({ id: i + 1, phone: null }));
    expect(findDuplicates(
      { fullName: "محمد أحمد سالم", phone: null, altPhone: null, birthYear: null }, many,
    )).toHaveLength(5);
  });

  it("التحذير يقترح ولا يمنع", () => {
    expect(duplicateWarning([])).toBe("");
    expect(duplicateWarning([{ patient: patient({}), reason: "phone", score: 90 }]))
      .toContain("راجعه قبل الإضافة");
  });
});

describe("مطابقة أرقام الهواتف", () => {
  it("يطابق الصيغة المحلية بالدولية — وهي أشيع سبب لتكرار الملفات", () => {
    expect(samePhone("770245745", "967770245745")).toBe(true);
    expect(samePhone("+967 770 245 745", "0770245745")).toBe(true);
  });

  it("لا يطابق رقمين مختلفين", () => {
    expect(samePhone("770245745", "771111111")).toBe(false);
    expect(samePhone(null, "770245745")).toBe(false);
  });

  it("الأرقام القصيرة تُقارن حرفيًا لا بذيلها", () => {
    // امتدادٌ داخلي قصير، ومطابقة ذيله تجمع غرباء في ملف واحد.
    expect(samePhone("1234", "991234")).toBe(false);
    expect(samePhone("1234", "1234")).toBe(true);
  });

  it("يمسك التكرار بالرقم المحلي رغم اختلاف الاسم", () => {
    const [match] = findDuplicates(
      { fullName: "اسم آخر", phone: "770245745", altPhone: null, birthYear: null },
      [patient({ phone: "967770245745" })],
    );
    expect(match.reason).toBe("phone");
  });

  it("«عبد الله» و«عبدالله» مطابقة تامة لا قريبة", () => {
    const [match] = findDuplicates(
      { fullName: "عبدالله محمد سالم", phone: null, altPhone: null, birthYear: null },
      [patient({ fullName: "عبد الله محمد سالم", phone: null })],
    );
    expect(match.reason).toBe("same_name");
  });
});
