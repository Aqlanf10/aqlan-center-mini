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
}

export interface AssistantMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

