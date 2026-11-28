export const ASSISTANT_MODE_KEYS = ["ai.internal_assistant", "ai.external_assistant"] as const;

export function assistantModes(settings: Record<string, unknown>) {
  // Default for existing installations. Invalid saved values must not enable a mode.
  const enabled = (key: string) => settings[key] === undefined || settings[key] === "true";
  return { internal: enabled(ASSISTANT_MODE_KEYS[0]), external: enabled(ASSISTANT_MODE_KEYS[1]) };
}

function normalize(text: string) {
  return text.normalize("NFKC").trim().toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "").replace(/[أإآ]/g, "ا")
    .replace(/[.!؟?،]+$/g, "").replace(/\s+/g, " ").trim();
}

export function greetingReply(text: string): string | null {
  const normalized = normalize(text);
  if (/^(?:(?:و)?السلام عليكم(?: ورحمة الله(?: وبركاته)?)?)$/.test(normalized)) {
    return "وعليكم السلام ورحمة الله، كيف أقدر أساعدك؟";
  }
  if (/^(?:مرحبا|اهلا|هلا|صباح الخير|مساء الخير|hello|hi)$/.test(normalized)) {
    return "أهلًا بك، كيف أقدر أساعدك؟";
  }
  return null;
}

export const EXTERNAL_ADMIN_TEMPLATES = [
  "اكتب رسالة شكر قصيرة لفريق العمل",
  "اكتب تذكيرًا عامًا بموعد",
  "اكتب إعلانًا عامًا عن إجازة المركز",
] as const;

// When local tools are disabled, the server never sends user-supplied free text.
export function externalOnlyTemplate(message: string): string | undefined {
  const normalized = normalize(message);
  return EXTERNAL_ADMIN_TEMPLATES.find(template => normalize(template) === normalized);
}
