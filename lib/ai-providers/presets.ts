/**
 * القوالب الجاهزة لمزودي الذكاء الاصطناعي (AI Provider Presets)
 *
 * تتيح للمدير إضافة أي مزود مشهور بضغطة زر مع ملء العنوان الافتراضي ونوع البروتوكول
 * وقائمة النماذج المقترحة تلقائياً.
 */

import type { AiProtocolType } from "./types";

export interface AiProviderPreset {
  id: string;
  name: string;
  protocolType: AiProtocolType;
  baseUrl: string;
  defaultModel: string;
  suggestedModels: string[];
  description: string;
  hintKey: string;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    protocolType: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    suggestedModels: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"],
    description: "محرك OpenAI الرائد عالمياً (GPT-4o و GPT-4o-mini)",
    hintKey: "sk-...",
  },
  {
    id: "zai",
    name: "Z.ai / GLM",
    protocolType: "openai-compatible",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-4.6",
    suggestedModels: ["glm-4.6", "glm-4", "glm-4-flash"],
    description: "مزود Z.ai ونماذج GLM المتميزة",
    hintKey: "API Key الخاص بـ Z.ai",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocolType: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
    description: "محرك ديب سيك فائق السرعة والاقتصادية",
    hintKey: "sk-...",
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    protocolType: "anthropic-compatible",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-3-5-sonnet-20241022",
    suggestedModels: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
    description: "نماذج Claude 3.5 Sonnet و Haiku الرائدة في الفهم السريري والتحليل",
    hintKey: "sk-ant-...",
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    protocolType: "google-gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-flash-latest",
    suggestedModels: ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.6-flash"],
    description: "محرك جوجل السحابي فائق السرعة (Gemini Flash & Pro)",
    hintKey: "AIzaSy...",
  },
  {
    id: "groq",
    name: "Groq (Llama / Mixtral)",
    protocolType: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    suggestedModels: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768", "llama-3.1-8b-instant"],
    description: "استدلال فائق السرعة مع شرائح LPU المخصصة",
    hintKey: "gsk_...",
  },
  {
    id: "ollama",
    name: "Ollama (محلي / Local)",
    protocolType: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.2",
    suggestedModels: ["llama3.2", "qwen2.5", "mistral"],
    description: "تشغيل محلي بالكامل دون اتصال بالإنترنت على سيرفر المركز",
    hintKey: "اختياري للتشغيل المحلي (ollama)",
  },
  {
    id: "custom",
    name: "مزود مخصص (OpenAI Compatible)",
    protocolType: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    defaultModel: "default-model",
    suggestedModels: [],
    description: "أي خادم أو بوابة تدعم بروتوكول OpenAI Chat Completions",
    hintKey: "Bearer Token أو API Key",
  },
];
