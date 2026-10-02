/** Synthetic success responses for the ceph executable's lifecycle tests.
 * No product runtime, schema bootstrap, database driver, or computation loads.
 * The executable still evaluates each of its actual clinical assertions. */
export function successfulCephJourney(onPoolEnd: () => Promise<void>) {
  const known = [
    ["SNA", 82], ["SNB", 80], ["ANB", 2], ["SND", 79.5], ["WITS", -1.3],
    ["FMA", 25], ["IMPA", 86.6], ["U1SN", 104], ["U1NA_A", 22],
    ["L1NB_A", 25], ["L1NB_D", -13.7], ["MAX_LEN", 113.4], ["MM_DIFF", 7.6],
    ["LAFH", 56.1], ["A_NPERP", -1.4], ["CONV_ANGLE", 4.4], ["AB_PLANE", -4.6],
    ["L1OP", 18.1],
  ] as const;
  const pending: Record<string, string[]> = {
    SADDLE: ["Ar"], ARTICULAR: ["Ar"], GONIAL: ["Ar"], BJORK_SUM: ["Ar"],
    E_LINE_UL: ["Prn", "PogS", "Ls"], E_LINE_LL: ["Prn", "PogS", "Li"],
    NASOLABIAL: ["Prn", "Sn", "Ls"],
  };
  const stamped = known.map(([code, value]) => ({ code, value }));
  const computed = [...stamped, ...Object.keys(pending).map((code) => ({ code, value: null }))];
  const landmarks = [
    "S", "N", "A", "B", "Pog", "Me", "Gn", "Go", "Or", "Po", "U1A",
    "U1", "L1A", "L1", "OcclA", "OcclP", "D", "Co", "ANS", "PNS",
  ].map((code) => ({ code, x: 0, y: 0 }));
  let patientId = 0;
  let createCount = 0;
  let completeCount = 0;
  let calibrationCount = 0;
  let landmarkCount = 0;
  let diagnosisCount = 0;
  let discardCount = 0;
  const pool = {
    end: onPoolEnd,
    async query(sql: string) {
      if (/INSERT INTO patient_documents/.test(sql)) return { rows: [{ id: 1 }] };
      if (/SELECT action, actor FROM audit_log/.test(sql)) {
        return { rows: ["create", "update", "complete", "discard"].map((action) => ({
          action: `ceph.${action}`, actor: "د. عقلان",
        })) };
      }
      throw new Error("UNEXPECTED_MOCK_RUNTIME_QUERY");
    },
  };
  return {
    ceph: {
      MEASUREMENTS: computed,
      computeMmPerPixel: () => 1,
      computeAll: () => computed,
      missingFor: (code: string) => pending[code] ?? [],
    },
    db: {
      ensureSchema: async () => {},
      createPatient: async () => ({ id: ++patientId }),
      getPool: () => pool,
      createCephAnalysis: async () => ({ ok: ++createCount === 1, id: 10 }),
      getCephStudy: async () => ({
        analysis: { phase: "during", xrayDate: "2026-08-20", device: "جهاز الفحص" },
        landmarks,
        diagnosis: { finalDx: "علاقة هيكلية صنف أول", createdBy: "د. عقلان" },
      }),
      listCephReferenceSets: async () => [{
        key: "builtin_default", values: Object.fromEntries(computed.map((row) => [row.code, row.value])),
      }],
      completeCephAnalysis: async () => ({
        ok: ++completeCount === 3, message: "معالم ناقصة", measurements: stamped,
      }),
      updateCephCalibration: async () => ({ ok: ++calibrationCount === 1 }),
      updateCephLandmarks: async () => ({ ok: ++landmarkCount === 1 }),
      updateCephDiagnosis: async () => ({ ok: ++diagnosisCount === 1 }),
      getCephStampedValues: async () => stamped,
      duplicateCephAnalysis: async () => ({ ok: true, id: 11 }),
      discardCephAnalysis: async () => ({ ok: ++discardCount === 1 }),
    },
  };
}
