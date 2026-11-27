export const ORTHO_AUXILIARY_LABEL = {
  hyrax_marpe: "Hyrax / MARPE",
  nance_button: "Nance Button",
  tpa: "TPA",
  tad: "TAD / Mini-screw",
  closed_coil_niti: "Closed Coil NiTi",
  open_coil: "Open Coil",
  power_chain: "Power Chain",
  laceback_bendback: "Laceback / Bendback",
  bite_turbo: "Bite Turbo",
  carriere_motion: "Carriere Motion",
  herbst: "Herbst",
  forsus: "Forsus",
  twin_block: "Twin Block",
  lip_bumper: "Lip Bumper",
  lingual_holding_arch: "Lingual Holding Arch",
  quad_helix: "Quad Helix",
  other: "آخر",
} as const;
export type OrthoAuxiliary = keyof typeof ORTHO_AUXILIARY_LABEL;
export const ORTHO_AUXILIARY_KEYS = Object.keys(ORTHO_AUXILIARY_LABEL) as OrthoAuxiliary[];
export const AUXILIARY_OTHER_LIMIT = 80;

export interface AuxiliaryRecord {
  auxiliaries: OrthoAuxiliary[] | null;
  auxiliaryOther: string | null;
}
export type AuxiliaryParse = { ok: true; value: AuxiliaryRecord } | { ok: false; message: string };

const isKey = (value: unknown): value is OrthoAuxiliary =>
  typeof value === "string" && Object.hasOwn(ORTHO_AUXILIARY_LABEL, value);

export const AUXILIARY_LIST_ERROR = "قائمة الأجهزة المساعدة غير صالحة؛ لم تُسجّل جلسة جديدة.";
export const AUXILIARY_OTHER_REQUIRED = "اكتب اسم الجهاز المساعد الآخر أو ألغِ اختيار «آخر»؛ لم تُسجّل جلسة جديدة.";
export const AUXILIARY_OTHER_WITHOUT_CHOICE = "اسم الجهاز الآخر يُرسل فقط مع اختيار «آخر»؛ لم تُسجّل جلسة جديدة.";
export const AUXILIARY_OTHER_TOO_LONG = `اسم الجهاز المساعد الآخر يتجاوز ${AUXILIARY_OTHER_LIMIT} حرفًا؛ اختصره قبل الحفظ. لم يُحذف نصك.`;

export function parseAuxiliariesInput(source: Record<string, unknown>): AuxiliaryParse {
  const list = Object.hasOwn(source, "auxiliaries") ? source.auxiliaries : null;
  const other = Object.hasOwn(source, "auxiliaryOther") ? source.auxiliaryOther : null;
  if (list === null) {
    return other === null
      ? { ok: true, value: { auxiliaries: null, auxiliaryOther: null } }
      : { ok: false, message: AUXILIARY_OTHER_WITHOUT_CHOICE };
  }
  if (!Array.isArray(list) || list.length > ORTHO_AUXILIARY_KEYS.length || !list.every(isKey) || new Set(list).size !== list.length) {
    return { ok: false, message: AUXILIARY_LIST_ERROR };
  }
  const chosen = new Set<OrthoAuxiliary>(list);
  const ordered = ORTHO_AUXILIARY_KEYS.filter((key) => chosen.has(key));
  if (!chosen.has("other")) {
    return other === null
      ? { ok: true, value: { auxiliaries: ordered, auxiliaryOther: null } }
      : { ok: false, message: AUXILIARY_OTHER_WITHOUT_CHOICE };
  }
  if (typeof other !== "string" || !other.trim()) return { ok: false, message: AUXILIARY_OTHER_REQUIRED };
  if (other.trim().length > AUXILIARY_OTHER_LIMIT) return { ok: false, message: AUXILIARY_OTHER_TOO_LONG };
  return { ok: true, value: { auxiliaries: ordered, auxiliaryOther: other.trim() } };
}

export function auxiliariesText(auxiliaries: readonly string[] | null | undefined, other: string | null | undefined): string {
  if (auxiliaries == null) return "غير مسجّلة في هذه الجلسة";
  if (auxiliaries.length === 0) return "لا أجهزة مساعدة (سُجّل صراحةً)";
  return auxiliaries
    .map((key) => (key === "other" ? `آخر: ${other?.trim() || "—"}` : isKey(key) ? ORTHO_AUXILIARY_LABEL[key] : key))
    .join("، ");
}
