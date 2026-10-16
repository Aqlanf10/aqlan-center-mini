"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession } from '@/components/SessionProvider';
import { Modal } from '@/components/Modal';
import { operationalStatusLabel } from '@/lib/hr-operational-employment-shared';
import { HR_ATTENDANCE_STATUS_LABELS, HR_CONTRACT_STATUS_LABELS, type HrAttendanceRecordView, type HrContractView, type HrLeaveBalanceView } from '@/lib/hr-contracts-attendance-shared';
import { CURRENCIES, CURRENCY_SHORT, formatAmount, type Currency } from '@/lib/money';
import { CLINIC_ZONE_FALLBACK } from '@/lib/clinicZone';
import { hrHref, type HrProfileTab } from '@/lib/hr-navigation';
import { useHrReadEpoch } from './useHrReadEpoch';
import { useHrNavigation } from './HrNavigation';
import { CurrentPaySummary } from './CurrentPaySummary';
import type { StaffDetail } from './StaffPanel';

interface Props { staffId: string | number; open: boolean; onClose: () => void; onEdit: (detail: StaffDetail) => void }
export function StaffProfileModal(props: Props) {
  const session = useSession();
  return props.open ? <StaffProfileView key={`${session?.username}:${session?.role}:${props.staffId}`} {...props} /> : null;
}
type ReadResult = { key: string; detail: StaffDetail; contracts: HrContractView[]; attendance: HrAttendanceRecordView[]; balances: HrLeaveBalanceView[] };
function StaffProfileView({ staffId, onClose, onEdit }: Props) {
  const navigation = useHrNavigation(), readEpoch = useHrReadEpoch();
  const [localTab, setLocalTab] = useState<HrProfileTab>('overview');
  const tab = navigation?.profileTab ?? localTab;
  const key = `${staffId}:${tab}:${readEpoch}`;
  const [result, setResult] = useState<ReadResult | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const generation = useRef(0);
  const invalidate = useCallback(() => { generation.current++; }, []);
  useLayoutEffect(() => { invalidate(); return invalidate; }, [key, invalidate]);
  useEffect(() => {
    const lease = generation.current, abort = new AbortController();
    const read = async (path: string) => {
      const response = await fetch(path, { cache: 'no-store', signal: abort.signal });
      if (!response.ok) throw new Error('تعذّر تحميل ملف الموظف أو بيانات تبويبه. أعد المحاولة.');
      return response.json();
    };
    void (async () => {
      try {
        const [detail, rows] = await Promise.all([read(`/api/hr/staff/${staffId}`),
          tab === 'contract' ? read(`/api/hr/contracts?staffId=${staffId}`) : tab === 'attendance' ? read(`/api/hr/attendance?staffId=${staffId}`)
            : tab === 'leaves' ? read(`/api/hr/leaves/balances?staffId=${staffId}`) : Promise.resolve([])]);
        if (String(detail?.staff?.id) !== String(staffId) || !Array.isArray(rows) || rows.some(row => String(row.staffId) !== String(staffId))) throw new Error('تعذّر التحقق من هوية بيانات الملف.');
        if (abort.signal.aborted || generation.current !== lease) return;
        setResult({ key, detail, contracts: tab === 'contract' ? rows : [], attendance: tab === 'attendance' ? rows : [], balances: tab === 'leaves' ? rows : [] });
        setError(null);
      } catch (err) {
        if (!abort.signal.aborted && generation.current === lease) { setResult(null); setError({ key, message: err instanceof Error ? err.message : 'تعذّر التحميل.' }); }
      }
    })();
    return () => abort.abort();
  }, [key, staffId, tab]);
  const current = result?.key === key ? result : null, staff = current?.detail.staff;
  const href = (patch: Record<string, string | null>) => navigation?.href(patch) ?? hrHref('', { tab: 'staff', staffId: String(staffId), ...patch });
  const clock = (value: string | null) => value ? new Intl.DateTimeFormat('ar', { timeZone: CLINIC_ZONE_FALLBACK, dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
  const tabs: Array<[HrProfileTab, string]> = [['overview', 'نظرة عامة'], ['contract', 'العقود'], ['attendance', 'الحضور'], ['leaves', 'أرصدة الإجازة']];
  return <Modal onClose={onClose} label="ملف الموظف الشامل" alignTop>
    <div className="mx-auto w-full min-w-0 max-w-3xl rounded-2xl bg-white p-4 shadow-raised [overflow-wrap:anywhere] [&_div]:min-w-0 [&_fieldset]:min-w-0 [&_input]:min-w-0 [&_select]:min-w-0 [&_textarea]:min-w-0 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-bold text-navy-900">{staff?.fullName ?? 'ملف الموظف'}</h2>{staff && <p className="text-sm text-navy-600">{staff.jobTitle} · {operationalStatusLabel(staff)}</p>}</div>
        <button onClick={onClose} className="rounded-xl border px-3 py-2 text-sm">إغلاق الملف</button>
      </div>
      <nav aria-label="تبويبات ملف الموظف" className="mb-4 flex flex-wrap gap-2">
        {tabs.map(([id, label]) => <Link key={id} href={href({ profileTab: id })} prefetch={false} scroll={false} aria-current={tab === id ? 'page' : undefined}
          onClick={event => { if (!navigation) { event.preventDefault(); setLocalTab(id); } }}
          className={`rounded-xl px-3 py-2 text-sm ${tab === id ? 'bg-navy-900 text-white' : 'bg-navy-50 text-navy-700'}`}>{label}</Link>)}
      </nav>
      {error?.key === key ? <p role="alert" className="text-danger-700">{error.message}</p> : !current || !staff ? <p role="status">جارٍ تحميل الملف…</p> : <div className="space-y-4">
        {tab === 'overview' && <>
          <CurrentPaySummary pay={staff.currentPay} staffId={staff.id} />
          <dl className="grid gap-3 rounded-xl bg-navy-50 p-3 text-sm sm:grid-cols-2">
            <div><dt>تاريخ الالتحاق</dt><dd>{staff.hireDate ?? '—'}</dd></div>
            <div><dt>الهاتف</dt><dd><bdi>{staff.phone ?? '—'}</bdi></dd></div>
            <div><dt>حساب الدخول</dt><dd>{current.detail.linkedUser ? `${current.detail.linkedUser.displayName} (${current.detail.linkedUser.username}) — ${current.detail.linkedUser.role}` : 'بلا حساب دخول'}</dd></div>
            <div><dt>ملاحظة</dt><dd>{staff.note ?? '—'}</dd></div>
          </dl>
          <button onClick={() => onEdit(current.detail)} className="rounded-xl bg-navy-800 px-4 py-2 text-sm font-bold text-white">تعديل بيانات الموظف وربط الحساب</button>
        </>}
        {tab === 'contract' && <>
          <CurrentPaySummary pay={staff.currentPay} staffId={staff.id} />
          {current.contracts.length ? current.contracts.map(c => <article key={c.id} className="space-y-2 rounded-xl border p-3 text-sm">
            <h3 className="font-bold">{c.title} · {c.contractNumber} · {HR_CONTRACT_STATUS_LABELS[c.status]}</h3>
            <p>من <bdi>{c.startDate}</bdi> إلى <bdi>{c.endDate ?? 'غير محدد'}</bdi></p>
            <p>الراتب: {c.baseSalaryMinor != null && CURRENCIES.includes(c.salaryCurrency as Currency) ? `${formatAmount(c.baseSalaryMinor, c.salaryCurrency as Currency)} ${CURRENCY_SHORT[c.salaryCurrency as Currency]}` : 'غير موثق'} · النسبة: {c.commissionRatePercent == null ? 'غير موثقة' : `${c.commissionRatePercent}%`}</p>
            <Link href={href({ tab: 'contracts', contractId: String(c.id) })} prefetch={false} scroll={false} className="font-bold text-brand-blue underline">فتح العقد وملاحقه</Link>
          </article>) : <p>لا توجد عقود موثقة.</p>}
        </>}
        {tab === 'leaves' && <>
          {current.balances.length ? current.balances.map(b => <div key={b.id} className="rounded-xl border p-3 text-sm"><b>{b.leaveTypeName} · {b.year}</b><p>متاح: {b.availableDays} يوم · مستخدم: {b.usedDays} · معلّق: {b.pendingDays}</p></div>) : <p>لا أرصدة إجازة مسجلة.</p>}
          <Link href={href({ tab: 'leaves' })} prefetch={false} scroll={false} className="font-bold text-brand-blue underline">طلبات الإجازة واعتماداتها</Link>
        </>}
        {tab === 'attendance' && <>
          {current.attendance.length ? <div className="overflow-x-auto"><table className="w-full text-right text-xs"><thead><tr>{['اليوم', 'الدخول الفعلي', 'الخروج الفعلي', 'دقائق العمل', 'الحالة'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{current.attendance.map(a => <tr key={a.id} className="border-t"><td className="p-2">{a.attendanceDate}</td><td className="p-2">{clock(a.checkInActual)}</td><td className="p-2">{clock(a.checkOutActual)}</td><td className="p-2">{a.workMinutes}</td><td className="p-2">{HR_ATTENDANCE_STATUS_LABELS[a.status]}</td></tr>)}</tbody></table></div> : <p>لا سجلات حضور في نطاق القراءة الحالي.</p>}
          <Link href={href({ tab: 'attendance' })} prefetch={false} scroll={false} className="font-bold text-brand-blue underline">إدارة الحضور والتصحيحات</Link>
        </>}
      </div>}
    </div>
  </Modal>;
}
