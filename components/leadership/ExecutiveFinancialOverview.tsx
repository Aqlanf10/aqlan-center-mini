"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import styles from "./leadership.module.css";
import { CURRENCY_LABEL, formatMoney } from "@/lib/money";
import {
  PERIOD_PRESET_LABEL,
  periodRange,
  type ExecutiveKpis,
  type PeriodPreset,
} from "@/lib/executive";
import { friendlyDateLong } from "@/lib/reminders";

/**
 * غرفة القيادة — شاشة المالك.
 *
 * قرارٌ لا أرقام: هل العيادة رابحة؟ كم عليها للمختبرات؟ وهل كراسيّا تعمل أم تنام؟
 * (P-01 owner review — تصحيح ١) الفواتير والذمم بعملة كل اتفاق من مراجعها
 * القانونية — لا رقم واحد يمزج عملات — والصندوق والمصروفات من الدفاتر
 * الأساسية الخالصة، وصافي الربح الموحّد مؤجَّل لتصميم الدفتر العميق (TD-REG-028).
 *
 * والفترة تُختار لا تُخمَّن: شهرٌ مكتمل يقول غير ما يقوله أسبوع.
 */

const PRESETS: PeriodPreset[] = ["thisMonth", "lastMonth", "last3", "thisYear", "lastYear"];

export default function ExecutiveFinancialOverview({ standalone = false }: { standalone?: boolean } = {}) {
  const [preset, setPreset] = useState<PeriodPreset | null>("thisMonth");
  const [range, setRange] = useState(() => periodRange("thisMonth", new Date()));
  const [feed, setFeed] = useState<ExecutiveKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const [view, setView] = useState<FinanceView>("cash");

  const load = useCallback(async (from: string, to: string) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setFeed(null);
    setError(null);
    try {
      const response = await fetch(`/api/executive?from=${from}&to=${to}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      if (sequence !== loadSequence.current) return;
      setFeed(payload as ExecutiveKpis);
      setError(null);
    } catch (loadError) {
      if (sequence !== loadSequence.current) return;
      setFeed(null);
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(range.from, range.to); }, [range, load]);

  const pickPreset = (next: PeriodPreset) => {
    setPreset(next);
    setRange(periodRange(next, new Date()));
  };

  return <section className={styles.stack} data-testid="leadership-finance">
    <div className={styles.sectionHeading}>
      <div><p className={styles.eyebrow}>قراءة مالية · نطاق مستقل عن يوم التشغيل</p>
        {standalone ? <h1>المالية والفترات</h1> : <h2>المالية والفترات</h2>}
        <p className={styles.sourceLine}>كل عملة في مكانها. التحصيل والفواتير والذمم ليست رقمًا واحدًا.</p>
      </div>
      <button type="button" className={styles.smallButton} disabled={loading} onClick={() => void load(range.from, range.to)}>تحديث المالية</button>
    </div>
    <section className={styles.panel} aria-label="الفترة المالية">
      <div className={styles.pillGroup} role="group" aria-label="فترات مالية جاهزة">{PRESETS.map(option =>
        <button type="button" key={option} aria-pressed={preset === option} onClick={() => pickPreset(option)}>{PERIOD_PRESET_LABEL[option]}</button>)}</div>
      <div className={styles.financeDates}>
        <label className={styles.dayLabel}>من<input type="date" value={range.from} onChange={event => { setPreset(null); setRange(r => ({ ...r, from: event.target.value })); }} /></label>
        <label className={styles.dayLabel}>إلى<input type="date" value={range.to} onChange={event => { setPreset(null); setRange(r => ({ ...r, to: event.target.value })); }} /></label>
        {preset === null && <span className={styles.status}>فترة مخصّصة</span>}
        {feed && <a className={styles.smallButton} href={`/api/executive?from=${range.from}&to=${range.to}&format=csv`}>تصدير CSV</a>}
      </div>
    </section>
    {error && <div role="alert" className={styles.error}>{error} <button type="button" onClick={() => void load(range.from, range.to)}>إعادة المحاولة</button></div>}
    {loading && !feed && <p className={styles.sourceState} role="status">جارٍ التحقق من المصدر المالي… القيم غير معروفة بعد.</p>}
    {feed && <>
      <p className={styles.sourceLine}>من {friendlyDateLong(feed.from)} إلى {friendlyDateLong(feed.to)} · العملة الأساسية {feed.baseCurrency} للمرجع، وليست تحويلًا لبقية العملات</p>
      <nav className={styles.pillGroup} aria-label="أقسام القراءة المالية">{FINANCE_VIEWS.map(item =>
        <button type="button" key={item.id} aria-pressed={view === item.id} onClick={() => setView(item.id)}>{item.label}</button>)}</nav>
      <FinancialReadout feed={feed} view={view} showAdminLinks={!standalone} />
    </>}
  </section>;
}

export type FinanceView = "cash" | "billing" | "debts" | "operations";
const FINANCE_VIEWS: { id: FinanceView; label: string }[] = [
  { id: "cash", label: "حركة النقد" }, { id: "billing", label: "الفواتير والمصروفات" },
  { id: "debts", label: "الذمم" }, { id: "operations", label: "تشغيل الفترة" },
];
function AmountCard({ label, value, scope, children }: { label: string; value: string; scope: string; children?: ReactNode }) {
  return <article className={styles.amountCard}>
    <div className={styles.metricTop}><h3>{label}</h3><Icon name="wallet" className="h-5 w-5" /></div>
    <p className={styles.amountValue}><bdi>{value}</bdi></p><p className={styles.sourceLine}>{scope}</p>{children}
  </article>;
}
function Fact({ label, value }: { label: string; value: string | number }) {
  return <div><dt>{label}</dt><dd><bdi>{value}</bdi></dd></div>;
}
/** Presentation only. Values come directly from the existing financial read model, without conversion or recalculation. */
export function FinancialReadout({ feed, view, showAdminLinks = false }: { feed: ExecutiveKpis; view: FinanceView; showAdminLinks?: boolean }) {
  const activeCash = feed.cashMovements.filter(row => row.collectedMinor !== 0 || row.paidOutMinor !== 0 || row.netMinor !== 0);
  const quietCash = feed.cashMovements.filter(row => row.collectedMinor === 0 && row.paidOutMinor === 0 && row.netMinor === 0);
  if (view === "cash") return <section className={styles.stack} aria-labelledby="leadership-cash-title">
    <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>حركات الفترة فقط</p><h2 id="leadership-cash-title">ما دخل وما خرج، بكل عملة</h2></div>{showAdminLinks && <a className={styles.textLink} href="/finance/accounting">فتح المحاسبة</a>}</div>
    <div className={styles.amountGrid}>{activeCash.map(row => <AmountCard key={row.currency} label={`صندوق ${CURRENCY_LABEL[row.currency]}`} value={formatMoney(row.netMinor, row.currency)} scope="صافي حركة الفترة، وليس الرصيد الحالي للصندوق">
      <dl className={styles.factList}><Fact label="ما دخل" value={formatMoney(row.collectedMinor, row.currency)} /><Fact label="ما خرج" value={formatMoney(row.paidOutMinor, row.currency)} /></dl>
    </AmountCard>)}</div>
    {activeCash.length === 0 && <p className={styles.empty}>لا حركة نقدية مسجّلة في هذه القراءة.</p>}
    {quietCash.length > 0 && <p className={styles.sourceLine}>عملات بلا حركة في الفترة: {quietCash.map(row => CURRENCY_LABEL[row.currency]).join("، ")}.</p>}
    <p className={styles.footnote}>من مدين ودائن حسابات النقدية في دفتر اليومية للفترة. هذا الصافي ليس ربحًا، ولا رصيد درج حاليًا؛ لا جمع أو تحويل بين العملات.</p>
  </section>;
  if (view === "billing") return <div className={styles.stack}>
    <section aria-labelledby="leadership-billing-title"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>أساس الاستحقاق · بعملة الفاتورة</p><h2 id="leadership-billing-title">الفواتير</h2></div>{showAdminLinks && <a className={styles.textLink} href="/finance/reports">فتح التقارير المالية</a>}</div>
      {feed.billingByCurrency.length === 0 ? <p className={styles.empty}>لا فواتير في الفترة.</p> : <div className={styles.amountGrid}>{feed.billingByCurrency.map(row => <AmountCard key={row.currency} label={`صافي الفواتير · ${CURRENCY_LABEL[row.currency]}`} value={formatMoney(row.netMinor, row.currency)} scope="قيمة الفواتير بعد الخصومات، لا إثبات تحصيل">
        <dl className={styles.factList}><Fact label="الإجمالي" value={formatMoney(row.grossMinor, row.currency)} /><Fact label="الخصومات" value={formatMoney(row.discountMinor, row.currency)} /></dl>
      </AmountCard>)}</div>}
    </section>
    <section aria-labelledby="leadership-expenses-title"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>أساس الاستحقاق · حسب الدفتر الأصلي</p><h2 id="leadership-expenses-title">المصروفات</h2></div></div>
      {feed.expensesByCurrency.length === 0 ? <p className={styles.empty}>لا مصروفات في الفترة.</p> : <div className={styles.amountGrid}>{feed.expensesByCurrency.map(group => <AmountCard key={group.currency} label={`مصروفات ${CURRENCY_LABEL[group.currency]}`} value={formatMoney(group.totalMinor, group.currency)} scope="كل بند بعملته، دون صافي ربح مختلط">
        <details className={styles.recordDetails}><summary>تفصيل بنود المصروفات</summary><dl className={styles.factList}>{group.rows.map(expense => <Fact key={expense.code} label={expense.name} value={formatMoney(expense.amountMinor, group.currency)} />)}</dl></details>
      </AmountCard>)}</div>}
    </section>
    <p className={styles.footnote}>الأرقام من المرجع القانوني لكل عملة. لا تُطرح مصروفات عملة من فواتير عملة أخرى. قراءة ربح كل عملة في المحاسبة.</p>
  </div>;
  if (view === "debts") return <div className={styles.stack}>
    <section aria-labelledby="leadership-receivables-title"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>تراكمي حتى نهاية الفترة المختارة</p><h2 id="leadership-receivables-title">ذمم المرضى</h2></div>{showAdminLinks && <a className={styles.textLink} href="/finance/debts">فتح الذمم</a>}</div>
      {feed.receivableByCurrency.length === 0 ? <p className={styles.empty}>لا ذمم مرضى ضمن نتيجة المصدر لهذه الفترة.</p> : <div className={styles.amountGrid}>{feed.receivableByCurrency.map(row => <AmountCard key={row.currency} label={CURRENCY_LABEL[row.currency]} value={formatMoney(row.dueMinor, row.currency)} scope={`من مرجع أرصدة المرضى حتى ${feed.to}`} />)}</div>}
    </section>
    <section aria-labelledby="leadership-payables-title"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>رصيد الجهات الحالي · ليس مقيدًا بالفترة أعلاه</p><h2 id="leadership-payables-title">المعامل والموردون</h2></div>{showAdminLinks && <a className={styles.textLink} href="/finance/parties">فتح الجهات</a>}</div>
      {feed.payableByCurrency === undefined ? <p className={styles.empty}>بيانات ذمم الجهات غير متاحة في هذه القراءة.</p> : feed.payableByCurrency.length === 0 ? <p className={styles.empty}>لا رصيد جهات غير صفري في نتيجة المصدر الحالية.</p> : <div className={styles.amountGrid} data-testid="payable-by-currency">{feed.payableByCurrency.map(row => <AmountCard key={row.currency} label={CURRENCY_LABEL[row.currency]} value={formatMoney(row.dueMinor, row.currency)} scope="الالتزامات بعد السداد والأرصدة المقدّمة، من مرجع الجهة" />)}</div>}
      {feed.parties.filter(party => party.dueMinor > 0).length > 0 && <details className={styles.recordDetails}><summary>جهات ذات رصيد مستحق · أول 5 من المصدر</summary><dl className={styles.factList}>{feed.parties.filter(party => party.dueMinor > 0).slice(0,5).map(party => <Fact key={`${party.kind}-${party.label}-${party.currency}`} label={party.label} value={formatMoney(party.dueMinor,party.currency)} />)}</dl></details>}
    </section>
    <p className={styles.footnote}>ذمم المرضى حتى نهاية الفترة، وأرصدة الجهات حالية. لكل عملة رصيد مستقل؛ لا مقاصة بين العملات أو بين المرضى والجهات.</p>
  </div>;
  return <div className={styles.stack}>
    <section className={styles.panel}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>مصدر التقرير المالي · للفترة المختارة</p><h2>تشغيل الفترة، لا تشغيل اليوم</h2></div></div>
      <p className={styles.sourceLine}>الحالة الحالية لزيارات وصلت خلال الفترة. ليست إعادة بناء لحالتها في يوم سابق.</p>
      <dl className={styles.operationalFacts}><Fact label="زيارات وصلت" value={feed.operational.arrived} /><Fact label="منتهية" value={feed.operational.done} /><Fact label="ما زالت مفتوحة" value={feed.operational.stillOpen} /><Fact label="لم يحضر" value={feed.operational.noShow} /><Fact label="ملغاة" value={feed.operational.cancelled} /><Fact label="مرضى جدد في الفترة" value={feed.operational.newPatients} /></dl>
    </section>
    <section className={styles.panel}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>من زمن الجلوس والانتهاء والسعة المسجّلة</p><h2>إشغال الكراسي في الفترة</h2></div><strong className={styles.occupancyValue}>{feed.occupancy.capacityMinutes > 0 ? `${feed.occupancy.pct}%` : "غير قابل للحساب"}</strong></div>
      {feed.occupancy.capacityMinutes > 0 && <div className={styles.occupancyTrack} aria-hidden="true"><span style={{width:`${Math.min(100,feed.occupancy.pct)}%`}} /></div>}
      <p className={styles.footnote}>{feed.occupancy.occupiedMinutes.toLocaleString("en")} دقيقة شغل من {feed.occupancy.capacityMinutes.toLocaleString("en")} دقيقة سعة ({feed.occupancy.chairs} كراسٍ × {feed.occupancy.activeDays} يوم وصول فعلي × ساعات الإعدادات). هذه ليست نسبة حضور الأطباء أو سعة حجز موعد جديد.</p>
    </section>
    <details className={`${styles.panel} ${styles.recordDetails}`}><summary>سجلات حالية خارج نطاق الفترة</summary><dl className={styles.factList}><Fact label="إجمالي المرضى المسجّلين الآن" value={feed.operational.totalPatients} /><Fact label={`حالات تقويم نشطة من ${feed.operational.orthoTotal} حالة`} value={feed.operational.orthoActive} /><Fact label="تنبيهات مخزون حالية (أصناف ودفعات، لا عدد أصناف)" value={feed.operational.inventoryAlerts} /></dl></details>
  </div>;
}
