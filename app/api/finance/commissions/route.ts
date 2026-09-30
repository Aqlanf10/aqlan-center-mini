import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, commissionDetailReport, commissionReport } from "@/lib/db";
import { mergeCommissionBalances } from "@/lib/commission-balance";
import { resolveCommissionViewer } from "@/lib/commission-access";
import { isCurrency, CLINIC_BASE_CURRENCY } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY_PATTERN = /^[a-z_]{1,40}$/;
/* بداية محايدة لحساب الرصيد التراكمي المشتق حتى نهاية التقرير. */
const COMMISSION_BALANCE_EPOCH = "1970-01-01";

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  /* صلاحيات الوكيل المساعد + «المالية المخفية»: الطبيب يرى مستحقاته الشخصية
     فقط (canViewOwnCommissions) — ورؤية عمولات الجميع تحتاج منحًا صريحًا.
     الإدارة كما كانت، والاستقبال خارج الباب تمامًا. الربط بجهة الطبيب عبر
     party_id (V2 §٣٥). (COMM-DETAIL-1) القاعدة في lib/commission-access.ts —
     وطبيبٌ شخصيّ بلا جهة مربوطة لا يرى شيئًا بدل أن يرى الجميع. */
  const viewer = await resolveCommissionViewer(session);
  if (viewer.kind === "denied") {
    return NextResponse.json({ message: viewer.message }, { status: viewer.status });
  }
  const isPersonalOnly = viewer.kind === "own";
  const ownPartyId = viewer.kind === "own" ? viewer.partyId : null;

  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : monthStart;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  const [start, end] = from <= to ? [from, to] : [to, from];
  // (TD-05) الأساس دستوري من الكود.
  const base = CLINIC_BASE_CURRENCY;

  try {
    /* (COMM-DETAIL-1 · F-8) وضع التفصيل: سطرٌ لكل حصة طبيب من المحرّك نفسه — بمرشّحات
       الطبيب والتخصص والعملة. الطبيب الشخصيّ مقيَّدٌ بجهته مهما طلب. */
    if (params.get("detail") === "1") {
      if (isPersonalOnly && ownPartyId === null) {
        return NextResponse.json({
          from: start, to: end, rows: [], lines: [], unallocatedMaterials: [], serviceRateFindings: [],
          baseCurrency: base, isPersonalOnly,
        });
      }
      const requestedDoctor = Number(params.get("doctorId"));
      const doctorId = isPersonalOnly
        ? ownPartyId
        : Number.isInteger(requestedDoctor) && requestedDoctor > 0 ? requestedDoctor : null;
      const currencyParam = params.get("currency");
      const categoryParam = params.get("specialty");
      const report = await commissionDetailReport(start, end, {
        doctorId,
        currency: currencyParam && isCurrency(currencyParam) ? currencyParam : null,
        category: categoryParam && CATEGORY_PATTERN.test(categoryParam) ? categoryParam : null,
      });
      return NextResponse.json({
        ...report,
        // المواد غير المنسوبة لا تخصّ طبيبًا بعينه — للإدارة وحدها.
        unallocatedMaterials: isPersonalOnly ? [] : report.unallocatedMaterials,
        baseCurrency: base,
        isPersonalOnly,
      });
    }

    const periodRows = await commissionReport(start, end);
    /* الرصيد المالي للطبيب لا يبدأ من مرشح الشاشة: أي زيادة صُرفت في شهر سابق
       تظل مديونية حتى تغطيها عمولة لاحقة. لذلك نحسب رصيدًا مشتقًا من كامل
       التاريخ حتى نهاية التقرير، من نفس محرك العمولة ونفس سندات الصرف. */
    const cumulativeRows = start === COMMISSION_BALANCE_EPOCH
      ? periodRows
      : await commissionReport(COMMISSION_BALANCE_EPOCH, end);
    const allRows = mergeCommissionBalances(periodRows, cumulativeRows);

    const rows = isPersonalOnly
      ? allRows.filter((r) => ownPartyId !== null && r.doctorId === ownPartyId)
      : allRows;

    return NextResponse.json({
      from: start,
      to: end,
      rows,
      baseCurrency: isCurrency(base) ? base : "YER",
      isPersonalOnly,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل العمولات." }, { status: 500 });
  }
}
