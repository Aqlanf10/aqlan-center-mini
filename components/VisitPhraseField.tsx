"use client";

import { useEffect, useId, useRef, useState } from "react";
import { appendPhrase } from "@/lib/visit-suggestions";

/** One narrative value. Search and focus never edit it; only an explicit pick does. */
export function VisitPhraseField({ label, value, onChange, disabled, auto = false, hint, phrases = [], onPhrase, maxLength = 2000 }: {
  label: string; value: string; onChange: (value: string) => void; disabled: boolean;
  auto?: boolean; hint?: string; phrases?: string[]; onPhrase?: (phrase: string) => void; maxLength?: number;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [announcement, setAnnouncement] = useState("");
  const filtered = phrases.filter((phrase) => phrase.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const expanded = open && !disabled;
  const choose = (phrase: string) => {
    if (disabled || !onPhrase) return;
    if (appendPhrase(value, phrase).length > maxLength) {
      setAnnouncement(`لا تتسع هذه العبارة ضمن حد ${maxLength} حرفًا؛ عدّل النص أولًا.`);
      return;
    }
    onPhrase(phrase);
    setOpen(false);
    setAnnouncement(`أُضيفت العبارة: ${phrase}`);
    input.current?.focus();
  };
  const close = (focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  };
  useEffect(() => {
    if (expanded) search.current?.focus();
  }, [expanded]);
  useEffect(() => {
    if (expanded && active >= 0) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [expanded, active]);

  return (
    <div className="min-w-0" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
    }}>
      <label className="block" htmlFor={`${id}-text`}>
        <span className="mb-1 block text-[11px] font-bold text-slate-500">
          {label}
          {auto ? <span className="mr-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">✨ تلقائي — عدّله إن لزم</span> : null}
        </span>
        <textarea ref={input} id={`${id}-text`} value={value} aria-label={label} maxLength={maxLength}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => { if (!disabled) onChange(event.target.value); }} rows={2} disabled={disabled}
          className={`w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-brand-blue disabled:bg-slate-50 disabled:text-slate-500 ${
            auto ? "border-amber-200 bg-amber-50/40" : "border-slate-200"}`} />
      </label>
      {hint ? <p id={`${id}-hint`} className="mt-0.5 text-[10px] font-semibold text-slate-500">{hint}</p> : null}
      {onPhrase ? (
        <div className="mt-1" aria-label={`عبارات سريعة — ${label}`}>
          <button ref={trigger} type="button" disabled={disabled} aria-expanded={expanded} aria-controls={`${id}-choices`}
            onClick={() => {
              if (disabled) return;
              if (open) close();
              else { setQuery(""); setActive(-1); setAnnouncement(""); setOpen(true); }
            }}
            className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 disabled:opacity-50">
            اختر عبارة محفوظة
          </button>
          {expanded ? (
            <div id={`${id}-choices`} className="mt-1 min-w-0 rounded-xl border border-slate-200 bg-white p-2"
              onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.keyCode !== 229 && event.key === "Escape") { event.preventDefault(); close(true); } }}>
              <input ref={search} value={query} role="combobox" aria-label={`بحث في العبارات — ${label}`}
                aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`}
                aria-activedescendant={active >= 0 && filtered[active] ? `${id}-option-${active}` : undefined}
                placeholder="ابحث في العبارات المحفوظة…"
                onChange={(event) => { setQuery(event.target.value); setActive(-1); setAnnouncement(""); }}
                onKeyDown={(event) => {
                  // Enter/arrow keys may belong to an IME candidate, not this list.
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setActive((previous) => filtered.length === 0 ? -1 : event.key === "ArrowDown"
                      ? Math.min(previous + 1, filtered.length - 1) : previous < 0 ? filtered.length - 1 : Math.max(0, previous - 1));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    if (active >= 0 && filtered[active]) choose(filtered[active]);
                  }
                }}
                className="min-h-11 w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-navy-800" />
              <p role="status" className="py-1 text-[11px] text-slate-500">
                {phrases.length === 0 ? "لا توجد عبارات محفوظة متاحة؛ اكتب النص بحرية." : filtered.length === 0
                  ? "لا توجد عبارة تطابق البحث." : `${filtered.length} عبارة؛ اختر لإضافتها إلى النص.`}
              </p>
              <ul ref={list} id={`${id}-list`} role="listbox" aria-label={`العبارات المحفوظة — ${label}`}
                className="max-h-[min(12rem,30dvh)] overflow-y-auto overscroll-contain">
                {filtered.map((phrase, index) => (
                  <li key={phrase} id={`${id}-option-${index}`} role="option" aria-selected={index === active}>
                    <button type="button" tabIndex={-1} onClick={() => choose(phrase)}
                      className={`min-h-11 w-full break-words rounded-lg px-3 py-2 text-right text-xs ${index === active ? "bg-navy-50 font-bold text-navy-900" : "text-slate-700 hover:bg-slate-50"}`}>
                      {phrase}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-1 flex flex-wrap gap-2 border-t border-slate-100 pt-1">
                <button type="button" onClick={() => { close(); input.current?.focus(); }}
                  className="min-h-11 rounded-lg px-3 py-2 text-xs font-bold text-navy-800">كتابة نص آخر</button>
                <button type="button" onClick={() => close(true)}
                  className="min-h-11 rounded-lg px-3 py-2 text-xs text-slate-600">إغلاق العبارات</button>
              </div>
            </div>
          ) : null}
          <p role="status" className="sr-only">{announcement}</p>
        </div>
      ) : null}
    </div>
  );
}
