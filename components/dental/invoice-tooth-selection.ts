/**
 * (INV-LINK TOOTH) أسنان/موضع بند الفاتورة العلاجية — منطقٌ خالص بلا React.
 *
 * النمط من فئة خدمة الدليل وحدها (`toothScope` في `lib/invoice-clinical-linkage` — المصدر الواحد للخادم والواجهة).
 * هنا فقط: كيف يتحوّل اختيار المخطط إلى أسطر الفاتورة، وما يُرسل للمعاينة والحفظ، ومتى يُمنع الحفظ (fail closed).
 * - عصب/وتد/زراعة/خلع/جراحة: سطرٌ وحالةٌ مستقلة لكل سن — لا حالة عصبٍ واحدة لعدة أسنان.
 * - تاج/قشرة/جسر: سطرٌ لكل سن، وكلها تحمل `episodeTeeth` = الاختيار كله (حلقةٌ واحدة) — لا تُستنتج الدعامات.
 * - حشوة/سدّ شقوق: سنٌّ واحد وأسطحه (اختيارية).
 * - تنظيف/لثة: كامل الفم (افتراضي) أو فك أو سن. تقويم: علوي/سفلي/الفكّان — لا سنٌّ منفرد.
 */
import { normalizeSurfaces } from "@/lib/dental";
import {
  SITE_SCOPE_LABEL, allowedScopes, toothRequired, toothScope,
  type SiteScope, type ToothScopeMode,
} from "@/lib/invoice-clinical-linkage";

const MODES: readonly ToothScopeMode[] = [
  "none", "per_tooth_episode", "multi_tooth_episode", "tooth_surfaces", "region", "arch",
];

/** نمط البند من فئة خدمته — وأي قيمةٍ غير معروفة (فئة خام مثل `constructor`) ⇒ `none`. */
export function invoiceToothMode(category: string | null | undefined): ToothScopeMode {
  if (typeof category !== "string" || category === "") return "none";
  const mode: unknown = toothScope(category);
  return typeof mode === "string" && (MODES as readonly string[]).includes(mode) ? mode as ToothScopeMode : "none";
}

/** الأنماط التي تُفتح لها نافذة المخطط (التقويم نطاقٌ فقط، بلا سن). */
export function usesToothChart(mode: ToothScopeMode): boolean {
  return mode === "per_tooth_episode" || mode === "multi_tooth_episode" || mode === "tooth_surfaces" || mode === "region";
}

/** هل يختار المخطط عدة أسنان في نقرةٍ واحدة لكلٍّ منها؟ */
export function multiSelect(mode: ToothScopeMode): boolean {
  return mode === "per_tooth_episode" || mode === "multi_tooth_episode";
}

export interface ToothFields {
  /** السن (FDI) لهذا السطر. */
  toothCode: number | null;
  /** أسطح الحشوة بالترتيب القانوني (MODBL)، أو "". */
  surfaces: string;
  /** نطاقٌ بلا أسنان: فك/الفكّان/كامل الفم. */
  scope: SiteScope | null;
  /** حلقة التاج/الجسر: الاختيار كله، على كل سطرٍ منها. */
  episodeTeeth: number[] | null;
  /** يجمع أسطر الحلقة الواحدة في النموذج (لا يُرسل). */
  groupId: string | null;
}

export interface ToothRowLike extends ToothFields {
  key: string;
  caseId: string;
}

export interface ToothSelection {
  teeth: number[];
  surfaces: string;
  scope: SiteScope | null;
}

export function emptyToothFields(mode: ToothScopeMode): ToothFields {
  return { toothCode: null, surfaces: "", scope: mode === "region" ? "full_mouth" : null, episodeTeeth: null, groupId: null };
}

const sorted = (teeth: readonly number[]) => [...new Set(teeth)].sort((a, b) => a - b);

/** الاختيار الذي تُفتح به النافذة لهذا السطر: للحلقة كلُّ أسنانها، ولغيرها سنُّه. */
export function selectionOfRow(row: ToothFields): ToothSelection {
  const teeth = row.episodeTeeth && row.episodeTeeth.length > 0 ? row.episodeTeeth
    : row.toothCode !== null ? [row.toothCode] : [];
  return { teeth: sorted(teeth), surfaces: row.surfaces, scope: row.scope };
}

/**
 * سطرٌ يخرج من حلقته (حُذف أو تغيّرت خدمته): بقية أسطر الحلقة تُحدَّث أسنانها؛ ويبقى سطرٌ واحد ⇒ لا حلقة.
 * الناتج: الأسطر نفسها مع تحديث بقية الحلقة — والسطر المعني كما هو (على المستدعي حذفه أو إعادة ضبطه).
 */
function releaseFromGroup<R extends ToothRowLike>(rows: readonly R[], index: number): R[] {
  const row = rows[index];
  if (!row?.groupId) return [...rows];
  const rest = rows.filter((other, i) => i !== index && other.groupId === row.groupId);
  const teeth = sorted(rest.map((other) => other.toothCode).filter((tooth): tooth is number => tooth !== null));
  return rows.map((other, i) => i === index || other.groupId !== row.groupId ? other : {
    ...other, episodeTeeth: teeth.length > 0 ? teeth : null, groupId: rest.length > 1 ? row.groupId : null,
  });
}

export function removeRowAt<R extends ToothRowLike>(rows: readonly R[], index: number): R[] {
  return releaseFromGroup(rows, index).filter((_, i) => i !== index);
}

/** تغيّرت خدمة السطر: يخرج من حلقته ويُعاد ضبط أسنانه لنمط الخدمة الجديدة، مع بقية التعديل. */
export function replaceRowService<R extends ToothRowLike>(rows: readonly R[], index: number, patch: Partial<R>, mode: ToothScopeMode): R[] {
  return releaseFromGroup(rows, index).map((row, i) => i === index
    ? { ...row, ...patch, ...emptyToothFields(mode), caseId: "" } : row);
}

/** نقرة نطاق (فك/الفكّان/كامل الفم): تُلغي السن المنفرد. */
export function setRowScope<R extends ToothRowLike>(rows: readonly R[], index: number, scope: SiteScope | null): R[] {
  return rows.map((row, i) => i === index
    ? { ...row, scope, toothCode: null, surfaces: "", episodeTeeth: null, groupId: null, caseId: row.scope === scope ? row.caseId : "" } : row);
}

/**
 * تأكيد النافذة: يُحوَّل الاختيار إلى أسطر.
 * - per_tooth_episode: N سن ⇒ N سطر (الخدمة والسعر والطبيب والوصف نفسها)، كلٌّ بسنّه.
 * - multi_tooth_episode: N سن ⇒ N سطر، كلها تحمل الاختيار كله (`episodeTeeth`) — حلقةٌ واحدة.
 *   تعديل حلقةٍ قائمة يستبدل أسطرها كلها، ويحفظ سطر السن الذي بقي مختارًا (سعره/حالته).
 * - tooth_surfaces / region: سنٌّ واحد (والأسطح للحشوة؛ وللمنطقة يلغي النطاق).
 * `makeKey` يعطي مفتاحًا ثابتًا لكل سطرٍ جديد.
 */
export function applyToothSelection<R extends ToothRowLike>(
  rows: readonly R[], index: number, mode: ToothScopeMode, selection: ToothSelection, makeKey: () => string,
): R[] {
  const row = rows[index];
  if (!row) return [...rows];
  const teeth = sorted(selection.teeth);
  const keepCase = (tooth: number | null, base: R) => base.toothCode === tooth ? base.caseId : "";

  if (mode === "per_tooth_episode") {
    const released = releaseFromGroup(rows, index);
    const base = released[index];
    const replacements: R[] = teeth.length === 0
      ? [{ ...base, toothCode: null, surfaces: "", scope: null, episodeTeeth: null, groupId: null, caseId: "" }]
      : teeth.map((tooth, i) => ({
          ...base, key: i === 0 ? base.key : makeKey(), toothCode: tooth, surfaces: "", scope: null,
          episodeTeeth: null, groupId: null, caseId: keepCase(tooth, base),
        }));
    return [...released.slice(0, index), ...replacements, ...released.slice(index + 1)];
  }

  if (mode === "multi_tooth_episode") {
    const members = row.groupId
      ? rows.map((other, i) => ({ other, i })).filter(({ other }) => other.groupId === row.groupId)
      : [{ other: row, i: index }];
    const at = members[0].i;
    const memberIndexes = new Set(members.map(({ i }) => i));
    const groupId = teeth.length > 1 ? row.groupId ?? makeKey() : null;
    const usedKeys = new Set<string>();
    const replacements: R[] = teeth.length === 0
      ? [{ ...row, toothCode: null, surfaces: "", scope: null, episodeTeeth: null, groupId: null, caseId: "" }]
      : teeth.map((tooth) => {
          const existing = members.find(({ other }) => other.toothCode === tooth)?.other;
          const base = existing ?? row;
          const key = !usedKeys.has(base.key) ? base.key : makeKey();
          usedKeys.add(key);
          return {
            ...base, key, toothCode: tooth, surfaces: "", scope: null, episodeTeeth: teeth, groupId,
            caseId: existing ? existing.caseId : keepCase(tooth, row),
          };
        });
    const before = rows.slice(0, at).filter((_, i) => !memberIndexes.has(i));
    const after = rows.slice(at).filter((_, offset) => !memberIndexes.has(at + offset));
    return [...before, ...replacements, ...after];
  }

  if (mode === "tooth_surfaces" || mode === "region") {
    const tooth = teeth[0] ?? null;
    return rows.map((other, i) => i !== index ? other : {
      ...other, toothCode: tooth,
      surfaces: mode === "tooth_surfaces" && tooth !== null ? normalizeSurfaces(selection.surfaces) ?? "" : "",
      scope: mode === "region" && tooth === null ? selection.scope ?? "full_mouth" : null,
      episodeTeeth: null, groupId: null, caseId: keepCase(tooth, other),
    });
  }

  if (mode === "arch") return setRowScope(rows, index, selection.scope);
  return [...rows];
}

export interface ToothPayload {
  toothCode?: number;
  surfaces?: string;
  episodeTeeth?: number[];
  scope?: SiteScope;
}

/** ما يُرسل للمعاينة والحفظ لهذا السطر حسب نمطه — لا شيء لبندٍ بلا سن. */
export function toothPayload(mode: ToothScopeMode, row: ToothFields): ToothPayload {
  const tooth = row.toothCode ?? undefined;
  const scope = row.scope && allowedScopes(mode).includes(row.scope) ? row.scope : undefined;
  switch (mode) {
    case "per_tooth_episode": return { toothCode: tooth };
    case "multi_tooth_episode": return {
      toothCode: tooth,
      episodeTeeth: tooth === undefined ? undefined : row.episodeTeeth && row.episodeTeeth.length > 0 ? row.episodeTeeth : [tooth],
    };
    case "tooth_surfaces": return { toothCode: tooth, surfaces: tooth === undefined ? undefined : normalizeSurfaces(row.surfaces) ?? undefined };
    case "region": return tooth !== undefined ? { toothCode: tooth } : { scope: scope ?? "full_mouth" };
    case "arch": return { scope };
    default: return {};
  }
}

export const TOOTH_REQUIRED_MESSAGE = "حدّد السن من مخطط الأسنان — هذا العلاج لا يُحفظ بلا سن.";

/** منعٌ في الواجهة (والخادم يرفض أيضًا): بندٌ يحتاج سنًّا ولا سنّ له. */
export function toothProblem(mode: ToothScopeMode, row: ToothFields): string | null {
  return toothRequired(mode) && row.toothCode === null ? TOOTH_REQUIRED_MESSAGE : null;
}

/** وصفٌ موجز لاختيار السطر (الشارة بجانب «تغيير»)، أو `null` إن لم يُختر شيء. */
export function selectionLabel(mode: ToothScopeMode, row: ToothFields): string | null {
  if (mode === "none") return null;
  if (row.toothCode === null) return row.scope && allowedScopes(mode).includes(row.scope) ? SITE_SCOPE_LABEL[row.scope] : null;
  if (mode === "multi_tooth_episode" && row.episodeTeeth && row.episodeTeeth.length > 1) {
    return `جسر/حلقة: ${row.episodeTeeth.join("، ")}`;
  }
  const surfaces = mode === "tooth_surfaces" ? normalizeSurfaces(row.surfaces) : null;
  return `سن ${row.toothCode}${surfaces ? ` — أسطح ${surfaces}` : ""}`;
}

export const MODE_HINT: Record<ToothScopeMode, string> = {
  none: "",
  per_tooth_episode: "اختر سنًّا أو أكثر بالنقر على المخطط. سيُنشأ سطر وحالة مستقلة لكل سن.",
  multi_tooth_episode: "اختر أسنان الحلقة (تاج/قشرة/جسر). سطرٌ لكل سن ضمن حلقةٍ علاجية واحدة — بلا استنتاج للدعامات.",
  tooth_surfaces: "اختر سنًّا واحدًا، ثم أسطحه إن لزم (اختياري).",
  region: "اختر سنًّا واحدًا — أو ألغِ لتبقى على نطاق الفم.",
  arch: "",
};

export const PER_TOOTH_SPLIT_NOTICE = "سيُنشأ سطر وحالة مستقلة لكل سن";
