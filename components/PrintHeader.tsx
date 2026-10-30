import type { SettingsMap } from "@/lib/settings";
import { Logo } from "./Icon";

/**
 * ترويسة المستندات المطبوعة.
 *
 * هوية المركز من الإعدادات لا من الكود — قرار المالك أن يحمل كل تقرير اسم المركز
 * كاملًا واسم الطبيب وتخصصه ومؤهله. ولأنها من الإعدادات، تغييرها لا يحتاج نشرة.
 */
export function PrintHeader({ settings, title, compact = false }: {
  settings: SettingsMap;
  title: string;
  compact?: boolean;
}) {
  return (
    <header className="print-brand-header">
      {/* الشعار على الورق كما على الشاشة: سندٌ يُعطى لمريض أو يُرسل إلى مختبر هو
          مستندٌ باسم المركز، وشعارٌ عليه يجعله يُعرف من بعيد بين أوراق كثيرة.
          ويُرسم متجهيًا لا صورةً: يخرج حادًّا على أي طابعة مهما كانت دقتها. */}
      <PrintBrandIdentity settings={settings} compact={compact} />
      <div className="rule" />
      <p className="doc-title" style={{ textAlign: "center" }}>{title}</p>
    </header>
  );
}

/** The approved contract identity, also used by client-side report adapters. */
export function PrintBrandIdentity({ settings, compact = false, showContacts = false }: {
  settings: SettingsMap; compact?: boolean; showContacts?: boolean;
}) {
  return (
      <div className="print-brand-identity" style={{ textAlign: "center" }}>
        <Logo className="print-logo" />
        <p className="clinic-name">{settings["clinic.name"]}</p>
        <p className="clinic-sub">
          {settings["clinic.lead_doctor"]} — {settings["clinic.lead_doctor_title"]}
        </p>
        {!compact && settings["clinic.lead_doctor_credentials"]?.trim() && !settings["clinic.lead_doctor_title"]?.includes(settings["clinic.lead_doctor_credentials"].trim()) ? (
          <p className="clinic-sub">{settings["clinic.lead_doctor_credentials"]}</p>
        ) : null}
        {showContacts && (settings["clinic.address"] || settings["clinic.phone"]) ? <p className="clinic-sub">
          {settings["clinic.address"]}{settings["clinic.address"] && settings["clinic.phone"] ? " · " : ""}
          {settings["clinic.phone"] ? <>هاتف: <span dir="ltr">{settings["clinic.phone"]}</span></> : null}
        </p> : null}
      </div>
  );
}

export function PrintFooter({ settings }: { settings: SettingsMap }) {
  return (
    <>
      <div className="rule-light print-footer-rule" />
      {/* الهاتف بـ`dir="ltr"`: رقمٌ مثل «04-253028» داخل نصّ عربي يُقلب إلى
          «253028-04» بقواعد الاتجاه الثنائي، فيُطبع رقم خاطئ على كل سند. */}
      <p className="footer-note print-contact-footer" style={{ textAlign: "center" }}>
        {settings["clinic.address"]} · هاتف: <span dir="ltr">{settings["clinic.phone"]}</span>
      </p>
    </>
  );
}
