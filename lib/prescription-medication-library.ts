/** Review-only reference cards. No RxItem or executable dose is exported here.
 * Approval must be a separately reviewed change, never a UI checkbox. */
export interface MedicationReference {
  id: string;
  genericName: string;
  arabicName: string;
  reviewStatus: "pending-owner-review";
  version: string;
  units: string;
  adult: string;
  child: string;
  instructions: string;
  sources: readonly { title: string; url: string; version: string }[];
}
const aapd = { title: "AAPD — Useful Medications", url: "https://www.aapd.org/globalassets/media/policies_guidelines/r_usefulmeds25.pdf", version: "2025–2026، ص 669–670" };
const sdcep = (slug: string) => `https://sdcepdentalprescribing.nhs.scot/guidance/odontogenic-pain/analgesics/${slug}/`;
export const MEDICATION_REFERENCES: readonly MedicationReference[] = [
  {
    id: "paracetamol", genericName: "Paracetamol (Acetaminophen)", arabicName: "باراسيتامول",
    reviewStatus: "pending-owner-review", version: "review-2026-10-30", units: "mg/kg/dose; mg/24h",
    adult: "مرجع SDCEP: أقراص 500 mg؛ مثال 1000 mg أربع مرات يوميًا لمدة 5 أيام، سقف 4000 mg/24h. معلومة مرجعية وليست جرعة افتراضية؛ يختار الطبيب الجرعة والمدة الملائمتين.",
    child: "AAPD، أقل من 12 سنة: 10–15 mg/kg لكل جرعة، كل 4–6 ساعات عند الحاجة. السقف 75 mg/kg/24h وبحد أقصى 4000 mg/24h. يختار الطبيب المقدار والفاصل وعدد الجرعات؛ 15 mg/kg كل 4 ساعات يتجاوز السقف اليومي. يلزم حد عمر أدنى ونشرة منتج مؤكدة وعمر ووزن حديث وتركيز mg/mL صريح؛ هذا النطاق لا يفعّل حديثي الولادة أو الرضع تلقائيًا، وخارجه مراجعة يدوية.",
    instructions: "راجع مرض الكبد وجميع الأدوية المحتوية على نفس المادة؛ لا تجمعها دون احتساب مجموع الجرعة. الشكل والتركيز من العبوة. المدة والتعليمات النهائية يحددهما الطبيب.",
    sources: [aapd, { title: "SDCEP — Paracetamol", url: sdcep("paracetamol"), version: "صفحة حية، تحقق 2026-10-30" }],
  },
  {
    id: "ibuprofen", genericName: "Ibuprofen", arabicName: "إيبوبروفين",
    reviewStatus: "pending-owner-review", version: "review-2026-10-30", units: "mg/dose; mg/kg/day",
    adult: "SDCEP: أقراص 400 mg أربع مرات يوميًا، ويفضل بعد الطعام؛ مثال لمدة 5 أيام. لا اختيار تلقائي للجرعة أو المدة.",
    child: "SDCEP فقط؛ مرجع غير مفعّل للحساب: 6–11 شهرًا: 50 mg أربع مرات؛ 1–3 سنوات: 100 mg ثلاث مرات؛ 4–6: 150 mg ثلاث مرات؛ 7–9: 200 mg ثلاث مرات؛ 10–11: 300 mg ثلاث مرات؛ 12–17: 300–400 mg أربع مرات يوميًا. يلزم الوزن: السقف 30 mg/kg/day، ومن عمر 7 سنوات لا يتجاوز كذلك 2400 mg/day. لا ملف لأقل من 6 أشهر. يُراجع تركيز العبوة؛ لا يُخلط بسقف مرجع آخر.",
    instructions: "بعد الطعام. راجع حساسية أو ربو NSAID، القرحة والنزف، الكلى والجفاف، مضادات التخثر والأسبرين والحمل. FDA: يُتجنب بدءًا من 20 أسبوعًا إلا بتقييم طبي، ويُتجنب بعد 30 أسبوعًا.",
    sources: [{ title: "SDCEP — Ibuprofen", url: sdcep("ibuprofen"), version: "صفحة حية، تحقق 2026-10-30" }, { title: "FDA — NSAIDs in pregnancy", url: "https://www.fda.gov/drugs/drug-safety-and-availability/fda-recommends-avoiding-use-nsaids-pregnancy-20-weeks-or-later-because-they-can-result-low-amniotic", version: "2020، تحديث 2022؛ تحقق 2026-10-30" }],
  },
  {
    id: "amoxicillin", genericName: "Amoxicillin", arabicName: "أموكسيسيلين",
    reviewStatus: "pending-owner-review", version: "review-2026-10-30", units: "mg/kg/day (not per dose); mg/dose",
    adult: "ADA/CDC: 500 mg ثلاث مرات يوميًا لمدة 3–7 أيام عند وجود استطباب مناسب في البالغ المؤهل للإرشاد. مراجعة بعد 3 أيام؛ الإيقاف بعد 24 ساعة من زوال العلامات والأعراض بالكامل وفق تقييم الطبيب.",
    child: "AAPD: عمر أكبر من 3 أشهر ووزن أقل من 40 kg. مسار مستقل: 20–40 mg/kg/day مقسمة كل 8 ساعات، سقف 500 mg/dose. أو مسار مستقل: 25–45 mg/kg/day مقسمة كل 12 ساعة، سقف 875 mg/dose. يختار الطبيب المسار والجرعة والمدة حسب الاستطباب؛ لا تُنقل مدة البالغ للطفل. وزن 40 kg بالضبط يحتاج مراجعة يدوية.",
    instructions: "يلزم تحديد الاستطباب ومراجعة الحساسية والتداخلات. معظم الألم اللبي لا يحتاج مضادًا مع إمكان العلاج الموضعي؛ المضاد لا يعوض التصريف أو علاج الجذور أو الخلع. لا بديل دوائي تلقائي عند الحساسية. الشكل والتركيز يؤخذان من العبوة.",
    sources: [aapd, { title: "ADA/CDC — Dental pain and swelling", url: "https://cdc.gov/antibiotic-use/media/pdfs/ADA-treatment-guidelines-508.pdf", version: "ADA 2019؛ CDC CS329314-A" }, { title: "AAPD — Antibiotic therapy", url: "https://www.aapd.org/globalassets/media/policies_guidelines/bp_antibiotictherapy.pdf", version: "مراجعة 2022، دليل 2025" }],
  },
  {
    id: "chlorhexidine", genericName: "Chlorhexidine 0.2%", arabicName: "كلورهكسيدين",
    reviewStatus: "pending-owner-review", version: "review-2026-10-30", units: "% concentration; mL/rinse",
    adult: "SDCEP: غسول 0.2% فقط، 10 mL لمدة دقيقة مرتين يوميًا. مدة قصيرة يحددها الطبيب. لا يستبدل بتركيز 0.12% بنفس التعليمات.",
    child: "مرجع NHS لمنتجات الأسنان غالبًا من 12 سنة فأكثر. يلزم التحقق من عمر وتركيز المنتج والقدرة على المضمضة والبصق؛ لا ملف مفعّل للأصغر سنًا.",
    instructions: "مضمضة ثم بصق دون ابتلاع. راجع حساسية الكلورهكسيدين وصعوبة البلع ومحتوى الكحول ونشرة المستحضر؛ يحدد الطبيب المدة.",
    sources: [{ title: "SDCEP — Chlorhexidine mouthwash", url: "https://sdcepdentalprescribing.nhs.scot/guidance/ulceration-inflammation/antimicrobial-mouthwashes/chlorhexidine-mouthwash/", version: "صفحة حية، تحقق 2026-10-30" }, { title: "NHS — Who can use chlorhexidine", url: "https://www.nhs.uk/medicines/chlorhexidine/who-can-and-cannot-use-chlorhexidine/", version: "مراجعة 2024-08-19" }],
  },
];
