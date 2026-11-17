/**
 * C1 — links each legacy measurement with a C0 definition defect to its versioned research replacement, and
 * states how a STORED legacy value must be read. Stored values are never relabelled or recomputed in place: a
 * new definition is a new, separately identified result next to the original.
 */
import { WITS_RESEARCH_DEFINITION } from "../ceph-core/wits-research";
import { SN_GOGN_RESEARCH_DEFINITION, SN_GOME_RESEARCH_DEFINITION } from "../ceph-core/mandibular-plane-research";

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
  },
];
