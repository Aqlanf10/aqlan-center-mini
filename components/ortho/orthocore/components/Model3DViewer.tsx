"use client";

import React, { useEffect, useRef, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut, Box, Layers, Ruler, Save, X } from "lucide-react";
import type { Language } from "../types/ortho";
import { tr } from "../i18n/translations";

export type ScannerToolMode = "orbit" | "caliper" | "intercanine" | "intermolar" | "perimeter" | "tooth_width";
export type ScannerViewPreset = "isometric" | "occlusal_u" | "occlusal_l" | "frontal" | "right" | "left";

export interface ScannerMeasurementItem {
  id: string;
  kind: Exclude<ScannerToolMode, "orbit">;
  fdi?: string;
  labelAr: string;
  labelEn: string;
  valueMm: number;
}

interface Model3DViewerProps {
  open: boolean;
  embedded?: boolean;
  lang: Language;
  initialUrl?: string;
  title?: string;
  onClose?: () => void;
  onSaveMeasurement?: (distMm: number, label: string) => void;
  onToothWidthMeasured?: (fdi: string, widthMm: number) => void;
  onSaveSuite?: (items: ScannerMeasurementItem[], label: string) => void;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function parseAsciiStlOrObj(text: string): Array<[Vec3, Vec3, Vec3]> {
  const tris: Array<[Vec3, Vec3, Vec3]> = [];
  if (text.includes("facet normal")) {
    const vRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    const verts: Vec3[] = [];
    let m: RegExpExecArray | null;
    while ((m = vRe.exec(text)) !== null) {
      verts.push({ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) });
      if (verts.length === 3) {
        tris.push([verts[0], verts[1], verts[2]]);
        verts.length = 0;
      }
      if (tris.length >= 6000) break;
    }
    return tris;
  }
  const verts: Vec3[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("v ")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 4) {
        verts.push({ x: Number(parts[1]), y: Number(parts[2]), z: Number(parts[3]) });
      }
    } else if (trimmed.startsWith("f ")) {
      const parts = trimmed.split(/\s+/).slice(1).map((p) => Number(p.split("/")[0]) - 1);
      if (parts.length >= 3 && verts[parts[0]] && verts[parts[1]] && verts[parts[2]]) {
        tris.push([verts[parts[0]], verts[parts[1]], verts[parts[2]]]);
      }
      if (tris.length >= 6000) break;
    }
  }
  return tris;
}

function parseBinaryStl(buf: ArrayBuffer): Array<[Vec3, Vec3, Vec3]> {
  if (buf.byteLength < 84) return [];
  const dv = new DataView(buf);
  const count = Math.min(dv.getUint32(80, true), 8000);
  if (84 + count * 50 > buf.byteLength) return [];
  const tris: Array<[Vec3, Vec3, Vec3]> = [];
  let offset = 84;
  for (let i = 0; i < count; i++) {
    offset += 12;
    const v1 = { x: dv.getFloat32(offset, true), y: dv.getFloat32(offset + 4, true), z: dv.getFloat32(offset + 8, true) };
    const v2 = { x: dv.getFloat32(offset + 12, true), y: dv.getFloat32(offset + 16, true), z: dv.getFloat32(offset + 20, true) };
    const v3 = { x: dv.getFloat32(offset + 24, true), y: dv.getFloat32(offset + 28, true), z: dv.getFloat32(offset + 32, true) };
    offset += 38;
    tris.push([v1, v2, v3]);
  }
  return tris;
}

export const Model3DViewer: React.FC<Model3DViewerProps> = ({
  open,
  embedded = false,
  lang = "ar",
  initialUrl,
  title,
  onClose,
  onSaveMeasurement,
  onToothWidthMeasured,
  onSaveSuite,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [triangles, setTriangles] = useState<Array<[Vec3, Vec3, Vec3]>>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [rot, setRot] = useState({ x: 0.4, y: 0.6 });
  const [zoom, setZoom] = useState(1);
  const [wireframe, setWireframe] = useState(false);
  const [manualMm, setManualMm] = useState("34.5");
  const [manualLabel, setManualLabel] = useState(tr(lang, "العرض بين الأنياب", "Intercanine Width"));
  const [fdiInput, setFdiInput] = useState("11");
  const dragRef = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });

  useEffect(() => {
    if (!open || !initialUrl) return;
    let cancelled = false;
    setStatus("loading");
    fetch(initialUrl, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("Failed");
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled) return;
        const head = new TextDecoder().decode(buf.slice(0, 256));
        let parsed = head.includes("facet normal") || head.includes("\nv ")
          ? parseAsciiStlOrObj(new TextDecoder().decode(buf))
          : parseBinaryStl(buf);
        if (parsed.length === 0) parsed = parseAsciiStlOrObj(new TextDecoder().decode(buf));
        setTriangles(parsed);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [open, initialUrl]);

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#0d2137";
    ctx.fillRect(0, 0, w, h);

    if (triangles.length === 0) {
      ctx.strokeStyle = "rgba(154,182,211,0.35)";
      ctx.lineWidth = 1.2;
      for (let i = -4; i <= 4; i++) {
        ctx.beginPath();
        ctx.moveTo(w / 2 + i * 36 * zoom, 30);
        ctx.lineTo(w / 2 + i * 36 * zoom, h - 30);
        ctx.stroke();
      }
      ctx.strokeStyle = "#f5922e";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, 110 * zoom, 85 * zoom, 0, Math.PI, 0);
      ctx.stroke();
      ctx.fillStyle = "#e2eaf3";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        status === "loading"
          ? tr(lang, "جارٍ تحميل النموذج الثلاثي الأبعاد...", "Loading 3D mesh...")
          : tr(lang, "عارض النماذج ثلاثية الأبعاد (STL / OBJ) — اسحب للتدوير", "3D STL/OBJ Viewer — Drag to rotate"),
        w / 2,
        h - 24,
      );
      return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [a, b, c] of triangles) {
      for (const v of [a, b, c]) {
        if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
        if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z;
      }
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    const scale = (Math.min(w, h) * 0.72 * zoom) / span;
    const cosY = Math.cos(rot.y), sinY = Math.sin(rot.y);
    const cosX = Math.cos(rot.x), sinX = Math.sin(rot.x);

    const proj = (v: Vec3) => {
      const x0 = v.x - cx, y0 = v.y - cy, z0 = v.z - cz;
      const x1 = x0 * cosY - z0 * sinY;
      const z1 = x0 * sinY + z0 * cosY;
      const y2 = y0 * cosX - z1 * sinX;
      const z2 = y0 * sinX + z1 * cosX;
      return { sx: w / 2 + x1 * scale, sy: h / 2 - y2 * scale, z: z2 };
    };

    const projected = triangles.map((tri) => {
      const p0 = proj(tri[0]), p1 = proj(tri[1]), p2 = proj(tri[2]);
      return { p0, p1, p2, zAvg: (p0.z + p1.z + p2.z) / 3 };
    });
    projected.sort((a, b) => a.zAvg - b.zAvg);

    for (const t of projected) {
      ctx.beginPath();
      ctx.moveTo(t.p0.sx, t.p0.sy);
      ctx.lineTo(t.p1.sx, t.p1.sy);
      ctx.lineTo(t.p2.sx, t.p2.sy);
      ctx.closePath();
      if (!wireframe) {
        const shade = Math.max(120, Math.min(240, Math.round(180 + t.zAvg * 1.2)));
        ctx.fillStyle = `rgb(${shade - 20}, ${shade}, ${Math.min(255, shade + 15)})`;
        ctx.fill();
      }
      ctx.strokeStyle = wireframe ? "rgba(245,146,46,0.75)" : "rgba(13,33,55,0.18)";
      ctx.lineWidth = wireframe ? 0.9 : 0.4;
      ctx.stroke();
    }
  }, [open, triangles, rot, zoom, wireframe, status, lang]);

  if (!open) return null;

  const content = (
    <div className="rounded-xl border border-navy-200 bg-navy-950 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-navy-900 px-3 py-2 text-xs text-white">
        <div className="flex items-center gap-2 font-bold">
          <Box className="h-4 w-4 text-brand-orange" />
          <span>{title || tr(lang, "عارض النماذج ثلاثية الأبعاد (3D)", "3D Dental Model Studio")}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setWireframe((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1 hover:bg-white/20"
          >
            <Layers className="h-3.5 w-3.5" />
            {wireframe ? tr(lang, "مظلّل", "Shaded") : tr(lang, "شبكي", "Wireframe")}
          </button>
          <button type="button" onClick={() => setZoom((z) => Math.min(2.5, z + 0.2))} className="rounded-lg bg-white/10 p-1 hover:bg-white/20">
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))} className="rounded-lg bg-white/10 p-1 hover:bg-white/20">
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setRot({ x: 0.4, y: 0.6 });
              setZoom(1);
            }}
            className="rounded-lg bg-white/10 p-1 hover:bg-white/20"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          {!embedded && onClose ? (
            <button type="button" onClick={onClose} className="rounded-lg bg-white/10 p-1 hover:bg-red-600">
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <canvas
        ref={canvasRef}
        width={760}
        height={360}
        onMouseDown={(e) => {
          dragRef.current = { active: true, x: e.clientX, y: e.clientY };
        }}
        onMouseMove={(e) => {
          if (!dragRef.current.active) return;
          const dx = e.clientX - dragRef.current.x;
          const dy = e.clientY - dragRef.current.y;
          dragRef.current = { active: true, x: e.clientX, y: e.clientY };
          setRot((prev) => ({ x: prev.x + dy * 0.01, y: prev.y + dx * 0.01 }));
        }}
        onMouseUp={() => {
          dragRef.current.active = false;
        }}
        onMouseLeave={() => {
          dragRef.current.active = false;
        }}
        className="w-full cursor-grab active:cursor-grabbing block"
      />

      {(onSaveMeasurement || onToothWidthMeasured || onSaveSuite) ? (
        <div className="flex flex-wrap items-center gap-2 bg-navy-900/95 px-3 py-2.5 text-xs text-white border-t border-navy-800">
          <Ruler className="h-3.5 w-3.5 text-brand-orange shrink-0" />
          <input
            type="text"
            value={manualLabel}
            onChange={(e) => setManualLabel(e.target.value)}
            className="rounded-lg bg-navy-800 border border-navy-700 px-2 py-1 text-xs text-white w-40"
          />
          <input
            type="number"
            step="0.1"
            value={manualMm}
            onChange={(e) => setManualMm(e.target.value)}
            className="rounded-lg bg-navy-800 border border-navy-700 px-2 py-1 text-xs text-white w-20 font-mono"
          />
          <span className="text-slate-300">mm</span>
          {onSaveMeasurement ? (
            <button
              type="button"
              onClick={() => {
                const v = Number(manualMm);
                if (Number.isFinite(v) && v > 0) onSaveMeasurement(v, manualLabel);
              }}
              className="inline-flex items-center gap-1 rounded-lg bg-brand-orange px-2.5 py-1 font-bold text-white"
            >
              <Save className="h-3 w-3" />
              {tr(lang, "حفظ القياس", "Save Measurement")}
            </button>
          ) : null}
          {onToothWidthMeasured ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={fdiInput}
                onChange={(e) => setFdiInput(e.target.value)}
                className="rounded-lg bg-navy-800 border border-navy-700 px-1.5 py-1 text-xs text-white w-12 font-mono"
                placeholder="FDI"
              />
              <button
                type="button"
                onClick={() => {
                  const v = Number(manualMm);
                  if (Number.isFinite(v) && v > 0 && fdiInput.trim()) onToothWidthMeasured(fdiInput.trim(), v);
                }}
                className="rounded-lg bg-emerald-600 px-2 py-1 font-bold text-white"
              >
                {tr(lang, "تسجيل عرض السن", "Save FDI Width")}
              </button>
            </div>
          ) : null}
          {onSaveSuite ? (
            <button
              type="button"
              onClick={() => {
                const v = Number(manualMm);
                if (Number.isFinite(v) && v > 0) {
                  onSaveSuite(
                    [
                      {
                        id: `m3d-${Date.now()}`,
                        kind: "caliper",
                        labelAr: manualLabel,
                        labelEn: manualLabel,
                        valueMm: v,
                      },
                    ],
                    manualLabel,
                  );
                }
              }}
              className="rounded-lg bg-sky-600 px-2.5 py-1 font-bold text-white"
            >
              {tr(lang, "حفظ ضمن التحليل", "Save to Analysis")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (embedded) return content;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4">
      <div className="w-full max-w-4xl">{content}</div>
    </div>
  );
};
