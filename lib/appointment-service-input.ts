/**
 * قراءة مدخلات الخدمة من جسم الطلب — حقولٌ مكتوبة النوع، لا JSON خام.
 *
 * الشاشة لا تُرسل نصًّا حرًّا يُفسَّر لاحقًا: كل حقلٍ يُقرأ بنوعه ويُردّ بالعربية
 * إن خالفه. والقراءة هنا لا في المسارين كي لا يفترق الإنشاء عن التعديل في ما
 * يقبله — وهو أوّل ما يفترق حين يُكتب مرتين.
 */
import {
  SPECIALTIES, type AppointmentService, type AppointmentServiceInput,
  type ServiceSpecialty,
} from "./appointment-services";

export type ServiceInputResult =
  | { ok: true; input: AppointmentServiceInput }
  | { ok: false; message: string };

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const asText = (value: unknown, fallback: string, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : fallback;

/**
 * `current` يعني تعديلًا جزئيًّا: ما لم يُرسَل يبقى كما هو.
 *
 * وبدونه إنشاءٌ: الغائب يأخذ الافتراضيّ الآمن — لا مطلوبًا ولا مانعًا.
 */
export function readServiceInput(
  body: Record<string, unknown>, current?: AppointmentService,
): ServiceInputResult {
  const number = (key: string, fallback: number): number | null => {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  };

  const duration = number("defaultDurationMinutes", current?.defaultDurationMinutes ?? 20);
  const before = number("bufferBeforeMinutes", current?.bufferBeforeMinutes ?? 0);
  const after = number("bufferAfterMinutes", current?.bufferAfterMinutes ?? 0);
  const priority = number("priority", current?.priority ?? 100);
  const sortOrder = number("sortOrder", current?.sortOrder ?? 100);
  if (duration === null || before === null || after === null
    || priority === null || sortOrder === null) {
    return { ok: false, message: "القيم الرقمية يجب أن تكون أرقامًا صحيحة." };
  }

  const specialtyRaw = body.specialty === undefined
    ? (current?.specialty ?? "general")
    : String(body.specialty);
  if (!SPECIALTIES.includes(specialtyRaw as ServiceSpecialty)) {
    return { ok: false, message: "التخصّص غير معروف." };
  }

  /* الرمز يُقرأ عند الإنشاء وحده. وفي التعديل يُتجاهَل ما أُرسل ويُثبَّت القائم:
     هويةٌ تتغيّر ليست هوية، والمواعيد المحجوزة تشير إليها. */
  const code = current ? current.code : asText(body.code, "", 40);

  const nameAr = asText(body.nameAr, current?.nameAr ?? "", 120);
  if (!nameAr) return { ok: false, message: "اكتب اسم الخدمة بالعربية." };

  const nameEnRaw = body.nameEn === undefined
    ? (current?.nameEn ?? null)
    : asText(body.nameEn, "", 120) || null;

  const badgeRaw = body.badgeClass === undefined
    ? (current?.badgeClass ?? null)
    : asText(body.badgeClass, "", 60) || null;

  return {
    ok: true,
    input: {
      code,
      nameAr,
      nameEn: nameEnRaw,
      specialty: specialtyRaw as ServiceSpecialty,
      defaultDurationMinutes: duration,
      bufferBeforeMinutes: before,
      bufferAfterMinutes: after,
      requiresProvider: asBoolean(body.requiresProvider, current?.requiresProvider ?? true),
      requiresChair: asBoolean(body.requiresChair, current?.requiresChair ?? true),
      allowsConcurrentProviderWork: asBoolean(
        body.allowsConcurrentProviderWork, current?.allowsConcurrentProviderWork ?? false),
      consumesEmergencyReserve: asBoolean(
        body.consumesEmergencyReserve, current?.consumesEmergencyReserve ?? false),
      priority,
      badgeClass: badgeRaw,
      isActive: asBoolean(body.isActive, current?.isActive ?? true),
      sortOrder,
    },
  };
}
