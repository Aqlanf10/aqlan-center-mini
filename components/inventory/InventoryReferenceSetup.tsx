"use client";
import { validateReferenceInput } from "@/lib/inventory-domain/reference-validation";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Boxes,
  MapPin,
  ShieldCheck,
  Plus,
  RefreshCw,
  Search,
  X,
  Package,
} from "lucide-react";
import { useSession } from "@/components/SessionProvider";
import { formatMoney, parseAmount } from "@/lib/money";
import type {
  ReferenceInput,
  ReferenceRead,
} from "@/lib/inventory-reference-protocol";
import type { InventoryFirstUseReadiness } from "@/lib/inventory-domain/first-use-readiness";
import { useReferenceCommand } from "./useReferenceCommand";
import styles from "./inventory.module.css";
import setup from "./reference-setup.module.css";

type Section = "items" | "locations" | "policy";
type Draft = {
  name: string;
  category: string;
  baseUnit: string;
  precision: string;
  minLevel: string;
  note: string;
  itemId: string;
  enteredUnit: string;
  factor: string;
  enteredPrecision: string;
  locationId: string;
  locationLabel: string;
  kind: "store" | "transit" | "custody";
  doctorId: string;
  limit: string;
  reason: string;
  expectedVersion: string;
};
const blank: Draft = {
  name: "",
  category: "other",
  baseUnit: "",
  precision: "0",
  minLevel: "0",
  note: "",
  itemId: "",
  enteredUnit: "",
  factor: "",
  enteredPrecision: "0",
  locationId: "",
  locationLabel: "",
  kind: "store",
  doctorId: "",
  limit: "",
  reason: "",
  expectedVersion: "0",
};
export function InventoryReferenceSetup() {
  const session = useSession();
  return <ReferenceSetupScreen key={JSON.stringify(session)} />;
}
function ReferenceSetupScreen() {
  const session = useSession();
  const [locale, setLocale] = useState<"ar" | "en">("ar"),
    [section, setSection] = useState<Section>("items"),
    [editor, setEditor] = useState<
      "item" | "unit" | "location" | "policy" | null
    >(null);
  const t = (ar: string, en: string) => (locale === "ar" ? ar : en);
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<{
      owner: string;
      data: ReferenceRead;
    } | null>(null),
    [failure, setFailure] = useState<{ owner: string; message: string } | null>(
      null,
    );
  const [readiness, setReadiness] = useState<{
      owner: string;
      value: InventoryFirstUseReadiness;
    } | null>(null),
    [readinessError, setReadinessError] = useState("");
  const [draft, setDraft] = useState<Draft>(blank),
    [offered, setOffered] = useState<Draft | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [retireReason, setRetireReason] = useState("");
  const owner = JSON.stringify([session, search, page, refresh]),
    data = loaded?.owner === owner ? loaded.data : null;
  const binding = loaded?.data.authority ?? null;
  const command = useReferenceCommand(binding, () => {
    setNotice(
      t(
        "تم تأكيد نتيجة العملية وحفظ سجلها.",
        "Operation outcome confirmed and recorded.",
      ),
    );
    setEditor(null);
    setRefresh((v) => v + 1);
  });
  const draftKey = binding
    ? `inventory-reference-draft:${JSON.stringify([binding.realmId, binding.subjectId])}`
    : null;
  const searchRef = useRef<HTMLInputElement>(null),
    errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const abort = new AbortController();
    fetch(
      `/api/inventory/procurement?view=reference-setup&query=${encodeURIComponent(search)}&page=${page}`,
      { cache: "no-store", signal: abort.signal },
    )
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.message ?? "تعذّر تحميل التهيئة.");
        if (alive) {
          setLoaded({ owner, data: value });
          setFailure(null);
        }
      })
      .catch((e) => {
        if (alive)
          setFailure({
            owner,
            message: e instanceof Error ? e.message : "تعذّر التحميل.",
          });
      });
    return () => {
      alive = false;
      abort.abort();
    };
  }, [owner, search, page]);
  useEffect(() => {
    let alive = true;
    const abort = new AbortController();
    fetch("/api/inventory/procurement?view=first-use-readiness", {
      cache: "no-store",
      signal: abort.signal,
    })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.message);
        if (alive) {
          setReadiness({ owner: JSON.stringify([session, refresh]), value });
          setReadinessError("");
        }
      })
      .catch((e) => {
        if (alive)
          setReadinessError(
            e instanceof Error ? e.message : "تعذّر قراءة الجاهزية.",
          );
      });
    return () => {
      alive = false;
      abort.abort();
    };
  }, [session, refresh]);
  useEffect(() => {
    if (!draftKey) return;
    try {
      const value = localStorage.getItem(draftKey);
      if (value) {
        const saved = JSON.parse(value);
        if (
          saved.expires > Date.now() &&
          saved.draft &&
          Object.keys(blank).every((k) => typeof saved.draft[k] === "string")
        )
          setOffered(saved.draft);
      }
    } catch {
      /* Draft failure never grants command persistence. */
    }
  }, [draftKey]);
  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    setError("");
    setNotice("");
    setDraft((old) => {
      const next = { ...old, [key]: value };
      if (draftKey)
        try {
          localStorage.setItem(
            draftKey,
            JSON.stringify({ draft: next, expires: Date.now() + 7 * 86400000 }),
          );
        } catch {
          setError(
            t(
              "تعذّر حفظ المسودة على هذا الجهاز.",
              "This device could not save the draft.",
            ),
          );
        }
      return next;
    });
  }
  const busy = command.busy || !!command.pending;
  const action =
    editor === "item"
      ? "item.create"
      : editor === "unit"
        ? "unit.revise"
        : editor === "location"
          ? "location.create"
          : "policy.revise";
  function open(
    mode: NonNullable<typeof editor>,
    item?: ReferenceRead["items"][number],
  ) {
    if (busy) return;
    setEditor(mode);
    setError("");
    if (item)
      setDraft((old) => ({
        ...old,
        itemId: String(item.id),
        precision: String(item.basePrecision ?? 0),
        enteredUnit: "",
        factor: "",
        reason: "",
        expectedVersion: String(item.version),
      }));
    else if (mode === "policy")
      setDraft((old) => ({
        ...old,
        expectedVersion: String(data?.policy?.version ?? 0),
      }));
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!data || busy || !command.ready) return;
    setError("");
    try {
      if (draft.reason.trim().length < 3)
        throw new Error(
          t("اكتب سببًا واضحًا للحفظ.", "Enter a clear reason for saving."),
        );
      const reason = draft.reason.trim();
      let input: ReferenceInput;
      if (editor === "item")
        input = {
          action: "item.create",
          name: draft.name.trim(),
          category: draft.category.trim(),
          baseUnit: draft.baseUnit.trim(),
          basePrecision: Number(draft.precision),
          minLevel: draft.minLevel,
          note: draft.note.trim(),
          reason,
        };
      else if (editor === "unit") {
        const item = data.items.find((i) => String(i.id) === draft.itemId);
        if (!item)
          throw new Error(
            t("اختر مادة من الصفحة الحالية.", "Select an item from this page."),
          );
        input = {
          action: "unit.revise",
          itemId: item.id,
          expectedVersion: Number(draft.expectedVersion),
          enteredUnit: draft.enteredUnit.trim(),
          factor: draft.factor,
          enteredPrecision: Number(draft.enteredPrecision),
          basePrecision: item.basePrecision ?? Number(draft.precision),
          reason,
        };
      } else if (editor === "location")
        input = {
          action: "location.create",
          id: draft.locationId.trim(),
          label: draft.locationLabel.trim(),
          kind: draft.kind,
          doctorPartyId:
            draft.kind === "custody" ? Number(draft.doctorId) : null,
          reason,
        };
      else {
        const limit = parseAmount(draft.limit, "YER");
        if (limit === null)
          throw new Error(
            t(
              "راجع سقف الاعتماد بالريال اليمني.",
              "Check the approval limit in YER.",
            ),
          );
        input = {
          action: "policy.revise",
          expectedVersion: Number(draft.expectedVersion),
          limitMinor: limit,
          reason,
        };
      }
      validateReferenceInput(input);
      await command.start(input);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الحفظ.");
      errorRef.current?.focus();
    }
  }
  const field = (
    label: string,
    key: keyof Draft,
    options: { type?: string; max?: number; hint?: string } = {},
  ) => (
    <label className={setup.field}>
      {label}
      <input
        type={options.type ?? "text"}
        value={draft[key]}
        maxLength={options.max ?? 120}
        disabled={busy}
        onChange={(e) => change(key, e.target.value)}
        aria-invalid={!!error}
      />
      {options.hint ? (
        <span className={styles.caption}>{options.hint}</span>
      ) : null}
    </label>
  );
  const currentReadiness =
    readiness?.owner === JSON.stringify([session, refresh])
      ? readiness.value
      : null;
  return (
    <main
      className={`${styles.root} ${setup.root}`}
      dir={locale === "ar" ? "rtl" : "ltr"}
      lang={locale}
    >
      <header className={styles.toolbar}>
        <div>
          <p className={styles.caption}>
            {t("المخزون / الإدارة", "Inventory / Administration")}
          </p>
          <h1 className={styles.title}>
            {t("تهيئة المواد والمواقع", "Materials and locations setup")}
          </h1>
          <p className={styles.caption}>
            {t(
              "سجّل الوحدات والمواقع وحدود الاعتماد قبل أول طلب.",
              "Register units, locations and approval limits before the first request.",
            )}
          </p>
        </div>
        <div className={styles.actions}>
          <Link className={styles.button} href="/inventory/procurement">
            {t("طلبات المواد", "Material requests")}
          </Link>
          <button
            className={styles.button}
            onClick={() => setLocale((v) => (v === "ar" ? "en" : "ar"))}
          >
            {locale === "ar" ? "English" : "العربية"}
          </button>
        </div>
      </header>
      <div className={setup.commandBar}>
        <button
          className={styles.button}
          onClick={() => setRefresh((v) => v + 1)}
          disabled={command.busy}
        >
          <RefreshCw size={16} />
          {t("تحديث", "Refresh")}
        </button>
        <span className={styles.caption}>
          {t(
            "تسجيل مرجعي فقط؛ لا رصيد افتتاحي ولا حركة مخزون أو دين.",
            "Reference records only; no opening stock, movement or debt.",
          )}
        </span>
      </div>
      <section
        className={styles.panel}
        aria-label={t("ملاحظة الاستخدام الأول", "First-use observation")}
      >
        <div className={styles.panelHeading}>
          {t("فحص الاستخدام الأول", "First-use check")}
        </div>
        <div className={styles.note}>
          {currentReadiness ? (
            <>
              <p>
                {currentReadiness.state === "first_use_candidate"
                  ? t(
                      "مرشح للتهيئة بعد التحقق من الصلاحيات والمخطط. لا تظهر حركة مخزون في هذه اللقطة؛ ليست إذن تفعيل.",
                      "A setup candidate after authority and schema verification. No inventory history appears in this snapshot; this is not activation permission.",
                    )
                  : currentReadiness.state === "history_review_required"
                    ? t(
                        "توجد سجلات مخزون سابقة تحتاج مراجعة قبل البدء. لا تُحذف ولا تُتبنّى تلقائيًا.",
                        "Existing inventory evidence requires review. It is never deleted or automatically adopted.",
                      )
                    : t(
                        "بعض مصادر الفحص غير متاحة؛ لا تُعامل كمجموع صفر.",
                        "Some inspection sources are unavailable; they are not treated as zero.",
                      )}
              </p>
              <p>
                {t("وقت الملاحظة:", "Observed at:")}{" "}
                <time dateTime={currentReadiness.observedAt}>
                  {currentReadiness.observedAt}
                </time>
              </p>
              <details>
                <summary>
                  {t("أعداد السجلات المحمية", "Protected record counts")}
                </summary>
                <ul>
                  {currentReadiness.references.map((row) => (
                    <li key={row.table}>
                      {row.table}: {row.count ?? t("غير متاح", "Unavailable")}
                    </li>
                  ))}
                </ul>
                <p>
                  {t(
                    "مستحقات الموردين المشتركة:",
                    "Shared supplier liabilities:",
                  )}{" "}
                  {currentReadiness.protectedSupplierFinance.liabilities ?? "—"}{" "}
                  · {t("دفعات:", "Payments:")}{" "}
                  {currentReadiness.protectedSupplierFinance.payments ?? "—"}
                </p>
              </details>
            </>
          ) : (
            <p>
              {readinessError ||
                t("جارٍ قراءة الملاحظة…", "Reading observation…")}
            </p>
          )}
        </div>
      </section>
      {notice ? (
        <p role="status" className={setup.notice}>
          {notice}
        </p>
      ) : null}
      {offered ? (
        <div className={setup.notice}>
          {t("توجد مسودة محلية لم تُرسل.", "A local draft has not been sent.")}{" "}
          <button
            className={styles.button}
            disabled={busy}
            onClick={() => {
              setDraft(offered);
              setOffered(null);
            }}
          >
            {t("استعادة المسودة", "Restore draft")}
          </button>
          <button
            className={styles.button}
            onClick={() => {
              if (draftKey) localStorage.removeItem(draftKey);
              setOffered(null);
            }}
          >
            {t("تجاهل المسودة", "Discard draft")}
          </button>
        </div>
      ) : null}
      {command.pending ? (
        <section className={setup.pending} data-testid="reference-pending">
          <h2>
            {t(
              "عملية محفوظة بانتظار النتيجة",
              "Saved operation awaiting its outcome",
            )}
          </h2>
          <p>
            {command.pending.input.action} · {command.pending.input.reason}
          </p>
          <p>
            {t(
              "تبقى الهوية والمحتوى محفوظين؛ تغير الصلاحية أو الجلسة لا يعني فشل الحفظ.",
              "Identity and content remain saved; a permission or session change does not prove the write failed.",
            )}
          </p>
          <button
            className={styles.button}
            disabled={command.busy}
            onClick={() => void command.retry()}
          >
            {t("إعادة تأكيد العملية نفسها", "Confirm the same operation again")}
          </button>
          <details>
            <summary>
              {t("إنهاء محاولة لم تُنفّذ", "Retire an unexecuted attempt")}
            </summary>
            <label className={setup.field}>
              {t("سبب الإنهاء", "Retirement reason")}
              <input
                value={retireReason}
                onChange={(e) => setRetireReason(e.target.value)}
                maxLength={2000}
              />
            </label>
            <button
              className={styles.button}
              disabled={command.busy || retireReason.trim().length < 3}
              onClick={() => void command.retire(retireReason.trim())}
            >
              {t("طلب إثبات الإنهاء", "Request durable retirement proof")}
            </button>
          </details>
        </section>
      ) : null}
      {command.error ? (
        <p role="alert" className={setup.error}>
          {command.error}
        </p>
      ) : null}
      <div className={setup.workspace}>
        <nav
          className={setup.nav}
          aria-label={t("أقسام التهيئة", "Setup sections")}
        >
          {(
            [
              {
                id: "items",
                icon: Boxes,
                label: t("المواد والعبوات", "Items and packages"),
              },
              {
                id: "locations",
                icon: MapPin,
                label: t("المواقع والعهد", "Locations and custody"),
              },
              {
                id: "policy",
                icon: ShieldCheck,
                label: t("حدود الاعتماد", "Approval limits"),
              },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              aria-current={section === tab.id ? "page" : undefined}
              onClick={() => {
                setSection(tab.id);
                setEditor(null);
              }}
            >
              <tab.icon size={18} />
              {tab.label}
            </button>
          ))}
        </nav>
        <section className={`${styles.panel} ${setup.content}`}>
          {failure?.owner === owner ? (
            <div role="alert" className={styles.feedback}>
              <h2>{t("التهيئة غير متاحة", "Setup unavailable")}</h2>
              <p>{failure.message}</p>
              <p>
                {t(
                  "لن يُستخدم الدور وحده لمنح صلاحية، ولن تُرسل مسودتك تلقائيًا.",
                  "A role label alone does not grant permission. Your draft will not be sent automatically.",
                )}
              </p>
            </div>
          ) : !data ? (
            <p role="status" className={styles.feedback}>
              {t("جارٍ تحميل التهيئة…", "Loading setup…")}
            </p>
          ) : (
            <>
              <div className={styles.panelHeading}>
                <h2>
                  {section === "items"
                    ? t("المواد ووحدات الصرف", "Items and issue units")
                    : section === "locations"
                      ? t("المواقع المسجلة", "Registered locations")
                      : t("سياسة الاعتماد الحالية", "Current approval policy")}
                </h2>
                <button
                  className={`${styles.button} ${styles.primary}`}
                  disabled={
                    busy ||
                    !data.allowedActions.includes(
                      section === "items"
                        ? "item.create"
                        : section === "locations"
                          ? "location.create"
                          : "policy.revise",
                    )
                  }
                  onClick={() =>
                    open(
                      section === "items"
                        ? "item"
                        : section === "locations"
                          ? "location"
                          : "policy",
                    )
                  }
                >
                  <Plus size={16} />
                  {t("إضافة إصدار", "Add record or version")}
                </button>
              </div>
              {section === "items" ? (
                <>
                  <form
                    noValidate
                    className={setup.search}
                    onSubmit={(e) => {
                      e.preventDefault();
                      setSearch(query.trim());
                      setPage(0);
                    }}
                  >
                    <label>
                      <Search size={16} />
                      <span className="sr-only">
                        {t("بحث المواد", "Search items")}
                      </span>
                      <input
                        ref={searchRef}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        maxLength={120}
                        placeholder={t(
                          "ابحث باسم المادة",
                          "Search by item name",
                        )}
                      />
                    </label>
                    {query ? (
                      <button
                        type="button"
                        className={styles.button}
                        aria-label={t("مسح البحث", "Clear search")}
                        onClick={() => {
                          setQuery("");
                          setSearch("");
                          setPage(0);
                          searchRef.current?.focus();
                        }}
                      >
                        <X size={16} />
                      </button>
                    ) : null}
                    <button className={styles.button}>
                      {t("بحث", "Search")}
                    </button>
                  </form>
                  {data.items.length ? (
                    <div className={setup.tableWrap}>
                      <table>
                        <thead>
                          <tr>
                            <th>{t("المادة", "Item")}</th>
                            <th>{t("الوحدة الأساسية", "Base unit")}</th>
                            <th>
                              {t("آخر عبوة مسجلة", "Latest registered package")}
                            </th>
                            <th>{t("الحالة", "State")}</th>
                            <th>
                              <span className="sr-only">
                                {t("الإجراء", "Action")}
                              </span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.items.map((item) => (
                            <tr key={item.id}>
                              <th scope="row">{item.name}</th>
                              <td>{item.unit}</td>
                              <td>
                                {item.version
                                  ? `${item.enteredUnit} = ${item.factor} ${item.unit} · ${t("إصدار", "v")}${item.version}`
                                  : t("لم تسجّل وحدة", "No registered unit")}
                              </td>
                              <td>
                                {item.isActive
                                  ? t("نشطة", "Active")
                                  : t("غير نشطة", "Inactive")}
                              </td>
                              <td>
                                <button
                                  className={styles.button}
                                  disabled={
                                    busy ||
                                    !item.isActive ||
                                    !data.allowedActions.includes("unit.revise")
                                  }
                                  onClick={() => open("unit", item)}
                                >
                                  <Package size={15} />
                                  {t("عبوة جديدة", "New package")}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className={styles.note}>
                      {search
                        ? t(
                            "لا توجد نتائج. غيّر البحث أو امسحه.",
                            "No results. Change or clear the search.",
                          )
                        : t(
                            "ابدأ بإضافة مادة ووحدتها الأساسية. لا يُسجّل أي رصيد.",
                            "Start with an item and its base unit. No opening quantity is recorded.",
                          )}
                    </p>
                  )}
                  <div className={setup.pager}>
                    <button
                      className={styles.button}
                      disabled={!page}
                      onClick={() => setPage((v) => v - 1)}
                    >
                      {t("السابق", "Previous")}
                    </button>
                    <span>
                      {t("صفحة", "Page")} {page + 1} · {data.items.length}{" "}
                      {t("سجل", "records")}
                    </span>
                    <button
                      className={styles.button}
                      disabled={!data.hasMore}
                      onClick={() => setPage((v) => v + 1)}
                    >
                      {t("التالي", "Next")}
                    </button>
                  </div>
                </>
              ) : null}
              {section === "locations" ? (
                <div className={setup.tableWrap}>
                  <table>
                    <thead>
                      <tr>
                        <th>{t("الموقع", "Location")}</th>
                        <th>{t("النوع", "Type")}</th>
                        <th>{t("العهدة", "Custody")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.locations.map((l) => (
                        <tr key={l.id}>
                          <th scope="row">
                            {l.label}
                            <small>{l.id}</small>
                          </th>
                          <td>
                            {l.kind === "store"
                              ? t("مخزن", "Store")
                              : l.kind === "transit"
                                ? t("قيد النقل", "Transit")
                                : t("عهدة طبيب", "Doctor custody")}
                          </td>
                          <td>
                            {l.doctorPartyId
                              ? (data.doctors.find(
                                  (d) => d.id === l.doctorPartyId,
                                )?.name ??
                                t(
                                  "ارتباط يحتاج مراجعة",
                                  "Binding requires review",
                                ))
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!data.locations.length ? (
                    <p className={styles.note}>
                      {t(
                        "لا توجد مواقع. أضف المخزن قبل الاستلام.",
                        "No locations. Add a store before receiving goods.",
                      )}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {section === "policy" ? (
                <div className={styles.note}>
                  <p>
                    {data.policy
                      ? `${t("الإصدار", "Version")} ${data.policy.version} · ${formatMoney(data.policy.limitMinor, "YER")}`
                      : t(
                          "لم تضبط سياسة اعتماد بعد.",
                          "No approval policy is configured.",
                        )}
                  </p>
                  <p>
                    {t(
                      "سقف بالريال اليمني مع حفظ تقييم العملة الأصلي. الطلب والاعتماد من شخصين مختلفين؛ لا يتيح هذا النموذج اعتمادًا ذاتيًا.",
                      "A YER limit preserves original currency valuation. Request and approval require different people; this form cannot enable self-approval.",
                    )}
                  </p>
                </div>
              ) : null}
              {editor ? (
                <form
                  noValidate
                  onSubmit={submit}
                  className={setup.editor}
                  data-testid="reference-editor"
                >
                  <h3>
                    {editor === "item"
                      ? t("مادة جديدة ووحدة أساسية", "New item and base unit")
                      : editor === "unit"
                        ? t("إصدار عبوة معتمد", "Registered package version")
                        : editor === "location"
                          ? t("موقع جديد", "New location")
                          : t("إصدار حدود الاعتماد", "Approval limit revision")}
                  </h3>
                  <div
                    ref={errorRef}
                    tabIndex={-1}
                    role={error ? "alert" : undefined}
                  >
                    {error}
                  </div>
                  <div className={setup.fields}>
                    {editor === "item" ? (
                      <>
                        {field(t("اسم المادة", "Item name"), "name")}
                        {field(t("الوحدة الأساسية", "Base unit"), "baseUnit", {
                          max: 20,
                        })}
                        {field(
                          t("دقة الكمية (0–3)", "Quantity precision (0–3)"),
                          "precision",
                          { type: "number" },
                        )}
                        {field(
                          t("حد إعادة الطلب", "Reorder threshold"),
                          "minLevel",
                        )}
                        {field(t("ملاحظة", "Note"), "note", { max: 300 })}
                      </>
                    ) : null}
                    {editor === "unit" ? (
                      <>
                        <p>
                          {
                            data.items.find(
                              (i) => String(i.id) === draft.itemId,
                            )?.name
                          }
                        </p>
                        {field(t("اسم العبوة", "Package unit"), "enteredUnit", {
                          max: 80,
                        })}
                        {field(
                          t("وحدات أساسية في العبوة", "Base units per package"),
                          "factor",
                        )}
                        {field(
                          t("دقة كمية العبوة (0–3)", "Package precision (0–3)"),
                          "enteredPrecision",
                          { type: "number" },
                        )}
                        <p className={styles.caption}>
                          {t(
                            "الإصدارات السابقة ثابتة وتبقى على مستنداتها.",
                            "Earlier versions remain unchanged on their documents.",
                          )}
                        </p>
                      </>
                    ) : null}
                    {editor === "location" ? (
                      <>
                        {field(
                          t("اسم الموقع", "Location name"),
                          "locationLabel",
                        )}
                        {field(t("رمز الموقع", "Location code"), "locationId", {
                          max: 80,
                          hint: t(
                            "أحرف إنجليزية صغيرة وأرقام، مثال store-main",
                            "Lowercase letters and digits, e.g. store-main",
                          ),
                        })}
                        <label className={setup.field}>
                          {t("نوع الموقع", "Location type")}
                          <select
                            value={draft.kind}
                            disabled={busy}
                            onChange={(e) =>
                              change("kind", e.target.value as Draft["kind"])
                            }
                          >
                            <option value="store">{t("مخزن", "Store")}</option>
                            <option value="transit">
                              {t("قيد النقل", "Transit")}
                            </option>
                            <option value="custody">
                              {t("عهدة طبيب", "Doctor custody")}
                            </option>
                          </select>
                        </label>
                        {draft.kind === "custody" ? (
                          <label className={setup.field}>
                            {t("الطبيب صاحب العهدة", "Custody doctor")}
                            <select
                              value={draft.doctorId}
                              disabled={busy}
                              onChange={(e) =>
                                change("doctorId", e.target.value)
                              }
                            >
                              <option value="">
                                {t("اختر طبيبًا", "Select a doctor")}
                              </option>
                              {data.doctors.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </>
                    ) : null}
                    {editor === "policy"
                      ? field(
                          t(
                            "سقف الاعتماد بالريال اليمني",
                            "Approval limit in YER",
                          ),
                          "limit",
                        )
                      : null}
                    {field(t("سبب الحفظ", "Save reason"), "reason", {
                      max: 2000,
                    })}
                  </div>
                  <div className={styles.actions}>
                    <button
                      className={`${styles.button} ${styles.primary}`}
                      disabled={
                        busy ||
                        !command.ready ||
                        !data.allowedActions.includes(action)
                      }
                    >
                      {command.busy
                        ? t("جارٍ التأكيد…", "Confirming…")
                        : t("حفظ وتأكيد الإصدار", "Save and confirm")}
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={busy}
                      onClick={() => setEditor(null)}
                    >
                      {t("إغلاق مع حفظ المسودة", "Close and keep draft")}
                    </button>
                  </div>
                </form>
              ) : null}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
