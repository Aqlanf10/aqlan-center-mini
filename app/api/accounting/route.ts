import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  CLINIC_TIME_ZONE, ManualEntryInvalidError, createManualEntry, isPeriodLocked, journalEntries, recordAudit,
  type ManualEntryLine,
} from "@/lib/db";
import {
  ACCOUNTS,
  LEDGER_CURRENCIES,
  POSTABLE_ACCOUNTS,
  statementsByCurrency,
  trialBalance,
} from "@/lib/accounting";
import { FinancialCurrencyIntegrityError, isCurrency, parseAmount, CLINIC_BASE_CURRENCY, type Currency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { canViewFinancialReports, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "الدفاتر المحاسبية للمدير وحده." }, { status: 403 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canViewFinancialReports(session.role)) return forbidden();

  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : monthStart;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  const [start, end] = from <= to ? [from, to] : [to, from];
  const account = params.get("account");

  const accountCurrency = params.get("currency");

  try {
    const entries = await journalEntries(start, end);
    // (TD-05) الأساس دستوري من الكود — للعرض فقط؛ (TD-REG-028) كل مبلغ بعملته الصريحة.
    const base = CLINIC_BASE_CURRENCY;
    const balances = trialBalance(entries);

    // دفتر أستاذ حساب بعينه **بعملة واحدة**: أسطره بتلك العملة وحدها بترتيب التاريخ، مع رصيد متحرّك.
    // (TD-REG-028) رصيدٌ متحرّك يجمع ريالًا سعوديًا مع يمني لا معنى له — فالعملة جزء من الطلب.
    if (account) {
      const currency: Currency = isCurrency(accountCurrency) ? accountCurrency : base;
      let running = 0;
      const rows = entries
        .flatMap((entry) => entry.lines
          .filter((line) => line.accountCode === account && line.currency === currency)
          .map((line) => ({ entry, line })))
        .sort((a, b) => a.entry.date.localeCompare(b.entry.date))
        .map(({ entry, line }) => {
          const kind = ACCOUNTS.find((item) => item.code === account)?.kind ?? "asset";
          const natural = kind === "asset" || kind === "expense" ? "debit" : "credit";
          running += line.side === natural ? line.amountMinor : -line.amountMinor;
          return {
            date: entry.date,
            source: entry.source,
            reference: entry.reference,
            description: entry.description,
            currency: line.currency,
            debitMinor: line.side === "debit" ? line.amountMinor : 0,
            creditMinor: line.side === "credit" ? line.amountMinor : 0,
            balanceMinor: running,
          };
        });
      return NextResponse.json({
        from: start, to: end, account, currency, rows,
        baseCurrency: base,
      });
    }

    return NextResponse.json({
      from: start,
      to: end,
      accounts: POSTABLE_ACCOUNTS,
      currencies: LEDGER_CURRENCIES,
      // صفٌّ لكل (حساب، عملة) — لا إجمالي عابر للعملات.
      balances,
      // قائمة دخل وميزانية لكل عملة تحرّكت — BY CURRENCY ONLY.
      statements: statementsByCurrency(balances),
      entryCount: entries.length,
      baseCurrency: base,
    });
  } catch (error) {
    if (error instanceof FinancialCurrencyIntegrityError) {
      // فساد ربطٍ في مستند (دفعة عابرة بين عملتين أجنبيتين) — يُقال ولا يُخمَّن، بلا تفاصيل داخلية.
      return NextResponse.json(
        { message: "في المستندات دفعةٌ لا تُحلّ عملة تسويتها — راجع سجل المدفوعات قبل قراءة الدفاتر." },
        { status: 409 },
      );
    }
    return NextResponse.json({ message: "تعذّر تحميل الدفاتر." }, { status: 500 });
  }
}

/** قيد يدوي — للتسويات وإعادة تقييم العملات والأرصدة الافتتاحية. */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return forbidden();

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const date = typeof source.date === "string" && DATE_PATTERN.test(source.date) ? source.date : "";
  if (!date) return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });

  if (await isPeriodLocked(date)) {
    return NextResponse.json(
      { message: "الفترة مقفلة. غيّر تاريخ القفل من الإعدادات إن كان القيد لازمًا." },
      { status: 409 },
    );
  }

  const description = typeof source.description === "string" ? source.description.trim() : "";
  if (!description || description.length > 200) {
    return NextResponse.json({ message: "اكتب بيان القيد." }, { status: 400 });
  }

  const rawLines = Array.isArray(source.lines) ? source.lines : [];
  if (rawLines.length < 2 || rawLines.length > 20) {
    return NextResponse.json({ message: "القيد يحتاج طرفين على الأقل." }, { status: 400 });
  }

  const postable = new Set(POSTABLE_ACCOUNTS.map((account) => account.code));
  const lines: ManualEntryLine[] = [];
  for (const raw of rawLines as Record<string, unknown>[]) {
    const accountCode = typeof raw.accountCode === "string" ? raw.accountCode : "";
    // الحسابات التجميعية لا يُقيَّد فيها: قيدٌ على «الأصول» بدل «الصندوق» يجعل
    // الميزانية صحيحة والدفتر عديم الفائدة.
    if (!postable.has(accountCode)) {
      return NextResponse.json({ message: "اختر حسابًا تفصيليًا لكل طرف." }, { status: 400 });
    }
    // (TD-REG-028) عملة كل سطر إلزامية — والمبلغ يُقرأ بوحداتها هي.
    if (!isCurrency(raw.currency)) {
      return NextResponse.json({ message: "حدّد عملة كل سطر في القيد." }, { status: 400 });
    }
    const currency = raw.currency;
    const amountMinor = parseAmount(String(raw.amount ?? ""), currency);
    if (amountMinor === null || amountMinor <= 0) {
      return NextResponse.json({ message: "اكتب مبلغًا أكبر من صفر لكل طرف." }, { status: 400 });
    }
    const side = raw.side === "credit" ? "credit" : "debit";
    lines.push({ accountCode, currency, amountMinor, side });
  }

  try {
    // الفحص الحاسم (التوازن داخل كل عملة) داخل createManualEntry نفسها — لا يتجاوزه مسارٌ آخر.
    const id = await createManualEntry({ date, description, lines, createdBy: session.username });
    await recordAudit({
      action: "journal.manual", entity: "journal", entityId: id,
      entityLabel: description,
      details: {
        التاريخ: date,
        البيان: description,
        الأسطر: lines.map((line) => `${line.side === "debit" ? "مدين" : "دائن"} ${line.accountCode} ${line.amountMinor} ${line.currency}`).join(" | "),
      },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    if (error instanceof ManualEntryInvalidError) {
      // القيد غير المتوازن (داخل كل عملة) يُرفض عند الإدخال لا يُكتشف بعد شهور في ميزان لا يقفل.
      return NextResponse.json({ message: error.message }, { status: 400 });
    }
    return NextResponse.json({ message: "تعذّر حفظ القيد." }, { status: 500 });
  }
}
