"use client";
import Link from "next/link";
import { ArrowLeft, RefreshCw, Printer, Languages, Package, ShieldCheck, X } from "lucide-react";
import styles from "./inventory.module.css";
import { useEffect, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { ReportPrintHeader, ReportPrintFooter } from "@/components/ReportPrintHeader";
import { PrintMetadata } from "@/components/PrintDocument";
import { CLINIC_BASE_CURRENCY, formatMoney } from "@/lib/money";
import type { ValuedInventoryItem } from "@/lib/inventory-domain/read";

type Report = { items: ValuedInventoryItem[]; totalMinor: number | null; knownTotalMinor: number; withoutCost: number; estimated: number; baseCurrency: string };
const copy = {
  ar: { title: "مراجعة تقييم المخزون", back: "المخزون", print: "طباعة التقرير", refresh: "تحديث", loading: "جارٍ تحميل التقييم…", failed: "تعذّر تحميل التقييم. أعد المحاولة.", denied: "قراءة تكلفة المخزون للمدير فقط.", incomplete: "التقييم غير مكتمل", total: "إجمالي التقييم", knownTotal: "قيمة البنود المعلومة فقط", known: "معلومة", estimated: "تقديرية", missing: "مجهولة", qty: "الكمية", unit: "الوحدة", value: "القيمة", empty: "لا توجد حركات مخزون ضمن النطاق.", note: "المصدر: حركات المخزون الحالية بترتيب الترحيل. السعر المجهول لا يعامل كصفر. المرتجعات التاريخية دون رابط للصرف تقديرية. هذا التقرير لا يغير المخزون أو حسابات الموردين.", range: "الأصناف النشطة · جميع الحركات المرحلة · YER", missingCount: "بنود مجهولة التكلفة", estimatedCount: "بنود تقديرية", search: "بحث بالاسم أو الوحدة", clear: "مسح البحث", previous: "السابق", next: "التالي", noResults: "لا توجد مواد تطابق البحث.", shown: "المعروض", items: "مواد", page: "صفحة" },
  en: { title: "Inventory valuation review", back: "Inventory", print: "Print report", refresh: "Refresh", loading: "Loading valuation…", failed: "Valuation unavailable. Please retry.", denied: "Inventory costs are restricted to administrators.", incomplete: "Valuation incomplete", total: "Total valuation", knownTotal: "Known item values only", known: "Known", estimated: "Estimated", missing: "Missing", qty: "Quantity", unit: "Unit", value: "Value", empty: "No inventory movements in this scope.", note: "Source: current stock movements in posting order. Missing prices are not zero. Legacy returns without an issue link are estimates. This report does not change stock or supplier accounts.", range: "Active items · all posted movements · YER", missingCount: "Items with missing costs", estimatedCount: "Estimated items", search: "Search by name or unit", clear: "Clear search", previous: "Previous", next: "Next", noResults: "No materials match this search.", shown: "Showing", items: "items", page: "Page" },
} as const;

export function InventoryValuationReview() {
  const session = useSession();
  const [locale, setLocale] = useState<"ar" | "en">("ar");
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<{ key: string; report: Report | null } | null>(null);
  const owner = session?.role === "admin" ? session.username : null;
  const requestKey = `${owner ?? "none"}:${revision}`;
  const loading = state?.key !== requestKey;
  const failed = !loading && state?.report === null;
  const text = copy[locale];
  useEffect(() => {
    if (!owner) return;
    const controller = new AbortController();
    let alive = true;
    fetch("/api/inventory/value", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("unavailable");
        const report = await response.json() as Report;
        if (!Array.isArray(report.items) || report.baseCurrency !== CLINIC_BASE_CURRENCY) throw new Error("invalid_report");
        if (alive) setState({ key: requestKey, report });
      }).catch(() => { if (alive) setState({ key: requestKey, report: null }); });
    return () => { alive = false; controller.abort(); };
  }, [owner, requestKey]);
  const report = owner && state?.key === requestKey ? state.report : null;
  const filtered = report?.items.filter(item => `${item.name} ${item.unit}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const currentPage = Math.min(page, pages);
  const shown = filtered.slice((currentPage - 1) * 20, currentPage * 20);
  const renderItem = (item: ValuedInventoryItem) => <article key={item.id} className={styles.item}>
    <div className="flex flex-wrap justify-between gap-2"><h2 className="font-bold">{item.name}</h2><span className={styles.badge} data-state={item.costStatus}>{text[item.costStatus]}</span></div>
    <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
      <dt>{text.qty}</dt><dd className="text-end tabular-nums">{new Intl.NumberFormat(locale === "ar" ? "ar-YE" : "en-US").format(item.qty)}</dd>
      <dt>{text.unit}</dt><dd className="text-end">{item.unit}</dd>
      <dt>{text.value}</dt><dd className="text-end font-bold">{item.valueMinor === null ? text.missing : formatMoney(item.valueMinor, CLINIC_BASE_CURRENCY)}</dd>
    </dl>
  </article>;
  return <section dir={locale === "ar" ? "rtl" : "ltr"} lang={locale} className={`${styles.root} print-document-on-print space-y-5`} data-testid="inventory-valuation-review">
    <div className={styles.toolbar}>
      <Link href="/inventory" className={styles.button}><ArrowLeft size={16} aria-hidden="true" />{text.back}</Link>
      <button type="button" onClick={() => setLocale(locale === "ar" ? "en" : "ar")} className={styles.button}><Languages size={16} aria-hidden="true" />{locale === "ar" ? "English" : "العربية"}</button>
    </div>
    <div className={styles.printHeader}><ReportPrintHeader title={text.title} subtitle={text.range} /></div>
    <div className={styles.toolbar}><div><h1 className={styles.title}>{text.title}</h1><p className={styles.caption}>{text.range}</p></div><ShieldCheck aria-hidden="true" size={28} /></div>
    {!owner ? <p role="alert">{text.denied}</p> : <>
      <div className={styles.actions}>
        <button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading} className={styles.button}><RefreshCw aria-hidden="true" size={16}/>{text.refresh}</button>
        <button type="button" onClick={() => window.print()} disabled={!report || loading || failed} className={`${styles.button} ${styles.primary}`}><Printer aria-hidden="true" size={16}/>{text.print}</button>
      </div>
      {loading ? <p className={styles.feedback} role="status">{text.loading}</p> : failed ? <p role="alert" className={styles.feedback}>{text.failed}</p> : report ? <>
        <PrintMetadata printOnly className={styles.printMetrics}><dl className={styles.metrics}>
          <div className={`${styles.metric} ${report.totalMinor === null ? styles.warn : ""}`}><dt>{text.total}</dt><dd><h2>{report.totalMinor === null ? text.incomplete : formatMoney(report.totalMinor, CLINIC_BASE_CURRENCY)}</h2></dd></div>
          <div className={styles.metric}><dt>{text.knownTotal}</dt><dd>{formatMoney(report.knownTotalMinor, CLINIC_BASE_CURRENCY)}</dd></div>
          <div className={styles.metric}><dt>{text.missingCount} · {text.estimatedCount}</dt><dd dir="ltr">{report.withoutCost} · {report.estimated}</dd></div>
        </dl></PrintMetadata>
        <p className={styles.note}>{text.note}</p>
        <div className={styles.panel}><div className={styles.panelHeading}><span>{text.title}</span><Package size={18} aria-hidden="true" /></div>
          <div className={`${styles.note} ${styles.screenControls}`}>
            <label htmlFor="inventory-value-search" className="block mb-2">{text.search}</label>
            <div className={styles.actions}><input id="inventory-value-search" className={styles.search} value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} />
              {search ? <button type="button" className={styles.button} aria-label={text.clear} onClick={() => { setSearch(""); setPage(1); document.getElementById("inventory-value-search")?.focus(); }}><X size={16} aria-hidden="true" /></button> : null}</div>
          </div>
          <div className={`${styles.items} ${styles.screenItems}`}>{shown.map(renderItem)}</div>
          {!filtered.length ? <p className={`${styles.note} ${styles.screenControls}`}>{text.noResults}</p> : null}
          <div className={`${styles.toolbar} ${styles.note} ${styles.screenControls}`}>
            <span>{text.shown} {shown.length} / {filtered.length} {text.items} · {text.page} {currentPage} / {pages}</span>
            <div className={styles.actions}><button type="button" className={styles.button} disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>{text.previous}</button><button type="button" className={styles.button} disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>{text.next}</button></div>
          </div>
          <div className={`${styles.items} ${styles.printItems}`}>{report.items.map(renderItem)}</div>
        </div>
        {!report.items.length ? <p>{text.empty}</p> : null}
        <div className={styles.printFooter}><ReportPrintFooter /></div>
      </> : null}
    </>}
  </section>;
}
