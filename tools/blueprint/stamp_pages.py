#!/usr/bin/env python3
"""Stamp page numbers: cover + ending unnumbered; body pages Arabic from 1 (bare number)."""
import io, sys
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

SRC, DST = sys.argv[1], sys.argv[2]
reader = PdfReader(SRC); writer = PdfWriter(); n = len(reader.pages)

def overlay(label, w, h):
    buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=(w, h))
    c.setFont("Helvetica", 8.5); c.setFillColorRGB(0.42, 0.50, 0.58)
    c.drawCentredString(w / 2.0, 16, label); c.save(); buf.seek(0)
    return PdfReader(buf).pages[0]

for i, page in enumerate(reader.pages):
    if i == 0 or i == n - 1: writer.add_page(page); continue
    w, h = float(page.mediabox.width), float(page.mediabox.height)
    page.merge_page(overlay(str(i), w, h)); writer.add_page(page)
writer.add_metadata({"/Title": "AQLAN DENTAL OS — MASTER BLUEPRINT v1.0",
                     "/Author": "مركز الدكتور عقلان لطب الأسنان", "/Creator": "Z.ai",
                     "/Subject": "الخطة المرجعية الشاملة لبناء نظام مركز الدكتور عقلان"})
with open(DST, "wb") as f: writer.write(f)
print(f"stamped {n-2} numbers -> {DST}")
