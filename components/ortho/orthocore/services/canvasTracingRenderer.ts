import { AnnotationItem, MeasurementAnalysis, MediaRecord } from '../types/ortho';
import { PhotoModeId, Point2D } from '../utils/orthoMath';

export type FrontalOverlayVariant = 'overview' | 'fifths' | 'thirds';

function isExtraoralView(viewType: string): boolean {
  return (
    viewType === 'extraoral_frontal' ||
    viewType === 'extraoral_profile' ||
    viewType === 'extraoral_smile' ||
    viewType === 'extraoral_oblique'
  );
}

async function urlToDataUrl(url: string, rawCache: Map<string, string | null>): Promise<string | null> {
  if (!url) return null;
  if (rawCache.has(url)) return rawCache.get(url) ?? null;
  try {
    if (url.startsWith('data:image/')) {
      rawCache.set(url, url);
      return url;
    }
    const res = await fetch(url);
    if (!res.ok) {
      rawCache.set(url, null);
      return null;
    }
    const blob = await res.blob();
    const b64 = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    rawCache.set(url, b64);
    return b64;
  } catch {
    rawCache.set(url, null);
    return null;
  }
}

async function loadImageElement(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 2.5,
  dash: number[] = [],
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function drawDoubleArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 2.6,
) {
  drawLine(ctx, x1, y1, x2, y2, color, width);
  const headLen = 10;
  const ang1 = Math.atan2(y2 - y1, x2 - x1);
  const ang2 = Math.atan2(y1 - y2, x1 - x2);
  ctx.save();
  ctx.fillStyle = color;
  for (const [bx, by, a] of [
    [x1, y1, ang1],
    [x2, y2, ang2],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + headLen * Math.cos(a - Math.PI / 6), by + headLen * Math.sin(a - Math.PI / 6));
    ctx.lineTo(bx + headLen * Math.cos(a + Math.PI / 6), by + headLen * Math.sin(a + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawSingleArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 2.6,
) {
  drawLine(ctx, x1, y1, x2, y2, color, width);
  const headLen = 11;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(ang - Math.PI / 6), y2 - headLen * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(x2 - headLen * Math.cos(ang + Math.PI / 6), y2 - headLen * Math.sin(ang + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPillBadge(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts?: { bg?: string; fg?: string; border?: string; fontSize?: number; alignCenter?: boolean },
) {
  const fontSize = opts?.fontSize ?? 15;
  ctx.save();
  ctx.font = `bold ${fontSize}px Arial, sans-serif`;
  const padX = 8;
  const padY = 4;
  const metrics = ctx.measureText(text);
  const w = metrics.width + padX * 2;
  const h = fontSize + padY * 2;
  const rx = opts?.alignCenter ? x - w / 2 : x;
  const ry = opts?.alignCenter ? y - h / 2 : y;

  ctx.fillStyle = opts?.bg ?? 'rgba(11, 31, 58, 0.86)';
  ctx.strokeStyle = opts?.border ?? 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(rx, ry, w, h, 5);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = opts?.fg ?? '#f8fafc';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, rx + padX, ry + h / 2 + 0.5);
  ctx.restore();
}

function drawLandmarkPin(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  color = '#38bdf8',
  radius = 5.5,
) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  if (label) {
    ctx.font = 'bold 14px monospace, Arial';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.92)';
    ctx.strokeText(label, x + radius + 4, y);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(label, x + radius + 4, y);
  }
  ctx.restore();
}

function drawEditorAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: AnnotationItem[],
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
) {
  for (const ann of annotations) {
    const x1 = boxX + ann.x1 * boxW;
    const y1 = boxY + ann.y1 * boxH;
    const x2 = ann.x2 !== undefined ? boxX + ann.x2 * boxW : x1;
    const y2 = ann.y2 !== undefined ? boxY + ann.y2 * boxH : y1;
    const col = ann.color || '#f5922e';

    if (ann.type === 'line') {
      drawLine(ctx, x1, y1, x2, y2, col, 3);
    } else if (ann.type === 'arrow') {
      drawSingleArrow(ctx, x1, y1, x2, y2, col, 3);
    } else if (ann.type === 'angle' && ann.x3 !== undefined && ann.y3 !== undefined) {
      const x3 = boxX + ann.x3 * boxW;
      const y3 = boxY + ann.y3 * boxH;
      drawLine(ctx, x1, y1, x2, y2, col, 2.8);
      drawLine(ctx, x2, y2, x3, y3, col, 2.8);
    } else if (ann.type === 'point') {
      drawLandmarkPin(ctx, x1, y1, ann.text || '', col, 6);
    } else if (ann.type === 'text' && ann.text) {
      drawPillBadge(ctx, ann.text, x1, y1, { bg: 'rgba(15, 23, 42, 0.88)', fg: col, border: col, fontSize: 15 });
    }
  }
}

function computeToothPolygonPts(apex: Point2D, tip: Point2D, stageSize: number): Array<{ x: number; y: number }> | null {
  const ax = apex.x * stageSize;
  const ay = apex.y * stageSize;
  const tx = tip.x * stageSize;
  const ty = tip.y * stageSize;
  const dx = tx - ax;
  const dy = ty - ay;
  const len = Math.hypot(dx, dy);
  if (len < 8) return null;
  const nx = -dy / len;
  const ny = dx / len;
  const w = len * 0.16;
  const cx = ax + dx * 0.56;
  const cy = ay + dy * 0.56;
  return [
    { x: ax, y: ay },
    { x: cx + nx * w * 0.95, y: cy + ny * w * 0.95 },
    { x: tx + nx * w * 0.55, y: ty + ny * w * 0.55 },
    { x: tx, y: ty },
    { x: tx - nx * w * 0.55, y: ty - ny * w * 0.55 },
    { x: cx - nx * w * 0.95, y: cy - ny * w * 0.95 },
  ];
}

function computeContainRect(imgW: number, imgH: number, stageW: number, stageH: number) {
  const scale = Math.min(stageW / Math.max(1, imgW), stageH / Math.max(1, imgH));
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const drawX = (stageW - drawW) / 2;
  const drawY = (stageH - drawH) / 2;
  return { drawX, drawY, drawW, drawH };
}

/**
 * Renders clean or annotated clinical media (with brightness/contrast, rotation,
 * anonymize eye-bar, and editor annotations baked onto an offscreen canvas).
 */
export async function renderMediaForSlide(
  media: MediaRecord | undefined,
  rawCache: Map<string, string | null>,
  opts?: { anonymize?: boolean; darkMatte?: boolean },
): Promise<string | null> {
  if (!media) return null;
  const srcUrl = media.derivedUrl || media.originalUrl;
  const cacheKey = `clean:${media.id}:${opts?.anonymize ? '1' : '0'}:${media.editorState?.updatedAt || ''}:${media.editorState?.annotations?.length || 0}`;
  if (rawCache.has(cacheKey)) return rawCache.get(cacheKey) ?? null;

  const baseB64 = await urlToDataUrl(srcUrl, rawCache);
  if (!baseB64) return null;

  const ed = media.editorState;
  const needAnonymizeBar =
    Boolean(ed?.anonymizeBar?.enabled) || Boolean(opts?.anonymize && isExtraoralView(media.viewType));
  const hasEdits =
    needAnonymizeBar ||
    (ed?.annotations && ed.annotations.length > 0) ||
    (ed && (ed.brightness !== 100 || ed.contrast !== 100 || ed.rotationDeg !== 0 || ed.tiltDeg !== 0));

  if (!hasEdits || typeof document === 'undefined') {
    rawCache.set(cacheKey, baseB64);
    return baseB64;
  }

  const img = await loadImageElement(baseB64);
  if (!img) return baseB64;

  const maxSide = 1400;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 800, img.naturalHeight || 800));
  const cw = Math.max(200, Math.round((img.naturalWidth || 800) * scale));
  const ch = Math.max(200, Math.round((img.naturalHeight || 600) * scale));

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return baseB64;

  ctx.fillStyle = opts?.darkMatte ? '#050b14' : '#ffffff';
  ctx.fillRect(0, 0, cw, ch);

  ctx.save();
  const b = ed?.brightness ?? 100;
  const c = ed?.contrast ?? 100;
  ctx.filter = `brightness(${b}%) contrast(${c}%)`;
  const totalRot = ((ed?.rotationDeg ?? 0) + (ed?.tiltDeg ?? 0)) * (Math.PI / 180);
  if (totalRot !== 0) {
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(totalRot);
    ctx.drawImage(img, -cw / 2, -ch / 2, cw, ch);
  } else {
    ctx.drawImage(img, 0, 0, cw, ch);
  }
  ctx.restore();

  if (needAnonymizeBar) {
    const yPct = ed?.anonymizeBar?.yPct ?? 28;
    const hPct = ed?.anonymizeBar?.hPct ?? 11;
    ctx.fillStyle = '#020617';
    ctx.fillRect(cw * 0.14, (ch * yPct) / 100, cw * 0.72, (ch * hPct) / 100);
  }

  if (ed?.annotations?.length) {
    drawEditorAnnotations(ctx, ed.annotations, 0, 0, cw, ch);
  }

  const out = canvas.toDataURL('image/jpeg', 0.92);
  rawCache.set(cacheKey, out);
  return out;
}

/**
 * Renders the Lateral Cephalogram WITH full anatomical tracing overlay:
 * Cranial base, Frankfort, Palatal, Mandibular, Occlusal planes, N-A, N-B,
 * Jarabak lines, U1 & L1 tooth silhouettes + axes, Soft-tissue profile curve,
 * Ricketts E-Line, Calibration ruler, Landmark labels, and Live Angle HUD!
 */
export async function renderCephalometricTracingImage(
  media: MediaRecord | undefined,
  cephAnalysis: MeasurementAnalysis | undefined,
  rawCache: Map<string, string | null>,
  isAr = false,
): Promise<string | null> {
  if (!media) return null;
  const lm = cephAnalysis?.landmarks || {};
  const placedKeys = Object.keys(lm);
  if (placedKeys.length === 0 || typeof document === 'undefined') {
    return renderMediaForSlide(media, rawCache, { darkMatte: true });
  }

  const cacheKey = `ceph_traced:${media.id}:${cephAnalysis?.id || 'live'}:${placedKeys.length}:${isAr ? 'ar' : 'en'}`;
  if (rawCache.has(cacheKey)) return rawCache.get(cacheKey) ?? null;

  const baseB64 = await urlToDataUrl(media.derivedUrl || media.originalUrl, rawCache);
  if (!baseB64) return null;
  const img = await loadImageElement(baseB64);
  if (!img) return baseB64;

  // CephTracingStudio uses a 1:1 square stage with object-contain
  const S = 1200;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  if (!ctx) return baseB64;

  ctx.fillStyle = '#050b14';
  ctx.fillRect(0, 0, S, S);

  const { drawX, drawY, drawW, drawH } = computeContainRect(
    img.naturalWidth || 1000,
    img.naturalHeight || 1000,
    S,
    S,
  );

  ctx.save();
  const b = Math.max(103, media.editorState?.brightness ?? 105);
  const c = Math.max(110, media.editorState?.contrast ?? 112);
  ctx.filter = `brightness(${b}%) contrast(${c}%)`;
  ctx.drawImage(img, drawX, drawY, drawW, drawH);
  ctx.restore();

  const pt = (k: string) => (lm[k] ? { x: lm[k].x * S, y: lm[k].y * S } : null);

  // 1. Cranial Base S-N & Ba-S & Jarabak N-S-Ar-Go-Me
  const pS = pt('S');
  const pN = pt('N');
  const pBa = pt('Ba');
  const pAr = pt('Ar');
  const pCo = pt('Co');
  const pPo = pt('Po');
  const pOr = pt('Or');
  const pANS = pt('ANS');
  const pPNS = pt('PNS');
  const pA = pt('A');
  const pB = pt('B');
  const pPog = pt('Pog');
  const pGn = pt('Gn');
  const pMe = pt('Me');
  const pGo = pt('Go');
  const pU1Tip = pt('U1Tip');
  const pU1Apex = pt('U1Apex');
  const pL1Tip = pt('L1Tip');
  const pL1Apex = pt('L1Apex');
  const pU6 = pt('U6');
  const pL6 = pt('L6');
  const pPn = pt('Pn');
  const pCol = pt('Col');
  const pSn = pt('Sn');
  const pLs = pt('Ls');
  const pLi = pt('Li');
  const pPogS = pt('PogS');

  if (pS && pN) drawLine(ctx, pS.x, pS.y, pN.x, pN.y, '#38bdf8', 3.0);
  if (pBa && pS) drawLine(ctx, pBa.x, pBa.y, pS.x, pS.y, '#38bdf8', 2.2, [7, 5]);
  if (pS && pAr) drawLine(ctx, pS.x, pS.y, pAr.x, pAr.y, 'rgba(56, 189, 248, 0.75)', 2.0, [5, 4]);
  if (pPo && pOr) drawLine(ctx, pPo.x, pPo.y, pOr.x, pOr.y, '#a78bfa', 2.6, [9, 5]);
  if (pPNS && pANS) drawLine(ctx, pPNS.x, pPNS.y, pANS.x, pANS.y, '#2dd4bf', 2.8);
  if (pN && pA) drawLine(ctx, pN.x, pN.y, pA.x, pA.y, '#34d399', 2.6);
  if (pN && pB) drawLine(ctx, pN.x, pN.y, pB.x, pB.y, '#f5922e', 2.6);
  if (pCo && pA) drawLine(ctx, pCo.x, pCo.y, pA.x, pA.y, 'rgba(45, 212, 191, 0.55)', 1.8, [6, 5]);
  if (pCo && (pGn || pMe)) {
    const dest = (pGn || pMe)!;
    drawLine(ctx, pCo.x, pCo.y, dest.x, dest.y, 'rgba(245, 146, 46, 0.55)', 1.8, [6, 5]);
  }
  if (pGo && (pMe || pGn)) {
    const dest = (pMe || pGn)!;
    drawLine(ctx, pGo.x, pGo.y, dest.x, dest.y, '#f472b6', 3.0);
  }
  if (pAr && pGo) drawLine(ctx, pAr.x, pAr.y, pGo.x, pGo.y, '#f472b6', 2.5);

  // Functional Occlusal Plane
  const occRear = pU6 && pL6 ? { x: (pU6.x + pL6.x) / 2, y: (pU6.y + pL6.y) / 2 } : pU6 || pL6;
  const occFront = pU1Tip && pL1Tip ? { x: (pU1Tip.x + pL1Tip.x) / 2, y: (pU1Tip.y + pL1Tip.y) / 2 } : pU1Tip || pL1Tip;
  if (occRear && occFront) {
    drawLine(ctx, occRear.x, occRear.y, occFront.x, occFront.y, '#facc15', 2.3, [6, 5]);
  }

  // Ricketts E-Line & Nasolabial
  if (pPn && pPogS) drawLine(ctx, pPn.x, pPn.y, pPogS.x, pPogS.y, '#22c55e', 2.4, [7, 5]);
  if (pCol && pSn && pLs) {
    drawLine(ctx, pCol.x, pCol.y, pSn.x, pSn.y, '#fbbf24', 2.2);
    drawLine(ctx, pSn.x, pSn.y, pLs.x, pLs.y, '#fbbf24', 2.2);
  }

  // Soft-tissue profile contour
  const softSeq = [pPn, pCol, pSn, pLs, pLi, pPogS].filter((x): x is { x: number; y: number } => Boolean(x));
  if (softSeq.length >= 3) {
    ctx.save();
    ctx.strokeStyle = '#fde68a';
    ctx.lineWidth = 2.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(softSeq[0].x, softSeq[0].y);
    for (let i = 1; i < softSeq.length; i++) {
      ctx.lineTo(softSeq[i].x, softSeq[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Stylized Tooth Silhouettes (U1 & L1)
  if (lm.U1Apex && lm.U1Tip) {
    const poly = computeToothPolygonPts(lm.U1Apex, lm.U1Tip, S);
    if (poly) {
      ctx.save();
      ctx.fillStyle = 'rgba(251, 113, 133, 0.32)';
      ctx.strokeStyle = '#fb7185';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    drawLine(ctx, pU1Apex!.x, pU1Apex!.y, pU1Tip!.x, pU1Tip!.y, '#fb7185', 2.0, [4, 3]);
  }
  if (lm.L1Apex && lm.L1Tip) {
    const poly = computeToothPolygonPts(lm.L1Apex, lm.L1Tip, S);
    if (poly) {
      ctx.save();
      ctx.fillStyle = 'rgba(96, 165, 250, 0.32)';
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    drawLine(ctx, pL1Apex!.x, pL1Apex!.y, pL1Tip!.x, pL1Tip!.y, '#60a5fa', 2.0, [4, 3]);
  }

  // Calibration Ruler if present
  if (media.calibration?.p1 && media.calibration?.p2) {
    const c1 = { x: media.calibration.p1.x * S, y: media.calibration.p1.y * S };
    const c2 = { x: media.calibration.p2.x * S, y: media.calibration.p2.y * S };
    drawDoubleArrow(ctx, c1.x, c1.y, c2.x, c2.y, '#f5922e', 2.4);
    if (media.calibration.knownMm) {
      drawPillBadge(ctx, `${media.calibration.knownMm} mm`, (c1.x + c2.x) / 2 + 8, (c1.y + c2.y) / 2 - 12, {
        bg: 'rgba(245, 146, 46, 0.9)',
        fg: '#0b1f3a',
        border: '#ffffff',
        fontSize: 13,
      });
    }
  }

  // Landmark Pins
  for (const [k, rawPt] of Object.entries(lm)) {
    const px = rawPt.x * S;
    const py = rawPt.y * S;
    const isSoft = ['Pn', 'Col', 'Sn', 'Ls', 'Li', 'PogS'].includes(k);
    const isDent = ['U1Tip', 'U1Apex', 'L1Tip', 'L1Apex', 'U6', 'L6'].includes(k);
    const col = isSoft ? '#22c55e' : isDent ? '#fb7185' : '#38bdf8';
    const shortLabel = k === 'PogS' ? "Pog'" : k;
    drawLandmarkPin(ctx, px, py, shortLabel, col, 5.5);
  }

  // Live Key Angle Callout Strip at top-left
  const keyAngles = ['SNA', 'SNB', 'ANB', 'FMA', 'IMPA', 'U1_SN'];
  const hudItems = keyAngles
    .map((k) => cephAnalysis?.metrics.find((m) => m.key === k))
    .filter((m): m is NonNullable<typeof m> => Boolean(m && m.value !== null));

  if (hudItems.length > 0) {
    const hudText = hudItems
      .map((m) => `${m.key.replace('_SN', '-SN')}: ${m.value}${m.unit === 'deg' ? '°' : 'mm'}`)
      .join('   |   ');
    drawPillBadge(ctx, hudText, 22, 22, {
      bg: 'rgba(7, 21, 41, 0.90)',
      fg: '#38bdf8',
      border: '#f5922e',
      fontSize: 16,
    });
  }

  if (pPog) {
    // Keep TypeScript happy when Pog is placed
  }

  const out = canvas.toDataURL('image/jpeg', 0.93);
  rawCache.set(cacheKey, out);
  return out;
}

/**
 * Renders Clinical Photo (Extraoral or Intraoral) WITH Photo Analysis geometric lines,
 * landmarks, curves, and metric badges baked onto an offscreen canvas!
 */
export async function renderPhotoAnalysisImage(
  media: MediaRecord | undefined,
  mode: PhotoModeId,
  photoAnalysis: MeasurementAnalysis | undefined,
  rawCache: Map<string, string | null>,
  opts?: {
    anonymize?: boolean;
    frontalVariant?: FrontalOverlayVariant;
  },
): Promise<string | null> {
  if (!media) return null;
  const lm = photoAnalysis?.landmarks || {};
  const hasLandmarks = Object.keys(lm).length > 0;

  if (!hasLandmarks || typeof document === 'undefined') {
    return renderMediaForSlide(media, rawCache, { anonymize: opts?.anonymize });
  }

  const variant = opts?.frontalVariant || 'overview';
  const cacheKey = `photo_traced:${media.id}:${mode}:${variant}:${photoAnalysis?.id || ''}:${Object.keys(lm).length}:${opts?.anonymize ? '1' : '0'}`;
  if (rawCache.has(cacheKey)) return rawCache.get(cacheKey) ?? null;

  const baseB64 = await urlToDataUrl(media.derivedUrl || media.originalUrl, rawCache);
  if (!baseB64) return null;
  const img = await loadImageElement(baseB64);
  if (!img) return baseB64;

  // PhotoAnalysisStudio uses a 4:3 stage (1200 x 900) with object-contain
  const CW = 1200;
  const CH = 900;
  const canvas = document.createElement('canvas');
  canvas.width = CW;
  canvas.height = CH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return baseB64;

  ctx.fillStyle = '#0b1324';
  ctx.fillRect(0, 0, CW, CH);

  const { drawX, drawY, drawW, drawH } = computeContainRect(
    img.naturalWidth || 1200,
    img.naturalHeight || 900,
    CW,
    CH,
  );

  ctx.save();
  const b = media.editorState?.brightness ?? 100;
  const c = media.editorState?.contrast ?? 100;
  ctx.filter = `brightness(${b}%) contrast(${c}%)`;
  ctx.drawImage(img, drawX, drawY, drawW, drawH);
  ctx.restore();

  // Optional anonymize bar
  const needAnon =
    Boolean(media.editorState?.anonymizeBar?.enabled) || Boolean(opts?.anonymize && isExtraoralView(media.viewType));
  if (needAnon) {
    const yPct = media.editorState?.anonymizeBar?.yPct ?? 28;
    const hPct = media.editorState?.anonymizeBar?.hPct ?? 11;
    ctx.fillStyle = '#020617';
    ctx.fillRect(drawX + drawW * 0.16, drawY + (drawH * yPct) / 100, drawW * 0.68, (drawH * hPct) / 100);
  }

  const p = (k: string) => (lm[k] ? { x: lm[k].x * CW, y: lm[k].y * CH } : null);
  const getVal = (k: string) => {
    const m = photoAnalysis?.metrics.find((x) => x.key === k);
    return m && m.value !== null ? `${m.value}${m.unit === 'deg' ? '°' : m.unit === '%' ? '%' : ' mm'}` : null;
  };

  // ── MODE: EXTRAORAL FRONTAL (Overview / Rule of Fifths / Vertical Thirds) ──
  if (mode === 'frontal') {
    const Tr = p('Tr');
    const G = p('G');
    const Sn = p('Sn');
    const MeS = p('MeS');
    const PuR = p('PuR');
    const PuL = p('PuL');
    const AlR = p('AlR');
    const AlL = p('AlL');
    const ChR = p('ChR');
    const ChL = p('ChL');
    const MidDental = p('MidDental');

    const topY = Tr ? Math.max(40, Tr.y - 45) : drawY + 35;
    const botY = MeS ? Math.min(CH - 35, MeS.y + 45) : drawY + drawH - 35;
    const leftX = Math.max(60, drawX + drawW * 0.12);
    const rightX = Math.min(CW - 60, drawX + drawW * 0.88);

    if (variant === 'fifths' || variant === 'overview') {
      // Rule of Fifths vertical lines (matching PDF Slide 7)
      if (AlR && AlL) {
        const centralW = Math.abs(AlL.x - AlR.x);
        const minAlX = Math.min(AlR.x, AlL.x);
        const maxAlX = Math.max(AlR.x, AlL.x);
        const outerRX = minAlX - centralW * 1.95;
        const outerLX = maxAlX + centralW * 1.95;
        const midRX = minAlX - centralW * 0.98;
        const midLX = maxAlX + centralW * 0.98;
        for (const vx of [outerRX, midRX, minAlX, maxAlX, midLX, outerLX]) {
          if (vx > 20 && vx < CW - 20) {
            drawLine(ctx, vx, topY, vx, botY, '#facc15', 2.8);
          }
        }
      } else if (PuR && PuL) {
        for (const vx of [PuR.x, PuL.x]) {
          drawLine(ctx, vx, topY, vx, botY, '#facc15', 2.5, [7, 5]);
        }
      }
      if (PuR && PuL) {
        drawLine(ctx, PuR.x, PuR.y, PuL.x, PuL.y, '#22c55e', 2.6);
        const midX = (PuR.x + PuL.x) / 2;
        drawLine(ctx, midX, topY, midX, botY, '#f5922e', 2.4, [6, 5]);
      }
      if (ChR && ChL) {
        drawLine(ctx, ChR.x, ChR.y, ChL.x, ChL.y, '#f472b6', 2.6);
        if (variant === 'fifths') {
          drawLine(ctx, ChR.x, PuR ? PuR.y : topY + 120, ChR.x, botY - 30, '#38bdf8', 2.0, [5, 4]);
          drawLine(ctx, ChL.x, PuL ? PuL.y : topY + 120, ChL.x, botY - 30, '#38bdf8', 2.0, [5, 4]);
        }
      }
      if (MidDental) {
        drawLandmarkPin(ctx, MidDental.x, MidDental.y, 'Mid', '#f5922e', 5.5);
      }
    }

    if (variant === 'thirds' || variant === 'overview') {
      // Horizontal Facial Thirds & Lower-Third 1/3 : 2/3 Subdivision (matching PDF Slide 8)
      for (const [lbl, ptObj] of [
        ['Tr', Tr],
        ['G', G],
        ['Sn', Sn],
        ["Me'", MeS],
      ] as const) {
        if (ptObj) {
          drawLine(ctx, leftX, ptObj.y, rightX, ptObj.y, '#facc15', 2.8);
          drawLandmarkPin(ctx, ptObj.x, ptObj.y, lbl, '#38bdf8', 5.5);
        }
      }
      // Stomion 1/3 line inside Lower Third
      if (Sn && MeS) {
        const stomY = ChR && ChL ? (ChR.y + ChL.y) / 2 : Sn.y + (MeS.y - Sn.y) * 0.333;
        drawLine(ctx, leftX + 40, stomY, rightX - 40, stomY, '#38bdf8', 2.2, [6, 4]);
      }
      // Cyan Vertical Dimension Arrows on Right Side (matching PDF Slide 8)
      const arrowX = Math.min(CW - 95, rightX - 35);
      const u3 = getVal('FACIAL_UPPER_THIRD');
      const m3 = getVal('FACIAL_MID_THIRD');
      const l3 = getVal('FACIAL_LOWER_THIRD');
      if (Tr && G) {
        drawDoubleArrow(ctx, arrowX, Tr.y + 4, arrowX, G.y - 4, '#22d3ee', 2.8);
        if (u3) drawPillBadge(ctx, `U: ${u3}`, arrowX - 95, (Tr.y + G.y) / 2 - 13, { fontSize: 14, fg: '#22d3ee' });
      }
      if (G && Sn) {
        drawDoubleArrow(ctx, arrowX, G.y + 4, arrowX, Sn.y - 4, '#22d3ee', 2.8);
        if (m3) drawPillBadge(ctx, `M: ${m3}`, arrowX - 95, (G.y + Sn.y) / 2 - 13, { fontSize: 14, fg: '#22d3ee' });
      }
      if (Sn && MeS) {
        drawDoubleArrow(ctx, arrowX, Sn.y + 4, arrowX, MeS.y - 4, '#22d3ee', 2.8);
        if (l3) drawPillBadge(ctx, `L: ${l3}`, arrowX - 95, (Sn.y + MeS.y) / 2 - 13, { fontSize: 14, fg: '#22d3ee' });
      }
    }
  }

  // ── MODE: EXTRAORAL PROFILE (PDF Slide 5) ──
  if (mode === 'profile') {
    const G = p('G');
    const Pn = p('Pn');
    const Col = p('Col');
    const Sn = p('Sn');
    const Ls = p('Ls');
    const Li = p('Li');
    const BS = p('BS');
    const PogS = p('PogS');

    if (G && Sn && PogS) {
      drawLine(ctx, G.x, G.y, Sn.x, Sn.y, '#38bdf8', 3.0);
      drawLine(ctx, Sn.x, Sn.y, PogS.x, PogS.y, '#38bdf8', 3.0);
    }
    if (Col && Sn && Ls) {
      drawLine(ctx, Col.x, Col.y, Sn.x, Sn.y, '#f5922e', 3.0);
      drawLine(ctx, Sn.x, Sn.y, Ls.x, Ls.y, '#f5922e', 3.0);
    }
    if (Li && BS && PogS) {
      drawLine(ctx, Li.x, Li.y, BS.x, BS.y, '#f472b6', 2.6);
      drawLine(ctx, BS.x, BS.y, PogS.x, PogS.y, '#f472b6', 2.6);
    }
    if (Pn && PogS) {
      drawLine(ctx, Pn.x, Pn.y, PogS.x, PogS.y, '#22c55e', 2.8, [8, 5]);
    }

    for (const [k, rawPt] of Object.entries(lm)) {
      drawLandmarkPin(ctx, rawPt.x * CW, rawPt.y * CH, k === 'PogS' ? "Pog'" : k === 'BS' ? "B'" : k, '#facc15', 5.5);
    }

    const badges = [
      getVal('PHOTO_CONVEXITY') && `Convexity: ${getVal('PHOTO_CONVEXITY')}`,
      getVal('PHOTO_NASOLABIAL') && `NLA: ${getVal('PHOTO_NASOLABIAL')}`,
      getVal('PHOTO_LS_E') && `Ls-E: ${getVal('PHOTO_LS_E')}`,
      getVal('PHOTO_LI_E') && `Li-E: ${getVal('PHOTO_LI_E')}`,
    ].filter(Boolean) as string[];
    if (badges.length > 0) {
      drawPillBadge(ctx, badges.join('  |  '), 22, 22, { fg: '#facc15', border: '#38bdf8', fontSize: 15 });
    }
  }

  // ── MODE: EXTRAORAL SMILE (PDF Slide 6) ──
  if (mode === 'smile') {
    const ChR = p('ChR');
    const ChL = p('ChL');
    const DentR = p('DentR');
    const DentL = p('DentL');
    const FaceMid = p('FaceMid');
    const DentMid = p('DentMid');
    const U1Edge = p('U1Edge');

    if (ChR && ChL) drawLine(ctx, ChR.x, ChR.y, ChL.x, ChL.y, '#38bdf8', 2.6, [8, 5]);
    if (DentR && DentL) drawLine(ctx, DentR.x, DentR.y, DentL.x, DentL.y, '#22c55e', 3.0);
    if (FaceMid) drawLine(ctx, FaceMid.x, Math.max(40, FaceMid.y - 220), FaceMid.x, Math.min(CH - 40, FaceMid.y + 260), '#f5922e', 3.0, [7, 5]);
    if (DentMid) drawLine(ctx, DentMid.x, Math.max(60, DentMid.y - 90), DentMid.x, Math.min(CH - 40, DentMid.y + 110), '#22c55e', 2.8);
    if (ChR && U1Edge && ChL) {
      ctx.save();
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(ChR.x, ChR.y);
      ctx.quadraticCurveTo(U1Edge.x, U1Edge.y + 32, ChL.x, ChL.y);
      ctx.stroke();
      ctx.restore();
    }
    for (const [k, rawPt] of Object.entries(lm)) {
      drawLandmarkPin(ctx, rawPt.x * CW, rawPt.y * CH, k, '#38bdf8', 5);
    }
    const sBadges = [
      getVal('BUCCAL_CORRIDOR') && `Buccal Corridor: ${getVal('BUCCAL_CORRIDOR')}`,
      getVal('SMILE_MIDLINE_SHIFT') && `Midline Shift: ${getVal('SMILE_MIDLINE_SHIFT')}`,
      getVal('GINGIVAL_DISPLAY_MM') && `Gingival: ${getVal('GINGIVAL_DISPLAY_MM')}`,
    ].filter(Boolean) as string[];
    if (sBadges.length > 0) {
      drawPillBadge(ctx, sBadges.join('  |  '), 22, 22, { fg: '#fde68a', border: '#22c55e', fontSize: 15 });
    }
  }

  // ── MODE: INTRAORAL FRONTAL (PDF Slide 9 & 11) ──
  if (mode === 'intraoral_frontal') {
    const UMid = p('UMid');
    const LMid = p('LMid');
    const UCanR = p('UCanR');
    const UCanL = p('UCanL');
    const Zen11 = p('Zen11');
    const Zen21 = p('Zen21');
    const U1Edge = p('U1Edge');
    const L1Edge = p('L1Edge');
    const W11R = p('W11R');
    const W11L = p('W11L');
    const W12R = p('W12R');
    const W12L = p('W12L');

    if (UMid) drawLine(ctx, UMid.x, 90, UMid.x, CH - 90, '#f5922e', 3.0, [7, 5]);
    if (LMid) drawLine(ctx, LMid.x, CH * 0.44, LMid.x, CH - 80, '#22c55e', 3.0, [5, 4]);
    if (UCanR && UCanL) drawLine(ctx, UCanR.x, UCanR.y, UCanL.x, UCanL.y, '#38bdf8', 3.0);
    if (Zen11 && Zen21) drawLine(ctx, Zen11.x, Zen11.y, Zen21.x, Zen21.y, '#22c55e', 2.4);
    if (U1Edge && L1Edge) drawDoubleArrow(ctx, U1Edge.x, U1Edge.y, L1Edge.x, L1Edge.y, '#f472b6', 2.8);
    if (W11R && W11L) drawLine(ctx, W11R.x, W11R.y, W11L.x, W11L.y, '#facc15', 2.8);
    if (W12R && W12L) drawLine(ctx, W12R.x, W12R.y, W12L.x, W12L.y, '#facc15', 2.8);

    for (const [k, rawPt] of Object.entries(lm)) {
      drawLandmarkPin(ctx, rawPt.x * CW, rawPt.y * CH, k, '#38bdf8', 5);
    }
  }

  // ── MODE: INTRAORAL RIGHT & LEFT BUCCAL (PDF Slide 9 & 11) ──
  if (mode === 'intraoral_right' || mode === 'intraoral_left') {
    const U6MB = p('U6MB');
    const L6Groove = p('L6Groove');
    const U3Tip = p('U3Tip');
    const L34Embr = p('L34Embr');
    const U1Axis = p('U1Axis');
    const U1Lab = p('U1Lab');
    const L1Lab = p('L1Lab');

    if (U6MB && (U3Tip || U1Lab)) {
      const f = (U3Tip || U1Lab)!;
      drawLine(ctx, U6MB.x, U6MB.y, f.x, f.y, '#38bdf8', 2.6, [8, 5]);
    }
    if (U6MB && L6Groove) drawLine(ctx, U6MB.x, U6MB.y, L6Groove.x, L6Groove.y, '#22c55e', 3.2);
    if (U3Tip && L34Embr) drawLine(ctx, U3Tip.x, U3Tip.y, L34Embr.x, L34Embr.y, '#facc15', 3.2);
    if (U1Axis && U1Lab) drawLine(ctx, U1Axis.x, U1Axis.y, U1Lab.x, U1Lab.y, '#f5922e', 3.0);
    if (U1Lab && L1Lab) drawDoubleArrow(ctx, U1Lab.x, U1Lab.y, L1Lab.x, L1Lab.y, '#f472b6', 2.8);

    for (const [k, rawPt] of Object.entries(lm)) {
      drawLandmarkPin(ctx, rawPt.x * CW, rawPt.y * CH, k, '#facc15', 5);
    }
  }

  // ── MODE: INTRAORAL UPPER & LOWER OCCLUSAL (PDF Slide 9 & 10) ──
  if (mode === 'intraoral_upper' || mode === 'intraoral_lower') {
    const IncMid = p('IncMid');
    const PalMid = p('PalMid');
    const IncEdge = p('IncEdge');
    const C3R = p('C3R');
    const C3L = p('C3L');
    const P4R = p('P4R');
    const P4L = p('P4L');
    const M6R = p('M6R');
    const M6L = p('M6L');

    if (IncMid && PalMid) drawLine(ctx, IncMid.x, IncMid.y, PalMid.x, PalMid.y, '#f5922e', 3.0, [8, 5]);
    if (C3R && C3L) drawDoubleArrow(ctx, C3R.x, C3R.y, C3L.x, C3L.y, '#38bdf8', 2.8);
    if (P4R && P4L) drawDoubleArrow(ctx, P4R.x, P4R.y, P4L.x, P4L.y, '#22c55e', 2.8);
    if (M6R && M6L) drawDoubleArrow(ctx, M6R.x, M6R.y, M6L.x, M6L.y, '#f472b6', 2.8);

    const archPts = [M6R, P4R, C3R, IncEdge, C3L, P4L, M6L].filter((x): x is { x: number; y: number } => Boolean(x));
    if (archPts.length >= 4) {
      ctx.save();
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 3.2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(archPts[0].x, archPts[0].y);
      for (let i = 1; i < archPts.length; i++) ctx.lineTo(archPts[i].x, archPts[i].y);
      ctx.stroke();
      ctx.restore();
    }

    for (const [k, rawPt] of Object.entries(lm)) {
      drawLandmarkPin(ctx, rawPt.x * CW, rawPt.y * CH, k, '#38bdf8', 5);
    }

    const oBadges = [
      getVal('OCC_INTERCANINE_W') && `3-3: ${getVal('OCC_INTERCANINE_W')}`,
      getVal('OCC_INTERPREMOLAR_W') && `4-4: ${getVal('OCC_INTERPREMOLAR_W')}`,
      getVal('OCC_INTERMOLAR_W') && `6-6: ${getVal('OCC_INTERMOLAR_W')}`,
      getVal('OCC_ARCH_RATIO') && `Ratio: ${getVal('OCC_ARCH_RATIO')}`,
    ].filter(Boolean) as string[];
    if (oBadges.length > 0) {
      drawPillBadge(ctx, oBadges.join('  |  '), 22, 22, { fg: '#fde68a', border: '#38bdf8', fontSize: 15 });
    }
  }

  if (media.editorState?.annotations?.length) {
    drawEditorAnnotations(ctx, media.editorState.annotations, drawX, drawY, drawW, drawH);
  }

  const out = canvas.toDataURL('image/jpeg', 0.93);
  rawCache.set(cacheKey, out);
  return out;
}
