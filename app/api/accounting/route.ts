import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, createManualEntry, getSettings, isPeriodLocked, journalEntries } from "@/lib/db";
import {
  ACCOUNTS,
  POSTABLE_ACCOUNTS,
  balanceSheet,
  incomeStatement,
  isBalanced,
  trialBalance,
  type JournalEntry,
} from "@/lib/accounting";
import { isCurrency, parseAmount } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { isAdmin } from "@/lib/roles";
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
  if (!isAdmin(session.role)) return forbidden();

  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : monthStart;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  const [start, end] = from <= to ? [from, to] : [to, from];
  const account = params.get("account");

  try {
    const [entries, settings] = await Promise.all([journalEntries(start, end), getSettings()]);
    const base = settings["finance.base_currency"];
    const balances = trialBalance(entries);

    // دفتر أستاذ حساب بعينه: أسطر ذلك الحساب وحده بترتيب التاريخ، مع رصيد متحرّك.
    if (account) {
      let running = 0;
      const rows = entries
        .flatMap((entry) => entry.lines
          .filter((line) => line.accountCode === account)
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
            debitMinor: line.side === "debit" ? line.amountMinor : 0,
            creditMinor: line.side === "credit" ? line.amountMinor : 0,
            balanceMinor: running,
          };
        });
      return NextResponse.json({
        from: start, to: end, account, rows,
        baseCurrency: isCurrency(base) ? base : "YER",
      });
    }

    return NextResponse.json({
      from: start,
      to: end,
      accounts: POSTABLE_ACCOUNTS,
      balances,
      income: incomeStatement(balances),
      sheet: balanceSheet(balances),
      entryCount: entries.length,
      baseCurrency: isCurrency(base) ? base : "YER",
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الدفاتر." }, { status: 500 });
  }
}

/** قيد يدوي — للتسويات وإعادة تقييم العملات والأرصدة الافتتاحية. */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch {
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

  const settings = await getSettings();
  const base = settings["finance.base_currency"];
  if (!isCurrency(base)) {
    return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
  }

  const rawLines = Array.isArray(source.lines) ? source.lines : [];
  if (rawLines.length < 2 || rawLines.length > 20) {
    return NextResponse.json({ message: "القيد يحتاج طرفين على الأقل." }, { status: 400 });
  }

  const postable = new Set(POSTABLE_ACCOUNTS.map((account) => account.code));
  const lines: { accountCode: string; amountMinor: number; side: "debit" | "credit" }[] = [];
  for (const raw of rawLines as Record<string, unknown>[]) {
    const accountCode = typeof raw.accountCode === "string" ? raw.accountCode : "";
    // الحسابات التجميعية لا يُقيَّد فيها: قيدٌ على «الأصول» بدل «الصندوق» يجعل
    // الميزانية صحيحة والدفتر عديم الفائدة.
    if (!postable.has(accountCode)) {
      return NextResponse.json({ message: "اختر حسابًا تفصيليًا لكل طرف." }, { status: 400 });
    }
    const amountMinor = parseAmount(String(raw.amount ?? ""), base);
    if (amountMinor === null || amountMinor === 0) {
      return NextResponse.json({ message: "اكتب مبلغًا أكبر من صفر لكل طرف." }, { status: 400 });
    }
    const side = raw.side === "credit" ? "credit" : "debit";
    lines.push({ accountCode, amountMinor, side });
  }

  const entry: JournalEntry = { source: "manual", reference: "", date, description, lines };
  if (!isBalanced(entry)) {
    // القيد غير المتوازن يُرفض عند الإدخال لا يُكتشف بعد شهور في ميزان لا يقفل.
    return NextResponse.json(
      { message: "القيد لا يتوازن: مجموع المدين يجب أن يساوي مجموع الدائن." },
      { status: 400 },
    );
  }

  try {
    const id = await createManualEntry({ date, description, lines, createdBy: session.username });
    return NextResponse.json({ id }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ القيد." }, { status: 500 });
  }
}
