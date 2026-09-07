import { signedQty, type MovementKind } from "./inventory";

/**
 * تكلفة المخزون — **قيمةٌ مشتقّة من الحركات، كالرصيد تمامًا**.
 *
 * والمخزون اليوم يعرف الكمّيّات ولا يعرف أثمانها. فلا يُعرف كم في الرفّ من مال،
 * ولا كم كلّفت مواد عملٍ بعينه — **و`CLAUDE.md` تقول إنّ عمولة الطبيب على المحصّل
 * بعد خصم تكلفة المختبر والمواد**، والشقّ الثاني منها لم يكن ممكنًا أصلًا.
 * وهذا الملف يبني الطرف الناقص: الثمن يدخل مع الدفعة، والقيمة تُشتقّ منه.
 *
 * **والطريقة متوسّطٌ مرجَّح (WAC)**، لا الوارد-أوّلًا (FIFO). والسبب أنّ في هذا
 * النظام **ردًّا** للمصروف على زيارة، والردُّ إلغاءُ استهلاكٍ لا إدخالٌ جديد —
 * فتتبّعُ الدفعات في FIFO يوجب أن يُعرف من أيّ دفعةٍ خرج ما يُردّ، ولا يُسجَّل
 * ذلك. والمتوسّط لا يحتاجه: قيمةٌ واحدة للبند تتحرّك مع كل شراء.
 *
 * **والثمن بالعملة الأساسية لحظة الشراء**، لا بسعر اليوم. فقفازٌ اشتُري بدولارٍ
 * قبل سنة كلّف ما كلّف حينها، وضربُه بسعر اليوم يجعل تكلفة عملٍ ماضٍ تتغيّر كلّما
 * تحرّك الصرف — وهو المبدأ نفسه الذي بُنيت عليه العمولات وأوامر المختبر.
 */

export interface CostedMovement {
  kind: MovementKind;
  qty: number;
  /**
   * ثمنُ الوحدة بالوحدة الصغرى للعملة الأساسية — **للإدخال المُشترى وحده**.
   *
   * والردُّ لا ثمن له: هو إلغاءُ استهلاك، فيعود بقيمة المتوسّط القائم حينها.
   * والصرفُ والتسوية كذلك — تُقيَّمان بالمتوسّط لا بثمنٍ يُكتب معهما.
   */
  unitCostMinor?: number | null;
  isReturn?: boolean;
}

export interface CostState {
  /** الكمّية بعد الحركة. */
  qty: number;
  /** قيمة ما في الرفّ بالوحدة الصغرى. */
  valueMinor: number;
  /** متوسّط ثمن الوحدة — أو `null` إن لا رصيد ولا ثمن يُعرف. */
  unitCostMinor: number | null;
}

const EMPTY: CostState = { qty: 0, valueMinor: 0, unitCostMinor: null };

/** متوسّطُ الوحدة من قيمةٍ وكمّية — ولا قسمةَ على صفر. */
function averageOf(qty: number, valueMinor: number): number | null {
  return qty > 0 ? valueMinor / qty : null;
}

/**
 * يمرّ على الحركات بترتيبها فيعطي الحال بعد كلٍّ منها.
 *
 * **والترتيب هو ترتيب وقوعها** (`id` تصاعديًّا): المتوسّط تراكميّ، فقلبُ حركتين
 * يعطي متوسّطًا آخر — وشراءٌ بثمنٍ مرتفع قبل صرفٍ يجعل ذلك الصرف أغلى، وبعده
 * يجعله أرخص. ومن قلب الترتيب حسب تكلفة عملٍ بثمنٍ لم يكن قد اشتُري بعد.
 */
export function costStates(movements: readonly CostedMovement[]): CostState[] {
  const states: CostState[] = [];
  let qty = 0;
  let valueMinor = 0;

  for (const move of movements) {
    const change = signedQty(move.kind, move.qty);

    if (change > 0) {
      // إدخالٌ مُشترى بثمنٍ معلوم يحرّك المتوسّط؛ وما سواه يدخل بالمتوسّط القائم.
      const priced = !move.isReturn && typeof move.unitCostMinor === "number" && move.unitCostMinor >= 0;
      const unit = priced ? (move.unitCostMinor as number) : (averageOf(qty, valueMinor) ?? 0);
      valueMinor += change * unit;
      qty += change;
    } else if (change < 0) {
      const unit = averageOf(qty, valueMinor) ?? 0;
      const taken = Math.min(-change, qty);
      // ولا تنزل القيمة تحت الصفر ولو نزل الرصيد: رفٌّ فارغ قيمتُه صفر لا سالب.
      valueMinor = Math.max(0, valueMinor - taken * unit);
      qty += change;
    }

    states.push({ qty, valueMinor, unitCostMinor: averageOf(qty, valueMinor) });
  }
  return states;
}

/** حال البند بعد آخر حركة. */
export function costNow(movements: readonly CostedMovement[]): CostState {
  const states = costStates(movements);
  return states.length ? states[states.length - 1] : EMPTY;
}

/**
 * تكلفةُ ما صُرف في نافذةٍ من الحركات.
 *
 * وتُحسب من حال ما **قبل** كل صرف لا بعده: الصرف يُقوَّم بمتوسّط الرفّ لحظة
 * خروجه. وحسابُه بالمتوسّط اللاحق يجعل شراءً وقع بعد الصرف يغيّر تكلفته.
 */
export function issuedCostMinor(
  movements: readonly CostedMovement[],
  isInWindow: (index: number) => boolean,
): number {
  const states = costStates(movements);
  let total = 0;
  for (let index = 0; index < movements.length; index += 1) {
    const move = movements[index];
    const change = signedQty(move.kind, move.qty);
    if (change >= 0 || !isInWindow(index)) continue;
    const before = index === 0 ? EMPTY : states[index - 1];
    const unit = averageOf(before.qty, before.valueMinor) ?? 0;
    total += Math.min(-change, before.qty) * unit;
  }
  return Math.round(total);
}
