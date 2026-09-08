/**
 * أنماط وأنواع نظام أدوات الذكاء الاصطناعي الداخلي لمركز د. عقلان
 * (Aqlan Center AI Tool Layer - Types & Specifications)
 */

import type { Role } from "../roles";
import type { DoctorPermissions } from "../doctor-permissions";
import type { Currency } from "../money";

export interface AiToolContext {
  userId?: number;
  username?: string;
  userName?: string;
  role?: Role;
  userRole?: Role;
  doctorPartyId?: number | null;
  permissions?: Partial<DoctorPermissions> | null;
  canViewAllPatients?: boolean;
  canViewClinicFinance?: boolean;
  canViewOwnCommissions?: boolean;
  canManageInventory?: boolean;
  todayISO?: string;
  isDbConnected: boolean;
  conversationPatientId?: number | null;
  currentPatientId?: number | string | null;
  currentPatientName?: string | null;
  clinicName?: string;
  /**
   * تنفيذ موثّق عبر رمز تأكيد **خام موقّع** (raw signed token) — لا حمولة محلولة.
   *
   * الحاجز الأمني (دفاع في العمق): المنفّذ المركزي `executeAiTool` لا يثق بأي
   * object يستطيع caller داخلي بناؤه؛ يتحقق هو نفسه من التوقيع والعمر والمستخدم
   * والأداة قبل أي استهلاك أو تنفيذ. لا طريق لتمرير حمولةٍ غير موقعة.
   */
  confirmationToken?: string;
  /** (داخلي) عرض تأكيدٍ معلّق أنتجته أداة تغيير حالة — يلتقطه المحرك للعرض على المستخدم. */
  pendingConfirmation?: ToolConfirmationOffer;
}

/** حقلٌ واحد في معاينة التأكيد — القيم الحساسة (كمبلغٍ أو جرعة) تُبرَز للمستخدم قبل التنفيذ. */
export interface ToolConfirmationField {
  label: string;
  value: string;
  sensitive?: boolean;
}

/** عرض تأكيدٍ لأداة تغيّر الحالة: ماذا سيفعل، على من، وبأي قيم — قبل أي كتابة. */
export interface ToolConfirmationOffer {
  token: string;
  tool: string;
  title: string;
  description: string;
  patientLabel?: string | null;
  fields: ToolConfirmationField[];
  expiresAt: number;
}

/** حمولة رمز التأكيد الموقّع — تُنفّذ مرة واحدة وتُربط بمستخدمٍ وأداة ومعاملاتٍ ومريضٍ بعينهم. */
export interface ToolConfirmationPayload {
  v: 1;
  jti: string;
  userId: number;
  username: string;
  tool: string;
  params: Record<string, unknown>;
  patientId?: number | null;
  iat: number;
  exp: number;
}

export interface KpiCard {
  title: string;
  value: string;
  badge?: string;
  tone?: "good" | "warn" | "bad" | "info" | "calm";
  hint?: string;
}

export interface StructuredTable {
  headers: string[];
  rows: (string | number | null)[][];
  caption?: string;
}

export interface ActionButton {
  label: string;
  href?: string;
  actionType: "navigate" | "copy" | "print" | "filter" | "whatsapp";
  payload?: any;
}

export interface ToolExecutionResult {
  success: boolean;
  textSummary: string;
  message?: string;
  cards?: KpiCard[];
  table?: StructuredTable | null;
  actions?: ActionButton[];
  warnings?: string[];
  meta?: Record<string, any>;
  patientIdAccessed?: number;
  data?: any;
  /** عرض تأكيدٍ معلّق: الأداة تغيّر حالة ولم تُنفّذ بعد — ينتظر موافقة المستخدم الصريحة. */
  confirmation?: ToolConfirmationOffer;
  /** true حين يكون غيابُ النتيجة سببُه انتظار التأكيد لا فشل الإجراء. */
  requiresConfirmation?: boolean;
}

export interface AiToolDefinition {
  name: string;
  description: string;
  category: "patient" | "appointment" | "ortho" | "finance" | "inventory" | "lab" | "management" | "system";
  requiredPermission?: keyof DoctorPermissions | "admin_only" | "finance_only" | "inventory_only";
  execute(params: Record<string, any>, context: AiToolContext): Promise<ToolExecutionResult>;
}

export interface StructuredAiResponse {
  answer: string;
  intent: string;
  toolsUsed: string[];
  cards?: KpiCard[];
  table?: StructuredTable | null;
  actions?: ActionButton[];
  warnings?: string[];
  sourceType: "live_database" | "internal_engine" | "external_ai";
  model: string;
  latencyMs: number;
  generatedAt: string;
  /** تأكيدٌ معلّق لأداة تغيير حالة — تعرضه الواجهة بأزرار «تأكيد التنفيذ / إلغاء». */
  confirmation?: ToolConfirmationOffer;
}

export interface AssistantMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

