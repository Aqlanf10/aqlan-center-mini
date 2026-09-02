"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ADULT_FDI_TEETH,
  PRIMARY_FDI_TEETH,
  LAB_TOOTH_ROLE_META,
  type LabToothMap,
  type LabToothRole,
  type LabToothSummary,
  parseLabTeeth,
  serializeLabTeeth,
  summarizeLabTeeth,
} from "@/lib/lab";
import { toUniversal, toothName } from "@/lib/dental";
import { Icon } from "./Icon";

export interface LabDentalChartProps {
  value?: string | LabToothMap;
  onChange?: (valueStr: string, map: LabToothMap, summary: LabToothSummary) => void;
  readOnly?: boolean;
  compact?: boolean;
  title?: string;
  showSummary?: boolean;
  className?: string;
}

type DentitionViewMode = "adult" | "primary" | "both";

export function LabDentalChart({
  value,
  onChange,
  readOnly = false,
  compact = false,
  title = "مخطط الأسنان السريري لطلبات المختبر (FDI Lab Chart)",
  showSummary = true,
  className = "",
}: LabDentalChartProps) {
  // Convert incoming value into internal Map state
  const initialMap = useMemo(() => {
    if (!value) return {};
    if (typeof value === "string") return parseLabTeeth(value);
    return value;
  }, [value]);

  const [toothMap, setToothMap] = useState<LabToothMap>(initialMap);
  const [activeTool, setActiveTool] = useState<LabToothRole | "eraser">("crown");
  const [viewMode, setViewMode] = useState<DentitionViewMode>("adult");
  const [showUniversal, setShowUniversal] = useState(false);
  const [hoveredTooth, setHoveredTooth] = useState<number | null>(null);
  const [quickMenuTooth, setQuickMenuTooth] = useState<number | null>(null);

  // Bridge wizard state (quick bridge creation)
  const [bridgeWizard, setBridgeWizard] = useState<{
    active: boolean;
    startTooth: number | null;
  }>({ active: false, startTooth: null });

  // Sync external value changes
  useEffect(() => {
    if (value !== undefined) {
      const parsed = typeof value === "string" ? parseLabTeeth(value) : value;
      setToothMap(parsed);
    }
  }, [value]);

  const summary = useMemo(() => summarizeLabTeeth(toothMap), [toothMap]);

  const updateMap = useCallback(
    (newMap: LabToothMap) => {
      setToothMap(newMap);
      if (onChange) {
        const serialized = serializeLabTeeth(newMap);
        const summ = summarizeLabTeeth(newMap);
        onChange(serialized, newMap, summ);
      }
    },
    [onChange],
  );

  // Toggle or assign role to a specific tooth
  const handleToothClick = useCallback(
    (code: number) => {
      if (readOnly) return;

      // If bridge wizard is active
      if (bridgeWizard.active) {
        if (!bridgeWizard.startTooth) {
          // Select start abutment
          setBridgeWizard({ active: true, startTooth: code });
          const next = { ...toothMap, [code]: "abutment" as LabToothRole };
          updateMap(next);
        } else {
          // Complete bridge between startTooth and code
          const start = bridgeWizard.startTooth;
          const end = code;
          if (start === end) {
            setBridgeWizard({ active: false, startTooth: null });
            return;
          }

          // Same arch verification
          const isUpperStart = (start >= 11 && start <= 28) || (start >= 51 && start <= 65);
          const isUpperEnd = (end >= 11 && end <= 28) || (end >= 51 && end <= 65);

          const next = { ...toothMap };
          next[start] = "abutment";
          next[end] = "abutment";

          if (isUpperStart === isUpperEnd) {
            // Fill intermediate teeth as pontics if same arch
            const min = Math.min(start, end);
            const max = Math.max(start, end);
            for (let c = min + 1; c < max; c++) {
              // verify valid tooth code
              if ((c >= 11 && c <= 28) || (c >= 31 && c <= 48) || (c >= 51 && c <= 65) || (c >= 71 && c <= 85)) {
                next[c] = "pontic";
              }
            }
          }
          updateMap(next);
          setBridgeWizard({ active: false, startTooth: null });
        }
        return;
      }

      // Normal tool usage
      const currentRole = toothMap[code];

      if (activeTool === "eraser") {
        if (currentRole) {
          const next = { ...toothMap };
          delete next[code];
          updateMap(next);
        }
        return;
      }

      if (currentRole === activeTool) {
        // Toggle off if clicking with same tool
        const next = { ...toothMap };
        delete next[code];
        updateMap(next);
      } else {
        // Assign new role
        const next = { ...toothMap, [code]: activeTool };
        updateMap(next);
      }
    },
    [readOnly, bridgeWizard, toothMap, activeTool, updateMap],
  );

  // Directly assign specific role to a tooth (e.g., from quick menu)
  const setToothRole = useCallback(
    (code: number, role: LabToothRole | null) => {
      if (readOnly) return;
      const next = { ...toothMap };
      if (!role) {
        delete next[code];
      } else {
        next[code] = role;
      }
      updateMap(next);
      setQuickMenuTooth(null);
    },
    [readOnly, toothMap, updateMap],
  );

  // Quick preset selections
  const selectAllArch = useCallback(
    (arch: "upper" | "lower" | "all" | "clear", role: LabToothRole = "crown") => {
      if (readOnly) return;
      if (arch === "clear") {
        updateMap({});
        return;
      }

      const next = { ...toothMap };
      if (arch === "upper" || arch === "all") {
        ADULT_FDI_TEETH.upperRight.forEach((c) => (next[c] = role));
        ADULT_FDI_TEETH.upperLeft.forEach((c) => (next[c] = role));
      }
      if (arch === "lower" || arch === "all") {
        ADULT_FDI_TEETH.lowerRight.forEach((c) => (next[c] = role));
        ADULT_FDI_TEETH.lowerLeft.forEach((c) => (next[c] = role));
      }
      updateMap(next);
    },
    [readOnly, toothMap, updateMap],
  );

  const selectAnteriorTeeth = useCallback(
    (role: LabToothRole = "crown") => {
      if (readOnly) return;
      const next = { ...toothMap };
      // Upper anterior 13 to 23
      [13, 12, 11, 21, 22, 23].forEach((c) => (next[c] = role));
      // Lower anterior 43 to 33
      [43, 42, 41, 31, 32, 33].forEach((c) => (next[c] = role));
      updateMap(next);
    },
    [readOnly, toothMap, updateMap],
  );

  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white p-3.5 sm:p-5 shadow-xs select-none transition-all ${className}`}
    >
      {/* Header with Title and Mode Controls */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-navy-800 text-base text-white shadow-xs">
            🦷
          </span>
          <div>
            <h3 className="text-xs font-black text-navy-950 sm:text-sm">{title}</h3>
            <p className="text-[11px] text-slate-500">
              ترقيم الاتحاد الدولي FDI (11–48 دائم، 51–85 لبني) مع تحديد الأدوار التعويضية (Crown, Abutment, Pontic)
            </p>
          </div>
        </div>

        {/* Dentition Filter & Universal Numbering Toggle */}
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1 shadow-2xs">
            <button
              type="button"
              onClick={() => setViewMode("adult")}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-extrabold transition ${
                viewMode === "adult" ? "bg-white text-navy-900 shadow-xs" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              الأسنان الدائمة (11-48)
            </button>
            <button
              type="button"
              onClick={() => setViewMode("primary")}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-extrabold transition ${
                viewMode === "primary" ? "bg-white text-navy-900 shadow-xs" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              الأسنان اللبنية (51-85)
            </button>
            <button
              type="button"
              onClick={() => setViewMode("both")}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-extrabold transition ${
                viewMode === "both" ? "bg-white text-navy-900 shadow-xs" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              عرض الكل (All)
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowUniversal((prev) => !prev)}
            title="التبديل لعرض الترقيم العالمي (Universal Numbering 1-32)"
            className={`rounded-xl border px-2.5 py-1.5 text-[11px] font-bold transition ${
              showUniversal
                ? "border-navy-700 bg-navy-50 text-navy-900"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {showUniversal ? "ترقيم: عالمي (1-32)" : "ترقيم: FDI"}
          </button>
        </div>
      </div>

      {/* Role Selector Toolbar & Smart Presets (Read/Write Mode) */}
      {!readOnly && (
        <div className="mb-4 rounded-xl border border-slate-100 bg-slate-50/80 p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Active Tool Selector */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-extrabold text-slate-600 ml-1">الأداة الفعالة:</span>

              {(Object.keys(LAB_TOOTH_ROLE_META) as LabToothRole[]).map((roleKey) => {
                const meta = LAB_TOOTH_ROLE_META[roleKey];
                const isActive = activeTool === roleKey && !bridgeWizard.active;
                return (
                  <button
                    key={roleKey}
                    type="button"
                    onClick={() => {
                      setActiveTool(roleKey);
                      setBridgeWizard({ active: false, startTooth: null });
                    }}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition shadow-2xs ${
                      isActive
                        ? `${meta.bgClass} border-transparent shadow-xs scale-105`
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                    }`}
                    title={meta.desc}
                  >
                    <span>{meta.icon}</span>
                    <span>{meta.shortLabel}</span>
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => {
                  setActiveTool("eraser");
                  setBridgeWizard({ active: false, startTooth: null });
                }}
                className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition shadow-2xs ${
                  activeTool === "eraser" && !bridgeWizard.active
                    ? "bg-rose-600 text-white border-transparent shadow-xs scale-105"
                    : "border-slate-200 bg-white text-rose-700 hover:bg-rose-50"
                }`}
                title="إزالة السن من طلب المختبر"
              >
                <span>🧹</span>
                <span>إزالة</span>
              </button>
            </div>

            {/* Smart Bridge Builder & Quick Actions */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  if (bridgeWizard.active) {
                    setBridgeWizard({ active: false, startTooth: null });
                  } else {
                    setBridgeWizard({ active: true, startTooth: null });
                    setActiveTool("abutment");
                  }
                }}
                className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-extrabold transition shadow-2xs ${
                  bridgeWizard.active
                    ? "border-indigo-500 bg-indigo-600 text-white animate-pulse"
                    : "border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100"
                }`}
                title="حدد سن البداية ثم سن النهاية ليتم بناء الجسر آلياً"
              >
                <span>🌉</span>
                <span>
                  {bridgeWizard.active
                    ? bridgeWizard.startTooth
                      ? `اختر سن نهاية الجسر (البداية: ${bridgeWizard.startTooth})`
                      : "اختر سن بداية الجسر..."
                    : "بناء جسر ذكي"}
                </span>
              </button>

              {/* Dropdown / Quick presets */}
              <div className="relative inline-block text-left group">
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
                >
                  <span>⚡ خيارات سريعة</span>
                  <span className="text-[10px]">▼</span>
                </button>
                <div className="invisible group-hover:visible group-focus-within:visible opacity-0 group-hover:opacity-100 transition-all absolute left-0 z-30 mt-1 w-44 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                  <button
                    type="button"
                    onClick={() => selectAnteriorTeeth("crown")}
                    className="w-full text-right rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-blue-50 hover:text-blue-800"
                  >
                    ✨ الأسنان الأمامية (Anterior)
                  </button>
                  <button
                    type="button"
                    onClick={() => selectAllArch("upper", "crown")}
                    className="w-full text-right rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-blue-50 hover:text-blue-800"
                  >
                    👄 الفك العلوي كاملاً
                  </button>
                  <button
                    type="button"
                    onClick={() => selectAllArch("lower", "crown")}
                    className="w-full text-right rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-blue-50 hover:text-blue-800"
                  >
                    👄 الفك السفلي كاملاً
                  </button>
                  <div className="my-1 border-t border-slate-100" />
                  <button
                    type="button"
                    onClick={() => selectAllArch("clear")}
                    className="w-full text-right rounded-lg px-2.5 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-50"
                  >
                    🗑️ مسح كل الأسنان المحددة
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main FDI Dental Chart Canvas / Arch Visualizer */}
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-gradient-to-b from-slate-50/50 via-white to-slate-50/50 p-4 shadow-inner">
        {/* Orientation Labels */}
        <div className="mb-2 flex items-center justify-between text-[10px] font-extrabold text-slate-400 px-2">
          <span>الجانب الأيمن للمريض (Patient Right)</span>
          <span className="flex items-center gap-1 rounded-md bg-slate-200/70 px-2 py-0.5 text-slate-700">
            <span>خط المنتصف (Midline)</span>
          </span>
          <span>الجانب الأيسر للمريض (Patient Left)</span>
        </div>

        <div className="mx-auto flex flex-col items-center gap-3 w-fit min-w-[620px] py-1">
          {/* Upper Jaw Label */}
          <div className="flex items-center gap-1.5 text-[11px] font-extrabold text-navy-900 bg-navy-50/70 border border-navy-100/80 px-3 py-0.5 rounded-full shadow-2xs">
            <span>🔺 الفك العلوي (Maxillary Arch)</span>
          </div>

          {/* Adult Permanent Upper Arch (18-11 | 21-28) */}
          {(viewMode === "adult" || viewMode === "both") && (
            <div className="relative flex items-center gap-2">
              {/* Quadrant 1 (Upper Right 18-11) */}
              <div className="flex gap-1" dir="ltr">
                {ADULT_FDI_TEETH.upperRight.map((code) => (
                  <ToothCell
                    key={code}
                    code={code}
                    role={toothMap[code]}
                    isUpper={true}
                    showUniversal={showUniversal}
                    isHovered={hoveredTooth === code}
                    onHover={setHoveredTooth}
                    onClick={() => handleToothClick(code)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setQuickMenuTooth(quickMenuTooth === code ? null : code);
                    }}
                    readOnly={readOnly}
                    isBridgeStart={bridgeWizard.startTooth === code}
                  />
                ))}
              </div>

              {/* Midline Visual Divider */}
              <div className="h-14 w-0.5 border-r-2 border-dashed border-navy-300" title="خط المنتصف" />

              {/* Quadrant 2 (Upper Left 21-28) */}
              <div className="flex gap-1" dir="ltr">
                {ADULT_FDI_TEETH.upperLeft.map((code) => (
                  <ToothCell
                    key={code}
                    code={code}
                    role={toothMap[code]}
                    isUpper={true}
                    showUniversal={showUniversal}
                    isHovered={hoveredTooth === code}
                    onHover={setHoveredTooth}
                    onClick={() => handleToothClick(code)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setQuickMenuTooth(quickMenuTooth === code ? null : code);
                    }}
                    readOnly={readOnly}
                    isBridgeStart={bridgeWizard.startTooth === code}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Primary Upper Arch (55-51 | 61-65) */}
          {(viewMode === "primary" || viewMode === "both") && (
            <div className="rounded-xl border border-dashed border-purple-200 bg-purple-50/30 p-1.5 flex flex-col items-center">
              <span className="text-[9px] font-extrabold text-purple-800 mb-1">الأسنان اللبنية العلوية (55-65)</span>
              <div className="flex items-center gap-2">
                <div className="flex gap-1" dir="ltr">
                  {PRIMARY_FDI_TEETH.upperRight.map((code) => (
                    <ToothCell
                      key={code}
                      code={code}
                      role={toothMap[code]}
                      isUpper={true}
                      isPrimary={true}
                      showUniversal={showUniversal}
                      isHovered={hoveredTooth === code}
                      onHover={setHoveredTooth}
                      onClick={() => handleToothClick(code)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setQuickMenuTooth(quickMenuTooth === code ? null : code);
                      }}
                      readOnly={readOnly}
                      isBridgeStart={bridgeWizard.startTooth === code}
                    />
                  ))}
                </div>
                <div className="h-10 w-0.5 border-r-2 border-dashed border-purple-300" />
                <div className="flex gap-1" dir="ltr">
                  {PRIMARY_FDI_TEETH.upperLeft.map((code) => (
                    <ToothCell
                      key={code}
                      code={code}
                      role={toothMap[code]}
                      isUpper={true}
                      isPrimary={true}
                      showUniversal={showUniversal}
                      isHovered={hoveredTooth === code}
                      onHover={setHoveredTooth}
                      onClick={() => handleToothClick(code)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setQuickMenuTooth(quickMenuTooth === code ? null : code);
                      }}
                      readOnly={readOnly}
                      isBridgeStart={bridgeWizard.startTooth === code}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Arch Separator / Occlusal Plane */}
          <div className="my-1 flex items-center justify-center w-full">
            <div className="h-px bg-slate-200 flex-1" />
            <span className="px-3 text-[10px] font-extrabold text-slate-400 bg-white border border-slate-200 rounded-full py-0.5 shadow-2xs">
              مستوى الإطباق (Occlusal Plane)
            </span>
            <div className="h-px bg-slate-200 flex-1" />
          </div>

          {/* Primary Lower Arch (85-81 | 71-75) */}
          {(viewMode === "primary" || viewMode === "both") && (
            <div className="rounded-xl border border-dashed border-purple-200 bg-purple-50/30 p-1.5 flex flex-col items-center">
              <div className="flex items-center gap-2">
                <div className="flex gap-1" dir="ltr">
                  {PRIMARY_FDI_TEETH.lowerRight.map((code) => (
                    <ToothCell
                      key={code}
                      code={code}
                      role={toothMap[code]}
                      isUpper={false}
                      isPrimary={true}
                      showUniversal={showUniversal}
                      isHovered={hoveredTooth === code}
                      onHover={setHoveredTooth}
                      onClick={() => handleToothClick(code)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setQuickMenuTooth(quickMenuTooth === code ? null : code);
                      }}
                      readOnly={readOnly}
                      isBridgeStart={bridgeWizard.startTooth === code}
                    />
                  ))}
                </div>
                <div className="h-10 w-0.5 border-r-2 border-dashed border-purple-300" />
                <div className="flex gap-1" dir="ltr">
                  {PRIMARY_FDI_TEETH.lowerLeft.map((code) => (
                    <ToothCell
                      key={code}
                      code={code}
                      role={toothMap[code]}
                      isUpper={false}
                      isPrimary={true}
                      showUniversal={showUniversal}
                      isHovered={hoveredTooth === code}
                      onHover={setHoveredTooth}
                      onClick={() => handleToothClick(code)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setQuickMenuTooth(quickMenuTooth === code ? null : code);
                      }}
                      readOnly={readOnly}
                      isBridgeStart={bridgeWizard.startTooth === code}
                    />
                  ))}
                </div>
              </div>
              <span className="text-[9px] font-extrabold text-purple-800 mt-1">الأسنان اللبنية السفلية (85-75)</span>
            </div>
          )}

          {/* Adult Permanent Lower Arch (48-41 | 31-38) */}
          {(viewMode === "adult" || viewMode === "both") && (
            <div className="relative flex items-center gap-2">
              {/* Quadrant 4 (Lower Right 48-41) */}
              <div className="flex gap-1" dir="ltr">
                {ADULT_FDI_TEETH.lowerRight.map((code) => (
                  <ToothCell
                    key={code}
                    code={code}
                    role={toothMap[code]}
                    isUpper={false}
                    showUniversal={showUniversal}
                    isHovered={hoveredTooth === code}
                    onHover={setHoveredTooth}
                    onClick={() => handleToothClick(code)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setQuickMenuTooth(quickMenuTooth === code ? null : code);
                    }}
                    readOnly={readOnly}
                    isBridgeStart={bridgeWizard.startTooth === code}
                  />
                ))}
              </div>

              {/* Midline Visual Divider */}
              <div className="h-14 w-0.5 border-r-2 border-dashed border-navy-300" title="خط المنتصف" />

              {/* Quadrant 3 (Lower Left 31-38) */}
              <div className="flex gap-1" dir="ltr">
                {ADULT_FDI_TEETH.lowerLeft.map((code) => (
                  <ToothCell
                    key={code}
                    code={code}
                    role={toothMap[code]}
                    isUpper={false}
                    showUniversal={showUniversal}
                    isHovered={hoveredTooth === code}
                    onHover={setHoveredTooth}
                    onClick={() => handleToothClick(code)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setQuickMenuTooth(quickMenuTooth === code ? null : code);
                    }}
                    readOnly={readOnly}
                    isBridgeStart={bridgeWizard.startTooth === code}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Lower Jaw Label */}
          <div className="flex items-center gap-1.5 text-[11px] font-extrabold text-navy-900 bg-navy-50/70 border border-navy-100/80 px-3 py-0.5 rounded-full shadow-2xs">
            <span>🔻 الفك السفلي (Mandibular Arch)</span>
          </div>
        </div>
      </div>

      {/* Quick Tooth Action Popover Modal / Overlay when right-clicked or selected */}
      {quickMenuTooth !== null && !readOnly && (
        <div className="mt-3 rounded-xl border border-navy-200 bg-navy-50/70 p-3 shadow-sm">
          <div className="flex items-center justify-between border-b border-navy-200/60 pb-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-black text-navy-950">
                تعديل السن {quickMenuTooth} ({toothName(quickMenuTooth)})
              </span>
              <span className="text-[10px] text-slate-500">Universal: #{toUniversal(quickMenuTooth)}</span>
            </div>
            <button
              type="button"
              onClick={() => setQuickMenuTooth(null)}
              className="text-xs font-bold text-slate-500 hover:text-slate-800"
            >
              ✕ إغلاق
            </button>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-bold text-slate-600">تعيين الدور:</span>
            {(Object.keys(LAB_TOOTH_ROLE_META) as LabToothRole[]).map((roleKey) => {
              const meta = LAB_TOOTH_ROLE_META[roleKey];
              const isCurr = toothMap[quickMenuTooth] === roleKey;
              return (
                <button
                  key={roleKey}
                  type="button"
                  onClick={() => setToothRole(quickMenuTooth, roleKey)}
                  className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-bold transition ${
                    isCurr
                      ? `${meta.bgClass} border-transparent shadow-xs font-black`
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  <span>{meta.icon}</span>
                  <span>{meta.shortLabel}</span>
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => setToothRole(quickMenuTooth, null)}
              className="flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-xs font-bold text-rose-700 hover:bg-rose-50"
            >
              <span>🗑️ إلغاء التحديد</span>
            </button>
          </div>
        </div>
      )}

      {/* Summary of Selected Teeth & Role Breakdown */}
      {showSummary && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-lg bg-navy-900 px-2.5 py-1 text-xs font-black text-white shadow-2xs">
                إجمالي الوحدات: {summary.totalUnits} {summary.totalUnits === 1 ? "وحدة" : "وحدات"}
              </span>

              {summary.crownsCount > 0 && (
                <span className="rounded-lg bg-blue-100 border border-blue-200 px-2 py-0.5 text-xs font-bold text-blue-800">
                  👑 {summary.crownsCount} {summary.crownsCount === 1 ? "تاج" : "تيجان"}
                </span>
              )}

              {summary.abutmentsCount > 0 && (
                <span className="rounded-lg bg-indigo-100 border border-indigo-200 px-2 py-0.5 text-xs font-bold text-indigo-800">
                  🏛️ {summary.abutmentsCount} {summary.abutmentsCount === 1 ? "دعامة" : "دعامات جسر"}
                </span>
              )}

              {summary.ponticsCount > 0 && (
                <span className="rounded-lg bg-teal-100 border border-teal-200 px-2 py-0.5 text-xs font-bold text-teal-800">
                  🌉 {summary.ponticsCount} {summary.ponticsCount === 1 ? "دمية" : "دمى جسر"}
                </span>
              )}

              {summary.veneersCount > 0 && (
                <span className="rounded-lg bg-purple-100 border border-purple-200 px-2 py-0.5 text-xs font-bold text-purple-800">
                  ✨ {summary.veneersCount} فينير
                </span>
              )}

              {summary.otherCount > 0 && (
                <span className="rounded-lg bg-amber-100 border border-amber-200 px-2 py-0.5 text-xs font-bold text-amber-800">
                  🧩 {summary.otherCount} أخرى
                </span>
              )}
            </div>

            {summary.totalUnits > 0 && !readOnly && (
              <button
                type="button"
                onClick={() => selectAllArch("clear")}
                className="text-[11px] font-bold text-rose-600 hover:underline"
              >
                مسح التحديد
              </button>
            )}
          </div>

          {/* Interactive Tooth Badges List */}
          {summary.totalUnits > 0 ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-slate-200/80 pt-2">
              <span className="text-[11px] font-extrabold text-slate-500">الأسنان المحددة:</span>
              {summary.teethCodes.map((code) => {
                const role = toothMap[code];
                const meta = LAB_TOOTH_ROLE_META[role];
                return (
                  <span
                    key={code}
                    onClick={() => !readOnly && setQuickMenuTooth(code)}
                    className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-xs font-bold shadow-2xs transition ${
                      meta ? meta.badgeClass : "bg-white text-slate-700 border-slate-200"
                    } ${!readOnly ? "cursor-pointer hover:opacity-80" : ""}`}
                    title={`${toothName(code)}: ${meta?.label || "غير محدد"}`}
                  >
                    <span>{meta?.icon || "🦷"}</span>
                    <span className="font-mono font-black">{code}</span>
                    <span className="text-[10px] font-medium">({meta?.shortLabel || role})</span>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setToothRole(code, null);
                        }}
                        className="mr-0.5 text-slate-400 hover:text-rose-600 font-bold"
                      >
                        ×
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="mt-2 text-center text-[11px] font-medium text-slate-400">
              انقر على الأسنان في المخطط لتحديد نوع العمل والتركيبات المطلوبة للمختبر.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Individual Interactive Tooth Cell in FDI Chart
 */
interface ToothCellProps {
  code: number;
  role?: LabToothRole;
  isUpper: boolean;
  isPrimary?: boolean;
  showUniversal?: boolean;
  isHovered?: boolean;
  onHover: (code: number | null) => void;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  readOnly?: boolean;
  isBridgeStart?: boolean;
}

function ToothCell({
  code,
  role,
  isUpper,
  isPrimary = false,
  showUniversal = false,
  isHovered = false,
  onHover,
  onClick,
  onContextMenu,
  readOnly = false,
  isBridgeStart = false,
}: ToothCellProps) {
  const isSelected = Boolean(role);
  const meta = role ? LAB_TOOTH_ROLE_META[role] : null;

  // Determine tooth type for anatomical outline
  const pos = code % 10;
  const isMolar = pos >= 6;
  const isPremolar = pos === 4 || pos === 5;
  const isCanine = pos === 3;
  const isIncisor = pos === 1 || pos === 2;

  // Display label based on numbering system
  const displayLabel = showUniversal ? toUniversal(code) : String(code);

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => onHover(code)}
      onMouseLeave={() => onHover(null)}
      disabled={readOnly}
      title={`${toothName(code)} (FDI: ${code}, Univ: #${toUniversal(code)})${
        meta ? ` · ${meta.label}` : ""
      }`}
      className={`group relative flex flex-col items-center rounded-xl p-1 transition-all ${
        isSelected
          ? "bg-white ring-2 ring-navy-800 shadow-sm"
          : isHovered
            ? "bg-navy-50/80 shadow-2xs"
            : "hover:bg-slate-100/80"
      } ${isBridgeStart ? "ring-2 ring-indigo-500 animate-pulse bg-indigo-50" : ""}`}
      style={{ minWidth: isMolar ? "36px" : isPremolar ? "32px" : "28px" }}
    >
      {/* Top Number Label for Upper arch, Bottom for Lower arch */}
      {isUpper && (
        <span
          className={`text-[10px] font-mono font-extrabold leading-none mb-1 ${
            isSelected ? "text-navy-950 font-black" : "text-slate-500 group-hover:text-navy-800"
          }`}
        >
          {displayLabel}
        </span>
      )}

      {/* SVG Anatomical Tooth Representation */}
      <div className="relative flex items-center justify-center">
        <svg
          viewBox="0 0 28 34"
          className={`transition-transform duration-150 ${
            isPrimary ? "h-6 w-5" : isMolar ? "h-8 w-7" : isPremolar ? "h-7 w-6" : "h-7 w-5"
          } ${isHovered ? "scale-110" : ""}`}
        >
          {/* Anatomical Tooth Shape (Roots + Crown) */}
          <g transform={isUpper ? "" : "rotate(180 14 17)"}>
            {/* Root(s) */}
            {isMolar ? (
              // Multi-rooted molar
              <path
                d="M7 6 C6 12, 4 18, 5 22 C6 22, 9 18, 11 12 C13 18, 16 22, 17 22 C18 18, 16 12, 15 6 Z"
                className={isSelected ? "opacity-90" : "fill-slate-100 stroke-slate-300"}
                fill={isSelected && meta ? meta.fillHex : undefined}
                stroke={isSelected ? "#1e293b" : "#cbd5e1"}
                strokeWidth="1.2"
              />
            ) : isPremolar ? (
              // Two rooted or tapered root
              <path
                d="M9 7 C8 13, 7 19, 9 22 C11 22, 12 18, 14 12 C16 18, 17 22, 19 22 C21 19, 20 13, 19 7 Z"
                className={isSelected ? "opacity-90" : "fill-slate-100 stroke-slate-300"}
                fill={isSelected && meta ? meta.fillHex : undefined}
                stroke={isSelected ? "#1e293b" : "#cbd5e1"}
                strokeWidth="1.2"
              />
            ) : (
              // Single conical root (Incisors & Canines)
              <path
                d="M10 7 C9 13, 11 22, 14 24 C17 22, 19 13, 18 7 Z"
                className={isSelected ? "opacity-90" : "fill-slate-100 stroke-slate-300"}
                fill={isSelected && meta ? meta.fillHex : undefined}
                stroke={isSelected ? "#1e293b" : "#cbd5e1"}
                strokeWidth="1.2"
              />
            )}

            {/* Clinical Crown Body */}
            <path
              d={
                isMolar
                  ? "M4 6 C4 2, 24 2, 24 6 C25 10, 22 13, 14 13 C6 13, 3 10, 4 6 Z"
                  : isPremolar
                    ? "M6 6 C6 3, 22 3, 22 6 C23 9, 20 12, 14 12 C8 12, 5 9, 6 6 Z"
                    : isCanine
                      ? "M8 6 C8 2, 14 1, 20 6 C21 9, 18 11, 14 11 C10 11, 7 9, 8 6 Z"
                      : "M9 6 C9 3, 19 3, 19 6 C20 9, 18 11, 14 11 C10 11, 8 9, 9 6 Z"
              }
              className={
                isSelected
                  ? ""
                  : "fill-white stroke-slate-400 group-hover:stroke-navy-700 group-hover:fill-slate-50"
              }
              fill={isSelected && meta ? meta.fillHex : undefined}
              stroke={isSelected ? "#0f172a" : undefined}
              strokeWidth={isSelected ? "1.6" : "1.2"}
            />

            {/* Occlusal / Incisal Groove details */}
            <path
              d="M10 5 Q14 7 18 5"
              stroke={isSelected ? "#ffffff" : "#94a3b8"}
              strokeWidth="1"
              strokeLinecap="round"
              fill="none"
              opacity={isSelected ? "0.8" : "0.5"}
            />
          </g>

          {/* Pontic Floating / Suspended Indicator */}
          {role === "pontic" && (
            <circle cx="14" cy="17" r="4" fill="#ffffff" stroke="#0d9488" strokeWidth="1.5" />
          )}
        </svg>

        {/* Role Icon Overlay Badge */}
        {meta && (
          <span
            className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-white text-[9px] shadow-xs border border-slate-200"
            title={meta.label}
          >
            {meta.icon}
          </span>
        )}
      </div>

      {/* Bottom Number Label for Lower arch */}
      {!isUpper && (
        <span
          className={`text-[10px] font-mono font-extrabold leading-none mt-1 ${
            isSelected ? "text-navy-950 font-black" : "text-slate-500 group-hover:text-navy-800"
          }`}
        >
          {displayLabel}
        </span>
      )}
    </button>
  );
}
