"use client";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Contrast,
  Crosshair,
  RotateCcw,
  Ruler,
  Save,
  Scan,
  Trash2,
  Upload,
} from 'lucide-react';
import { Language, MeasurementAnalysis, PatientCase, RecordStage, UserRole } from '../types/ortho';
import { tr } from '../i18n/translations';

export type PlaneKind = 'axial' | 'coronal' | 'sagittal';

export interface CbctVolume {
  nx: number;
  ny: number;
  nz: number;
  spacingMm: [number, number, number]; // [dx, dy, dz]
  data: Int16Array;
  modality: string;
  fov: string;
  patientName: string;
  studyDate: string;
  sourceLabel: string;
}

export interface CbctMeasurement {
  id: string;
  plane: PlaneKind;
  kind: 'distance' | 'angle';
  label: string;
  value: number;
  unit: 'mm' | 'deg';
}

interface ParsedDicomSlice {
  rows: number;
  cols: number;
  frames: number;
  bitsAllocated: number;
  pixelSpacingMm: [number, number];
  sliceThicknessMm: number;
  sliceLocation: number;
  instanceNumber: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  modality: string;
  studyDate: string;
  patientName: string;
  pixelData: Uint16Array | Uint8Array;
}

interface CbctStudioProps {
  patient?: PatientCase;
  stage?: RecordStage;
  lang: Language;
  role?: UserRole;
  actorName?: string;
  initialUrl?: string;
  onChange?: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
  onCalibrateFromDicom?: (pixelsPerMm: number, source: string) => void;
}

function parseDicomSliceBuffer(buffer: ArrayBuffer): ParsedDicomSlice {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let offset = 0;
  if (bytes.length > 132 && String.fromCharCode(bytes[128], bytes[129], bytes[130], bytes[131]) === 'DICM') {
    offset = 132;
  }

  let rows = 512;
  let cols = 512;
  let frames = 1;
  let bitsAllocated = 16;
  let pixelSpacingMm: [number, number] = [0.3, 0.3];
  let sliceThicknessMm = 0.3;
  let sliceLocation = 0;
  let instanceNumber = 0;
  let rescaleSlope = 1;
  let rescaleIntercept = -1000;
  let modality = 'CBCT';
  let studyDate = '';
  let patientName = '';
  let pixelDataOffset = -1;
  let pixelDataLength = 0;

  const explicitVRs = new Set([
    'AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FL', 'FD', 'IS', 'LO', 'LT', 'OB', 'OD', 'OF', 'OW', 'PN', 'SH', 'SL', 'SQ', 'SS', 'ST', 'TM', 'UI', 'UL', 'UN', 'US', 'UT',
  ]);
  const longVRs = new Set(['OB', 'OD', 'OF', 'OW', 'SQ', 'UN', 'UT']);

  const readString = (start: number, len: number) =>
    new TextDecoder('ascii').decode(bytes.slice(start, start + len)).replace(/\0/g, '').trim();

  while (offset + 8 < bytes.length) {
    const group = view.getUint16(offset, true);
    const elem = view.getUint16(offset + 2, true);
    const tag = `${group.toString(16).padStart(4, '0')},${elem.toString(16).padStart(4, '0')}`;
    offset += 4;

    const vrCandidate = String.fromCharCode(bytes[offset], bytes[offset + 1]);
    let length = 0;
    if (explicitVRs.has(vrCandidate)) {
      offset += 2;
      if (longVRs.has(vrCandidate)) {
        offset += 2;
        length = view.getUint32(offset, true);
        offset += 4;
      } else {
        length = view.getUint16(offset, true);
        offset += 2;
      }
    } else {
      length = view.getUint32(offset, true);
      offset += 4;
    }

    if (length === 0xffffffff || length < 0 || offset + length > bytes.length) {
      if (tag === '7fe0,0010') {
        pixelDataOffset = offset;
        pixelDataLength = bytes.length - offset;
      }
      break;
    }

    if (tag === '0008,0020') studyDate = readString(offset, length);
    else if (tag === '0008,0060') modality = readString(offset, length) || modality;
    else if (tag === '0010,0010') patientName = readString(offset, length);
    else if (tag === '0018,0050') {
      const val = Number(readString(offset, length));
      if (val > 0) sliceThicknessMm = val;
    } else if (tag === '0020,0013') {
      const val = Number(readString(offset, length));
      if (!Number.isNaN(val)) instanceNumber = val;
    } else if (tag === '0020,1041') {
      const val = Number(readString(offset, length));
      if (!Number.isNaN(val)) sliceLocation = val;
    } else if (tag === '0028,0008') {
      const val = Number(readString(offset, length));
      if (val >= 1) frames = val;
    } else if (tag === '0028,0010') rows = view.getUint16(offset, true);
    else if (tag === '0028,0011') cols = view.getUint16(offset, true);
    else if (tag === '0028,0100') bitsAllocated = view.getUint16(offset, true);
    else if (tag === '0028,0030') {
      const parts = readString(offset, length).split('\\').map(Number);
      if (parts.length >= 2 && parts[0] > 0 && parts[1] > 0) {
        pixelSpacingMm = [parts[0], parts[1]];
      }
    } else if (tag === '0028,1052') {
      const val = Number(readString(offset, length));
      if (!Number.isNaN(val)) rescaleIntercept = val;
    } else if (tag === '0028,1053') {
      const val = Number(readString(offset, length));
      if (val > 0) rescaleSlope = val;
    } else if (tag === '7fe0,0010') {
      pixelDataOffset = offset;
      pixelDataLength = length;
      break;
    }

    offset += length;
  }

  if (pixelDataOffset < 0) {
    throw new Error('Uncompressed PixelData (7FE0,0010) not found in DICOM file.');
  }

  const totalPixels = rows * cols * frames;
  let pixelData: Uint16Array | Uint8Array;
  if (bitsAllocated === 16 && pixelDataLength >= totalPixels * 2) {
    pixelData = new Uint16Array(buffer.slice(pixelDataOffset, pixelDataOffset + totalPixels * 2));
  } else {
    const len = Math.min(totalPixels, pixelDataLength);
    pixelData = new Uint8Array(buffer.slice(pixelDataOffset, pixelDataOffset + len));
  }

  return {
    rows,
    cols,
    frames,
    bitsAllocated,
    pixelSpacingMm,
    sliceThicknessMm,
    sliceLocation,
    instanceNumber,
    rescaleSlope,
    rescaleIntercept,
    modality,
    studyDate,
    patientName,
    pixelData,
  };
}

function slicesToCbctVolume(slices: ParsedDicomSlice[], sourceLabel: string): CbctVolume {
  if (slices.length === 1 && slices[0].frames > 1) {
    const s = slices[0];
    const nx = s.cols;
    const ny = s.rows;
    const nz = s.frames;
    const data = new Int16Array(nx * ny * nz);
    for (let i = 0; i < data.length && i < s.pixelData.length; i++) {
      data[i] = Math.round(s.pixelData[i] * s.rescaleSlope + s.rescaleIntercept);
    }
    return {
      nx,
      ny,
      nz,
      spacingMm: [s.pixelSpacingMm[0], s.pixelSpacingMm[1], s.sliceThicknessMm],
      data,
      modality: s.modality,
      fov: `${(nx * s.pixelSpacingMm[0]).toFixed(0)}×${(ny * s.pixelSpacingMm[1]).toFixed(0)}×${(nz * s.sliceThicknessMm).toFixed(0)} mm`,
      patientName: s.patientName || 'CBCT Study',
      studyDate: s.studyDate || '—',
      sourceLabel,
    };
  }

  const sorted = [...slices].sort((a, b) =>
    a.sliceLocation !== b.sliceLocation ? a.sliceLocation - b.sliceLocation : a.instanceNumber - b.instanceNumber,
  );
  const first = sorted[0];
  const nx = first.cols;
  const ny = first.rows;
  const nz = sorted.length;
  const data = new Int16Array(nx * ny * nz);

  for (let z = 0; z < nz; z++) {
    const sl = sorted[z];
    const sliceOffset = z * nx * ny;
    const count = Math.min(nx * ny, sl.pixelData.length);
    for (let i = 0; i < count; i++) {
      data[sliceOffset + i] = Math.round(sl.pixelData[i] * sl.rescaleSlope + sl.rescaleIntercept);
    }
  }

  let dz = first.sliceThicknessMm;
  if (sorted.length > 1) {
    const diff = Math.abs(sorted[1].sliceLocation - sorted[0].sliceLocation);
    if (diff > 0.05 && diff < 10) dz = diff;
  }

  return {
    nx,
    ny,
    nz,
    spacingMm: [first.pixelSpacingMm[0], first.pixelSpacingMm[1], dz],
    data,
    modality: first.modality,
    fov: `${(nx * first.pixelSpacingMm[0]).toFixed(0)}×${(ny * first.pixelSpacingMm[1]).toFixed(0)}×${(nz * dz).toFixed(0)} mm`,
    patientName: first.patientName || 'CBCT Series',
    studyDate: first.studyDate || '—',
    sourceLabel,
  };
}

/**
 * Generates an anatomically structured 3D Craniofacial CBCT volume in Hounsfield Units:
 * - Soft tissue facial envelope
 * - Maxillary & Mandibular parabolic cortical + trabecular arches
 * - Dental crowns + roots (including palatally impacted #13 canine for clinical CBCT localization)
 * - Bilateral Inferior Alveolar Canals
 * - Posterior Oropharyngeal Airway lumen (-950 HU)
 */
function generateCraniofacialCbctVolume(): CbctVolume {
  const nx = 104;
  const ny = 104;
  const nz = 80;
  const data = new Int16Array(nx * ny * nz);
  const cx = nx / 2;
  const cy = ny / 2;

  for (let z = 0; z < nz; z++) {
    // z = 0 inferior mandible, z = 79 superior nasal/orbital floor
    const zNorm = z / (nz - 1);
    for (let y = 0; y < ny; y++) {
      // y = 0 anterior (lips), y = ny-1 posterior (spine/airway)
      const dy = y - 48;
      for (let x = 0; x < nx; x++) {
        const dx = x - cx;
        let hu = -1000; // Air background

        // Outer soft tissue facial contour
        const softDist = Math.hypot(dx * 0.92, (y - 52) * 0.85);
        if (softDist < 42) {
          hu = 45;
        }

        // Oropharyngeal airway posteriorly (centered around x=cx, y=74..85)
        const airwayDist = Math.hypot(dx * 1.15, (y - 77) * 1.35);
        if (airwayDist < 8.5 + Math.sin(zNorm * Math.PI) * 1.8) {
          hu = -940;
          data[z * nx * ny + y * nx + x] = hu;
          continue;
        }

        // Cervical vertebra posteriorly (y ~ 90)
        if (Math.hypot(dx, y - 92) < 9.5 && z > 8 && z < 74) {
          hu = Math.hypot(dx, y - 92) > 7.2 ? 1050 : 420;
        }

        // Parabolic dental arch distance (anterior apex around y=20, flaring posteriorly to y=66, x=±27)
        const archY = 21 + (dx * dx) * 0.062;
        const distFromArch = Math.abs(y - archY);

        // Mandible body (z = 12..34)
        if (z >= 12 && z <= 35 && Math.abs(dx) < 33 && y >= 18 && y <= 68) {
          if (distFromArch < 5.5) {
            hu = distFromArch > 3.9 || z < 15 ? 1220 : 430; // cortical vs trabecular
          }
          // Bilateral Mandibular Canal (around z=20, along arch)
          if (Math.abs(dx) > 14 && distFromArch < 1.3 && Math.abs(z - 20) < 1.3) {
            hu = 85;
          }
        }

        // Maxilla & Palate (z = 42..64)
        if (z >= 42 && z <= 65 && Math.abs(dx) < 32 && y >= 17 && y <= 65) {
          if (distFromArch < 5.2) {
            hu = distFromArch > 3.7 ? 1120 : 390;
          }
          // Palatal vault & nasal floor at z ~ 56
          if (z >= 54 && z <= 57 && y > archY && y < 56 && Math.abs(dx) < 20) {
            hu = 1080;
          }
          // Maxillary sinus air cavities above z=58 posteriorly
          if (z >= 58 && z <= 73 && Math.abs(dx) > 11 && Math.abs(dx) < 25 && y > 36 && y < 56) {
            hu = -880;
          }
        }

        // Nasal cavity superiorly (z = 59..78)
        if (z >= 59 && Math.abs(dx) < 10 && y > 18 && y < 56) {
          hu = Math.abs(dx) < 1.1 ? 820 : -900; // Nasal septum vs cavity
        }

        // Teeth (roots + enamel crowns) along 12 tooth positions bilaterally
        if (Math.abs(dx) < 29 && y >= 17 && y <= 64 && distFromArch < 3.2) {
          const toothWave = Math.cos(Math.abs(dx) * 0.72);
          if (toothWave > 0.25) {
            // Lower teeth roots z=21..33, crowns z=34..40
            if (z >= 22 && z <= 40) {
              hu = z >= 35 ? 2450 : 1750;
            }
            // Upper teeth crowns z=38..44, roots z=45..57
            if (z >= 38 && z <= 56) {
              hu = z <= 43 ? 2500 : 1780;
            }
          }
        }

        // Palatally Impacted Canine #13 (right side dx < 0, oblique from z=50..62)
        const impX = -8.5 - (z - 52) * 0.45;
        const impY = 27.5 + (z - 52) * 0.35;
        if (z >= 49 && z <= 63 && Math.hypot(dx - impX, y - impY) < 2.4) {
          hu = z < 54 ? 2620 : 1850;
        }

        // Mild clinical speckle noise
        const speckle = ((x * 29 + y * 53 + z * 19) % 50) - 25;
        data[z * nx * ny + y * nx + x] = Math.max(-1000, hu + speckle);
      }
    }
  }

  return {
    nx,
    ny,
    nz,
    spacingMm: [0.4, 0.4, 0.5],
    data,
    modality: 'CBCT 3D MPR',
    fov: '42 × 42 × 40 mm',
    patientName: 'Craniofacial CBCT Study (Impacted #13 + Airway)',
    studyDate: '2026-11-18',
    sourceLabel: 'Built-in 3D Volumetric CBCT Study (HU)',
  };
}

function classifyHU(hu: number, lang: Language): string {
  if (hu < -450) return tr(lang, 'فراغ / مجرى هوائي', 'Airway / Sinus');
  if (hu < 220) return tr(lang, 'أنسجة رخوة / عصب', 'Soft Tissue / Canal');
  if (hu < 750) return tr(lang, 'عظم إسفنجي', 'Trabecular Bone');
  if (hu < 1600) return tr(lang, 'عظم قشري', 'Cortical Bone');
  return tr(lang, 'مينا / عاج سني', 'Enamel / Dentin');
}

export const CbctStudio: React.FC<CbctStudioProps> = ({
  patient,
  stage = 'T0',
  lang,
  role = 'doctor',
  actorName = 'Doctor',
  initialUrl,
  onChange,
  onCalibrateFromDicom,
}) => {
  const [volume, setVolume] = useState<CbctVolume>(() => generateCraniofacialCbctVolume());
  const [sliceX, setSliceX] = useState(52);
  const [sliceY, setSliceY] = useState(30);
  const [sliceZ, setSliceZ] = useState(52);
  const [wc, setWc] = useState(650);
  const [ww, setWw] = useState(2200);
  const [invert, setInvert] = useState(false);
  const [preset, setPreset] = useState<'bone' | 'teeth' | 'airway'>('bone');
  const [tool, setTool] = useState<'crosshair' | 'distance' | 'angle'>('crosshair');
  const [hoverProbe, setHoverProbe] = useState<{ hu: number; x: number; y: number; z: number } | null>(null);
  const [activeMeasurePlane, setActiveMeasurePlane] = useState<PlaneKind | null>(null);
  const [measurePts, setMeasurePts] = useState<Array<{ u: number; v: number }>>([]);
  const [measurements, setMeasurements] = useState<CbctMeasurement[]>([]);
  const [regionLabel, setRegionLabel] = useState('الناب المنطمر #13 والمجرى الهوائي');
  const [cbctNotes, setCbctNotes] = useState('');
  const [error, setError] = useState('');

  const axialRef = useRef<HTMLCanvasElement | null>(null);
  const coronalRef = useRef<HTMLCanvasElement | null>(null);
  const sagittalRef = useRef<HTMLCanvasElement | null>(null);
  const mipRef = useRef<HTMLCanvasElement | null>(null);

  // Load initial external DICOM if provided
  useEffect(() => {
    if (!initialUrl || !initialUrl.toLowerCase().endsWith('.dcm')) return;
    setError('');
    fetch(initialUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const parsed = parseDicomSliceBuffer(buf);
        const vol = slicesToCbctVolume([parsed], initialUrl.split('/').pop() || 'DICOM');
        setVolume(vol);
        setSliceX(Math.floor(vol.nx / 2));
        setSliceY(Math.floor(vol.ny / 2));
        setSliceZ(Math.floor(vol.nz / 2));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Unable to parse DICOM');
      });
  }, [initialUrl]);

  const applyPreset = (p: 'bone' | 'teeth' | 'airway') => {
    setPreset(p);
    if (p === 'bone') {
      setWc(650);
      setWw(2200);
    } else if (p === 'teeth') {
      setWc(1250);
      setWw(2800);
    } else {
      setWc(-350);
      setWw(1400);
    }
  };

  const mapHU = (val: number, low: number, span: number) => {
    let n = ((val - low) / span) * 255;
    n = Math.max(0, Math.min(255, n));
    return invert ? 255 - n : n;
  };

  // Render Axial, Coronal, Sagittal & MIP Canvases
  useEffect(() => {
    const { nx, ny, nz, data } = volume;
    const low = wc - ww / 2;
    const span = Math.max(1, ww);

    // 1. Axial (x vs y at sliceZ)
    if (axialRef.current) {
      const c = axialRef.current;
      c.width = nx;
      c.height = ny;
      const ctx = c.getContext('2d');
      if (ctx) {
        const img = ctx.createImageData(nx, ny);
        const zOff = Math.max(0, Math.min(nz - 1, sliceZ)) * nx * ny;
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) {
            const g = mapHU(data[zOff + y * nx + x], low, span);
            const p = (y * nx + x) * 4;
            img.data[p] = g;
            img.data[p + 1] = g;
            img.data[p + 2] = g;
            img.data[p + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
      }
    }

    // 2. Coronal (x vs z inverted at sliceY)
    if (coronalRef.current) {
      const c = coronalRef.current;
      c.width = nx;
      c.height = nz;
      const ctx = c.getContext('2d');
      if (ctx) {
        const img = ctx.createImageData(nx, nz);
        const yClamped = Math.max(0, Math.min(ny - 1, sliceY));
        for (let z = 0; z < nz; z++) {
          const zDisp = nz - 1 - z;
          const zOff = z * nx * ny + yClamped * nx;
          for (let x = 0; x < nx; x++) {
            const g = mapHU(data[zOff + x], low, span);
            const p = (zDisp * nx + x) * 4;
            img.data[p] = g;
            img.data[p + 1] = g;
            img.data[p + 2] = g;
            img.data[p + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
      }
    }

    // 3. Sagittal (y vs z inverted at sliceX)
    if (sagittalRef.current) {
      const c = sagittalRef.current;
      c.width = ny;
      c.height = nz;
      const ctx = c.getContext('2d');
      if (ctx) {
        const img = ctx.createImageData(ny, nz);
        const xClamped = Math.max(0, Math.min(nx - 1, sliceX));
        for (let z = 0; z < nz; z++) {
          const zDisp = nz - 1 - z;
          const zOff = z * nx * ny;
          for (let y = 0; y < ny; y++) {
            const g = mapHU(data[zOff + y * nx + xClamped], low, span);
            const p = (zDisp * ny + y) * 4;
            img.data[p] = g;
            img.data[p + 1] = g;
            img.data[p + 2] = g;
            img.data[p + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
      }
    }

    // 4. Panoramic/Frontal MIP Reconstruction (max HU across anterior-posterior y for each x, z)
    if (mipRef.current) {
      const c = mipRef.current;
      c.width = nx;
      c.height = nz;
      const ctx = c.getContext('2d');
      if (ctx) {
        const img = ctx.createImageData(nx, nz);
        const yEnd = Math.min(ny, Math.round(ny * 0.72)); // anterior dental/jaw zone
        for (let z = 0; z < nz; z++) {
          const zDisp = nz - 1 - z;
          const zOff = z * nx * ny;
          for (let x = 0; x < nx; x++) {
            let maxHu = -1000;
            for (let y = 0; y < yEnd; y++) {
              const v = data[zOff + y * nx + x];
              if (v > maxHu) maxHu = v;
            }
            const g = mapHU(maxHu, low, span);
            const p = (zDisp * nx + x) * 4;
            img.data[p] = g;
            img.data[p + 1] = g;
            img.data[p + 2] = g;
            img.data[p + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
      }
    }
  }, [volume, sliceX, sliceY, sliceZ, wc, ww, invert]);

  const handleLoadDicomFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError('');
    try {
      const parsed: ParsedDicomSlice[] = [];
      for (let i = 0; i < files.length; i++) {
        const buf = await files[i].arrayBuffer();
        parsed.push(parseDicomSliceBuffer(buf));
      }
      const vol = slicesToCbctVolume(
        parsed,
        files.length > 1 ? `${files.length} DICOM slices` : files[0].name,
      );
      setVolume(vol);
      setSliceX(Math.floor(vol.nx / 2));
      setSliceY(Math.floor(vol.ny / 2));
      setSliceZ(Math.floor(vol.nz / 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load DICOM files');
    }
  };

  const getPlaneDimensions = (plane: PlaneKind) => {
    const [dx, dy, dz] = volume.spacingMm;
    if (plane === 'axial') return { w: volume.nx, h: volume.ny, sx: dx, sy: dy };
    if (plane === 'coronal') return { w: volume.nx, h: volume.nz, sx: dx, sy: dz };
    return { w: volume.ny, h: volume.nz, sx: dy, sy: dz };
  };

  const handlePlaneClick = (plane: PlaneKind, e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const { w, h, sx, sy } = getPlaneDimensions(plane);

    if (tool === 'crosshair') {
      if (plane === 'axial') {
        setSliceX(Math.round(u * (volume.nx - 1)));
        setSliceY(Math.round(v * (volume.ny - 1)));
      } else if (plane === 'coronal') {
        setSliceX(Math.round(u * (volume.nx - 1)));
        setSliceZ(Math.round((1 - v) * (volume.nz - 1)));
      } else {
        setSliceY(Math.round(u * (volume.ny - 1)));
        setSliceZ(Math.round((1 - v) * (volume.nz - 1)));
      }
      return;
    }

    const pt = { u, v };
    const next = activeMeasurePlane === plane ? [...measurePts, pt] : [pt];
    setActiveMeasurePlane(plane);

    if (tool === 'distance' && next.length === 2) {
      const dxMm = (next[1].u - next[0].u) * w * sx;
      const dyMm = (next[1].v - next[0].v) * h * sy;
      const dist = Number(Math.hypot(dxMm, dyMm).toFixed(2));
      setMeasurements((prev) => [
        {
          id: `cbct-m-${Date.now()}`,
          plane,
          kind: 'distance',
          label: `${plane.toUpperCase()} Linear`,
          value: dist,
          unit: 'mm',
        },
        ...prev,
      ]);
      setMeasurePts([]);
    } else if (tool === 'angle' && next.length === 3) {
      const p0 = { x: next[0].u * w * sx, y: next[0].v * h * sy };
      const p1 = { x: next[1].u * w * sx, y: next[1].v * h * sy };
      const p2 = { x: next[2].u * w * sx, y: next[2].v * h * sy };
      const v1x = p0.x - p1.x;
      const v1y = p0.y - p1.y;
      const v2x = p2.x - p1.x;
      const v2y = p2.y - p1.y;
      const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1)));
      const deg = Number(((Math.acos(cos) * 180) / Math.PI).toFixed(1));
      setMeasurements((prev) => [
        {
          id: `cbct-a-${Date.now()}`,
          plane,
          kind: 'angle',
          label: `${plane.toUpperCase()} Angle`,
          value: deg,
          unit: 'deg',
        },
        ...prev,
      ]);
      setMeasurePts([]);
    } else {
      setMeasurePts(next);
    }
  };

  const handlePlaneMove = (plane: PlaneKind, e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    let vx = sliceX;
    let vy = sliceY;
    let vz = sliceZ;
    if (plane === 'axial') {
      vx = Math.round(u * (volume.nx - 1));
      vy = Math.round(v * (volume.ny - 1));
    } else if (plane === 'coronal') {
      vx = Math.round(u * (volume.nx - 1));
      vz = Math.round((1 - v) * (volume.nz - 1));
    } else {
      vy = Math.round(u * (volume.ny - 1));
      vz = Math.round((1 - v) * (volume.nz - 1));
    }
    const idx = vz * volume.nx * volume.ny + vy * volume.nx + vx;
    const hu = volume.data[idx] ?? -1000;
    setHoverProbe({ hu, x: vx, y: vy, z: vz });
  };

  const handleSaveCbctReport = () => {
    if (!patient || !onChange) return;
    const count = patient.analyses.filter((a) => a.analysisType === 'cbct_3d').length + 1;
    const newAnalysis: MeasurementAnalysis = {
      id: `ana-cbct-${Date.now()}`,
      version: count,
      stage,
      analysisType: 'cbct_3d',
      templateName: `CBCT 3D MPR — ${regionLabel}`,
      normSource: `CBCT Volume ${volume.fov} (${volume.spacingMm[0]} mm voxel)`,
      calibrationValid: true,
      calibrationSource: `DICOM/CBCT Isotropic Voxel (${volume.spacingMm[0]} mm)`,
      landmarks: {},
      cbctFindings: {
        modality: volume.modality,
        fov: volume.fov,
        voxelMm: volume.spacingMm[0],
        region: regionLabel,
        notes: cbctNotes,
        measurements,
      },
      metrics: measurements.map((m, idx) => ({
        key: `CBCT_${idx + 1}`,
        labelAr: m.label,
        labelEn: m.label,
        value: m.value,
        unit: m.unit,
        normRange: 'قياس CBCT ثلاثي الأبعاد',
        formulaDesc: `${m.plane.toUpperCase()} MPR ${m.kind}`,
        interpretation: `${m.value} ${m.unit}`,
        requiresCalibration: true,
      })),
      examiner: actorName,
      createdAt: new Date().toISOString(),
      approvedBy: role === 'doctor' ? actorName : undefined,
      approvedAt: role === 'doctor' ? new Date().toISOString() : undefined,
    };

    onChange(
      { ...patient, analyses: [newAnalysis, ...patient.analyses] },
      { ar: `حفظ دراسة السي بي سي تي CBCT (${stage})`, en: `Saved CBCT 3D Study (${stage})` },
    );
  };

  const xPct = (sliceX / Math.max(1, volume.nx - 1)) * 100;
  const yPct = (sliceY / Math.max(1, volume.ny - 1)) * 100;
  const zInvPct = (1 - sliceZ / Math.max(1, volume.nz - 1)) * 100;

  return (
    <div className="space-y-4">
      {/* Top Radiology Control Bar */}
      <div className="bg-navy-900 text-white rounded-xl border border-navy-800 p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2">
            <Scan className="w-4 h-4 text-brand-orange" />
            <div>
              <p className="text-xs font-bold">{volume.sourceLabel}</p>
              <p className="text-[11px] font-mono tabular-nums text-navy-300">
                {volume.nx}×{volume.ny}×{volume.nz} · FOV {volume.fov} · {volume.spacingMm[0]}mm
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 bg-navy-950/70 p-1 rounded-lg border border-navy-800 text-[11px]">
            {(
              [
                ['bone', 'العظم', 'Bone'],
                ['teeth', 'الأسنان', 'Teeth'],
                ['airway', 'المجرى الهوائي', 'Airway'],
              ] as const
            ).map(([p, ar, en]) => (
              <button
                key={p}
                type="button"
                onClick={() => applyPreset(p)}
                className={`px-2.5 py-1 rounded transition-colors ${
                  preset === p ? 'bg-brand-orange text-navy-950 font-semibold' : 'text-navy-200 hover:bg-navy-800'
                }`}
              >
                {lang === 'ar' ? ar : en}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-navy-950/70 p-1 rounded-lg border border-navy-800 text-[11px]">
            <button
              type="button"
              onClick={() => {
                setTool('crosshair');
                setMeasurePts([]);
              }}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded ${
                tool === 'crosshair' ? 'bg-brand-blue text-white font-semibold' : 'text-navy-200 hover:bg-navy-800'
              }`}
            >
              <Crosshair className="w-3 h-3" />
              <span>{tr(lang, 'تزامن المقاطع', 'MPR Sync')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setTool('distance');
                setMeasurePts([]);
              }}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded ${
                tool === 'distance' ? 'bg-brand-orange text-navy-950 font-semibold' : 'text-navy-200 hover:bg-navy-800'
              }`}
            >
              <Ruler className="w-3 h-3" />
              <span>{tr(lang, 'مسافة mm', 'Dist (mm)')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setTool('angle');
                setMeasurePts([]);
              }}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded ${
                tool === 'angle' ? 'bg-brand-orange text-navy-950 font-semibold' : 'text-navy-200 hover:bg-navy-800'
              }`}
            >
              <span>{tr(lang, 'زاوية °', 'Angle °')}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setInvert((v) => !v)}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border ${
              invert ? 'bg-brand-blue border-brand-blue text-white' : 'bg-navy-800 border-navy-700 text-navy-200'
            }`}
          >
            <Contrast className="w-3.5 h-3.5" />
            <span>{tr(lang, 'عكس', 'Invert')}</span>
          </button>

          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-navy-800 hover:bg-navy-700 border border-navy-700 text-xs rounded-lg cursor-pointer">
            <Upload className="w-3.5 h-3.5 text-brand-orange" />
            <span>{tr(lang, 'فتح سلسلة .dcm', 'Load .dcm Series')}</span>
            <input
              type="file"
              multiple
              accept=".dcm"
              className="hidden"
              onChange={(e) => handleLoadDicomFiles(e.target.files)}
            />
          </label>

          <button
            type="button"
            onClick={() => {
              setSliceX(Math.floor(volume.nx / 2));
              setSliceY(Math.floor(volume.ny * 0.3));
              setSliceZ(Math.floor(volume.nz * 0.65));
              applyPreset('bone');
              setInvert(false);
            }}
            className="p-1.5 bg-navy-800 hover:bg-navy-700 border border-navy-700 rounded-lg text-navy-200"
            title={tr(lang, 'إعادة ضبط', 'Reset')}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-xs">{error}</div>
      )}

      {/* Main 4-Quadrant CBCT MPR Grid + Side Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-3 bg-navy-950 p-3 rounded-xl border border-navy-800">
          {/* 1. Axial */}
          <div className="bg-black border border-navy-800 rounded-lg p-2 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] px-1">
              <span className="font-bold text-cyan-400">AXIAL · Z = {sliceZ + 1}/{volume.nz}</span>
              <span className="font-mono text-navy-400">
                {(sliceZ * volume.spacingMm[2]).toFixed(1)} mm
              </span>
            </div>
            <div
              onClick={(e) => handlePlaneClick('axial', e)}
              onMouseMove={(e) => handlePlaneMove('axial', e)}
              className="relative aspect-square bg-black cursor-crosshair overflow-hidden rounded"
            >
              <canvas ref={axialRef} className="w-full h-full object-fill" />
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-0 bottom-0 w-px bg-brand-orange/70" style={{ left: `${xPct}%` }} />
                <div className="absolute left-0 right-0 h-px bg-cyan-400/70" style={{ top: `${yPct}%` }} />
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={volume.nz - 1}
              value={sliceZ}
              onChange={(e) => setSliceZ(Number(e.target.value))}
              className="w-full accent-cyan-400"
            />
          </div>

          {/* 2. Coronal */}
          <div className="bg-black border border-navy-800 rounded-lg p-2 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] px-1">
              <span className="font-bold text-emerald-400">CORONAL · Y = {sliceY + 1}/{volume.ny}</span>
              <span className="font-mono text-navy-400">
                {(sliceY * volume.spacingMm[1]).toFixed(1)} mm
              </span>
            </div>
            <div
              onClick={(e) => handlePlaneClick('coronal', e)}
              onMouseMove={(e) => handlePlaneMove('coronal', e)}
              className="relative aspect-square bg-black cursor-crosshair overflow-hidden rounded"
            >
              <canvas ref={coronalRef} className="w-full h-full object-fill" />
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-0 bottom-0 w-px bg-brand-orange/70" style={{ left: `${xPct}%` }} />
                <div className="absolute left-0 right-0 h-px bg-emerald-400/70" style={{ top: `${zInvPct}%` }} />
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={volume.ny - 1}
              value={sliceY}
              onChange={(e) => setSliceY(Number(e.target.value))}
              className="w-full accent-emerald-400"
            />
          </div>

          {/* 3. Sagittal */}
          <div className="bg-black border border-navy-800 rounded-lg p-2 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] px-1">
              <span className="font-bold text-brand-orange">SAGITTAL · X = {sliceX + 1}/{volume.nx}</span>
              <span className="font-mono text-navy-400">
                {(sliceX * volume.spacingMm[0]).toFixed(1)} mm
              </span>
            </div>
            <div
              onClick={(e) => handlePlaneClick('sagittal', e)}
              onMouseMove={(e) => handlePlaneMove('sagittal', e)}
              className="relative aspect-square bg-black cursor-crosshair overflow-hidden rounded"
            >
              <canvas ref={sagittalRef} className="w-full h-full object-fill" />
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-0 bottom-0 w-px bg-cyan-400/70" style={{ left: `${yPct}%` }} />
                <div className="absolute left-0 right-0 h-px bg-emerald-400/70" style={{ top: `${zInvPct}%` }} />
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={volume.nx - 1}
              value={sliceX}
              onChange={(e) => setSliceX(Number(e.target.value))}
              className="w-full accent-brand-orange"
            />
          </div>

          {/* 4. 3D MIP / Panoramic Reconstruction */}
          <div className="bg-black border border-navy-800 rounded-lg p-2 space-y-1.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-[11px] px-1">
              <span className="font-bold text-navy-100">
                {tr(lang, 'إسقاط كثافة عظمى 3D MIP (الفكين والأنف)', '3D MIP Frontal Jaw & Root Reconstruction')}
              </span>
            </div>
            <div className="relative aspect-square bg-black overflow-hidden rounded">
              <canvas ref={mipRef} className="w-full h-full object-fill" />
            </div>
            <div className="text-[11px] font-mono tabular-nums text-navy-300 flex items-center justify-between px-1">
              {hoverProbe ? (
                <>
                  <span>
                    HU: <strong className="text-brand-orange">{hoverProbe.hu}</strong>
                  </span>
                  <span>{classifyHU(hoverProbe.hu, lang)}</span>
                </>
              ) : (
                <span className="text-navy-500">{tr(lang, 'حرّر المؤشر لقراءة الكثافة HU', 'Hover any plane for HU density')}</span>
              )}
            </div>
          </div>
        </div>

        {/* Right Side Panel: WL/WW, Caliper Measurements & Save CBCT Report */}
        <div className="xl:col-span-4 bg-white border border-navy-200 rounded-xl p-4 space-y-4">
          <div className="border-b border-navy-100 pb-3">
            <h4 className="text-sm font-bold text-navy-900">
              {tr(lang, 'تحليل وقياسات السي بي سي تي (CBCT)', 'CBCT Radiology & Measurement Report')}
            </h4>
            <p className="text-[11px] text-navy-500 mt-0.5">
              {volume.patientName} · {volume.studyDate}
            </p>
          </div>

          <div className="space-y-2.5 text-xs">
            <label className="block space-y-1">
              <span className="flex justify-between font-mono tabular-nums text-navy-700">
                <span>Window Level (WL)</span>
                <span>{wc} HU</span>
              </span>
              <input
                type="range"
                min={-800}
                max={2400}
                value={wc}
                onChange={(e) => setWc(Number(e.target.value))}
                className="w-full accent-navy-800"
              />
            </label>

            <label className="block space-y-1">
              <span className="flex justify-between font-mono tabular-nums text-navy-700">
                <span>Window Width (WW)</span>
                <span>{ww} HU</span>
              </span>
              <input
                type="range"
                min={200}
                max={4000}
                value={ww}
                onChange={(e) => setWw(Number(e.target.value))}
                className="w-full accent-navy-800"
              />
            </label>
          </div>

          {/* CBCT Measurements Log */}
          <div className="space-y-2 pt-2 border-t border-navy-100">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-navy-900">
                {tr(lang, 'القياسات على المقاطع (عظم / عصب / مجرى هوائي)', 'MPR Slice Measurements')}
              </span>
              {measurements.length > 0 && (
                <button
                  type="button"
                  onClick={() => setMeasurements([])}
                  className="text-rose-700 text-[11px] inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>{tr(lang, 'مسح', 'Clear')}</span>
                </button>
              )}
            </div>

            {measurements.length === 0 ? (
              <p className="text-[11px] text-navy-500 bg-navy-50 border border-navy-100 rounded-lg p-2.5">
                {tr(
                  lang,
                  'اختر أداة "مسافة mm" أو "زاوية °" من الشريط العلوي ثم انقر على أي مقطع لقياس سماكة العظم للزرعات التقويمية TADs أو علاقة الناب المنطمر بالجذور.',
                  'Select Dist (mm) or Angle (°) above, then click on any Axial/Coronal/Sagittal plane to measure bone width, TAD depth, or impacted canine angulation.',
                )}
              </p>
            ) : (
              <div className="divide-y divide-navy-100 max-h-40 overflow-y-auto border border-navy-100 rounded-lg px-2.5">
                {measurements.map((m) => (
                  <div key={m.id} className="py-1.5 flex items-center justify-between text-xs">
                    <span className="text-navy-700 font-medium">{m.label}</span>
                    <span className="font-mono tabular-nums font-bold text-navy-900">
                      {m.value} {m.unit === 'deg' ? '°' : 'mm'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Clinical Region & Notes + Save to Patient Case */}
          {patient && onChange && (
            <div className="space-y-2.5 pt-2 border-t border-navy-100">
              <label className="block text-xs">
                <span className="font-semibold text-navy-700 block mb-1">
                  {tr(lang, 'نطاق الفحص الرئيسي', 'Primary Diagnostic Region')}
                </span>
                <select
                  value={regionLabel}
                  onChange={(e) => setRegionLabel(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-navy-200 rounded-lg bg-white text-xs"
                >
                  <option value="الناب المنطمر #13 والمجرى الهوائي">{tr(lang, 'الناب المنطمر #13 وعلاقته بالجذور', 'Impacted Canine #13 Localization')}</option>
                  <option value="تقييم سماكة العظم للزرعات التقويمية (TADs / IZC)">{tr(lang, 'تقييم العظم للزرعات التقويمية (TADs / IZC)', 'TADs / IZC Cortical Bone Thickness')}</option>
                  <option value="تحليل المجرى الهوائي العلوي والسفلي">{tr(lang, 'تحليل أبعاد المجرى الهوائي (Airway)', 'Oropharyngeal Airway Volume')}</option>
                  <option value="تقييم المفصل الفكي الصدغي (TMJ Condyles)">{tr(lang, 'المفصل الفكي الصدغي (TMJ)', 'TMJ Condylar Assessment')}</option>
                </select>
              </label>

              <label className="block text-xs">
                <span className="font-semibold text-navy-700 block mb-1">
                  {tr(lang, 'ملاحظات التقرير ثلاثي الأبعاد', 'CBCT Clinical Findings Note')}
                </span>
                <textarea
                  rows={2}
                  value={cbctNotes}
                  onChange={(e) => setCbctNotes(e.target.value)}
                  placeholder={tr(lang, 'مثلاً: الناب 13 بتوضع حنكي دون امتصاص واضح بجذر القاطع الجانبي 12...', 'e.g., #13 palatal crown proximity without root resorption...')}
                  className="w-full px-2.5 py-1.5 border border-navy-200 rounded-lg text-xs"
                />
              </label>

              <button
                type="button"
                onClick={handleSaveCbctReport}
                className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 px-4 bg-navy-900 hover:bg-navy-800 text-white text-xs font-semibold rounded-lg"
              >
                <Save className="w-4 h-4 text-brand-orange" />
                <span>{tr(lang, 'حفظ دراسة السي بي سي تي بملف المريض', 'Save CBCT 3D Study to Patient')}</span>
              </button>
            </div>
          )}

          {onCalibrateFromDicom && (
            <button
              type="button"
              onClick={() => {
                const pxPerMm = Number((1 / volume.spacingMm[0]).toFixed(3));
                onCalibrateFromDicom(pxPerMm, `CBCT Voxel (${volume.spacingMm[0]} mm)`);
              }}
              className="w-full py-2 px-3 bg-navy-100 hover:bg-navy-200 text-navy-900 text-xs font-semibold rounded-lg"
            >
              {tr(lang, 'اعتماد دقة Voxel لمعايرة السجل', 'Apply Voxel Calibration')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
