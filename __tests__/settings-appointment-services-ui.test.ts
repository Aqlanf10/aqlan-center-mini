import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPECIALTY_LABEL, type AppointmentService } from "../lib/appointment-services";
import AppointmentServicesPage, {
  ServiceFormFields,
  ServicesTable,
  emptyForm,
  fetchServices,
  flagViews,
  formFromService,
  formToInput,
  setServiceActive,
  submitService,
  visibleServices,
  type ServiceForm,
} from "../app/settings/appointment-services/page";

/**
 * شاشة «خدمات المواعيد» — اختبار الواجهة.
 *
 * **عن المِنصّة**: لا `jsdom` ولا `@testing-library` في هذا المستودع (راجع
 * `package.json` و`vitest.config.mts`)، وشقيقُ هذا الملف `settings-ui.test.ts`
 * يفحص الشاشات بمصدرها ومنطقها الخالص لا بنقرةٍ في متصفّحٍ وهميّ. فالحرَس هنا
 * ثلاثة، وكلُّها حقيقيّة لا تمثيليّة:
 *
 *  ١) **رسمٌ فعليّ** عبر `renderToStaticMarkup` لأجزاء العرض الخالصة في الشاشة
 *     (`ServicesTable` و`ServiceFormFields`) — فالمُخرَج HTML حقيقيّ يُفتَّش فيه
 *     عن نصٍّ عربيٍّ وسماتٍ وصلاحيّة، لا مجرّد سلسلةٍ في ملفٍّ نصّي.
 *  ٢) **سلوكُ الشبكة** بمناداة الدوالّ التي تستعملها الشاشة نفسها مع `fetch`
 *     مُموَّهٍ — فيُفحَص جسمُ الطلب المُرسَل حرفًا حرفًا.
 *  ٣) **فحصٌ مصدريّ** لما لا يُرسَم بلا DOM (ربطُ العناوين بالحقول، منطقةُ
 *     الخطأ، غيابُ الحذف من الشاشة كلّها).
 */

const pageSource = readFileSync(
  resolve(process.cwd(), "app/settings/appointment-services/page.tsx"), "utf8",
);

/* حرفٌ عربيّ واحد يكفي للحكم بأن الرسالة كُتبت للمالك لا للمطوّر. */
const ARABIC = /[؀-ۿ]/;

const service = (over: Partial<AppointmentService> = {}): AppointmentService => ({
  id: 1,
  code: "ORTHO_FOLLOW_UP",
  nameAr: "متابعة تقويم / شدّ",
  nameEn: "Ortho follow-up",
  specialty: "orthodontics",
  defaultDurationMinutes: 10,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  requiresProvider: true,
  requiresChair: true,
  allowsConcurrentProviderWork: false,
  consumesEmergencyReserve: false,
  priority: 50,
  badgeClass: null,
  isActive: true,
  sortOrder: 30,
  legacyType: "follow_up",
  createdAt: "2026-01-01T08:00:00.000Z",
  createdBy: "owner",
  updatedAt: "2026-01-01T08:00:00.000Z",
  updatedBy: "owner",
  ...over,
});

const CATALOG: AppointmentService[] = [
  service(),
  service({
    id: 2, code: "IMPLANT_PLACEMENT", nameAr: "زراعة سنّية", nameEn: "Implant placement",
    specialty: "implantology", defaultDurationMinutes: 45, bufferAfterMinutes: 10,
    priority: 30, sortOrder: 140,
  }),
  service({
    id: 3, code: "OLD_DENTURE_RELINE", nameAr: "إعادة تبطين طقم", nameEn: null,
    specialty: "prosthodontics", defaultDurationMinutes: 30, isActive: false,
    priority: 60, sortOrder: 200, legacyType: null,
  }),
];

/** استجابةٌ مصغَّرة تكفي ما تقرأه الشاشة من `Response`. */
const jsonResponse = (status: number, payload: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const table = (services: AppointmentService[]) =>
  renderToStaticMarkup(createElement(ServicesTable, { services }));

const fields = (form: ServiceForm, mode: "create" | "edit") =>
  renderToStaticMarkup(createElement(ServiceFormFields, { form, mode, onChange: () => {} }));

/** نصوصُ الأزرار وحدها — لا الشروح حولها. */
const buttonTexts = (markup: string): string[] =>
  [...markup.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
    .map((match) => match[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("شاشة خدمات المواعيد — القائمة", () => {
  /**
   * الشاشة تطلب المعطَّلة صراحةً.
   *
   * لو حمّلت الشاشةُ المفعَّلةَ وحدها لصارت خدمةٌ عُطِّلت مرّةً غيرَ قابلةٍ لإعادة
   * التفعيل إلا من قاعدة البيانات — وهذا في مركزٍ يديره أخصائيٌّ لا مبرمج يعني
   * أنها ضاعت.
   */
  it("تُحمّل الكتالوج كاملًا بالمعطَّلة معه", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { services: CATALOG, chairs: 4 }));

    const result = await fetchServices();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("includeInactive=1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.services.map((row) => row.code)).toEqual(
      ["ORTHO_FOLLOW_UP", "IMPLANT_PLACEMENT", "OLD_DENTURE_RELINE"],
    );
    expect(result.chairs).toBe(4);
  });

  /**
   * المعطَّلة تُرى معطَّلةً بالعربية.
   *
   * صفٌّ لا يفترق شكلُه عن المفعَّل يجعل المالك يعدّل خدمةً لا تظهر أصلًا في
   * الحجز، ثم يشتكي أن «التعديل لا يعمل».
   */
  it("ترسم كل خدمة باسمها ورمزها وتخصّصها ومدّتها، وتُعلِّم المعطَّلة", () => {
    const markup = table(CATALOG);

    expect(markup).toContain("متابعة تقويم / شدّ");
    expect(markup).toContain("ORTHO_FOLLOW_UP");
    expect(markup).toContain(SPECIALTY_LABEL.implantology);
    expect(markup).toContain("المدة 45 دقيقة");
    expect(markup).toContain("بعدها 10 دقيقة");

    /* الصفّ المعطَّل موسومٌ بسمةٍ يُنتقى بها، لا بنصٍّ فضفاض. */
    expect(markup).toContain('data-service-code="OLD_DENTURE_RELINE" data-service-active="0"');
    expect(markup).toContain("معطَّلة");
    expect((markup.match(/data-testid="service-row"/g) ?? []).length).toBe(3);
    expect((markup.match(/data-testid="service-disabled-badge"/g) ?? []).length).toBe(1);
  });

  /**
   * `true` ليست كلمةً عربية.
   *
   * الأعلام تصف ما تشغله الخدمة من كرسيٍّ وطبيبٍ واحتياطِ طوارئ — وهي القرار
   * الذي يحسب به المحرّك الزحمة. عرضُها خامًا يجعلها غير مقروءةٍ لمن يملكها.
   */
  it("تعرض الأعلام جملًا عربية لا true/false", () => {
    const markup = table([service({ consumesEmergencyReserve: true })]);
    const flagsBlock = markup.slice(markup.indexOf('data-testid="service-flags"'));

    expect(flagsBlock).toContain("يشغل طبيبًا");
    expect(flagsBlock).toContain("يشغل كرسيًّا");
    expect(flagsBlock).toContain("يحجز الطبيب وحده");
    expect(flagsBlock).toContain("يأكل من حجز الطوارئ");
    expect(flagsBlock).not.toMatch(/>(true|false)</);

    for (const flag of flagViews(service({ isActive: false }))) {
      expect(flag.text).toMatch(ARABIC);
    }
  });
});

describe("شاشة خدمات المواعيد — البحث والتصفية", () => {
  /**
   * البحث من وحدة النطاق لا من الشاشة.
   *
   * مطابقٌ ثانٍ مكتوبٌ هنا يعني أن يجد المالك خدمةً في الإعدادات ولا تجدها
   * الاستقبال في الحجز — عطبٌ لا يُشتكى منه لأنه لا يبدو عطبًا.
   */
  it("البحث يضيّق القائمة، ومحوُه يعيدها كاملة", () => {
    const narrowed = visibleServices(CATALOG, { term: "زراعة" });
    expect(narrowed.map((row) => row.code)).toEqual(["IMPLANT_PLACEMENT"]);
    expect(table(narrowed)).not.toContain("متابعة تقويم / شدّ");

    /* بالرمز اللاتينيّ أيضًا — الاستقبال تكتبه أسرع من الاسم العربي. */
    expect(visibleServices(CATALOG, { term: "ortho_follow" }).map((row) => row.code))
      .toEqual(["ORTHO_FOLLOW_UP"]);

    const restored = visibleServices(CATALOG, { term: "" });
    expect(restored).toHaveLength(3);
    expect((table(restored).match(/data-testid="service-row"/g) ?? []).length).toBe(3);

    expect(pageSource).toContain("searchServices");
    expect(pageSource).toContain("visibleServices(services ?? []");
  });

  /** قائمةُ التخصّصات تُبنى من السجلّ لا من قائمةٍ مكتوبةٍ في الشاشة. */
  it("تصفية التخصص تضيّق القائمة، وخياراتها من SPECIALTIES", () => {
    const orthoOnly = visibleServices(CATALOG, { specialty: "orthodontics" });
    expect(orthoOnly.map((row) => row.code)).toEqual(["ORTHO_FOLLOW_UP"]);

    const markup = table(orthoOnly);
    expect(markup).toContain("ORTHO_FOLLOW_UP");
    expect(markup).not.toContain("IMPLANT_PLACEMENT");

    expect(visibleServices(CATALOG, { specialty: "all" })).toHaveLength(3);
    expect(pageSource).toContain("SPECIALTIES.map");
    expect(pageSource).toContain("SPECIALTY_LABEL[specialty]");
  });

  /** المعطَّلة تُعزل حين يريد المالك مراجعة ما أوقفه. */
  it("تصفية الحالة تفصل المفعَّلة عن المعطَّلة", () => {
    expect(visibleServices(CATALOG, { activity: "active" }).map((row) => row.id)).toEqual([1, 2]);
    expect(visibleServices(CATALOG, { activity: "inactive" }).map((row) => row.id)).toEqual([3]);
    /* والبحث والتصفية يتراكبان لا يتنافسان. */
    expect(visibleServices(CATALOG, { term: "تقويم", activity: "inactive" })).toHaveLength(0);
  });
});

describe("شاشة خدمات المواعيد — الإضافة والتحرير", () => {
  /**
   * حقولٌ مكتوبةُ النوع، لا JSON خام.
   *
   * والفحص على **جسم الطلب نفسه**: شاشةٌ ترسل «١٥» نصًّا بدل ١٥ عددًا تمرّ من
   * كل اختبارٍ يكتفي بأن `fetch` نُودي، ثم يردّها الخادم برسالةٍ يظنّها المالك
   * عطبًا في الحفظ.
   */
  it("الإضافة ترسل POST بحقولٍ مكتوبةِ النوع ورمزٍ مُسوّى", async () => {
    const created = service({ id: 9, code: "ORTHO_WIRE_CHANGE", nameAr: "تغيير سلك تقويم" });
    fetchMock.mockResolvedValueOnce(jsonResponse(201, created));

    const form: ServiceForm = {
      ...emptyForm(),
      code: "ortho wire-change",
      nameAr: "تغيير سلك تقويم",
      nameEn: "Wire change",
      specialty: "orthodontics",
      defaultDurationMinutes: "15",
      bufferBeforeMinutes: "0",
      bufferAfterMinutes: "5",
      priority: "50",
      sortOrder: "40",
      badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-800",
    };

    const result = await submitService(form, null);
    expect(result).toEqual({ ok: true, service: created });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings/appointment-services");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      code: "ORTHO_WIRE_CHANGE",
      nameAr: "تغيير سلك تقويم",
      nameEn: "Wire change",
      specialty: "orthodontics",
      defaultDurationMinutes: 15,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 5,
      requiresProvider: true,
      requiresChair: true,
      allowsConcurrentProviderWork: false,
      consumesEmergencyReserve: false,
      priority: 50,
      badgeClass: "border-indigo-200 bg-indigo-50 text-indigo-800",
      isActive: true,
      sortOrder: 40,
    });
  });

  /**
   * الرمز هوية — والمواعيد المحجوزة تشير إليه.
   *
   * الخادم يتجاهل أيّ رمزٍ يصل مع التعديل، فلو عرضته الشاشةُ حقلًا قابلًا للكتابة
   * لظنّ المالك أنه غيّره ثم وجد الرمز القديم — وهو أسوأ من منعه: يظنّ النظام
   * كاذبًا لا حازمًا.
   */
  it("التحرير يعرض الرمز للقراءة فقط، وجسم PATCH لا يحمل رمزًا", async () => {
    const existing = CATALOG[0];
    const markup = fields(formFromService(existing), "edit");

    const codeInput = markup.match(/<input[^>]*data-testid="field-code"[^>]*>/)?.[0] ?? "";
    /* أسماء سمات HTML غير حسّاسة لحالة الحرف — React 19 يكتبها `readOnly`. */
    expect(codeInput.toLowerCase()).toContain("readonly");
    expect(codeInput).toContain('value="ORTHO_FOLLOW_UP"');
    expect(markup).toContain('data-testid="code-immutable-note"');
    expect(markup).toContain("الرمز هوية");
    expect(markup).toContain("المواعيد المحجوزة تشير إليه");
    /* وفي الإنشاء الرمز يُكتب ومعه صورتُه المُسوّاة. */
    expect(fields({ ...emptyForm(), code: "ortho wire-change" }, "create"))
      .toContain('data-testid="code-normalized"');

    const updated = service({ nameAr: "متابعة تقويم مطوّلة", defaultDurationMinutes: 15 });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, updated));

    const edited: ServiceForm = {
      ...formFromService(existing),
      code: "SOMETHING_ELSE", /* حتى لو عبث بها أحد: لا تُرسَل */
      nameAr: "متابعة تقويم مطوّلة",
      defaultDurationMinutes: "15",
    };
    const result = await submitService(edited, existing.id);
    expect(result.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/settings/appointment-services/${existing.id}`);
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(Object.keys(body)).not.toContain("code");
    expect(body).not.toHaveProperty("code");
    expect(body.nameAr).toBe("متابعة تقويم مطوّلة");
    expect(body.defaultDurationMinutes).toBe(15);
  });

  /**
   * المدّة الخاطئة تُردّ قبل الشبكة — وبنفس الجملة التي كان الخادم سيقولها.
   *
   * رحلةٌ إلى الخادم لتُردّ برسالةٍ نعرفها سلفًا ليست تحقّقًا بل انتظار. والأهمّ:
   * لو اختلفت جملةُ الشاشة عن جملة الخادم لصار للنظام صوتان.
   */
  it("مدّة غير صحيحة تُردّ برسالة عربية بلا أيّ نداءٍ للشبكة", async () => {
    for (const bad of ["1", "600", "12.5", "", "abc"]) {
      const result = await submitService(
        { ...emptyForm(), code: "TEST_CODE", nameAr: "خدمة", defaultDurationMinutes: bad },
        null,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toMatch(ARABIC);
      expect(result.message).toContain("المدة الافتراضية");
    }
    expect(fetchMock).not.toHaveBeenCalled();

    /* والرمز الخاطئ يُردّ ولا يُعاد كتابته صامتًا. */
    const badCode = await submitService(
      { ...emptyForm(), code: "متابعة", nameAr: "خدمة" }, null,
    );
    expect(badCode.ok).toBe(false);
    if (badCode.ok) return;
    expect(badCode.message).toContain("رمز الخدمة");
    expect(fetchMock).not.toHaveBeenCalled();

    /* والتسوية تصحّح ما يُصحَّح فقط: مسافةٌ وشرطة، لا حرفٌ عربيّ. */
    expect(formToInput({ ...emptyForm(), code: " ortho wire-change " }).code)
      .toBe("ORTHO_WIRE_CHANGE");
  });
});

describe("شاشة خدمات المواعيد — التعطيل بدل الحذف", () => {
  /**
   * نقرةٌ واحدة ترسل حقلًا واحدًا.
   *
   * التعديل في الخادم جزئيّ. فلو أرسل زرُّ التعطيل النموذجَ كلَّه لكتب فوق مدّةٍ
   * عدّلها زميلٌ قبل ثانيةٍ من جهازٍ آخر — وهو فقدُ عملٍ بلا رسالةٍ ولا أثر.
   */
  it("زرّ التفعيل/التعطيل يرسل isActive وحده ويُحدَّث العرض بردّ الخادم", async () => {
    const active = CATALOG[0];
    const disabled = service({ ...active, isActive: false });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, disabled));

    const result = await setServiceActive(active, false);
    expect(result).toEqual({ ok: true, service: disabled });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/settings/appointment-services/${active.id}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ isActive: false });

    /* الحالة قبل النقرة وبعدها مرسومتان فعلًا — والزرّ يقول حالته لقارئ الشاشة. */
    const before = table([active]);
    const after = table([disabled]);
    expect(before).toContain('aria-pressed="true"');
    expect(before).not.toContain('data-testid="service-disabled-badge"');
    expect(after).toContain('aria-pressed="false"');
    expect(after).toContain('data-testid="service-disabled-badge"');
    expect(after).toContain("معطَّلة — لا تُحجز من جديد");

    /* والشاشة تستبدل الصفَّ بردّ الخادم لا بتخمينها. */
    expect(pageSource).toContain("row.id === result.service.id ? result.service : row");
  });

  /**
   * لا زرَّ محوٍ في الشاشة — وغيابُه قرارٌ لا نسيان.
   *
   * خدمةٌ حُجزت بها مواعيد إن مُحيت صار موعدُ العام الماضي بلا اسمٍ وتقريرُ الأمس
   * بسطرٍ فارغ. ولذلك يُفحَص الغياب: زرٌّ يُضاف غدًا «للتنظيف» يكسر التاريخ صامتًا.
   */
  it("لا زرَّ حذفٍ ولا نداءَ DELETE في الشاشة كلّها، وفي مكانه شرحٌ عربيّ", () => {
    for (const text of buttonTexts(table(CATALOG))) {
      expect(text).not.toMatch(/حذف|محو|إزالة|delete|remove/i);
    }
    expect(buttonTexts(table(CATALOG)).length).toBeGreaterThan(0);

    expect(pageSource).not.toContain('"DELETE"');
    expect(pageSource).not.toContain("method: \"DELETE\"");
    expect(pageSource).not.toContain("حذف الخدمة");

    /* والشرح موجودٌ حيث كان الزرّ سيكون. */
    expect(pageSource).toContain('data-testid="no-delete-note"');
    expect(pageSource).toContain("تُعطَّل");
    expect(pageSource).toContain("تاريخُ المركز يشير إلى لا شيء");
  });
});

describe("شاشة خدمات المواعيد — الرسائل وإمكانية الوصول", () => {
  /**
   * ٤٠٣ ليست شاشةً بيضاء.
   *
   * الاستقبال تفتح الرابط فترى «إدارة خدمات المواعيد للمدير وحده» فتفهم. وشاشةٌ
   * فارغة تُقرأ عطبًا في النظام فيُتّصل بالدعم.
   */
  it("رسالة الخادم العربية تُعرض كما هي عند ٤٠٣ وعند انقطاع الشبكة", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { message: "إدارة خدمات المواعيد للمدير وحده." }),
    );
    const forbidden = await fetchServices();
    expect(forbidden).toEqual({ ok: false, message: "إدارة خدمات المواعيد للمدير وحده." });

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const offline = await fetchServices();
    expect(offline.ok).toBe(false);
    if (offline.ok) return;
    expect(offline.message).toMatch(ARABIC);
    /* ولا تسريب لتفاصيل الاستثناء إلى المستخدم. */
    expect(offline.message).not.toContain("network down");

    /* ورسالة خطأ الحفظ من الخادم تُعرض كما جاءت. */
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { message: "الرمز «FILLING» مستعملٌ في خدمةٍ أخرى." }),
    );
    const clash = await submitService(
      { ...emptyForm(), code: "FILLING", nameAr: "حشوة" }, null,
    );
    expect(clash).toEqual({ ok: false, message: "الرمز «FILLING» مستعملٌ في خدمةٍ أخرى." });

    expect(pageSource).toContain('data-testid="load-error"');
    expect(pageSource).toContain('data-testid="form-error"');
  });

  /**
   * عنوانٌ حقيقيّ لكل حقل، ومنطقةُ خطأٍ يُعلنها القارئ.
   *
   * `placeholder` ليس عنوانًا: يختفي أوّل ما يُكتب، ولا يقرؤه قارئ الشاشة عنوانًا.
   * وفي شاشةٍ تُغيّر طاقةَ يومٍ كامل، حقلٌ بلا اسمٍ يُملأ بالخطأ.
   */
  it("كل حقل مرتبطٌ بعنوانه، ومنطقة الخطأ role=alert، والتبديل aria-pressed", () => {
    const literalIds = [
      "svc-code", "svc-name-ar", "svc-name-en", "svc-specialty", "svc-duration",
      "svc-buffer-before", "svc-buffer-after", "svc-priority", "svc-sort", "svc-badge",
      "svc-search", "svc-filter-specialty", "svc-filter-activity",
    ];
    for (const id of literalIds) {
      expect(pageSource).toContain(`htmlFor="${id}"`);
      expect(pageSource).toContain(`id="${id}"`);
    }

    /* والمرسومُ فعلًا يحمل `for`/`id` متطابقين في HTML الحقيقي — بما فيه خانات
       الأعلام التي يُبنى معرّفها من المفتاح لا يُكتب حرفيًّا. */
    const rendered = fields(emptyForm(), "create") + table(CATALOG);
    const renderedIds = [
      ...literalIds.filter((id) => !id.startsWith("svc-search") && !id.startsWith("svc-filter")),
      "svc-flag-requiresProvider", "svc-flag-requiresChair",
      "svc-flag-allowsConcurrentProviderWork", "svc-flag-consumesEmergencyReserve",
      "svc-flag-isActive",
    ];
    for (const id of renderedIds) {
      expect(rendered).toContain(`for="${id}"`);
      expect(rendered).toContain(`id="${id}"`);
    }
    /* ولا حقلَ بلا عنوان: كل `data-testid="field-*"` يقابله `for`. */
    const fieldCount = (fields(emptyForm(), "create").match(/data-testid="field-/g) ?? []).length;
    expect((fields(emptyForm(), "create").match(/ for="svc-/g) ?? []).length).toBe(fieldCount);

    expect((pageSource.match(/role="alert"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(table(CATALOG)).toContain("aria-pressed=");
    /* واتجاه الصفحة عربيّ صراحةً لا بالوراثة وحدها. */
    expect(pageSource).toContain('dir="rtl"');
  });

  /**
   * التحذير الذي يمنع مفاجأةَ الشهر القادم.
   *
   * من يرفع مدّةً لا يرى أثرها اليوم بل بعد أسبوعٍ حين تمتلئ المواعيد. وقولُه عند
   * الحقل نفسه هو الفرق بين قرارٍ واعٍ وشكوى.
   */
  it("تشرح عند حقول المدة أنها تُغيّر السعة، وأن المحجوز لا يتأثّر", () => {
    const markup = fields(emptyForm(), "create");
    expect(markup).toContain("محرّك السعة");
    expect(markup).toContain("والمواعيد المحجوزة لا تتأثّر");
    expect(markup).toContain("يسري على الحجوزات الجديدة وحدها");
    expect(markup).toContain(`data-testid="capacity-warning"`);
  });

  /** الشاشة مكوّنُ عميلٍ فعلًا — بلا ذلك لا `useState` ولا `fetch` في المتصفّح. */
  it("الشاشة مكوّن عميل ولا تحمل نصًّا لاتينيًّا موجّهًا للمستخدم", () => {
    expect(pageSource.startsWith('"use client"')).toBe(true);
    expect(typeof AppointmentServicesPage).toBe("function");
    /* عناوين الحقول كلّها عربية. */
    for (const label of [...pageSource.matchAll(/htmlFor="[^"]+">([^<]+)</g)].map((m) => m[1])) {
      expect(label.trim()).toMatch(ARABIC);
    }
  });
});
