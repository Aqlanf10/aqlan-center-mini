/**
 * Kim indices as versioned RESEARCH definitions (owner directive #483 6963767937). Isolated: no production
 * callers, no stored-result change, no norms enabled, clinicalUseAllowed always false.
 *
 * Evidence (lib/ceph-evidence/references.ts):
 *  - APDI: Kim & Vietas 1978 abstract (primary): "facial angle ± A-B plane angle ± palatal plane angle"; normal
 *    mean 81.4°, SD 3.79, 102 children with normal occlusion. Geometric equivalent (obamiyi-2019, citing Kim 1994):
 *    the angle between the A-B plane and the palatal plane.
 *  - ODI: Kim 1974 original not readable here; three peer-reviewed secondary studies agree: A-B plane to
 *    mandibular plane (Me–Go) + palatal plane to FH, the palatal term ADDED when the palatal plane slopes downward
 *    anteriorly and SUBTRACTED when it slopes upward anteriorly.
 *  - CF and Extraction Index: the primary source (Kim et al. 1994, Int J MEAW) was not readable and secondary
 *    descriptions disagree on the Extraction Index, so both are returned as INCOMPLETE with the reason — never as
 *    a value.
 *
 * Every angle is computed in mm space (synthetic grid calibration) and is invariant to mirroring the image.
 * Missing landmarks are named, never substituted (the legacy 3° palatal substitution is not reproduced).
 */
import { angleBetweenRays, dot, GeometryError, unitVector, vector, type Point2D } from "./geometry";
import { syntheticGridScaler, type SyntheticGridCalibration } from "./mandibular-plane-research";

export const KIM_PP_FH_RESEARCH_DEFINITION = "kim-palatal-fh-signed/0.1.0-research" as const;
export const KIM_ODI_RESEARCH_DEFINITION = "kim-odi/0.1.0-research" as const;
export const KIM_APDI_RESEARCH_DEFINITION = "kim-apdi/0.1.0-research" as const;
export const KIM_CF_RESEARCH_DEFINITION = "kim-combination-factor/0.1.0-research" as const;
export const KIM_EI_RESEARCH_DEFINITION = "kim-extraction-index/0.1.0-research" as const;

export type KimDefinitionId = typeof KIM_PP_FH_RESEARCH_DEFINITION | typeof KIM_ODI_RESEARCH_DEFINITION
  | typeof KIM_APDI_RESEARCH_DEFINITION | typeof KIM_CF_RESEARCH_DEFINITION | typeof KIM_EI_RESEARCH_DEFINITION;

/** How strong the definition's source is — carried on every result. */
export type KimDefinitionEvidence =
  | "primary-abstract-and-peer-reviewed-secondary"
  | "peer-reviewed-secondary-only"
  | "primary-source-not-read";

export type KimLandmark = "Po" | "Or" | "ANS" | "PNS" | "A" | "B" | "Go" | "Me";

export interface KimResearchInput {
  readonly landmarks: Partial<Record<KimLandmark, Point2D>>;
  readonly calibration: SyntheticGridCalibration;
}

export type KimIssue =
  | "unsupported-research-basis" | "missing-landmark" | "orientation-inconsistent"
  | "primary-source-not-read" | "definition-conflicts-across-secondary-sources" | "component-not-computable"
  | GeometryError["code"];

export interface KimResult {
  readonly definitionId: KimDefinitionId;
  readonly evidence: KimDefinitionEvidence;
  readonly unit: "deg";
  readonly clinicalUseAllowed: false;
  readonly normsStatus: "not-enabled";
  /** `incomplete`: the definition itself cannot be completed from a read source; no value is given. */
  readonly status: "ok" | "not-computable" | "incomplete";
  readonly value: number | null;
  readonly issue: KimIssue | null;
  readonly missing?: readonly KimLandmark[];
  /** For ODI/APDI: the parts, so a reviewer can check the sum. */
  readonly components?: Readonly<Record<string, number>>;
}

const EVIDENCE: Readonly<Record<KimDefinitionId, KimDefinitionEvidence>> = {
  [KIM_PP_FH_RESEARCH_DEFINITION]: "peer-reviewed-secondary-only",
  [KIM_ODI_RESEARCH_DEFINITION]: "peer-reviewed-secondary-only",
  [KIM_APDI_RESEARCH_DEFINITION]: "primary-abstract-and-peer-reviewed-secondary",
  [KIM_CF_RESEARCH_DEFINITION]: "primary-source-not-read",
  [KIM_EI_RESEARCH_DEFINITION]: "primary-source-not-read",
};

/** Landmarks each research definition needs — declared per index, not assumed shared. */
export const KIM_REQUIRED_LANDMARKS: Readonly<Record<typeof KIM_PP_FH_RESEARCH_DEFINITION | typeof KIM_ODI_RESEARCH_DEFINITION | typeof KIM_APDI_RESEARCH_DEFINITION, readonly KimLandmark[]>> = {
  [KIM_PP_FH_RESEARCH_DEFINITION]: ["Po", "Or", "ANS", "PNS"],
  [KIM_ODI_RESEARCH_DEFINITION]: ["A", "B", "Go", "Me", "Po", "Or", "ANS", "PNS"],
  [KIM_APDI_RESEARCH_DEFINITION]: ["Po", "Or", "A", "B", "ANS", "PNS"],
};

const meta = (definitionId: KimDefinitionId) => ({
  definitionId, evidence: EVIDENCE[definitionId], unit: "deg" as const, clinicalUseAllowed: false as const, normsStatus: "not-enabled" as const,
});
const refuse = (id: KimDefinitionId, issue: KimIssue, extra: Partial<KimResult> = {}): KimResult =>
  ({ ...meta(id), status: "not-computable", value: null, issue, ...extra });

type Scaled = Record<KimLandmark, Point2D>;

function prepare(id: keyof typeof KIM_REQUIRED_LANDMARKS, input: KimResearchInput): KimResult | Scaled {
  if (!input || input.calibration?.basis !== "synthetic-grid") return refuse(id, "unsupported-research-basis");
  const missing = KIM_REQUIRED_LANDMARKS[id].filter((code) => !input.landmarks?.[code]);
  if (missing.length) return refuse(id, "missing-landmark", { missing });
  const at = syntheticGridScaler(input.calibration);
  const out = {} as Scaled;
  for (const code of KIM_REQUIRED_LANDMARKS[id]) out[code] = at(input.landmarks[code]!);
  return out;
}

/**
 * Palatal plane to FH, SIGNED: positive when the palatal plane slopes DOWNWARD anteriorly (ANS lower than PNS
 * relative to FH), negative when upward. "Downward" is the side of FH on which the palate lies, so the sign does
 * not depend on image orientation. Refuses if PNS→ANS does not point anteriorly along Po→Or.
 */
function palatalTilt(p: Pick<Scaled, "Po" | "Or" | "ANS" | "PNS">): number | "orientation-inconsistent" {
  const fh = unitVector(vector(p.Po, p.Or));
  const pp = vector(p.PNS, p.ANS);
  if (dot(pp, fh) <= 0) return "orientation-inconsistent";
  const normal = { x: -fh.y, y: fh.x };
  const mid = { x: (p.ANS.x + p.PNS.x) / 2, y: (p.ANS.y + p.PNS.y) / 2 };
  const side = dot(vector(p.Po, mid), normal);
  if (side === 0) return "orientation-inconsistent";
  const inferior = side > 0 ? normal : { x: -normal.x, y: -normal.y };
  const magnitude = angleBetweenRays(fh, pp);
  const along = dot(pp, inferior);
  return along === 0 ? 0 : along > 0 ? magnitude : -magnitude;
}

function guarded(id: KimDefinitionId, run: () => KimResult): KimResult {
  try { return run(); } catch (error) {
    if (!(error instanceof GeometryError)) throw error;
    return refuse(id, error.code);
  }
}

export function evaluateKimPalatalTilt(input: KimResearchInput): KimResult {
  const id = KIM_PP_FH_RESEARCH_DEFINITION;
  return guarded(id, () => {
    const p = prepare(id, input);
    if ("status" in p) return p as KimResult;
    const tilt = palatalTilt(p);
    if (tilt === "orientation-inconsistent") return refuse(id, tilt);
    return { ...meta(id), status: "ok", value: tilt, issue: null };
  });
}

/** ODI = angle between the rays A→B and Go→Me (A-B plane to Me–Go mandibular plane) + signed palatal tilt. */
export function evaluateKimOdi(input: KimResearchInput): KimResult {
  const id = KIM_ODI_RESEARCH_DEFINITION;
  return guarded(id, () => {
    const p = prepare(id, input);
    if ("status" in p) return p as KimResult;
    const fh = vector(p.Po, p.Or);
    if (dot(vector(p.Go, p.Me), fh) <= 0) return refuse(id, "orientation-inconsistent");
    const tilt = palatalTilt(p);
    if (tilt === "orientation-inconsistent") return refuse(id, tilt);
    const abMp = angleBetweenRays(vector(p.A, p.B), vector(p.Go, p.Me));
    return { ...meta(id), status: "ok", value: abMp + tilt, issue: null, components: { abToMandibularPlane: abMp, palatalTilt: tilt } };
  });
}

/**
 * APDI = FH to A-B plane, measured as the angle between the POSTERIOR FH ray (Or→Po) and the ray A→B (this is the
 * facial angle plus the signed A-B plane angle of Kim & Vietas), + signed palatal tilt. Geometrically equal to the
 * angle between the posterior palatal ray (ANS→PNS) and A→B. Larger = more mesial (Class III) relationship.
 */
export function evaluateKimApdi(input: KimResearchInput): KimResult {
  const id = KIM_APDI_RESEARCH_DEFINITION;
  return guarded(id, () => {
    const p = prepare(id, input);
    if ("status" in p) return p as KimResult;
    const tilt = palatalTilt(p);
    if (tilt === "orientation-inconsistent") return refuse(id, tilt);
    const fhAb = angleBetweenRays(vector(p.Or, p.Po), vector(p.A, p.B));
    return { ...meta(id), status: "ok", value: fhAb + tilt, issue: null, components: { fhToAbPlane: fhAb, palatalTilt: tilt } };
  });
}

/** CF: secondary sources describe ODI + APDI, but the primary (Kim 1994) was not read → incomplete, no value. */
export function evaluateKimCombinationFactor(input: KimResearchInput): KimResult {
  const odi = evaluateKimOdi(input), apdi = evaluateKimApdi(input);
  const missing = [...new Set([...(odi.missing ?? []), ...(apdi.missing ?? [])])];
  return { ...meta(KIM_CF_RESEARCH_DEFINITION), status: "incomplete", value: null, issue: "primary-source-not-read", ...(missing.length ? { missing } : {}) };
}

/** Extraction Index: primary not read and secondary formulas conflict → incomplete, no value, whatever the inputs. */
export function evaluateKimExtractionIndex(_input: KimResearchInput): KimResult {
  return { ...meta(KIM_EI_RESEARCH_DEFINITION), status: "incomplete", value: null, issue: "definition-conflicts-across-secondary-sources" };
}
