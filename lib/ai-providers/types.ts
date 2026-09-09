/**
 * أنواع وبيانات سجل مزودي الذكاء الاصطناعي الديناميكي
 * Dynamic AI Provider Registry Types
 */

import type { AiChatMessage, AiChatResult, AiTestOutcome } from "../ai";

export type AiProtocolType =
  | "openai-compatible"
  | "openai-responses"
  | "anthropic-compatible"
  | "google-gemini"
  | "custom-http";

export const AI_PROTOCOL_LABELS: Record<AiProtocolType, string> = {
  "openai-compatible": "واجهة متوافقة مع OpenAI (OpenAI, GLM, DeepSeek, Groq, Ollama)",
  "openai-responses": "واجهة OpenAI الحديثة (OpenAI Responses)",
  "anthropic-compatible": "بروتوكول أنثروبيك (Anthropic Messages API)",
  "google-gemini": "بروتوكول جوجل جيميني (Google Gemini API)",
  "custom-http": "واجهة HTTP مخصصة (Custom JSON HTTP API)",
};

export interface AiTaskModels {
  chat?: string;
  clinical?: string;
  reports?: string;
  reasoning?: string;
  vision?: string;
  ocr?: string;
  embeddings?: string;
}

export interface AiProviderConfig {
  id: string;
  name: string;
  protocolType: AiProtocolType;
  baseUrl: string;
  apiEndpoint?: string | null;
  model: string;
  models: string[];
  apiKeyEnc: string | null;
  organizationId?: string | null;
  customHeaders?: Record<string, string> | null;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  enabled: boolean;
  isDefault: boolean;
  priority: number;
  taskModels?: AiTaskModels | null;
  lastTestAt?: Date | null;
  lastTestOk?: boolean | null;
  lastTestMessage?: string | null;
  lastTestLatency?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
  updatedBy?: string | null;
}

/**
 * العرض الآمن للمزود — يُرسل للواجهة والعملاء دون كشف المفتاح المشفر مطلقاً
 */
export interface AiProviderView {
  id: string;
  name: string;
  protocolType: AiProtocolType;
  baseUrl: string;
  apiEndpoint: string | null;
  model: string;
  models: string[];
  hasKey: boolean;
  keyMasked: string;
  organizationId: string | null;
  customHeaders: Record<string, string> | null;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  enabled: boolean;
  isDefault: boolean;
  priority: number;
  taskModels: AiTaskModels | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  lastTestLatency: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface AiProviderInput {
  id: string;
  name: string;
  protocolType: AiProtocolType;
  baseUrl: string;
  apiEndpoint?: string | null;
  model: string;
  models?: string[];
  apiKey?: string | undefined;
  organizationId?: string | null;
  customHeaders?: Record<string, string> | null;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  enabled?: boolean;
  isDefault?: boolean;
  priority?: number;
  taskModels?: AiTaskModels | null;
}

export interface AIProviderAdapter {
  protocol: AiProtocolType;
  chat(
    options: {
      messages: AiChatMessage[];
      maxTokens?: number;
      temperature?: number;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
    config: AiProviderConfig,
  ): Promise<AiChatResult>;
  testConnection(
    config: AiProviderConfig,
    fetchImpl?: typeof fetch,
  ): Promise<AiTestOutcome>;
}

export interface FallbackChatResult extends AiChatResult {
  providerId: string;
  providerName: string;
  fallbackChainUsed?: string[];
}
