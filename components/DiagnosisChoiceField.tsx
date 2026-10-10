"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { DiagnosisChoiceGroup } from "@/lib/diagnosis-choice-options";

/** Search is presentation state. Only typing or an explicit choice edits the value. */
export function DiagnosisChoiceField({ label, value, onChange, disabled, groups, placeholder = "اختر وصفًا أو اكتب بحرية", dir }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean;
  groups: readonly DiagnosisChoiceGroup[]; placeholder?: string; dir?: "ltr" | "rtl";
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const expanded = open && !disabled;
  const needle = query.trim().toLocaleLowerCase();
  const choices = groups.flatMap((group) => group.options
    .filter((option) => `${option.value} ${option.searchTerms ?? ""}`.toLocaleLowerCase().includes(needle))
    .map((option) => ({ ...option, group: group.label })));
  const close = (returnToTrigger = false) => {
    setOpen(false); setActive(-1);
    if (returnToTrigger) trigger.current?.focus();
  };
  const show = () => {
    if (disabled) return;
    setQuery(""); setActive(-1); setOpen(true);
  };
  const choose = (chosen: string) => {
    if (disabled || !choices.some((option) => option.value === chosen)) return;
    onChange(chosen); close(); field.current?.focus();
  };
  useEffect(() => { if (expanded) search.current?.focus(); }, [expanded]);
  useEffect(() => {
    if (expanded && active >= 0) list.current?.querySelector(`[data-choice-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [expanded, active]);

  return <div className="relative min-w-0" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
  }}>
    <label htmlFor={`${id}-value`} className="mb-1 block text-[10px] font-bold text-slate-500">{label}</label>
    <div className="flex min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white focus-within:border-navy-800">
      <input ref={field} id={`${id}-value`} value={value} disabled={disabled} maxLength={200}
        onChange={(event) => { if (!disabled) onChange(event.target.value); }}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && event.keyCode !== 229 && event.key === "ArrowDown" && !disabled) {
            event.preventDefault(); show();
          }
        }}
        aria-label={label} placeholder={placeholder} dir={dir}
        className="min-h-11 min-w-0 flex-1 bg-transparent px-2 py-1.5 text-xs outline-none disabled:bg-slate-50" />
      <button ref={trigger} type="button" disabled={disabled} aria-label={`اختيارات — ${label}`}
        aria-expanded={expanded} aria-controls={`${id}-choices`} aria-haspopup="listbox"
        onClick={() => { if (!disabled) { if (open) close(); else show(); } }}
        className="min-h-11 shrink-0 border-s border-slate-200 px-3 text-xs font-bold text-navy-800 disabled:opacity-50">
        <span aria-hidden="true">▾</span>
      </button>
    </div>
    {expanded ? <div className="absolute inset-x-0 top-full z-30 mt-1 rounded-xl border border-slate-200 bg-white p-2 shadow-lg"
      onKeyDown={(event) => {
        if (!event.nativeEvent.isComposing && event.keyCode !== 229 && event.key === "Escape") {
          event.preventDefault(); close(true);
        }
      }}>
      <input ref={search} value={query} role="combobox" aria-label={`بحث في الاختيارات — ${label}`}
        aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-choices`}
        aria-activedescendant={active >= 0 && choices[active] ? `${id}-option-${active}` : undefined}
        placeholder="ابحث في الأوصاف…"
        onChange={(event) => { if (!disabled) { setQuery(event.target.value); setActive(-1); } }}
        onKeyDown={(event) => {
          if (disabled || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive((previous) => choices.length === 0 ? -1 : event.key === "ArrowDown"
              ? Math.min(previous + 1, choices.length - 1) : previous < 0 ? choices.length - 1 : Math.max(0, previous - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (active >= 0 && choices[active]) choose(choices[active].value);
          }
        }}
        className="min-h-11 w-full min-w-0 rounded-lg border border-slate-200 px-2 py-2 text-xs outline-none focus:border-navy-800" />
      <div ref={list} id={`${id}-choices`} role="listbox" aria-label={`اختيارات — ${label}`}
        className="max-h-[min(12rem,30dvh)] overflow-y-auto overscroll-contain py-1">
        {groups.map((group) => {
          const rows = choices.map((option, index) => ({ option, index })).filter(({ option }) => option.group === group.label);
          return rows.length ? <div key={group.label} role="group" aria-label={group.label}>
            <p aria-hidden="true" className="px-2 py-1 text-[10px] font-bold text-slate-500">{group.label}</p>
            {rows.map(({ option, index }) => <button key={option.value} id={`${id}-option-${index}`} type="button"
              role="option" aria-selected={index === active} tabIndex={-1} data-choice-index={index}
              onClick={() => choose(option.value)}
              className={`min-h-11 w-full break-words rounded-lg px-2 py-2 text-right text-xs ${index === active ? "bg-navy-50 font-bold text-navy-900" : "text-slate-700 hover:bg-slate-50"}`}>
              {option.value}
            </button>)}
          </div> : null;
        })}
      </div>
      {choices.length === 0 ? <p role="status" className="px-2 py-1 text-xs text-slate-500">لا وصف يطابق البحث؛ يمكنك الكتابة بحرية.</p> : null}
      <div className="flex flex-wrap gap-1 border-t border-slate-100 pt-1">
        <button type="button" onClick={() => { if (!disabled) { close(); field.current?.focus(); } }}
          className="min-h-11 rounded-lg px-2 py-2 text-xs font-bold text-navy-800">أخرى — اكتب بحرية</button>
        <button type="button" onClick={() => close(true)} className="min-h-11 rounded-lg px-2 py-2 text-xs text-slate-600">إغلاق</button>
      </div>
    </div> : null}
  </div>;
}
