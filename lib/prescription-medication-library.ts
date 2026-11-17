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
    instructions: "راجع وزن البالغ الأقل من 50 kg وسوء التغذية والجفاف والكحول المزمن ومرض الكبد وجميع الأدوية المحتوية على نفس المادة؛ لا تجمعها دون احتساب مجموع الجرعة؛ 4000 mg/day ليس هدفًا افتراضيًا ولا مناسبًا للجميع. الشكل والتركيز من العبوة. المدة والتعليمات النهائية يحددهما الطبيب.",
    sources: [{ title: "NHS — Paracetamol adults", url: "https://www.nhs.uk/medicines/paracetamol-for-adults/", version: "تحقق 2026-10-30" }, { title: "HSE — Hepatotoxicity risk", url: "https://www2.healthservice.hse.ie/organisation/nqpsd/pst/safety-supplements/paracetamol-dosing-for-adult-patients-under-50-kg-and-those-with-additional-risk-factors-for-hepatotoxicity/", version: "2026-05-11" }, aapd, { title: "SDCEP — Paracetamol", url: sdcep("paracetamol"), version: "صفحة حية، تحقق 2026-10-30" }],
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
    adult: "ADA/CDC: 500 mg ثلاث مرات يوميًا لمدة 3–7 أيام عند وجود استطباب مناسب في البالغ المؤهل للإرشاد ذي المناعة السليمة. مراجعة بعد 3 أيام؛ الإيقاف بعد 24 ساعة من زوال العلامات والأعراض الجهازية بالكامل وفق تقييم الطبيب.",
    child: "AAPD: عمر أكبر من 3 أشهر ووزن أقل من 40 kg. مسار مستقل: 20–40 mg/kg/day مقسمة كل 8 ساعات، سقف 500 mg/dose. أو مسار مستقل: 25–45 mg/kg/day مقسمة كل 12 ساعة، سقف 875 mg/dose. يختار الطبيب المسار والجرعة والمدة حسب الاستطباب؛ لا تُنقل مدة البالغ للطفل. وزن 40 kg بالضبط يحتاج مراجعة يدوية.",
    instructions: "يلزم تحديد الاستطباب ومراجعة الحساسية والتداخلات ووظائف الكلى. معظم الألم اللبي لا يحتاج مضادًا مع إمكان العلاج الموضعي؛ المضاد لا يعوض التصريف أو علاج الجذور أو الخلع. راجع النشرة في القصور الكلوي؛ لا تُستخدم قوة 875 mg عند GFR أقل من 30 mL/min وفق النشرة المشار إليها، ولا تستنتج جرعة بديلة من هذا التنبيه وحده. لا بديل دوائي تلقائي عند الحساسية. الشكل والتركيز يؤخذان من العبوة.",
    sources: [{ title: "DailyMed — Amoxicillin label", url: "https://www.dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=26e257d5-5b98-3795-e063-6394a90a05bc", version: "تحقق 2026-10-30؛ ليست نشرة المنتج المحلي" }, aapd, { title: "ADA/CDC — Dental pain and swelling", url: "https://cdc.gov/antibiotic-use/media/pdfs/ADA-treatment-guidelines-508.pdf", version: "ADA 2019؛ CDC CS329314-A" }, { title: "AAPD — Antibiotic therapy", url: "https://www.aapd.org/globalassets/media/policies_guidelines/bp_antibiotictherapy.pdf", version: "مراجعة 2022، دليل 2025" }],
  },
  {
    id: "chlorhexidine", genericName: "Chlorhexidine 0.2%", arabicName: "كلورهكسيدين",
    reviewStatus: "pending-owner-review", version: "review-2026-10-30", units: "% concentration; mL/rinse",
    adult: "SDCEP: غسول 0.2% فقط، 10 mL لمدة دقيقة مرتين يوميًا. مدة قصيرة يحددها الطبيب. لا يستبدل بتركيز 0.12% بنفس التعليمات.",
    child: "مرجع NHS لمنتجات الأسنان غالبًا من 12 سنة فأكثر. يلزم التحقق من عمر وتركيز المنتج والقدرة على المضمضة والبصق؛ لا ملف مفعّل للأصغر سنًا.",
    instructions: "مضمضة ثم بصق دون ابتلاع. راجع حساسية الكلورهكسيدين وصعوبة البلع ومحتوى الكحول ونشرة المستحضر؛ يحدد الطبيب المدة.",
    sources: [{ title: "SDCEP — Chlorhexidine mouthwash", url: "https://sdcepdentalprescribing.nhs.scot/guidance/ulceration-inflammation/antimicrobial-mouthwashes/chlorhexidine-mouthwash/", version: "صفحة حية، تحقق 2026-10-30" }, { title: "NHS — Who can use chlorhexidine", url: "https://www.nhs.uk/medicines/chlorhexidine/who-can-and-cannot-use-chlorhexidine/", version: "مراجعة 2024-08-19" }],
  },
{
  "id": "penicillin-v",
  "genericName": "Phenoxymethylpenicillin (Penicillin V)",
  "arabicName": "فينوكسي ميثيل بنسلين — بنسلين V",
  "reviewStatus": "pending-owner-review",
  "version": "reference-review-2026-11-01.1",
  "units": "mg/dose; age bands",
  "adult": "SDCEP للخراج عند تحقق استطباب المضاد: مثال 500 mg أربع مرات يوميًا؛ عادة 3–5 أيام ومراجعة اليوم الثالث. ضيق الطيف سبب تفضيله في هذا الإرشاد عندما يلائم الحالة.",
  "child": "SDCEP: 6–11 شهرًا 62.5 mg؛ 1–5 سنوات 125 mg؛ 6–11 سنة 250 mg؛ 12–17 سنة 500 mg، كل منها أربع مرات يوميًا. أقل من 6 أشهر أو عدوى شديدة خارج هذه البطاقة: مراجعة يدوية. أمثلة المحلول 125 أو 250 mg/5mL لا تختار تلقائيًا.",
  "instructions": "قبل الطعام بـ30 دقيقة أو بعده بساعتين. حساسية البنسلين الفورية تمنع المسار؛ راجع الكلى وwarfarin والتداخلات. لا زيادة تلقائية لجرعات العدوى الشديدة؛ يلزم تقييم خطر الانتشار والإحالة. مرجع للمراجعة لا وصفة جاهزة؛ لا جرعة أو منتج أو مدة افتراضية. يلزم اختيار الطبيب ونشرة المنتج الفعلي.",
  "sources": [
    {
      "title": "SDCEP phenoxymethylpenicillin",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/bacterial-infections/dental-abscess/first-line-antibiotics/phenoxymethylpenicillin/",
      "version": "bacterial section May 2026"
    },
    {
      "title": "SDCEP antibiotic cautions",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/supporting-tools/contraindications-cautions/contraindications-cautions-antibiotics/",
      "version": "live page"
    },
    {
      "title": "SDCEP dental abscess",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/bacterial-infections/dental-abscess/",
      "version": "bacterial section updated May 2026"
    }
  ]
},
{
  "id": "metronidazole",
  "genericName": "Metronidazole",
  "arabicName": "ميترونيدازول",
  "reviewStatus": "pending-owner-review",
  "version": "reference-review-2026-11-01.1",
  "units": "mg/dose; age bands",
  "adult": "SDCEP لخراج له استطباب مضاد: 400 mg ثلاث مرات يوميًا، عادة 3–5 أيام ومراجعة اليوم الثالث. بديل أو إضافة حسب تشخيص الطبيب؛ لا إضافة روتينية إلى أي مضاد.",
  "child": "SDCEP: 1–2 سنة 50 mg ثلاث مرات؛ 3–6 سنوات 100 mg مرتين؛ 7–9 سنوات 100 mg ثلاث مرات؛ 10–17 سنة 200 mg ثلاث مرات يوميًا. أقل من سنة خارج هذه البطاقة. مرجع المعلق 200 mg/5mL يتطلب تحقق العبوة؛ لا يستبدل بنظام AAPD لمرض لثوي مختلف.",
  "instructions": "حساسية nitroimidazole تمنع المسار؛ SDCEP ينصح بعدم وصفه مع warfarin. تجنب الكحول أثناءه؛ مدة الامتناع بعده حسب النشرة. راجع الكبد والحمل والرضاعة والتداخلات؛ لا وصف آلي للحساسية. مرجع للمراجعة لا وصفة جاهزة؛ لا جرعة أو منتج أو مدة افتراضية. يلزم اختيار الطبيب ونشرة المنتج الفعلي.",
  "sources": [
    {
      "title": "SDCEP metronidazole",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/bacterial-infections/dental-abscess/first-line-antibiotics/metronidazole/",
      "version": "bacterial section May 2026"
    },
    {
      "title": "SDCEP antibiotic cautions",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/supporting-tools/contraindications-cautions/contraindications-cautions-antibiotics/",
      "version": "live page"
    },
    {
      "title": "SDCEP dental abscess",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/bacterial-infections/dental-abscess/",
      "version": "bacterial section updated May 2026"
    }
  ]
},
{
  "id": "amoxicillin-clavulanate",
  "genericName": "Amoxicillin + Clavulanate",
  "arabicName": "أموكسيسيلين مع كلافولانات",
  "reviewStatus": "pending-owner-review",
  "version": "reference-review-2026-11-01.1",
  "units": "amoxicillin mg/kg/day; separate component mg/dose",
  "adult": "مرجع مقيد للتوسيع بعد فشل العلاج الأول وإعادة التقييم في نطاق ADA: 500/125 mg ثلاث مرات يوميًا، مرجع 7 أيام مع مراجعة اليوم الثالث وقاعدة الإيقاف حسب الدليل. ليس خطًا أولًا تلقائيًا.",
  "child": "نشرة الجرعات العامة من عمر 12 أسبوعًا: مثال 25–45 mg/kg/day من مكون الأموكسيسيلين، مقسمة كل 12 ساعة؛ لا يتجاوز مقدار البالغ لنفس المنتج والنظام. لا توجد مدة سنية أو سقوف منتج محلي معتمدة هنا: مراجعة يدوية فقط، خصوصًا حدود الوزن/العمر. لا تطبق النظام دون تثبيت نسبة المركبين.",
  "instructions": "أظهر مقدار الكلافولانات أيضًا؛ الأشكال والنسب غير قابلة للاستبدال التلقائي. تاريخ يرقان/اختلال كبدي مرتبط بالدواء أو حساسية خطرة مانع. القصور الكلوي الشديد يحتاج مسارًا مختلفًا؛ 875/125 غير ملائم عند GFR<30 حسب النشرة المرجعية. النشرة مؤرخة 2018 وليست إثبات أحدث نشرة محلية. مرجع للمراجعة لا وصفة جاهزة؛ لا جرعة أو منتج أو مدة افتراضية. يلزم اختيار الطبيب ونشرة المنتج الفعلي.",
  "sources": [
    {
      "title": "ADA dental infection guideline / chairside guide",
      "url": "https://www.ada.org/-/media/project/ada-organization/ada/ada-org/files/resources/research/ada_chairside_guide_antibiotics_tna.pdf?hash=0611A3DB9B1C2BCC497CF6E91CEA2751&rev=3c99efba951c4ed599324316297ce5ba",
      "version": "2019 guideline; accessed current ADA resource"
    },
    {
      "title": "DailyMed amoxicillin/clavulanate official label",
      "url": "https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=7870336b-1f49-bcf4-e053-2991aa0af8b7",
      "version": "label revised July 2018; currently accessible, not claimed most recent manufacturer label"
    }
  ]
},
{
  "id": "azithromycin",
  "genericName": "Azithromycin",
  "arabicName": "أزيثرومايسين",
  "reviewStatus": "pending-owner-review",
  "version": "reference-review-2026-11-01.1",
  "units": "mg/dose; mg/kg/dose; loading/maintenance",
  "adult": "ADA، بديل مقيد لحالات حساسية مناسبة بعد تقييم الطبيب: 500 mg يوم 1، ثم 250 mg يوميًا لأربعة أيام أخرى؛ ليس بديلًا تلقائيًا للبنسلين.",
  "child": "AAPD: يوم 1 مقدار 10–12 mg/kg/dose مرة واحدة، أقصى 500 mg؛ ثم 5–6 mg/kg/dose مرة يوميًا. يذكر المصدر بقية العلاج 2–5 أيام؛ لا يحدد النظام النهائي تلقائيًا. سقف الصيانة 250 mg مستند إلى سقف البالغ ومبدأ عدم تجاوزه. الحد الأدنى للعمر والمدة والمنتج تحتاج مراجعة يدوية؛ لا تنقل جرعات ممتد التحرر.",
  "instructions": "راجع QT واضطراب النظم والتداخلات والمرض الكبدي والحمل/الرضاعة ونشرة المنتج. المقاومة والملاءمة السريرية تمنع اعتباره بديلًا افتراضيًا. جرعة التحميل والصيانة مرحلتان مستقلتان. مرجع للمراجعة لا وصفة جاهزة؛ لا جرعة أو منتج أو مدة افتراضية. يلزم اختيار الطبيب ونشرة المنتج الفعلي.",
  "sources": [
    {
      "title": "ADA dental infection guideline / chairside guide",
      "url": "https://www.ada.org/-/media/project/ada-organization/ada/ada-org/files/resources/research/ada_chairside_guide_antibiotics_tna.pdf?hash=0611A3DB9B1C2BCC497CF6E91CEA2751&rev=3c99efba951c4ed599324316297ce5ba",
      "version": "2019 guideline; accessed current ADA resource"
    },
    {
      "title": "AAPD Useful Medications, revision 2025, pp669–677",
      "url": "https://www.aapd.org/globalassets/media/policies_guidelines/r_usefulmeds25.pdf",
      "version": "2025"
    },
    {
      "title": "Azithromycin250mg SmPC",
      "url": "https://www.medicines.org.uk/emc/product/2272/smpc",
      "version": "21 May2026"
    }
  ]
},
{
  "id": "clarithromycin",
  "genericName": "Clarithromycin",
  "arabicName": "كلاريثرومايسين",
  "reviewStatus": "pending-owner-review",
  "version": "reference-review-2026-11-01.1",
  "units": "mg/dose; weight bands",
  "adult": "SDCEP، خط ثانٍ مقيد بعد عدم الاستجابة أو حالة شديدة يقيّمها الطبيب: مثال 500 mg مرتين يوميًا لمدة 5 أيام، مع مراجعة اليوم الثالث؛ ليس خيارًا روتينيًا أولًا.",
  "child": "SDCEP لعمر 1–11 سنة: وزن 8–11 kg:62.5 mg؛ 12–19 kg:125 mg؛ 20–29 kg:187.5 mg؛ 30–40 kg:250 mg، مرتين يوميًا. عمر 12–17 سنة:250–500 mg مرتين. لا تخمين للأوزان بين الفئات أو الأعمار غير المشمولة: مراجعة يدوية. المعلق 125 أو250 mg/5mL حسب المنتج.",
  "instructions": "راجع QT والتداخلات المهمة والحساسية والكبد والكلى. القصور الكلوي الشديد يستلزم تعديلًا مهنيًا، والحمل تقييم منفعة/خطر خاصة مبكرًا. لا تستخدم جرعات البالغ لسد فجوة وزن الطفل، ولا تعالج انتشارًا خطيرًا بمجرد تغيير المضاد. مرجع للمراجعة لا وصفة جاهزة؛ لا جرعة أو منتج أو مدة افتراضية. يلزم اختيار الطبيب ونشرة المنتج الفعلي.",
  "sources": [
    {
      "title": "SDCEP clarithromycin",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/bacterial-infections/dental-abscess/second-line-antibiotics/clarithromycin/",
      "version": "bacterial section May 2026"
    },
    {
      "title": "Clarithromycin250mg SmPC",
      "url": "https://www.medicines.org.uk/emc/medicine/32481",
      "version": "01 April2026"
    }
  ]
},
{
  "id": "nystatin",
  "genericName": "Nystatin",
  "arabicName": "نيستاتين",
  "reviewStatus": "pending-owner-review",
  "version": "reference-review-2026-11-01.1",
  "units": "units/dose; units/mL; never mg substitution",
  "adult": "SDCEP/النشرة UK للمبيضات الفموية: معلق 100000 units/mL، مقدار 1 mL أربع مرات يوميًا؛ مثال7 أيام مع استمرار48 ساعة على الأقل بعد زوال الأعراض وفق المراجعة.",
  "child": "النشرة المرجعية تذكر1 mL أربع مرات يوميًا للرضع والأطفال بنفس التركيز. يلزم تحقق عمر المنتج والقياس وتعليمات الإعطاء؛ الحالات غير المطابقة مراجعة يدوية. هذه بطاقة UK وليست نظام AAPD ذي الأحجام المختلفة؛ لا تخلطهما.",
  "instructions": "يبقى ملاصقًا للموضع قدر الإمكان قبل البلع وفق النشرة. راجع الحساسية والسكر/السواغات والتركيز. ليس لعلاج عدوى جهازية. استمرار الأعراض أو تفاقمها يستدعي تقييمًا؛ وحدات الدواء لا تحول إلىmg. مرجع للمراجعة لا وصفة جاهزة؛ لا جرعة أو منتج أو مدة افتراضية. يلزم اختيار الطبيب ونشرة المنتج الفعلي.",
  "sources": [
    {
      "title": "SDCEP nystatin",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/fungal-infections/candidosis/nystatin/",
      "version": "live page"
    },
    {
      "title": "Nystatin 100000 units/ml SmPC, reference product",
      "url": "https://www.medicines.org.uk/emc/product/100765/smpc",
      "version": "22 April 2025"
    }
  ]
},
{
  "id": "miconazole",
  "genericName": "Miconazole oral gel",
  "arabicName": "ميكونازول — جل فموي",
  "reviewStatus": "pending-owner-review",
  "version": "reference-review-2026-11-01.1",
  "units": "mg/g; mL/application; no assumed density",
  "adult": "نشرة الجل الفموي20 mg/g: 2.5 mL أربع مرات يوميًا بعد الطعام، مع الإبقاء بالفم وعدم البلع مباشرة؛ يستمر أسبوعًا على الأقل بعد زوال الأعراض. هذه نشرة منتج محدد وليست كل مستحضرات ميكونازول.",
  "child": "من عمر سنتين حسب النشرة كالجرعة المذكورة؛ الأصغر خارج هذه البطاقة ويحتاج مراجعة متخصصة بسبب خطر الاختناق وحدود العمر/البلع. لا تنقل جرعة الجل إلى أقراص شدقية أو كريم جلدي.",
  "instructions": "20mg/g ليس20mg/mL؛ لا تحويل بكثافة مفترضة. يحظر مع warfarin وبعض أدوية QT وstatins وفق النشرة، ومع خلل الكبد. لا يوضع بمؤخرة الحلق أو حلمة الرضاعة لإعطاء رضيع. الحمل/الرضاعة يحتاجان مراجعة. لا يخلط بكمية حبة البازلاء في نظام SDCEP الآخر. مرجع للمراجعة لا وصفة جاهزة؛ لا جرعة أو منتج أو مدة افتراضية. يلزم اختيار الطبيب ونشرة المنتج الفعلي.",
  "sources": [
    {
      "title": "Daktarin 2% oral gel SmPC, reference product",
      "url": "https://www.medicines.org.uk/emc/medicine/22032",
      "version": "04 September 2026"
    },
    {
      "title": "SDCEP miconazole",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/fungal-infections/candidosis/miconazole/",
      "version": "live page"
    }
  ]
},
{
  "id": "fluconazole",
  "genericName": "Fluconazole",
  "arabicName": "فلوكونازول",
  "reviewStatus": "pending-owner-review",
  "version": "reference-review-2026-11-01.1",
  "units": "mg/dose; mg/kg/dose; loading/maintenance",
  "adult": "SDCEP، مرجع مقيد لمبيضات واسعة/شديدة أو فشل/عدم مناسبة الموضعي: 200 mg في اليوم الأول، ثم100 mg مرة يوميًا؛ مثال إجمالي7 أيام. لا يطبق على كل مبيضات أو كل استطباب.",
  "child": "SDCEP: 6أشهر–11سنة: يوم1 مقدار6 mg/kg مرة واحدة بحد400 mg، ثم3 mg/kg مرة يوميًا بحد200 mg؛ 12–17سنة كالمرجع البالغ. أقل من6أشهر خارج البطاقة. لا تمزج هذا النظام بجرعات AAPD اليومية المختلفة؛ المنتج والمدة والكلى تحتاج مراجعة.",
  "instructions": "راجع الكلى والكبد وQT وتداخلات CYP؛ SDCEP ينصح بعدم إعطائه مع warfarin أوstatins. لا يستخدم بالحمل إلا لضرورة واضحة يقررها المختص، والرضاعة تحتاج مراجعة خاصة لتعدد الجرعات. لا ضبط كلوي أو جرعة تحميل تلقائية. مرجع للمراجعة لا وصفة جاهزة؛ لا جرعة أو منتج أو مدة افتراضية. يلزم اختيار الطبيب ونشرة المنتج الفعلي.",
  "sources": [
    {
      "title": "SDCEP fluconazole",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/fungal-infections/candidosis/fluconazole/",
      "version": "live page"
    },
    {
      "title": "Fluconazole 50mg capsules SmPC",
      "url": "https://www.medicines.org.uk/emc/product/4437/smpc",
      "version": "13 March 2024"
    }
  ]
},
{
  "id": "benzydamine",
  "genericName": "Benzydamine hydrochloride mouthwash",
  "arabicName": "بنزيدامين — غسول فموي",
  "reviewStatus": "pending-owner-review",
  "version": "reference-review-2026-11-01.1",
  "units": "% w/v; mL/rinse",
  "adult": "النشرة المرجعية0.15%: 15mL مضمضة/غرغرة كل1.5–3ساعات عند الحاجة، ثم بصق؛ لا يتجاوز العلاج المتصل7أيام دون إشراف. 15mL تعادل22.5mg في هذا المنتج.",
  "child": "من13سنة فأكثر حسب النشرة؛ الغسول غير مناسب≤12سنة. لا تستنتج جرعة بخاخ أو أقراص مص من هذه البطاقة. عدد مرات24ساعة غير محدد هنا ويحتاج إقرارًا؛ لا تستنتج16جرعة تلقائيًا من أقصر فاصل.",
  "instructions": "لا بلع؛ راجع الحساسية والتهيج والكحول/السواغات. الحمل فقط عند ضرورة واضحة، والرضاعة إذا رآها الطبيب ضرورية. عند استمرار الألم راجع السبب، ولا تحول المسكن الموضعي إلى علاج للعدوى. مرجع للمراجعة لا وصفة جاهزة؛ لا جرعة أو منتج أو مدة افتراضية. يلزم اختيار الطبيب ونشرة المنتج الفعلي.",
  "sources": [
    {
      "title": "Benzydamine 0.15% mouthwash SmPC",
      "url": "https://www.medicines.org.uk/emc/product/3347/smpc",
      "version": "10 October 2025"
    }
  ]
},
{
  "id": "sodium-fluoride",
  "genericName": "Sodium fluoride — formulation-specific",
  "arabicName": "فلوريد الصوديوم",
  "reviewStatus": "pending-owner-review",
  "version": "reference-review-2026-11-01.1",
  "units": "ppm fluoride; % sodium fluoride; cm paste or mL rinse",
  "adult": "SDCEP، ثلاثة ملفات منفصلة: معجون2800ppm (فلوريد صوديوم0.619%):1cm مرتين يوميًا، تفريش دقيقة. معجون5000ppm (1.1%):2cm ثلاث مرات يوميًا، تفريش3دقائق. غسول0.05%:10mL مرة يوميًا لمدة دقيقة، ثم بصق ويفضل بوقت مختلف عن التفريش. المدة حسب الخطر ومراجعة الطبيب.",
  "child": "2800ppm من10سنوات؛5000ppm من16سنة؛ غسول0.05% من6سنوات مع القدرة على البصق. الأعمار الأصغر أو عدم القدرة على البصق خارج هذه الملفات وتحتاج مراجعة. ليست أنظمة معجون أطفال عامة.",
  "instructions": "لا ابتلاع؛ راجع مجموع مصادر الفلوريد وخطر التسوس والمنتج الفعلي. ppm لأيون الفلوريد ليس نسبة فلوريد الصوديوم، وطول شريط المعجون لا يحول إلىmg بكثافة مفترضة. لا استبدال بين المستحضرات أو نسخ تعليمات أحدها للآخر. مرجع للمراجعة لا وصفة جاهزة؛ لا جرعة أو منتج أو مدة افتراضية. يلزم اختيار الطبيب ونشرة المنتج الفعلي.",
  "sources": [
    {
      "title": "SDCEP fluoride toothpaste 2800ppm",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/dry-mouth/topical-fluoride/fluoride-toothpaste-2800-ppm/",
      "version": "live page"
    },
    {
      "title": "SDCEP fluoride toothpaste 5000ppm",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/dry-mouth/topical-fluoride/fluoride-toothpaste-5000-ppm/",
      "version": "live page"
    },
    {
      "title": "SDCEP sodium fluoride 0.05% rinse",
      "url": "https://www.sdcepdentalprescribing.nhs.scot/guidance/dry-mouth/topical-fluoride/fluoride-mouthwash-005/",
      "version": "live page"
    }
  ]
},
];
