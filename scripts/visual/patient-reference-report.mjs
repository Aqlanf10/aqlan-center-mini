import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";

// Review artifact only. Uses Playwright's installed comparator; installs nothing.
const [referenceDirectory, captureDirectory, outputDirectory] = process.argv.slice(2);
if (!referenceDirectory || !captureDirectory || !outputDirectory) {
  throw new Error("Usage: node scripts/visual/patient-reference-report.mjs REFERENCES CAPTURES OUTPUT");
}
const require = createRequire(import.meta.url);
const core = path.dirname(require.resolve("playwright-core/package.json"));
const compare = require(path.join(core, "lib/coreBundle.js")).utils.getComparator("image/png");
const scenes = [
  ["01_summary", "summary", "الملخص"], ["02_today_visit", "today", "زيارة اليوم"],
  ["03_account", "account", "الحساب"], ["04_files", "files", "الأشعة والملفات"],
  ["05_dental_chart", "treatment", "المخطط السني"], ["06_treatment_plans", "plans", "الخطط"],
  ["07_cases_and_problems", "cases", "الحالات والمشاكل"], ["08_root_canal", "endo", "علاج الجذور"],
  ["09_orthodontics_ceph", "ortho", "التقويم"], ["10_lab_orders", "lab", "المعمل"],
  ["11_referrals", "referrals", "الإحالات"], ["12_patient_materials", "materials", "المستهلكات"],
  ["13_personal_details", "personal-details", "البيانات الشخصية"],
  ["14_medical_history", "medical-history", "التاريخ الطبي"],
  ["15_cephalometric_detail", "cephalometric", "السيفالومتري"],
];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
await mkdir(outputDirectory, { recursive: true });
const manifest = [];
for (const [reference, scene, title] of scenes) {
  const expected = await readFile(path.join(referenceDirectory, `${reference}.png`));
  await writeFile(path.join(outputDirectory, `${scene}-reference.png`), expected);
  const captures = [];
  for (const width of [1448, 1280, 390]) {
    const filename = `${scene}-${width}.png`;
    const actual = await readFile(path.join(captureDirectory, filename));
    await writeFile(path.join(outputDirectory, filename), actual);
    await copyFile(path.join(captureDirectory, `${scene}-${width}-geometry.json`), path.join(outputDirectory, `${scene}-${width}-geometry.json`));
    const detailFile = ["plans", "endo", "ortho", "cephalometric"].includes(scene) ? `${scene}-${width}-detail.png` : null;
    if (detailFile) await copyFile(path.join(captureDirectory, detailFile), path.join(outputDirectory, detailFile));
    captures.push({ width, filename, sha256: hash(actual), detailFile });
  }
  // The gallery only supplies a 1448px reference. Never stretch it to invent a mobile baseline.
  const actual = await readFile(path.join(captureDirectory, `${scene}-1448.png`));
  const result = compare(actual, expected, { comparator: "pixelmatch", threshold: 0.2, maxDiffPixels: 0 });
  if (result?.diff) await writeFile(path.join(outputDirectory, `${scene}-diff.png`), result.diff);
  manifest.push({ scene, title, referenceSha256: hash(expected), captures, pixelComparison: result?.errorMessage ?? "Identical pixels" });
}
await writeFile(path.join(outputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2));
const sections = manifest.map(row => `<section id="${row.scene}"><h2>${row.title}</h2>
<div class="pair"><figure><figcaption>المرجع المعتمد · 1448px</figcaption><img loading="lazy" src="${row.scene}-reference.png" alt="مرجع ${row.title}"></figure>
<figure><figcaption>التطبيق المحلي الفعلي · بيانات اصطناعية</figcaption><img class="actual" data-scene="${row.scene}" loading="lazy" src="${row.scene}-1448.png" alt="التطبيق الفعلي — ${row.title}"></figure></div>
${row.captures[0].detailFile ? `<details><summary>تفاصيل القسم الفعلي أسفل السياق المالي</summary><img class="actual" data-scene="${row.scene}" data-suffix="-detail" loading="lazy" src="${row.captures[0].detailFile}" alt="تفاصيل ${row.title}"></details>` : ""}
<details><summary>فرق البكسلات — تشخيص للفروقات، وليس شهادة مطابقة</summary><p dir="ltr">${row.pixelComparison}</p><img loading="lazy" src="${row.scene}-diff.png" alt="خريطة الفروق"></details></section>`).join("\n");
await writeFile(path.join(outputDirectory, "index.html"), `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AQLAN — مقارنة المراجع واللقطات الفعلية</title><style>body{font-family:Arial,sans-serif;margin:0;background:#eff8ff;color:#174777}header{padding:20px;background:white;position:sticky;top:0;z-index:1;border-bottom:1px solid #cce4fa}h1{font-size:20px}p{line-height:1.7}nav{display:flex;flex-wrap:wrap;gap:12px}a{color:#006bc4}section{margin:20px;padding:16px;background:white;border:1px solid #cce4fa;border-radius:10px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}figure{margin:0;min-width:0}figcaption{padding:10px;font-weight:bold}img{display:block;max-width:100%;height:auto;border:1px solid #d5e8fa}select{padding:7px}details{margin-top:12px}summary{cursor:pointer}@media(max-width:700px){.pair{grid-template-columns:1fr}section{margin:10px}}</style>
<header><h1>مراجعة واجهات ملف المريض — صور من التطبيق الحقيقي</h1><p>45 لقطة من PostgreSQL معزول. المرجع الأصلي 1448px فقط؛ العروضان الآخران لإثبات التكيّف. الأرقام والتنبيهات الاصطناعية تختلف عن الرسم. راجع تقرير الفروقات قبل القبول.</p>
<label>عرض التطبيق: <select id="width"><option>1448</option><option>1280</option><option>390</option></select></label>
<nav>${manifest.map(row => `<a href="#${row.scene}">${row.title}</a>`).join("")}</nav></header>${sections}
<script>document.getElementById('width').addEventListener('change',event=>{for(const image of document.querySelectorAll('.actual'))image.src=image.dataset.scene+'-'+event.target.value+(image.dataset.suffix||'')+'.png';});</script></html>`);
await writeFile(path.join(outputDirectory, "README.md"), `# المراجع واللقطات الفعلية\n\nصور اصطناعية من التطبيق المحلي الحقيقي. [تقرير النطاق والفروقات](../../PATIENT_PREMIUM_REFERENCE_REVIEW.md) · [المعرض التفاعلي](index.html) · [البصمات ونتائج فرق البكسلات](manifest.json).\n\nالصور المرجعية الأصلية بعرض 1448 فقط. لا تعني خرائط الفروق أو أعداد الاختبارات اكتمال المطابقة البصرية.\n\n| الشاشة | المرجع | 1448 | 1280 | 390 |\n|---|---|---|---|---|\n${manifest.map(row => `| ${row.title} | ![مرجع](./${row.scene}-reference.png) | ![1448](./${row.scene}-1448.png) | ![1280](./${row.scene}-1280.png) | ![390](./${row.scene}-390.png) |`).join("\n")}\n\n## تفاصيل الأقسام الطويلة\n\n${manifest.filter(row => row.captures[0].detailFile).map(row => `- ${row.title}: ${row.captures.map(capture => `[${capture.width}](${capture.detailFile})`).join(" · ")}`).join("\n")}\n`);
console.log(`Created ${manifest.length} comparisons and 45 actual screenshots in ${outputDirectory}`);
