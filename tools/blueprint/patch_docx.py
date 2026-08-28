#!/usr/bin/env python3
"""Post-process blueprint DOCX (WPS/Word compat, per docx skill toc.md):
remove empty pgNumType, patch footer PAGE fields (ROMAN/arabic via sectPr mapping),
add <w:bidi/> to TOC 1/2/3 styles."""
import re, shutil, sys, zipfile

DOCX = sys.argv[1]
TMP = DOCX + ".tmp.zip"

with zipfile.ZipFile(DOCX, "r") as z:
    names = z.namelist()
    data = {n: z.read(n) for n in names}

doc = data["word/document.xml"].decode("utf-8")
rels = data["word/_rels/document.xml.rels"].decode("utf-8")
doc = doc.replace("<w:pgNumType/>", "")
rid_to_target = dict(re.findall(r'<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"', rels))
patch_plan = {}
for blk in re.findall(r"<w:sectPr.*?</w:sectPr>", doc, flags=re.S):
    m = re.search(r'<w:pgNumType[^>]*w:fmt="([^"]+)"', blk)
    if not m:
        continue
    fmt = m.group(1)
    for rid in re.findall(r'<w:footerReference[^>]*r:id="([^"]+)"', blk):
        target = rid_to_target.get(rid, "")
        fname = ("word/" + target.lstrip("/")) if not target.startswith("word/") else target
        if "upperRoman" in fmt: patch_plan[fname] = "ROMAN"
        elif fmt in ("decimal", "arabic"): patch_plan[fname] = "arabic"
for fname, style in patch_plan.items():
    if fname not in data: continue
    xml = data[fname].decode("utf-8")
    xml, n = re.subn(r"(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)", r"\1 PAGE \\* " + style + r" \\* MERGEFORMAT \2", xml)
    data[fname] = xml.encode("utf-8")
    print(f"  {fname}: {n} PAGE -> \\* {style}")

styles = data["word/styles.xml"].decode("utf-8")
for sid in ("TOC1", "TOC2", "TOC3"):
    pat = r'(<w:style [^>]*w:styleId="' + sid + r'"[^>]*>.*?<w:pPr>)'
    styles = re.sub(pat, lambda m: m.group(1) + ("<w:bidi/>" if "<w:bidi/>" not in m.group(1) else ""), styles, count=1, flags=re.S)
data["word/styles.xml"] = styles.encode("utf-8")
data["word/document.xml"] = doc.encode("utf-8")

with zipfile.ZipFile(TMP, "w", zipfile.ZIP_DEFLATED) as z:
    for n in names: z.writestr(n, data[n])
shutil.move(TMP, DOCX)
print("patched:", DOCX)
