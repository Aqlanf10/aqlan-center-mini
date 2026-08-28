# tools/blueprint — خط توليد وثيقة MASTER BLUEPRINT الرسمية

الوثيقة المرجعية الحاكمة (`docs/MASTER_BLUEPRINT.md`) هي **المصدر الوحيد**، وتولَّد منها النسخ الرسمية Word وPDF بهذه الأدوات — فأي تعديل على الوثيقة يبدأ من ملف Markdown ويُعاد التوليد منه (حوكمة الوثيقة، القسم 11).

## الملفات

| الملف | الوظيفة |
| --- | --- |
| `mdparse.js` | محلل يحول `docs/MASTER_BLUEPRINT.md` إلى نموذج كتل موحد (أقسام/فقرات/جداول/أشجار/خطوات/تنبيهات) |
| `md_to_docx.js` | توليد Word RTL (غلاف R1 بلوحة MC-1، فهرس حقيقي، ترقيم ثلاثي المقاطع) |
| `md_to_html.js` | توليد HTML (غلاف Template 07 Crystal Blue + متن flowing) — مصدر الـPDF |
| `patch_docx.py` | رقع التوافق: إزالة pgNumType الفارغ، حقل PAGE روماني/عربي، bidi لأنماط الفهرس |
| `stamp_pages.py` | ختم أرقام صفحات الـPDF (الغلاف والخاتمة بلا رقم) |

## الاستخدام

يعمل من أي مكان يضم حزم `docx` (عبر `bun add docx` في الجذر) ويُطلق من جذر المستودع:

```bash
node tools/blueprint/md_to_docx.js        # → Word
node tools/blueprint/md_to_html.js        # → HTML
python3 skills-path/docx/scripts/add_toc_placeholders.py <docx> --auto   # سكربت مهارة docx
python3 tools/blueprint/patch_docx.py <docx>
# PDF: html2pdf-next.js (مهارة pdf) بعرض 794px وارتفاع 1123px مع --nopaged، ثم:
python3 tools/blueprint/stamp_pages.py <pdf> <out.pdf> && qpdf --object-streams=generate --compress-streams=y <out.pdf> <final.pdf>
```

ملاحظات: خطوط Noto Naskh/Kufi Arabic مطلوبة للـPDF (تثبيت في `~/.fonts` + `fc-cache`)؛ خطا Word (Sakkal Majalla/Times New Roman) قياسيان على Windows/Office لدى المالك.
