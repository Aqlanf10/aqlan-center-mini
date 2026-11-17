/**
 * C0 — evidence register for every legacy cephalometric measurement in lib/ceph.ts (49 codes).
 * Record only. It changes no calculation, stored result, report or screen. Each entry states which primary source
 * the legacy definition cites, whether the definition matches that source as far as it was checked, and whether
 * the legacy default norm (mean ± tol) is verified, contradicted, or simply unverified.
 *
 * Rules (doctor #483 6963090096, handoff docs da84506f): no number is imported from an unread source; a norm is
 * usable only with its population, sex/age stratum, enlargement convention and the table it came from.
 */
import type { CephReferenceId } from "./references";

export type DefinitionStatus =
  /** The legacy formula matches the source's definition as far as the source was read. */
  | "matches-source"
  /** The legacy formula or its label contradicts the cited source. */
  | "conflicts-source"
  /** The source was not read; the definition is the common textbook form and remains unverified. */
  | "unverified";

export type NormStatus =
  /** The legacy default contradicts a read primary source (value, spread, population or units). */
  | "conflicts-source"
  /** No primary source was read for the number. It must not be shown as a norm. */
  | "unverified"
  /** Not a population norm in the source (a treatment goal, a single case, or a size-matched relation). */
  | "not-a-population-norm";

/** A norm copied from a read primary source, with everything needed to use it honestly. */
export interface VerifiedNorm {
  readonly reference: CephReferenceId;
  readonly table: string;
  readonly population: string;
  readonly stratum: string;
  readonly mean: number;
  readonly sd: number | null;
  readonly unit: "mm" | "deg";
  /** True when the published values include radiographic enlargement (McNamara: 8%). */
  readonly includesEnlargement: boolean;
  /** Text-layer extraction of a scan: check against the page image before clinical use. */
  readonly extraction: "ocr-text-layer";
}

export interface MeasurementEvidence {
  readonly code: string;
  readonly references: readonly CephReferenceId[];
  readonly definition: DefinitionStatus;
  readonly norm: NormStatus;
  readonly findings: readonly string[];
  readonly verifiedNorms?: readonly VerifiedNorm[];
}

const AA = "Ann Arbor: 111 untreated adults, Class I, well-balanced faces (McNamara 1984, Table I)";
const mc = (stratum: string, mean: number, sd: number, unit: "mm" | "deg"): VerifiedNorm =>
  ({ reference: "mcnamara-1984", table: "Table I", population: AA, stratum, mean, sd, unit, includesEnlargement: true, extraction: "ocr-text-layer" });

const STEINER_UNREAD = "Steiner 1953 not read here: the legacy default is the commonly quoted value, unverified.";
const DOWNS_UNREAD = "Downs 1948 not read here: legacy default unverified.";
const KIM_UNREAD = "Kim's original not read here: legacy default unverified.";
const JARABAK_UNREAD = "Jarabak/Björk source not located or not read: legacy default unverified.";
const unread = (code: string, references: readonly CephReferenceId[], note: string, extra: readonly string[] = []): MeasurementEvidence =>
  ({ code, references, definition: "unverified", norm: "unverified", findings: [note, ...extra] });

export const MEASUREMENT_EVIDENCE: readonly MeasurementEvidence[] = [
  unread("SNA", ["steiner-1953"], STEINER_UNREAD, ["Point A x-error is the dominant error source for SNA (Grogger 2018, abstract)."]),
  unread("SNB", ["steiner-1953"], STEINER_UNREAD),
  unread("ANB", ["steiner-1953"], STEINER_UNREAD, ["Inherits Point A x-error (Grogger 2018, abstract)."]),
  unread("SND", ["steiner-1953"], STEINER_UNREAD, ["Point D (symphysis centre) is not part of most later analyses; its construction needs the original text."]),
  { code: "WITS", references: ["jacobson-1975", "jacobson-1976"], definition: "conflicts-source", norm: "unverified",
    findings: [
      "Jacobson: perpendiculars from A and B to the occlusal plane (AO, BO). Legacy keeps this construction, but:",
      "Defect — a true zero (AO = BO) returns NaN instead of 0 (lib/ceph.ts WITS branch: `len === 0`).",
      "Defect — 'forward' is chosen from screen x (`dir.x < 0` flips), so a mirrored image can reverse the sign.",
      "Legacy default −1 ± 1 is single-sex; the reported originals are sex-specific (≈ −1 mm men, ≈ 0 mm women, ±2) — not yet read in the original.",
      "Legacy classification thresholds (> 1 Class II, < −3 Class III) cite no source.",
      "Which occlusal plane (functional vs bisecting) changes the value; the legacy landmarks OcclA/OcclP do not say which.",
      "Point A x-error dominates (Grogger 2018, abstract).",
    ] },
  unread("CONV", ["downs-1948"], DOWNS_UNREAD),
  unread("CONV_ANGLE", ["downs-1948"], DOWNS_UNREAD),
  unread("AB_PLANE", ["downs-1948"], DOWNS_UNREAD),
  unread("FH_AB", ["downs-1948", "kim-1978-apdi"], "Cited to both Downs and Kim; neither read here. Legacy default unverified."),
  unread("APDI", ["kim-1978-apdi"], KIM_UNREAD, ["APDI full citation not confirmed.", "Point A x-error dominates (Grogger 2018, abstract).", "Legacy substitutes a fixed 3° palatal-plane tilt when PP_FH cannot be measured (missing ANS/PNS/Or/Po); C2 flags such values as not fully measured."]),
  unread("FANGLE", ["downs-1948"], DOWNS_UNREAD),
  { code: "MAX_LEN", references: ["mcnamara-1984"], definition: "matches-source", norm: "conflicts-source",
    findings: ["McNamara: effective midfacial length, condylion (most posterosuperior point of the condyle) to Point A.",
      "Legacy uses one fixed default (94 ± 5) for everyone; McNamara reports it by sex and uses it to set the expected mandibular length, not as a stand-alone norm.",
      "Published values include 8% enlargement; a calibrated true-size measurement must not be compared to them unadjusted."],
    verifiedNorms: [mc("adult females (mean age 26y8m)", 91.0, 4.3, "mm"), mc("adult males (mean age 30y9m)", 99.8, 6.0, "mm")] },
  { code: "MAND_LEN", references: ["mcnamara-1984"], definition: "matches-source", norm: "conflicts-source",
    findings: ["McNamara: effective mandibular length, condylion to ANATOMIC gnathion (most anteroinferior point of the symphysis).",
      "Not the constructed gnathion used for the facial axis — two different points share the name.",
      "Legacy single default (122 ± 5) ignores sex and the size relation to midfacial length; values include 8% enlargement."],
    verifiedNorms: [mc("adult females", 120.2, 5.3, "mm"), mc("adult males", 134.3, 6.8, "mm")] },
  { code: "MM_DIFF", references: ["mcnamara-1984"], definition: "matches-source", norm: "conflicts-source",
    findings: ["McNamara step 17: ideal differential by midface size — small 20 mm, medium 25–27 mm, large 30–33 mm.",
      "Legacy single default (28 ± 4) is not size-stratified."],
    verifiedNorms: [mc("adult females", 29.2, 3.3, "mm"), mc("adult males", 34.5, 4.0, "mm")] },
  { code: "A_NPERP", references: ["mcnamara-1984"], definition: "matches-source", norm: "conflicts-source",
    findings: ["McNamara: nasion perpendicular to Frankfort horizontal built from ANATOMIC porion and orbitale (machine porion can be ~1 cm off).",
      "Table II composite: 0 mm in mixed dentition, 1 mm in adults. Legacy 0.5 ± 0.5 matches neither and its spread is ~4× narrower than Table I."],
    verifiedNorms: [mc("adult females", 0.4, 2.3, "mm"), mc("adult males", 1.1, 2.1, "mm")] },
  { code: "POG_NPERP", references: ["mcnamara-1984"], definition: "matches-source", norm: "conflicts-source",
    findings: ["Table II composite is age- and sex-specific: mixed dentition −8 to −6 mm; adult female −4 to 0; adult male −2 to +4 (as extracted; verify on the page image).",
      "Legacy single default −2 ± 2 is neither."],
    verifiedNorms: [mc("adult females", -1.8, 4.5, "mm"), mc("adult males", -0.3, 3.8, "mm")] },
  { code: "FMA", references: ["tweed-1946", "mcnamara-1984"], definition: "unverified", norm: "conflicts-source",
    findings: ["Tweed 1946 not read; secondary sources disagree (16–35° range vs 25°).",
      "McNamara's mandibular plane angle (FH to gonion–menton) is lower in adults than the legacy 25°: Table II gives 25° (mixed dentition) decreasing to 22° (adult)."],
    verifiedNorms: [mc("adult females", 22.7, 4.3, "deg"), mc("adult males", 21.3, 3.9, "deg")] },
  { code: "SNGOGN", references: ["steiner-1953"], definition: "conflicts-source", norm: "unverified",
    findings: ["Labelled SN-GoGn (Steiner) but computed on Go–Me: the formula requires Menton, not Gnathion.",
      "Stored values must keep their meaning: a new definition needs separate SN-GoGn and SN-GoMe identifiers; old results are never relabelled.",
      STEINER_UNREAD] },
  unread("JARABAK", ["jarabak-1972"], JARABAK_UNREAD),
  unread("SADDLE", ["jarabak-1972", "bjork-1969"], JARABAK_UNREAD),
  unread("ARTICULAR", ["jarabak-1972", "bjork-1969"], JARABAK_UNREAD),
  unread("GONIAL", ["jarabak-1972", "bjork-1969"], JARABAK_UNREAD),
  { code: "BJORK_SUM", references: ["bjork-1969"], definition: "unverified", norm: "unverified",
    findings: [JARABAK_UNREAD, "Björk 1969 abstract: a metric single-film prediction 'has so far not proved of value'. The sum must not be presented as a growth predictor."] },
  unread("AB_MAND", ["kim-1974"], KIM_UNREAD),
  unread("PP_FH", ["kim-1978-apdi"], KIM_UNREAD),
  unread("ODI", ["kim-1974"], KIM_UNREAD, ["Point A x-error dominates (Grogger 2018, abstract).", "Legacy substitutes a fixed 3° palatal-plane tilt when PP_FH cannot be measured (missing ANS/PNS/Or/Po); C2 flags such values as not fully measured."]),
  unread("CF", ["kim-1974", "kim-1978-apdi"], KIM_UNREAD, ["Legacy substitutes a fixed 3° palatal-plane tilt when PP_FH cannot be measured (missing ANS/PNS/Or/Po); C2 flags such values as not fully measured."]),
  unread("SN_OCCL", ["steiner-1953"], STEINER_UNREAD, ["Depends on which occlusal plane is traced (functional vs bisecting)."]),
  unread("OCCL_FH", ["downs-1948"], DOWNS_UNREAD, ["Depends on which occlusal plane is traced."]),
  unread("YAXIS", ["steiner-1953"], STEINER_UNREAD),
  unread("YAXIS_FH", ["downs-1948"], DOWNS_UNREAD),
  { code: "LAFH", references: ["mcnamara-1984"], definition: "conflicts-source", norm: "conflicts-source",
    findings: ["Legacy computes a percentage ratio (ANS–Me ÷ N–Me, default 55 %) and credits McNamara.",
      "McNamara measures lower anterior face height as the distance ANS–Me in mm, judged against effective midfacial length (step 18: small 60–62, medium 65–67, large 70–73 mm).",
      "The ratio needs its own source before it is shown with any norm."],
    verifiedNorms: [mc("adult females (ANS–Me, mm)", 66.7, 4.1, "mm")] },
  { code: "OVERJET", references: [], definition: "unverified", norm: "unverified",
    findings: ["Legacy cites 'Standard / WebCeph' only. Commercial descriptions are not evidence; needs a primary source and an explicit plane."] },
  { code: "OVERBITE", references: [], definition: "unverified", norm: "unverified",
    findings: ["Legacy cites 'Standard / WebCeph' only. Needs a primary source."] },
  unread("IMPA", ["tweed-1946"], "Tweed not read here: legacy default unverified."),
  { code: "FMIA", references: ["tweed-1954"], definition: "unverified", norm: "not-a-population-norm",
    findings: ["In secondary descriptions 65° is Tweed's treatment GOAL, not a population mean. Must not be shown as a 'normal' value."] },
  unread("U1SN", ["steiner-1953"], STEINER_UNREAD),
  unread("U1NA_A", ["steiner-1953"], STEINER_UNREAD),
  unread("U1NA_D", ["steiner-1953"], STEINER_UNREAD, ["Research core marks the matching measurement 'figure-review-pending'."]),
  unread("L1NB_A", ["steiner-1953"], STEINER_UNREAD),
  unread("L1NB_D", ["steiner-1953"], STEINER_UNREAD, ["Research core marks the matching measurement 'figure-review-pending'."]),
  unread("POG_NB_D", ["steiner-1953"], STEINER_UNREAD),
  unread("INTER", ["steiner-1953", "downs-1948"], STEINER_UNREAD, ["Research core marks interincisal 'figure-review-pending'."]),
  unread("L1OP", ["downs-1948"], DOWNS_UNREAD),
  unread("U1_APOG", ["ricketts-1960"], "Ricketts not read here: legacy default unverified."),
  unread("EXT_INDEX", ["kim-1978-apdi"], KIM_UNREAD, ["Legacy substitutes a fixed 3° palatal-plane tilt when PP_FH cannot be measured (missing ANS/PNS/Or/Po); C2 flags such values as not fully measured.", "Legacy also treats a missing nasolabial angle as a zero adjustment; C2 flags it."]),
  unread("E_LINE_UL", ["ricketts-1957", "ricketts-1960"], "Ricketts not read here: legacy default unverified."),
  unread("E_LINE_LL", ["ricketts-1957", "ricketts-1960"], "Ricketts not read here: legacy default unverified."),
  { code: "NASOLABIAL", references: [], definition: "unverified", norm: "unverified",
    findings: ["Legacy cites 'Holdaway / McNamara / WebCeph'. McNamara 1984 discusses the nasolabial angle qualitatively in the soft-tissue assessment; no primary numeric norm was verified here."] },
];
