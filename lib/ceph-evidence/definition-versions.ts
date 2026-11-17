/**
 * C1 — links each legacy measurement with a C0 definition defect to its versioned research replacement, and
 * states how a STORED legacy value must be read. Stored values are never relabelled or recomputed in place: a
 * new definition is a new, separately identified result next to the original.
 */
import { WITS_RESEARCH_DEFINITION } from "../ceph-core/wits-research";
import { SN_GOGN_RESEARCH_DEFINITION, SN_GOME_RESEARCH_DEFINITION } from "../ceph-core/mandibular-plane-research";
import {
  KIM_APDI_RESEARCH_DEFINITION, KIM_CF_RESEARCH_DEFINITION, KIM_EI_RESEARCH_DEFINITION, KIM_ODI_RESEARCH_DEFINITION,
  KIM_PP_FH_RESEARCH_DEFINITION,
} from "../ceph-core/kim-research";

export interface LegacyDefinitionVersion {
  /** Legacy measurement code in lib/ceph.ts (also a key of the C0 register). */
  readonly legacyCode: string;
  /** What the legacy formula actually computes — the honest reading of every stored value. */
  readonly storedValueMeansAr: string;
  readonly storedValueMeansEn: string;
  /** Always false: the stored number keeps its original code and meaning. */
  readonly relabelStoredValues: false;
  readonly researchDefinitions: readonly string[];
  /** C0 defects that the research definitions resolve, and what stays open. */
  readonly resolves: readonly string[];
  readonly stillOpen: readonly string[];
}

export const LEGACY_DEFINITION_VERSIONS: readonly LegacyDefinitionVersion[] = [
  {
    legacyCode: "SNGOGN",
    storedValueMeansAr: "زاوية SN مع مستوى الفك Go–Me (سُجّلت تاريخيًا باسم SN-GoGn)",
    storedValueMeansEn: "S–N to the Go–Me mandibular plane (historically labelled SN-GoGn)",
    relabelStoredValues: false,
    researchDefinitions: [SN_GOME_RESEARCH_DEFINITION, SN_GOGN_RESEARCH_DEFINITION],
    resolves: ["label/construction mismatch: Go–Me and Go–Gn are separate definitions", "gnathion type is explicit (anatomic or constructed)"],
    stillOpen: ["Steiner 1953 not read: which gnathion Steiner used and his norm remain unverified", "no norm is enabled", "observer repeatability not studied"],
  },
  {
    legacyCode: "WITS",
    storedValueMeansAr: "مسافة AO–BO باتجاه مأخوذ من محور x للشاشة؛ الصفر الحقيقي سُجّل فارغًا (NaN)",
    storedValueMeansEn: "AO–BO with direction taken from screen x; a true zero was stored as NaN",
    relabelStoredValues: false,
    researchDefinitions: [WITS_RESEARCH_DEFINITION],
    resolves: ["a true zero is 0, not NaN", "direction comes from the anatomical posterior→anterior plane, so mirroring keeps the sign"],
    stillOpen: ["clinical construction of the functional occlusal plane unvalidated", "sex-specific norms (Jacobson 1975/1976) not read in the original", "Point A x-error dominates (Grogger 2018)"],
  },  {
    legacyCode: "FH_AB",
    storedValueMeansAr: "الزاوية بين FH باتجاه الأمام والخط A→B — أي مكمّل الزاوية الخلفية السفلية المعتمدة عند Kim/Downs (≈ 180° − القيمة المرجعية)",
    storedValueMeansEn: "angle from the ANTERIOR FH ray to A→B — the supplement of the Kim/Downs posterior-inferior angle",
    relabelStoredValues: false,
    researchDefinitions: [KIM_APDI_RESEARCH_DEFINITION],
    resolves: ["the research APDI measures FH to A→B from the posterior FH ray (its fhToAbPlane component)"],
    stillOpen: ["Downs 1948 not read", "no norm is enabled"],
  },
  {
    legacyCode: "PP_FH",
    storedValueMeansAr: "زاوية المستوى الحنكي مع FH دون إشارة (دائمًا موجبة)",
    storedValueMeansEn: "palatal plane to FH, unsigned (always positive)",
    relabelStoredValues: false,
    researchDefinitions: [KIM_PP_FH_RESEARCH_DEFINITION],
    resolves: ["signed: + downward anteriorly, − upward anteriorly; sign independent of image orientation"],
    stillOpen: ["sign rule known from peer-reviewed secondary studies; Kim 1974 not read"],
  },
  {
    legacyCode: "APDI",
    storedValueMeansAr: "مكمّل زاوية FH–AB مضافًا إليه ميل الحنك دون إشارة (أو 3° عند غياب نقاطه) — ليس APDI كما عرّفه Kim وVietas؛ وعتبات التصنيف القديمة تعمل عليه معكوسة",
    storedValueMeansEn: "supplement of FH–AB plus an unsigned palatal tilt (or 3° when missing) — not Kim & Vietas APDI; legacy thresholds classify it in reverse",
    relabelStoredValues: false,
    researchDefinitions: [KIM_APDI_RESEARCH_DEFINITION],
    resolves: ["posterior FH convention (facial angle ± A-B plane angle)", "signed palatal tilt", "missing ANS/PNS refused, never substituted", "inputs declared for APDI alone (Po, Or, A, B, ANS, PNS)"],
    stillOpen: ["Kim & Vietas full text not read (only the abstract)", "norm 81.4 ± 3.79 from the abstract is not enabled: population and age (children) must be reviewed", "Point A x-error dominates (Grogger 2018)"],
  },
  {
    legacyCode: "ODI",
    storedValueMeansAr: "زاوية AB مع Go–Me مضافًا إليها ميل الحنك دون إشارة (أو 3° عند غياب نقاطه)",
    storedValueMeansEn: "A-B to Go–Me plus an unsigned palatal tilt (or 3° when missing)",
    relabelStoredValues: false,
    researchDefinitions: [KIM_ODI_RESEARCH_DEFINITION],
    resolves: ["signed palatal tilt", "missing landmarks refused, never substituted", "inputs declared for ODI alone"],
    stillOpen: ["Kim 1974 not read: definition from peer-reviewed secondary studies only", "mandibular plane Me–Go per obamiyi-2019; caballero-2019 does not name it", "no norm is enabled"],
  },
  {
    legacyCode: "CF",
    storedValueMeansAr: "مجموع ODI وAPDI القديمين، فيرث عيوبهما",
    storedValueMeansEn: "sum of the legacy ODI and APDI, inheriting their defects",
    relabelStoredValues: false,
    researchDefinitions: [KIM_CF_RESEARCH_DEFINITION],
    resolves: ["no value is presented as complete without a read source"],
    stillOpen: ["primary source Kim et al. 1994 (Int J MEAW 1:11–32) not readable: the research result is INCOMPLETE", "3° palatal tilt substituted when ANS/PNS/Or/Po are missing (flagged by C2)"],
  },
  {
    legacyCode: "EXT_INDEX",
    storedValueMeansAr: "CF القديم + (الزاوية الأنفية الشفوية − 95) × 0.5 — صيغة لا تطابق أي وصف وُجد في المصادر",
    storedValueMeansEn: "legacy CF + (nasolabial − 95) × 0.5 — matches no description found",
    relabelStoredValues: false,
    researchDefinitions: [KIM_EI_RESEARCH_DEFINITION],
    resolves: ["no value is presented as complete without a read source"],
    stillOpen: ["primary source Kim et al. 1994 not readable; secondary formulas (interincisal angle, lip position) conflict: the research result is INCOMPLETE", "3° palatal tilt substituted when ANS/PNS/Or/Po are missing (flagged by C2)"],
  },
];

const BY_CODE = new Map(LEGACY_DEFINITION_VERSIONS.map((version) => [version.legacyCode, version]));

/** One Arabic line for a legacy value whose definition differs from the sources — shown next to it, never instead. */
export function legacyDefinitionWarningAr(code: string): string | null {
  const version = BY_CODE.get(code);
  return version ? `تعريف الصيغة القديمة يخالف المصدر: ${version.storedValueMeansAr}.` : null;
}
