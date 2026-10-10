import { describe, expect, it } from "vitest";
import { formatLabPrescriptionText, labDispatchQrPayload, labFollowUpText, toLabDispatchExternal } from "../lib/lab";
import { DISPATCH_PRIVATE_CANARIES, dispatchOrder } from "./fixtures/lab-dispatch";

describe("external lab dispatch privacy", () => {
  it("uses an explicit projection without patient linkage, private text or finance", () => {
    const source = dispatchOrder();
    const before = structuredClone(source);
    const external = toLabDispatchExternal(source);
    expect(Object.keys(external).sort()).toEqual([
      "reference", "labName", "labPhone", "doctorName", "workType", "teeth", "toothNumbers",
      "shade", "stumpShade", "priority", "impressionType", "sentDate", "dueDate", "reviewWarnings",
    ].sort());
    const json = JSON.stringify(external);
    for (const privateText of [...DISPATCH_PRIVATE_CANARIES, "910007", "910008", "910009", "910010", "875431", "YER"]) {
      expect(json).not.toContain(privateText);
    }
    expect(external.reference).toBe("RX-381");
    expect(external.workType).toBe("SYNTHETIC_CATALOGUE_CROWN");
    expect(external.teeth).toEqual([{ code: 14, role: "abutment" }, { code: 15, role: "pontic" }, { code: 16, role: "abutment" }]);
    expect(external.reviewWarnings.join(" ")).toContain("الملاحظات الداخلية");
    expect(source).toEqual(before);
  });

  it("QR carries only a stable order reference, independent of patient identity", () => {
    const first = labDispatchQrPayload(toLabDispatchExternal(dispatchOrder()));
    const changedIdentity = labDispatchQrPayload(toLabDispatchExternal(dispatchOrder({ patientId: 99, patientName: "OTHER_PRIVATE_NAME", patientNumber: "OTHER_PRIVATE_FILE" })));
    expect(first).toBe('{"rx":"RX-381"}');
    expect(changedIdentity).toBe(first);
    expect(labDispatchQrPayload(toLabDispatchExternal(dispatchOrder({ id: 382 })))).toBe('{"rx":"RX-382"}');
    expect(first).not.toMatch(/https?:|patient|file|name|phone|shade|teeth/);
  });

  it("copy and urgency text both omit private canaries and disclose omitted instructions", () => {
    const source = dispatchOrder();
    for (const text of [formatLabPrescriptionText(source, "SYNTHETIC_CLINIC", "000-333-444"), labFollowUpText(source, "2000-02-08", "SYNTHETIC_CLINIC")]) {
      for (const privateText of DISPATCH_PRIVATE_CANARIES) expect(text).not.toContain(privateText);
      for (const expected of ["RX-381", "SYNTHETIC_CATALOGUE_CROWN", "14(Abutment)", "15(Pontic)", "A2", "2000-02-05", "عاجل", "الملاحظات الداخلية", "قبل الإرسال"]) expect(text).toContain(expected);
    }
    expect(labFollowUpText(source, "2000-02-08", "SYNTHETIC_CLINIC")).toContain("3 أيام");
  });

  it("does not leak arbitrary per-patient free text through service, shade or teeth fallbacks", () => {
    const source = dispatchOrder({ labServiceId: null, serviceName: null,
      workType: "SYNTHETIC_PRIVATE_WORK", toothNumbers: "SYNTHETIC_PRIVATE_TOOTH_12", shade: "SYNTHETIC_PRIVATE_SHADE", stumpShade: "SYNTHETIC_PRIVATE_STUMP" });
    const result = toLabDispatchExternal(source);
    expect(result.workType).toBe("غير محدد في دليل المعمل");
    expect(result.teeth).toEqual([]);
    expect(result.shade).toBeNull();
    expect(result.stumpShade).toBeNull();
    for (const text of [JSON.stringify(result), formatLabPrescriptionText(source, "CLINIC"), labFollowUpText(source, "2000-02-08", "CLINIC")]) {
      expect(text).not.toContain("SYNTHETIC_PRIVATE_");
      expect(text).toContain("نوع العمل يحتاج مراجعة");
      expect(text).toContain("أرقام الأسنان وأدوارها");
      expect(text).toContain("لون السن غير محدد");
    }
  });

  it("preserves bare and automatically sourced tooth codes without inventing crown roles", () => {
    expect(toLabDispatchExternal(dispatchOrder({ toothNumbers: "11, 21", labServiceId: null, workType: "تاج" })).teeth)
      .toEqual([{ code: 11, role: null }, { code: 21, role: null }]);
    const automatic = toLabDispatchExternal(dispatchOrder({ toothNumbers: null, toothCode: 36 }));
    expect(automatic.toothNumbers).toBe("36");
    expect(automatic.teeth).toEqual([{ code: 36, role: null }]);
    expect(automatic.reviewWarnings.join(" ")).toContain("لا يُفترض أنها تيجان أو دعامات");
  });

  it("keeps recognized legacy/remake work while flagging unrecognized clinical facts", () => {
    expect(toLabDispatchExternal(dispatchOrder({ labServiceId: null, serviceName: null, workType: "تاج زيركون كامل (إعادة)", remakeOriginalId: 910009 })).workType).toBe("تاج زيركون كامل (إعادة)");
    const external = toLabDispatchExternal(dispatchOrder({ toothNumbers: "99(Crown), 14(Unknown), 15(Pontic)", impressionType: "other", doctorName: null }));
    expect(external.teeth).toEqual([{ code: 15, role: "pontic" }]);
    expect(external.doctorName).toBeNull();
    expect(external.reviewWarnings.join(" ")).toContain("بعض بيانات الأسنان غير معيارية");
    expect(external.reviewWarnings.join(" ")).toContain("نوع الطبعة يحتاج تأكيدًا");
  });

  it("does not relabel a historical prescription after a live catalogue rename", () => {
    const external = toLabDispatchExternal(dispatchOrder({ workType: "تاج زيركون كامل", serviceName: "تاج إيماكس" }));
    expect(external.workType).toBe("غير محدد في دليل المعمل");
    expect(external.reviewWarnings.join(" ")).toContain("لا يطابق نوع العمل المحفوظ");
    expect(JSON.stringify(external)).not.toContain("تاج إيماكس");
  });

  it("retains a catalogue-linked remake label without exporting the original internal ID", () => {
    const external = toLabDispatchExternal(dispatchOrder({ workType: "SYNTHETIC_CATALOGUE_CROWN (إعادة)", remakeOriginalId: 910009 }));
    expect(external.workType).toBe("SYNTHETIC_CATALOGUE_CROWN (إعادة)");
    expect(JSON.stringify(external)).not.toContain("910009");
  });

  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])("refuses invalid order reference %s", (id) => {
    expect(() => toLabDispatchExternal(dispatchOrder({ id }))).toThrow("Invalid lab order reference");
  });
});
