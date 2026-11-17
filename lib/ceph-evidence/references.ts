/**
 * C0 — primary references for cephalometric definitions and norms (doctor request #483 6962861096 / 6963090096).
 * Only what was actually checked is recorded, with how it was checked. A citation that could not be opened stays
 * `citation-only`: it names the source, it does not prove a number. Commercial software descriptions are never
 * evidence (owner instruction). No patient data.
 */
export type ReferenceAccess =
  /** Full text read; numbers taken from it are marked with the table/page. */
  | "full-text"
  /** Only the indexed abstract was readable. */
  | "abstract"
  /** Bibliographic record confirmed (journal, volume, pages, DOI); content not read. */
  | "citation-only"
  /** Cited in the legacy code but not located as a primary source. */
  | "unlocated";

export interface PrimaryReference {
  readonly id: string;
  readonly citation: string;
  readonly doi: string | null;
  readonly pmid: string | null;
  readonly access: ReferenceAccess;
  /** What was verified and its limits, in one or two sentences. */
  readonly note: string;
}

export const CEPH_REFERENCES = [
  { id: "steiner-1953", citation: "Steiner CC. Cephalometrics for you and me. Am J Orthod 1953;39(10):729–755.",
    doi: "10.1016/0002-9416(53)90082-7", pmid: null, access: "citation-only",
    note: "Origin of the Steiner analysis (SN reference). Full text not opened; Steiner norms remain unverified here." },
  { id: "steiner-1959", citation: "Steiner CC. Cephalometrics in clinical practice. Angle Orthod 1959;29(1):8–29.",
    doi: null, pmid: null, access: "citation-only", note: "Bibliographic record located; content not read." },
  { id: "steiner-1960", citation: "Steiner CC. The use of cephalometrics as an aid to planning and assessing orthodontic treatment. Report of a case. Am J Orthod 1960;46(10):721–735.",
    doi: "10.1016/0002-9416(60)90145-7", pmid: null, access: "citation-only",
    note: "Single case report; not a normative sample. Content not read." },
  { id: "jacobson-1975", citation: "Jacobson A. The \"Wits\" appraisal of jaw disharmony. Am J Orthod 1975;67(2):125–138.",
    doi: null, pmid: null, access: "citation-only",
    note: "Defines AO/BO as perpendiculars from A and B to the occlusal plane. Sex-specific norms are reported in the literature; not read in the original here." },
  { id: "jacobson-1976", citation: "Jacobson A. Application of the \"Wits\" appraisal. Am J Orthod 1976;70(2):179–189.",
    doi: "10.1016/s0002-9416(76)90318-3", pmid: null, access: "citation-only",
    note: "A scanned excerpt (imperfect OCR) suggests male ≈ −1 mm and female ≈ 0 mm (±2). Not verified against the original — must not be used as a norm until read." },
  { id: "downs-1948", citation: "Downs WB. Variations in facial relationships: their significance in treatment and prognosis. Am J Orthod 1948;34(10):812–840.",
    doi: "10.1016/0002-9416(48)90015-3", pmid: null, access: "citation-only",
    note: "Young adults with excellent occlusion (per secondary descriptions). Downs norms not read in the original here." },
  { id: "tweed-1946", citation: "Tweed CH. The Frankfort-mandibular plane angle in orthodontic diagnosis, classification, treatment planning, and prognosis. Am J Orthod Oral Surg 1946;32:175–230.",
    doi: "10.1016/0096-6347(46)90001-4", pmid: null, access: "citation-only",
    note: "Secondary sources disagree on the FMA value (a 16–35° range vs 25°). Not read in the original." },
  { id: "tweed-1954", citation: "Tweed CH. The Frankfort-mandibular incisor angle (FMIA) in orthodontic diagnosis, treatment planning and prognosis. Angle Orthod 1954;24:121–169.",
    doi: null, pmid: null, access: "citation-only",
    note: "FMIA ≈ 65° is a treatment goal in secondary descriptions, not a population mean. Not read in the original." },
  { id: "mcnamara-1984", citation: "McNamara JA Jr. A method of cephalometric evaluation. Am J Orthod 1984;86(6):449–469.",
    doi: "10.1016/s0002-9416(84)90352-x", pmid: "6594933", access: "full-text",
    note: "Read (text layer of the author-hosted scan). Table I: Ann Arbor, 111 untreated adults, Class I, well-balanced faces; females 26y8m, males 30y9m. Norms include an 8% radiographic enlargement. Table II composite norms were formed by 'arbitrarily combining' Bolton, Burlington and Ann Arbor values (author's wording)." },
  { id: "ricketts-1957", citation: "Ricketts RM. Planning treatment on the basis of the facial pattern and an estimate of its growth. Angle Orthod 1957;27:14–37.",
    doi: "10.1043/0003-3219(1957)027<0014:PTOTBO>2.0.CO;2", pmid: null, access: "citation-only", note: "Content not read." },
  { id: "ricketts-1960", citation: "Ricketts RM. A foundation for cephalometric communication. Am J Orthod 1960;46(5):330–357.",
    doi: "10.1016/0002-9416(60)90047-6", pmid: null, access: "citation-only",
    note: "Distinct from 'Cephalometric synthesis' (Am J Orthod 1960;46:647–673). Content not read." },
  { id: "bjork-1969", citation: "Björk A. Prediction of mandibular growth rotation. Am J Orthod 1969;55:585–599.",
    doi: null, pmid: null, access: "abstract",
    note: "Abstract: a metric single-film method 'has so far not proved of value'; structural signs are discussed. The Björk sum is not presented there as a validated predictor." },
  { id: "kim-1974", citation: "Kim YH. Overbite depth indicator with particular reference to anterior open-bite. Am J Orthod 1974;65(6):586–611.",
    doi: "10.1016/0002-9416(74)90255-3", pmid: "4524490", access: "citation-only",
    note: "ODI origin. The index record has no abstract (Europe PMC, PMID 4524490); full text not readable here. Definition, sign rule and norm (74.5 ± 6.07; 119 children 7–14 y, Forsyth) are known only through peer-reviewed secondary studies (obamiyi-2019, caballero-2019, fatima-2016)." },
  { id: "kim-1978-apdi", citation: "Kim YH, Vietas JJ. Anteroposterior dysplasia indicator: an adjunct to cephalometric differential diagnosis. Am J Orthod 1978;73(6):619–633.",
    doi: "10.1016/0002-9416(78)90223-3", pmid: "276266", access: "abstract",
    note: "Abstract read (Europe PMC): 102 children with normal occlusion (Group 1) and 874 with malocclusion; APDI normal mean 81.4°, SD 3.79; reading = facial angle ± A-B plane angle ± palatal plane angle; highest correlation with molar displacement (0.643). Sign rules and age/sex detail not in the abstract." },
  { id: "kim-1979", citation: "Kim YH. A comparative cephalometric study of Class II, Division 1 nonextraction and extraction cases. Angle Orthod 1979;49(2):77–84.",
    doi: "10.1043/0003-3219(1979)049<0077:ACCSOC>2.0.CO;2", pmid: "286568", access: "abstract",
    note: "Abstract read (Europe PMC): ODI lower in extraction cases; APDI below the normal mean after treatment suggests relapse. No formula or norm in the abstract; full text blocked by the publisher site." },
  { id: "kim-1994-meaw", citation: "Kim YH, Caulfield Z, Chung WN, Chang YI. Overbite depth indicator, anteroposterior dysplasia indicator, combination factor and extraction index. Int J MEAW 1994;1 (pages disputed: 11–32 or 81–104).",
    doi: null, pmid: null, access: "citation-only",
    note: "Primary source for the Combination Factor and the Extraction Index. Pages 11–32 in obamiyi-2019, caballero-2019 and a Hiroshima University repository paper; 81–104 in an Athenaeum 2020 pilot study (owner search, #483 6964318159). The original is not located (journal holdings: Health Sciences University of Hokkaido library); not found in PubMed; content not read. CF and EI definitions and the page range remain unverified." },
  { id: "obamiyi-2019", citation: "Obamiyi S, et al. Overbite depth indicator and anteroposterior dysplasia indicator cephalometric norms for African Americans. Angle Orthod 2019;89(6):897–902 (PMC8109155).",
    doi: null, pmid: null, access: "full-text",
    note: "SECONDARY, peer-reviewed. States: mandibular plane Me–Go; palatal plane PNS–ANS; PP–FH subtracted when the palatal plane slopes upward anteriorly, added when downward (citing Kim 1974); APDI geometrically equals the A-B to palatal plane angle (citing Kim 1994); Kim norms ODI 74.5 ± 6.07, APDI 81.4 ± 3.79. Own sample: 160 African American children, ODI 70.9 ± 5.8, APDI 78.1 ± 4.2 (population dependence)." },
  { id: "caballero-2019", citation: "Caballero-Purizaga M, Arriola-Guillén LE, Watanabe-Kanno GA. Efficiency of ODI and APDI of Kim's cephalometric analysis in a Latin American population with skeletal open bite. Dental Press J Orthod 2019;24(3):46–54 (PMC6677332).",
    doi: null, pmid: null, access: "full-text",
    note: "SECONDARY, peer-reviewed. Same ODI sum and palatal sign rule (positive when inclined downwards and forward); FH through porion and orbitale; APDI as the palatal-plane to A-B plane angle. Its mandibular-plane wording does not name Go–Me." },
  { id: "fatima-2016", citation: "Fatima F, Fida M, Shaikh A. Reliability of ODI and APDI in the assessment of different vertical and sagittal dental malocclusions: a ROC analysis. Dental Press J Orthod 2016;21(5):75–81 (PMC5125174).",
    doi: null, pmid: null, access: "full-text",
    note: "SECONDARY, peer-reviewed. ODI = AB-MP + PP-FH; APDI = FH-NPg + PP-FH + AB-NPg (sign rules not stated in text). Diagnostic accuracy only; not a norm source." },
  { id: "jarabak-1972", citation: "Jarabak JR, Fizzell JA. Technique and treatment with light-wire edgewise appliances (1972), as cited.",
    doi: null, pmid: null, access: "unlocated", note: "Book; not located. Jarabak ratio and polygon norms unverified." },
  { id: "damstra-2010", citation: "Damstra J, et al. Reliability and the smallest detectable difference of measurements on 3-dimensional cone-beam CT images / digital cephalograms. Am J Orthod Dentofacial Orthop 2010.",
    doi: "10.1016/j.ajodo.2010.05.013", pmid: "21055590", access: "abstract",
    note: "Repeatability design reference only (handoff protocol). Not a norm." },
  { id: "grogger-2018", citation: "Grogger P, et al. Identification of 'Point A' as the prevalent source of error in cephalometric analysis of lateral radiographs. Int J Oral Maxillofac Surg 2018.",
    doi: "10.1016/j.ijom.2018.03.019", pmid: "29650356", access: "abstract",
    note: "Point A x-coordinate dominates error in SNA, ANB, Wits, APDI and ODI (abstract). Error source, not a norm." },
] as const satisfies readonly PrimaryReference[];

export type CephReferenceId = (typeof CEPH_REFERENCES)[number]["id"];
