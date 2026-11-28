import { isRole, ROLES, type Role } from "./roles";

/**
 * الخصوصية والصلاحيات التفصيلية لوحدة التقويم — المنطق الخالص.
 *
 * المبادئ الحاكمة (إلزامية):
 * 1. الافتراضي هو المنع (Deny-by-Default) ما لم توجد صلاحية صريحة سارية.
 * 2. المنع الصريح يتقدم دائمًا على أي سماح عبر جميع النطاقات (الدور/الفرع/المستخدم/الطبيب/الحالة/المريض).
 * 3. صلاحيات القراءة والكتابة والإدخال الأعمى (Blind Create) والاعتماد وإعادة الفتح مستقلة تمامًا.
 * 4. إخفاء وحدة التقويم (`module.visible = false`) يحجب كل الأقسام والحقول والعمليات دون استثناء.
 * 5. الصلاحيات المؤقتة تنتهي تلقائيًا عند بلوغ `expiresAt` وتعود إلى المنع.
 * 6. لا يجوز لأي موظف رفع صلاحياته أو تجاوز المالك أو تعديل صلاحيات المالك.
 */

export const ORTHO_PRIVACY_SCHEMA_VERSION = 1 as const;
export const ORTHO_PRIVACY_SETTING_KEY = "ortho.privacy_policy_v1" as const;

export const ORTHO_PERMISSIONS = [
  "module.visible",
  "records.read",
  "records.create",
  "records.blind_create",
  "records.edit",
  "records.delete",
  "photos.capture",
  "photos.upload",
  "photos.view",
  "photos.edit",
  "photos.download",
  "reports.export",
  "reports.print",
  "measurements.perform",
  "measurements.edit",
  "measurements.approve",
  "diagnosis.approve",
  "plan.approve",
  "sessions.record",
  "sessions.approve",
  "records.reopen",
  "presentation.create",
  "ai.use",
  "settings.manage",
  "finance.view",
  "owner.delegate_ortho_privacy",
] as const;

export type OrthoPermissionKey = (typeof ORTHO_PERMISSIONS)[number];

export const ORTHO_PERMISSION_META: Record<
  OrthoPermissionKey,
  { labelAr: string; group: "access" | "records" | "media" | "clinical" | "governance"; ownerSensitive?: boolean }
> = {
  "module.visible": { labelAr: "ظهور وحدة التقويم بالكامل", group: "access" },
  "records.read": { labelAr: "قراءة بيانات وسجلات التقويم", group: "records" },
  "records.create": { labelAr: "إدخال بيانات جديدة", group: "records" },
  "records.blind_create": { labelAr: "إدخال بيانات دون استعراض السجلات السابقة", group: "records" },
  "records.edit": { labelAr: "تعديل البيانات السريرية", group: "records" },
  "records.delete": { labelAr: "حذف/إخفاء السجلات وفق سياسة الحذف", group: "records", ownerSensitive: true },
  "photos.capture": { labelAr: "التقاط الصور المباشر بالكاميرا", group: "media" },
  "photos.upload": { labelAr: "رفع الصور والأشعة", group: "media" },
  "photos.view": { labelAr: "رؤية الصور والأشعة", group: "media" },
  "photos.edit": { labelAr: "تعديل الصور (قص/تدوير/إضاءة بنسخة مشتقة)", group: "media" },
  "photos.download": { labelAr: "تنزيل الصور والأشعة", group: "media" },
  "reports.export": { labelAr: "تصدير التقارير", group: "clinical" },
  "reports.print": { labelAr: "طباعة التقارير", group: "clinical" },
  "measurements.perform": { labelAr: "إجراء القياسات والتحليلات", group: "clinical" },
  "measurements.edit": { labelAr: "تعديل القياسات والتحليلات", group: "clinical" },
  "measurements.approve": { labelAr: "اعتماد القياسات والتحليلات", group: "clinical" },
  "diagnosis.approve": { labelAr: "اعتماد التشخيص", group: "clinical" },
  "plan.approve": { labelAr: "اعتماد خطة العلاج", group: "clinical" },
  "sessions.record": { labelAr: "تسجيل الشدّات والجلسات", group: "clinical" },
  "sessions.approve": { labelAr: "اعتماد الشدّات والجلسات", group: "clinical" },
  "records.reopen": { labelAr: "إعادة فتح السجلات المعتمدة", group: "governance", ownerSensitive: true },
  "presentation.create": { labelAr: "إنشاء Case Presentation", group: "clinical" },
  "ai.use": { labelAr: "استخدام AQLAN AI Assistant", group: "governance" },
  "settings.manage": { labelAr: "التحكم بإعدادات وحدة التقويم", group: "governance", ownerSensitive: true },
  "finance.view": { labelAr: "رؤية المعلومات المالية للتقويم", group: "governance", ownerSensitive: true },
  "owner.delegate_ortho_privacy": { labelAr: "تفويض إدارة صلاحيات التقويم (للمالك فقط)", group: "governance", ownerSensitive: true },
};

export const ORTHO_SECTIONS = [
  "followup",
  "overview",
  "medical_history",
  "exam",
  "media",
  "ceph",
  "photo_analysis",
  "model3d",
  "measurements",
  "diagnosis",
  "plan",
  "appliances",
  "sessions",
  "retention",
  "reports",
  "ai_assistant",
] as const;

export type OrthoSectionKey = (typeof ORTHO_SECTIONS)[number];

export const ORTHO_SECTION_LABELS: Record<OrthoSectionKey, string> = {
  followup: "لوحة متابعة التقويم",
  overview: "بيانات الحالة والملخص",
  medical_history: "التاريخ الطبي والاستبيان",
  exam: "الفحص داخل وخارج الفم",
  media: "الصور والأشعة والأرشيف",
  ceph: "استوديو السيفالومتري",
  photo_analysis: "تحليل الصور الوجهية والداخل فموية",
  model3d: "تحليل النماذج ثلاثية الأبعاد",
  measurements: "القياسات وتحليل النماذج (FDI/Bolton/Moyers)",
  diagnosis: "قائمة المشكلات والتشخيص",
  plan: "أهداف وخطة العلاج",
  appliances: "الأجهزة والأسلاك والميكانيكا",
  sessions: "الشدّات والجلسات",
  retention: "مرحلة التثبيت والمتابعة",
  reports: "التقارير وCase Presentation",
  ai_assistant: "عقلان — المساعد الذكي",
};

export const ORTHO_FIELDS = [
  "medicalHistory",
  "clinicalNotes",
  "previousPhotos",
  "financialBalances",
  "internalNotes",
  "identityFields",
] as const;

export type OrthoFieldKey = (typeof ORTHO_FIELDS)[number];

export const ORTHO_FIELD_LABELS: Record<OrthoFieldKey, string> = {
  medicalHistory: "حقول التاريخ الطبي والحساسية",
  clinicalNotes: "الملاحظات السريرية السابقة",
  previousPhotos: "استعراض الصور والأشعة السابقة",
  financialBalances: "الأرصدة والمعلومات المالية للتقويم",
  internalNotes: "الملاحظات الإدارية الداخلية",
  identityFields: "بيانات الهوية والتواصل الكاملة للمريض",
};

export interface OrthoRoleGrantSet {
  permissions: Partial<Record<OrthoPermissionKey, boolean>>;
  sections: Partial<Record<OrthoSectionKey, boolean>>;
  fields: Partial<Record<OrthoFieldKey, boolean>>;
}

export interface OrthoPrivacyRuleTarget {
  roles?: Role[];
  userIds?: number[];
  branches?: string[];
  doctorPartyIds?: number[];
  patientIds?: number[];
  orthoCaseIds?: number[];
}

export interface OrthoPrivacyRule {
  id: string;
  label?: string;
  effect: "allow" | "deny";
  target: OrthoPrivacyRuleTarget;
  permissions?: OrthoPermissionKey[];
  sections?: OrthoSectionKey[];
  fields?: OrthoFieldKey[];
  /** تاريخ ووقت انتهاء الصلاحية المؤقتة (ISO-8601) — null يعني دائمة حتى الإلغاء. */
  expiresAt?: string | null;
  reason?: string;
  createdBy?: string;
  createdAt?: string;
}

export interface OrthoPrivacyPolicyDocument {
  schemaVersion: typeof ORTHO_PRIVACY_SCHEMA_VERSION;
  revision: number;
  ownerUserId: number | null;
  delegatedManagerUserIds: number[];
  roleDefaults: Record<Role, OrthoRoleGrantSet>;
  rules: OrthoPrivacyRule[];
}

export interface OrthoSubject {
  userId: number;
  username: string;
  role: string;
  isActive: boolean;
  branch?: string | null;
  partyId?: number | null;
  isOwner?: boolean;
}

export interface OrthoAccessContext {
  patientId?: number | null;
  orthoCaseId?: number | null;
  doctorPartyId?: number | null;
  branch?: string | null;
}

export interface ResolvedOrthoAccess {
  isOwner: boolean;
  moduleVisible: boolean;
  permissions: Record<OrthoPermissionKey, boolean>;
  sections: Record<OrthoSectionKey, boolean>;
  fields: Record<OrthoFieldKey, boolean>;
  matchedRuleIds: string[];
  expiredRuleIds: string[];
}

const PERMISSION_SET = new Set<string>(ORTHO_PERMISSIONS);
const SECTION_SET = new Set<string>(ORTHO_SECTIONS);
const FIELD_SET = new Set<string>(ORTHO_FIELDS);

export const OWNER_ONLY_ORTHO_PERMISSIONS: ReadonlySet<OrthoPermissionKey> = new Set([
  "settings.manage",
  "owner.delegate_ortho_privacy",
]);

function allMap<K extends string>(keys: readonly K[], value: boolean): Record<K, boolean> {
  const out = {} as Record<K, boolean>;
  for (const k of keys) out[k] = value;
  return out;
}

export function isOrthoPermissionKey(value: unknown): value is OrthoPermissionKey {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

export function isOrthoSectionKey(value: unknown): value is OrthoSectionKey {
  return typeof value === "string" && SECTION_SET.has(value);
}

export function isOrthoFieldKey(value: unknown): value is OrthoFieldKey {
  return typeof value === "string" && FIELD_SET.has(value);
}

/**
 * السياسة الافتراضية الآمنة عند التشغيل الأول:
 * - المالك/المدير (admin): كامل الصلاحيات.
 * - الطبيب (doctor): عمل سريري كامل على مرضاه بدون مالية وبدون حذف وبدون إعدادات الوحدة.
 * - الاستقبال (reception): متابعة المواعيد والمعلومات الأساسية والرفع الأعمى عند الإذن دون عرض الصور أو المراجع أو الاعتماد السريري.
 * - المساعد السريري (assistant): إدخال أعمى وتصوير/رفع شدّات اليوم فقط — بلا رؤية للصور السابقة أو التشخيص أو الخطة أو المالية.
 * - الكاشير والمحاسب (cashier / accountant): وحدة التقويم مخفية بالكامل (منع تام).
 */
export function buildDefaultOrthoPrivacyPolicy(ownerUserId: number | null = null): OrthoPrivacyPolicyDocument {
  return {
    schemaVersion: ORTHO_PRIVACY_SCHEMA_VERSION,
    revision: 0,
    ownerUserId,
    delegatedManagerUserIds: [],
    roleDefaults: {
      admin: {
        permissions: allMap(ORTHO_PERMISSIONS, true),
        sections: allMap(ORTHO_SECTIONS, true),
        fields: allMap(ORTHO_FIELDS, true),
      },
      doctor: {
        permissions: {
          "module.visible": true,
          "records.read": true,
          "records.create": true,
          "records.blind_create": false,
          "records.edit": true,
          "records.delete": false,
          "photos.capture": true,
          "photos.upload": true,
          "photos.view": true,
          "photos.edit": true,
          "photos.download": true,
          "reports.export": true,
          "reports.print": true,
          "measurements.perform": true,
          "measurements.edit": true,
          "measurements.approve": true,
          "diagnosis.approve": true,
          "plan.approve": true,
          "sessions.record": true,
          "sessions.approve": true,
          "records.reopen": false,
          "presentation.create": true,
          "ai.use": true,
          "settings.manage": false,
          "finance.view": false,
          "owner.delegate_ortho_privacy": false,
        },
        sections: {
          followup: true,
          overview: true,
          medical_history: true,
          exam: true,
          media: true,
          ceph: true,
          photo_analysis: true,
          model3d: true,
          measurements: true,
          diagnosis: true,
          plan: true,
          appliances: true,
          sessions: true,
          retention: true,
          reports: true,
          ai_assistant: true,
        },
        fields: {
          medicalHistory: true,
          clinicalNotes: true,
          previousPhotos: true,
          financialBalances: false,
          internalNotes: true,
          identityFields: true,
        },
      },
      reception: {
        permissions: {
          "module.visible": true,
          "records.read": true,
          "records.create": true,
          "records.blind_create": false,
          "records.edit": false,
          "records.delete": false,
          "photos.capture": false,
          "photos.upload": false,
          "photos.view": false,
          "photos.edit": false,
          "photos.download": false,
          "reports.export": false,
          "reports.print": false,
          "measurements.perform": false,
          "measurements.edit": false,
          "measurements.approve": false,
          "diagnosis.approve": false,
          "plan.approve": false,
          "sessions.record": false,
          "sessions.approve": false,
          "records.reopen": false,
          "presentation.create": false,
          "ai.use": false,
          "settings.manage": false,
          "finance.view": true,
          "owner.delegate_ortho_privacy": false,
        },
        sections: {
          followup: true,
          overview: true,
          medical_history: false,
          exam: false,
          media: false,
          ceph: false,
          photo_analysis: false,
          model3d: false,
          measurements: false,
          diagnosis: false,
          plan: false,
          appliances: false,
          sessions: false,
          retention: false,
          reports: false,
          ai_assistant: false,
        },
        fields: {
          medicalHistory: false,
          clinicalNotes: false,
          previousPhotos: false,
          financialBalances: true,
          internalNotes: false,
          identityFields: true,
        },
      },
      assistant: {
        permissions: {
          "module.visible": true,
          "records.read": false,
          "records.create": false,
          "records.blind_create": true,
          "records.edit": false,
          "records.delete": false,
          "photos.capture": true,
          "photos.upload": true,
          "photos.view": false,
          "photos.edit": false,
          "photos.download": false,
          "reports.export": false,
          "reports.print": false,
          "measurements.perform": false,
          "measurements.edit": false,
          "measurements.approve": false,
          "diagnosis.approve": false,
          "plan.approve": false,
          "sessions.record": true,
          "sessions.approve": false,
          "records.reopen": false,
          "presentation.create": false,
          "ai.use": false,
          "settings.manage": false,
          "finance.view": false,
          "owner.delegate_ortho_privacy": false,
        },
        sections: {
          followup: false,
          overview: false,
          medical_history: false,
          exam: false,
          media: false,
          ceph: false,
          photo_analysis: false,
          model3d: false,
          measurements: false,
          diagnosis: false,
          plan: false,
          appliances: false,
          sessions: true,
          retention: false,
          reports: false,
          ai_assistant: false,
        },
        fields: {
          medicalHistory: false,
          clinicalNotes: false,
          previousPhotos: false,
          financialBalances: false,
          internalNotes: false,
          identityFields: false,
        },
      },
      cashier: {
        permissions: allMap(ORTHO_PERMISSIONS, false),
        sections: allMap(ORTHO_SECTIONS, false),
        fields: allMap(ORTHO_FIELDS, false),
      },
      accountant: {
        permissions: allMap(ORTHO_PERMISSIONS, false),
        sections: allMap(ORTHO_SECTIONS, false),
        fields: allMap(ORTHO_FIELDS, false),
      },
    },
    rules: [],
  };
}

function normalizePositiveInts(raw: unknown, maxLen = 200): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: number[] = [];
  for (const item of raw) {
    if (typeof item === "number" && Number.isSafeInteger(item) && item > 0 && !out.includes(item)) {
      out.push(item);
      if (out.length >= maxLen) break;
    }
  }
  return out.length > 0 ? out : undefined;
}

function normalizeStrings(raw: unknown, maxLen = 60, maxItems = 50): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const clean = item.trim().slice(0, maxLen);
      if (clean && !out.includes(clean)) {
        out.push(clean);
        if (out.length >= maxItems) break;
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * محلل صارم لوثيقة السياسة: يتجاهل المفاتيح غير المعروفة ويعيد وثيقة صالحة حتميًا أو خطأً صريحًا.
 */
export function parseOrthoPrivacyPolicy(
  raw: unknown,
  fallbackOwnerUserId: number | null = null,
): { ok: true; value: OrthoPrivacyPolicyDocument } | { ok: false; error: string } {
  const defaults = buildDefaultOrthoPrivacyPolicy(fallbackOwnerUserId);
  if (raw === null || raw === undefined || raw === "") {
    return { ok: true, value: defaults };
  }

  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, error: "تعذّر قراءة وثيقة صلاحيات التقويم (JSON غير صالح)." };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "بنية وثيقة صلاحيات التقويم غير صالحة." };
  }
  const source = obj as Record<string, unknown>;
  const revision = typeof source.revision === "number" && Number.isInteger(source.revision) && source.revision >= 0
    ? source.revision
    : 0;
  const ownerUserId = typeof source.ownerUserId === "number" && Number.isSafeInteger(source.ownerUserId) && source.ownerUserId > 0
    ? source.ownerUserId
    : fallbackOwnerUserId;

  const delegatedManagerUserIds = normalizePositiveInts(source.delegatedManagerUserIds, 25) ?? [];

  const roleDefaults = buildDefaultOrthoPrivacyPolicy(ownerUserId).roleDefaults;
  if (source.roleDefaults && typeof source.roleDefaults === "object" && !Array.isArray(source.roleDefaults)) {
    const rawRoles = source.roleDefaults as Record<string, unknown>;
    for (const role of ROLES) {
      const entry = rawRoles[role];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      if (e.permissions && typeof e.permissions === "object" && !Array.isArray(e.permissions)) {
        const nextPerms: Partial<Record<OrthoPermissionKey, boolean>> = { ...roleDefaults[role].permissions };
        for (const [k, v] of Object.entries(e.permissions as Record<string, unknown>)) {
          if (isOrthoPermissionKey(k) && typeof v === "boolean") nextPerms[k] = v;
        }
        roleDefaults[role].permissions = nextPerms;
      }
      if (e.sections && typeof e.sections === "object" && !Array.isArray(e.sections)) {
        const nextSecs: Partial<Record<OrthoSectionKey, boolean>> = { ...roleDefaults[role].sections };
        for (const [k, v] of Object.entries(e.sections as Record<string, unknown>)) {
          if (isOrthoSectionKey(k) && typeof v === "boolean") nextSecs[k] = v;
        }
        roleDefaults[role].sections = nextSecs;
      }
      if (e.fields && typeof e.fields === "object" && !Array.isArray(e.fields)) {
        const nextFields: Partial<Record<OrthoFieldKey, boolean>> = { ...roleDefaults[role].fields };
        for (const [k, v] of Object.entries(e.fields as Record<string, unknown>)) {
          if (isOrthoFieldKey(k) && typeof v === "boolean") nextFields[k] = v;
        }
        roleDefaults[role].fields = nextFields;
      }
    }
  }

  const rules: OrthoPrivacyRule[] = [];
  if (Array.isArray(source.rules)) {
    if (source.rules.length > 500) {
      return { ok: false, error: "تجاوز عدد قواعد الخصوصية الحد الأقصى المسموح (500 قاعدة)." };
    }
    const seenIds = new Set<string>();
    for (let i = 0; i < source.rules.length; i++) {
      const r = source.rules[i];
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        return { ok: false, error: `القاعدة رقم ${i + 1} غير صالحة.` };
      }
      const item = r as Record<string, unknown>;
      const id = typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 80) : `rule-${i + 1}`;
      if (seenIds.has(id)) return { ok: false, error: `معرّف القاعدة مكرر: ${id}` };
      seenIds.add(id);

      const effect = item.effect === "allow" || item.effect === "deny" ? item.effect : null;
      if (!effect) return { ok: false, error: `نوع الأثر (allow/deny) مطلوب للقاعدة ${id}.` };

      const rawTarget = (item.target && typeof item.target === "object" && !Array.isArray(item.target)
        ? item.target
        : {}) as Record<string, unknown>;

      const targetRoles = Array.isArray(rawTarget.roles)
        ? rawTarget.roles.filter((x): x is Role => isRole(x))
        : undefined;

      const target: OrthoPrivacyRuleTarget = {
        ...(targetRoles && targetRoles.length > 0 ? { roles: [...new Set(targetRoles)] } : {}),
        ...(normalizePositiveInts(rawTarget.userIds) ? { userIds: normalizePositiveInts(rawTarget.userIds) } : {}),
        ...(normalizeStrings(rawTarget.branches) ? { branches: normalizeStrings(rawTarget.branches) } : {}),
        ...(normalizePositiveInts(rawTarget.doctorPartyIds) ? { doctorPartyIds: normalizePositiveInts(rawTarget.doctorPartyIds) } : {}),
        ...(normalizePositiveInts(rawTarget.patientIds) ? { patientIds: normalizePositiveInts(rawTarget.patientIds) } : {}),
        ...(normalizePositiveInts(rawTarget.orthoCaseIds) ? { orthoCaseIds: normalizePositiveInts(rawTarget.orthoCaseIds) } : {}),
      };

      const hasAnyTarget = Object.keys(target).length > 0;
      if (!hasAnyTarget) {
        return { ok: false, error: `القاعدة ${id} يجب أن تحدد نطاقًا واحدًا على الأقل (مستخدم/دور/فرع/طبيب/حالة/مريض).` };
      }

      const permissions = Array.isArray(item.permissions)
        ? [...new Set(item.permissions.filter(isOrthoPermissionKey))]
        : undefined;
      const sections = Array.isArray(item.sections)
        ? [...new Set(item.sections.filter(isOrthoSectionKey))]
        : undefined;
      const fields = Array.isArray(item.fields)
        ? [...new Set(item.fields.filter(isOrthoFieldKey))]
        : undefined;

      if ((!permissions || permissions.length === 0) && (!sections || sections.length === 0) && (!fields || fields.length === 0)) {
        return { ok: false, error: `القاعدة ${id} يجب أن تشمل عملية أو قسمًا أو حقلًا واحدًا على الأقل.` };
      }

      let expiresAt: string | null = null;
      if (item.expiresAt !== undefined && item.expiresAt !== null && item.expiresAt !== "") {
        if (typeof item.expiresAt !== "string" || Number.isNaN(Date.parse(item.expiresAt))) {
          return { ok: false, error: `تاريخ انتهاء الصلاحية المؤقتة غير صالح في القاعدة ${id}.` };
        }
        expiresAt = new Date(item.expiresAt).toISOString();
      }

      rules.push({
        id,
        label: typeof item.label === "string" ? item.label.trim().slice(0, 120) : undefined,
        effect,
        target,
        ...(permissions && permissions.length > 0 ? { permissions } : {}),
        ...(sections && sections.length > 0 ? { sections } : {}),
        ...(fields && fields.length > 0 ? { fields } : {}),
        expiresAt,
        reason: typeof item.reason === "string" ? item.reason.trim().slice(0, 240) : undefined,
        createdBy: typeof item.createdBy === "string" ? item.createdBy.trim().slice(0, 80) : undefined,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
      });
    }
  }

  return {
    ok: true,
    value: {
      schemaVersion: ORTHO_PRIVACY_SCHEMA_VERSION,
      revision,
      ownerUserId,
      delegatedManagerUserIds,
      roleDefaults,
      rules,
    },
  };
}

function ruleMatches(rule: OrthoPrivacyRule, subject: OrthoSubject, context: OrthoAccessContext): boolean {
  const t = rule.target;
  if (t.roles && t.roles.length > 0 && !t.roles.includes(subject.role as Role)) return false;
  if (t.userIds && t.userIds.length > 0 && !t.userIds.includes(subject.userId)) return false;

  if (t.branches && t.branches.length > 0) {
    const branch = (context.branch ?? subject.branch ?? "").trim().toLowerCase();
    if (!branch || !t.branches.some((b) => b.trim().toLowerCase() === branch)) return false;
  }

  if (t.doctorPartyIds && t.doctorPartyIds.length > 0) {
    const doctorId = context.doctorPartyId ?? subject.partyId ?? null;
    if (!doctorId || !t.doctorPartyIds.includes(doctorId)) return false;
  }

  if (t.patientIds && t.patientIds.length > 0) {
    if (!context.patientId || !t.patientIds.includes(context.patientId)) return false;
  }

  if (t.orthoCaseIds && t.orthoCaseIds.length > 0) {
    if (!context.orthoCaseId || !t.orthoCaseIds.includes(context.orthoCaseId)) return false;
  }

  return true;
}

/**
 * الحسم النهائي لصلاحيات وحدة التقويم لمستخدم وسياق محدد.
 * - الافتراضي: منع (false).
 * - المالك: مسموح بالكامل ولا يمكن حجبه.
 * - المنع الصريح يتقدم دائمًا على السماح.
 * - الصلاحيات المؤقتة المنتهية لا تُطبَّق.
 * - إخفاء الوحدة (`module.visible = false`) يطفئ كل شيء داخلها.
 */
export function resolveOrthoAccess(
  policy: OrthoPrivacyPolicyDocument,
  subject: OrthoSubject,
  context: OrthoAccessContext = {},
  nowMs: number = Date.now(),
): ResolvedOrthoAccess {
  const empty: ResolvedOrthoAccess = {
    isOwner: false,
    moduleVisible: false,
    permissions: allMap(ORTHO_PERMISSIONS, false),
    sections: allMap(ORTHO_SECTIONS, false),
    fields: allMap(ORTHO_FIELDS, false),
    matchedRuleIds: [],
    expiredRuleIds: [],
  };

  if (!subject || !subject.isActive || !Number.isSafeInteger(subject.userId) || subject.userId <= 0 || !isRole(subject.role)) {
    return empty;
  }

  const isOwner = subject.isOwner === true
    || (policy.ownerUserId !== null && policy.ownerUserId === subject.userId);

  if (isOwner) {
    return {
      isOwner: true,
      moduleVisible: true,
      permissions: allMap(ORTHO_PERMISSIONS, true),
      sections: allMap(ORTHO_SECTIONS, true),
      fields: allMap(ORTHO_FIELDS, true),
      matchedRuleIds: [],
      expiredRuleIds: [],
    };
  }

  const base = policy.roleDefaults[subject.role];
  const allowPerm = allMap(ORTHO_PERMISSIONS, false);
  const denyPerm = allMap(ORTHO_PERMISSIONS, false);
  const allowSec = allMap(ORTHO_SECTIONS, false);
  const denySec = allMap(ORTHO_SECTIONS, false);
  const allowField = allMap(ORTHO_FIELDS, false);
  const denyField = allMap(ORTHO_FIELDS, false);

  for (const key of ORTHO_PERMISSIONS) {
    if (base?.permissions?.[key] === true && !OWNER_ONLY_ORTHO_PERMISSIONS.has(key)) {
      allowPerm[key] = true;
    }
  }
  for (const key of ORTHO_SECTIONS) {
    if (base?.sections?.[key] === true) allowSec[key] = true;
  }
  for (const key of ORTHO_FIELDS) {
    if (base?.fields?.[key] === true) allowField[key] = true;
  }

  const matchedRuleIds: string[] = [];
  const expiredRuleIds: string[] = [];

  for (const rule of policy.rules) {
    if (!ruleMatches(rule, subject, context)) continue;

    if (rule.expiresAt) {
      const expMs = Date.parse(rule.expiresAt);
      if (Number.isNaN(expMs) || nowMs >= expMs) {
        expiredRuleIds.push(rule.id);
        continue;
      }
    }

    matchedRuleIds.push(rule.id);
    if (rule.effect === "deny") {
      for (const p of rule.permissions ?? []) denyPerm[p] = true;
      for (const s of rule.sections ?? []) denySec[s] = true;
      for (const f of rule.fields ?? []) denyField[f] = true;
    } else {
      for (const p of rule.permissions ?? []) {
        if (!OWNER_ONLY_ORTHO_PERMISSIONS.has(p)) allowPerm[p] = true;
      }
      for (const s of rule.sections ?? []) allowSec[s] = true;
      for (const f of rule.fields ?? []) allowField[f] = true;
    }
  }

  // تفويض محدود للمديرين المعتمدين من المالك لإدارة القواعد غير الحساسة
  if (subject.role === "admin" && policy.delegatedManagerUserIds.includes(subject.userId) && !denyPerm["settings.manage"]) {
    allowPerm["settings.manage"] = true;
  }

  const permissions = allMap(ORTHO_PERMISSIONS, false);
  const sections = allMap(ORTHO_SECTIONS, false);
  const fields = allMap(ORTHO_FIELDS, false);

  for (const k of ORTHO_PERMISSIONS) {
    permissions[k] = allowPerm[k] && !denyPerm[k];
  }

  // إذا أُخفيت وحدة التقويم بالكامل، تُغلق جميع العمليات والأقسام والحقول فورًا
  if (!permissions["module.visible"]) {
    return {
      isOwner: false,
      moduleVisible: false,
      permissions: allMap(ORTHO_PERMISSIONS, false),
      sections: allMap(ORTHO_SECTIONS, false),
      fields: allMap(ORTHO_FIELDS, false),
      matchedRuleIds,
      expiredRuleIds,
    };
  }

  for (const k of ORTHO_SECTIONS) {
    sections[k] = allowSec[k] && !denySec[k];
  }
  for (const k of ORTHO_FIELDS) {
    fields[k] = allowField[k] && !denyField[k];
  }

  // حظر قطعي لدور الاستقبال (غير المالك) من عرض أو تحرير أو تنزيل صور التقويم أو مراجعها حتى لو وُجدت قاعدة سماح صريحة
  if (subject.role === "reception") {
    permissions["photos.view"] = false;
    permissions["photos.edit"] = false;
    permissions["photos.download"] = false;
    sections["media"] = false;
    sections["photo_analysis"] = false;
    fields["previousPhotos"] = false;
  }

  return {
    isOwner: false,
    moduleVisible: true,
    permissions,
    sections,
    fields,
    matchedRuleIds,
    expiredRuleIds,
  };
}

export function canManageOrthoPrivacy(policy: OrthoPrivacyPolicyDocument, actor: OrthoSubject): {
  allowed: boolean;
  isOwner: boolean;
  isDelegatedManager: boolean;
} {
  if (!actor.isActive) return { allowed: false, isOwner: false, isDelegatedManager: false };
  const isOwner = actor.isOwner === true || (policy.ownerUserId !== null && policy.ownerUserId === actor.userId);
  if (isOwner) return { allowed: true, isOwner: true, isDelegatedManager: false };
  const isDelegatedManager = actor.role === "admin" && policy.delegatedManagerUserIds.includes(actor.userId);
  return { allowed: isDelegatedManager, isOwner: false, isDelegatedManager };
}

/**
 * التحقق الصارم قبل حفظ أي تعديل على سياسة خصوصية التقويم:
 * - منع أي موظف غير مخول.
 * - حماية المالك وعدم السماح للمدير المفوض بتعديل ownerUserId أو delegatedManagerUserIds أو قواعد تمس المالك أو نفسه.
 * - منع رفع الصلاحيات الذاتي (self-escalation).
 * - فرض التحقق التفاؤلي على revision لمنع الكتابة المتداخلة.
 */
export function validateOrthoPolicyMutation(input: {
  actor: OrthoSubject;
  current: OrthoPrivacyPolicyDocument;
  next: OrthoPrivacyPolicyDocument;
  expectedRevision: number;
  reason?: string;
}): { ok: true; persisted: OrthoPrivacyPolicyDocument } | { ok: false; status: number; message: string } {
  const { actor, current, next, expectedRevision, reason } = input;
  const auth = canManageOrthoPrivacy(current, actor);
  if (!auth.allowed) {
    return { ok: false, status: 403, message: "إدارة خصوصية وصلاحيات وحدة التقويم محصورة بالمالك أو المدير المفوض." };
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
    return { ok: false, status: 409, message: "تم تحديث سياسة الصلاحيات من جلسة أخرى. حدّث الصفحة قبل الحفظ." };
  }
  if (!reason || reason.trim().length < 3) {
    return { ok: false, status: 400, message: "سبب تعديل الصلاحيات مطلوب للتوثيق في سجل التدقيق (3 أحرف على الأقل)." };
  }

  if (!auth.isOwner) {
    // المدير المفوض لا يستطيع تغيير المالك ولا قائمة المفوضين ولا صلاحيات المالك ولا رفع صلاحيات نفسه
    if (next.ownerUserId !== current.ownerUserId) {
      return { ok: false, status: 403, message: "تغيير هوية المالك محصور بالمالك وحده." };
    }
    const prevDel = [...current.delegatedManagerUserIds].sort((a, b) => a - b).join(",");
    const nextDel = [...next.delegatedManagerUserIds].sort((a, b) => a - b).join(",");
    if (prevDel !== nextDel) {
      return { ok: false, status: 403, message: "إدارة قائمة المديرين المفوضين محصورة بالمالك وحده." };
    }
    for (const rule of next.rules) {
      if (current.ownerUserId !== null && rule.target.userIds?.includes(current.ownerUserId)) {
        return { ok: false, status: 403, message: "لا يجوز إنشاء قواعد تستهدف حساب المالك." };
      }
      if (rule.target.userIds?.includes(actor.userId) && rule.effect === "allow") {
        return { ok: false, status: 403, message: "لا يجوز للموظف منح نفسه صلاحيات إضافية." };
      }
      if (rule.permissions?.some((p) => OWNER_ONLY_ORTHO_PERMISSIONS.has(p))) {
        return { ok: false, status: 403, message: "منح الصلاحيات الحساسة لإدارة الوحدة محصور بالمالك وحده." };
      }
    }
    if (JSON.stringify(next.roleDefaults.admin) !== JSON.stringify(current.roleDefaults.admin)) {
      return { ok: false, status: 403, message: "تعديل صلاحيات دور المدير محصور بالمالك وحده." };
    }
  }

  return {
    ok: true,
    persisted: {
      ...next,
      schemaVersion: ORTHO_PRIVACY_SCHEMA_VERSION,
      revision: current.revision + 1,
      ownerUserId: auth.isOwner ? (next.ownerUserId ?? current.ownerUserId ?? actor.userId) : current.ownerUserId,
    },
  };
}
