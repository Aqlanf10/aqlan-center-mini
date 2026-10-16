import { isValidTooth, MAX_SELECTED_TEETH } from "@/lib/dental";
import { LINKAGE_SPECIALTY_LABEL, lineLinkage, toothScope, validateLineSite } from "@/lib/invoice-clinical-linkage";
import type { InvoiceTemplatePreview, InvoiceTemplatePreviewLine, InvoiceTemplateSelection } from "@/lib/invoice-template";
import { MAX_TEMPLATES, type SpecialtyTemplate, type TemplateStep } from "@/lib/specialty-templates";
import { MAX_SESSION_COUNT } from "@/lib/workflow";
import { readInvoicePriceQuote, sameInvoicePriceQuote } from "@/lib/invoice-price-quote";
import type { InvoiceCatalogService } from "@/lib/invoice-catalog-price";
import type { Currency } from "@/lib/money";
import {
  INVOICE_TEMPLATE_SCHEDULED_ROW, readInvoiceSelectionPreview, type InvoicePreviewRequestRow,
} from "./invoice-selection-state";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value >= min && value <= max;
const id = (value: unknown): value is number => integer(value, 1, 2_147_483_647);
const safeKey = (value: string) => value !== "prototype" && !Object.hasOwn(Object.prototype, value);
const text = (value: unknown, max: number, empty = false): value is string => typeof value === "string"
  && value.length <= max && value === value.trim() && (empty || value.length > 0);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const allowedKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const teeth = (value: unknown): value is number[] => Array.isArray(value) && value.length <= MAX_SELECTED_TEETH
  && value.every((tooth) => integer(tooth, 11, 85) && isValidTooth(tooth)) && new Set(value).size === value.length;
const sameTeeth = (actual: unknown, expected: readonly number[] | null) => expected === null ? actual === null
  : Array.isArray(actual) && actual.length === expected.length && actual.every((tooth, index) => tooth === expected[index]);

/** Catalog evidence is decoded before rendering. Malformed settings never become default templates. */
export function readInvoiceTemplateCatalog(payload: unknown): SpecialtyTemplate[] | null {
  if (!object(payload) || !Array.isArray(payload.templates) || payload.templates.length === 0
    || payload.templates.length > MAX_TEMPLATES) return null;
  const result: SpecialtyTemplate[] = [];
  const ids = new Set<string>();
  for (const raw of payload.templates) {
    if (!object(raw) || !exactKeys(raw, ["id", "specialty", "name", "description", "steps"])
      || !text(raw.id, 40) || !/^[a-z0-9_-]+$/.test(raw.id) || !safeKey(raw.id) || ids.has(raw.id)
      || !text(raw.specialty, 80) || !text(raw.name, 80) || !text(raw.description, 300, true)
      || !Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > 20) return null;
    const steps: TemplateStep[] = [];
    const keys = new Set<string>();
    for (const step of raw.steps) {
      if (!object(step) || !exactKeys(step, ["key", "title", "category", "preferredService", "perTooth", "optional", "billingRule", "labWork", "sessions"])
        || !text(step.key, 40) || !safeKey(step.key) || keys.has(step.key) || !text(step.title, 80) || !text(step.category, 40)
        || !(step.preferredService === null || text(step.preferredService, 120))
        || typeof step.perTooth !== "boolean" || typeof step.optional !== "boolean" || typeof step.labWork !== "boolean"
        || (step.billingRule !== "on_start" && step.billingRule !== "on_completion" && step.billingRule !== "per_session")
        || !Array.isArray(step.sessions) || step.sessions.length === 0 || step.sessions.length > MAX_SESSION_COUNT) return null;
      const sessions: TemplateStep["sessions"] = [];
      for (const session of step.sessions) {
        if (!object(session) || !exactKeys(session, ["title", "minutes", "afterDays"]) || !text(session.title, 80)
          || !integer(session.minutes, 5, 480) || !integer(session.afterDays, 0, 365)) return null;
        sessions.push({ title: session.title, minutes: session.minutes, afterDays: session.afterDays });
      }
      keys.add(step.key);
      steps.push({ key: step.key, title: step.title, category: step.category, preferredService: step.preferredService,
        perTooth: step.perTooth, optional: step.optional, billingRule: step.billingRule, labWork: step.labWork, sessions });
    }
    if (steps.every((step) => step.optional)) return null;
    ids.add(raw.id);
    result.push({ id: raw.id, specialty: raw.specialty, name: raw.name, description: raw.description, steps });
  }
  return result;
}

export interface InvoiceTemplateCatalogService { id: number; name: string; category: string | null; invoiceQuotes?: InvoiceCatalogService["invoiceQuotes"] }
export type InvoiceTemplatePreviewRow = InvoicePreviewRequestRow;
export interface InvoiceTemplatePreviewContext {
  currency?: Currency;
  selection: InvoiceTemplateSelection;
  template: SpecialtyTemplate;
  catalogServices: readonly InvoiceTemplateCatalogService[];
}

/** Stable within the exact owner/request. Never include a receipt version in a request or row key. */
export function invoiceTemplateRowKey(stepKey: string, toothCode: number | null): string {
  return `template-row:${JSON.stringify([stepKey, toothCode])}`;
}

/**
 * A receipt is all-or-nothing: selected step/service/site/provider and named schedule must agree,
 * then the existing strict linkage decoder validates every manual and generated line together.
 * The caller must still bind the result to its exact preview owner and request key.
 */
export function readInvoiceTemplatePreview(
  payload: unknown, manualRows: readonly InvoicePreviewRequestRow[], existingPlanId: number | null,
  context: InvoiceTemplatePreviewContext,
) {
  if (!object(payload) || !object(payload.template) || !Array.isArray(payload.lines)
    || !Array.isArray(manualRows) || manualRows.length >= 40 || !(existingPlanId === null || id(existingPlanId))
    || !object(context) || !Array.isArray(context.catalogServices)) return null;
  const template = readInvoiceTemplateCatalog({ templates: [context.template] })?.[0];
  const selection = context.selection;
  if (!template || !object(selection) || !allowedKeys(selection, ["templateId", "version", "teeth", "steps", "doctorId", "sites"])
    || selection.templateId !== template.id || !teeth(selection.teeth) || !Array.isArray(selection.steps) || selection.steps.length > 20
    || !(selection.doctorId === null || id(selection.doctorId))
    || (selection.version !== undefined && (typeof selection.version !== "string" || !/^[a-f0-9]{64}$/.test(selection.version)))) return null;
  const response = payload.template;
  if (!exactKeys(response, ["templateId", "version", "lines"]) || response.templateId !== template.id
    || typeof response.version !== "string" || !/^[a-f0-9]{64}$/.test(response.version)
    || (selection.version !== undefined && selection.version !== response.version)
    || !Array.isArray(response.lines) || response.lines.length === 0 || response.lines.length + manualRows.length > 40) return null;

  const services = new Map<number, InvoiceTemplateCatalogService>();
  for (const service of context.catalogServices) {
    if (!object(service) || !id(service.id) || typeof service.name !== "string" || !service.name.trim()
      || !(service.category === null || typeof service.category === "string") || services.has(service.id)) return null;
    const invoiceQuotes: InvoiceTemplateCatalogService["invoiceQuotes"] = {};
    if (service.invoiceQuotes !== undefined) {
      if (!object(service.invoiceQuotes)) return null;
      for (const currency of ["YER","SAR","USD"] as const) {
        if (service.invoiceQuotes[currency] === undefined) continue;
        const quote = readInvoicePriceQuote(service.invoiceQuotes[currency],currency);
        if (!quote) return null;
        invoiceQuotes[currency] = quote;
      }
    }
    services.set(service.id, { id: service.id, name: service.name, category: service.category, invoiceQuotes });
  }
  const choices = new Map<string, InvoiceTemplateSelection["steps"][number]>();
  for (const choice of selection.steps) {
    if (!object(choice) || !exactKeys(choice, ["key", "include", "serviceId"]) || !text(choice.key, 40)
      || choices.has(choice.key) || typeof choice.include !== "boolean" || !(choice.serviceId === null || id(choice.serviceId))) return null;
    const step = template.steps.find((one) => one.key === choice.key);
    if (!step || (!step.optional && !choice.include)) return null;
    choices.set(choice.key, choice);
  }
  const sites = new Map<string, NonNullable<InvoiceTemplateSelection["sites"]>[number]>();
  if (selection.sites !== undefined && (!Array.isArray(selection.sites) || selection.sites.length > 40)) return null;
  for (const site of selection.sites ?? []) {
    if (!object(site) || !allowedKeys(site, ["stepKey", "toothCode", "scope", "episodeTeeth", "surfaces", "caseId"])
      || !text(site.stepKey, 40) || !(site.toothCode === null || integer(site.toothCode, 11, 85) && isValidTooth(site.toothCode))
      || !(site.scope === undefined || site.scope === null || text(site.scope, 20))
      || !(site.surfaces === undefined || site.surfaces === null || text(site.surfaces, 20, true))
      || !(site.episodeTeeth === undefined || site.episodeTeeth === null || teeth(site.episodeTeeth))
      || !(site.caseId === undefined || site.caseId === null || id(site.caseId))) return null;
    const key = invoiceTemplateRowKey(site.stepKey, site.toothCode);
    if (sites.has(key)) return null;
    sites.set(key, site);
  }
  const rows: InvoiceTemplatePreviewRow[] = [];
  const rowKeys = new Set<string>();
  for (const row of manualRows) {
    if (!object(row) || typeof row.key !== "string" || !row.key || typeof row.clinical !== "boolean"
      || row.expectedScheduled !== undefined || rowKeys.has(row.key)
      || !(row.planItemId === undefined || row.planItemId === null || id(row.planItemId))) return null;
    rowKeys.add(row.key);
    rows.push({ key: row.key, clinical: row.clinical, ...(row.planItemId === undefined ? {} : { planItemId: row.planItemId }) });
  }
  const selectedTeeth = [...selection.teeth].sort((a, b) => a - b);
  const lines: InvoiceTemplatePreviewLine[] = [];
  const priceByService = new Map<number, number>();
  let totalMinor = 0;
  for (const step of template.steps) {
    const choice = choices.get(step.key);
    if (step.optional && choice?.include !== true) continue;
    // The UI makes its displayed choice explicit; a server-side default is not evidence of that choice.
    if (!choice || !id(choice.serviceId)) return null;
    const service = services.get(choice.serviceId);
    if (!service || service.category !== step.category || (step.perTooth && selectedTeeth.length === 0)) return null;
    const linkage = lineLinkage({ serviceId: service.id, category: service.category });
    for (const toothCode of step.perTooth ? selectedTeeth : [null]) {
      const key = invoiceTemplateRowKey(step.key, toothCode);
      const requestedSite = sites.get(key);
      sites.delete(key);
      const episode = requestedSite?.episodeTeeth ?? null;
      if (toothScope(service.category) === "multi_tooth_episode" && (!episode || episode.length === 0)) return null;
      const expectedSite = validateLineSite({ category: service.category, toothCode,
        scope: requestedSite?.scope ?? null, surfaces: requestedSite?.surfaces ?? null, episodeTeeth: episode });
      const caseId = requestedSite?.caseId ?? null;
      if (!expectedSite.ok || (caseId !== null && (linkage.kind === "financial" || !linkage.needsCase)) || rowKeys.has(key)) return null;
      const raw = response.lines[lines.length];
      const lineIndex = manualRows.length + lines.length;
      if (!object(raw) || !exactKeys(raw, [...(Object.hasOwn(raw,"priceQuote")?["priceQuote"]:[]), "line", "stepKey", "serviceId", "description", "quantity", "unitPriceMinor",
        "toothCode", "scope", "episodeTeeth", "surfaces", "caseId", "doctorId", "sessions", "sessionPlan"])
        || raw.line !== lineIndex || raw.stepKey !== step.key || raw.serviceId !== service.id || raw.description !== service.name
        || raw.quantity !== 1 || !integer(raw.unitPriceMinor, 1, Number.MAX_SAFE_INTEGER)
        || raw.toothCode !== expectedSite.site.toothCode || raw.scope !== expectedSite.site.scope
        || raw.surfaces !== expectedSite.site.surfaces || !sameTeeth(raw.episodeTeeth, expectedSite.site.episodeTeeth)
        || raw.caseId !== caseId || raw.doctorId !== selection.doctorId || raw.sessions !== step.sessions.length
        || !Array.isArray(raw.sessionPlan) || raw.sessionPlan.length !== step.sessions.length) return null;
      if (priceByService.has(service.id) && priceByService.get(service.id) !== raw.unitPriceMinor) return null;
      priceByService.set(service.id, raw.unitPriceMinor);
      totalMinor += raw.unitPriceMinor;
      const quote = service.invoiceQuotes?.[context.currency??"YER"];
      if ((quote || raw.priceQuote !== undefined) && (!quote || !sameInvoicePriceQuote(raw.priceQuote, quote) || quote.minor !== raw.unitPriceMinor)) return null;
      if (!Number.isSafeInteger(totalMinor)) return null;
      const sessionPlan: InvoiceTemplatePreviewLine["sessionPlan"] = [];
      for (const [index, scheduled] of raw.sessionPlan.entries()) {
        const expected = step.sessions[index];
        const visitTitle = `${expected.title}${step.perTooth ? ` — سن ${selectedTeeth.join("، ")}` : ""}`.slice(0, 200);
        if (!object(scheduled) || !exactKeys(scheduled, ["title", "minutes", "afterDays", "visitKey", "visitTitle"])
          || scheduled.title !== expected.title || scheduled.minutes !== expected.minutes || scheduled.afterDays !== expected.afterDays
          || scheduled.visitKey !== `${step.key}:${index}` || scheduled.visitTitle !== visitTitle) return null;
        sessionPlan.push({ title: expected.title, minutes: expected.minutes, afterDays: expected.afterDays,
          visitKey: `${step.key}:${index}`, visitTitle });
      }
      const evidence = payload.lines[lineIndex];
      if (!object(evidence) || evidence.line !== lineIndex || evidence.scheduled !== true
        || evidence.kind !== linkage.kind || !object(evidence.item) || evidence.item.mode !== "new" || evidence.item.id !== null
        || evidence.specialty !== (linkage.kind === "clinical" ? linkage.specialty : null)
        || evidence.specialtyLabel !== (linkage.kind === "clinical" ? LINKAGE_SPECIALTY_LABEL[linkage.specialty] : null)) return null;
      if (evidence.refusal === null && evidence.refusalMessage === null
        && (!Array.isArray(evidence.itemCandidates) || evidence.itemCandidates.length !== 0
          || evidence.financialReviewRequired !== (selection.doctorId === null))) return null;
      if (object(evidence.case) && Array.isArray(evidence.case.options)) {
        const optionIds = new Set<number>();
        for (const option of evidence.case.options) {
          if (!object(option) || !id(option.id) || optionIds.has(option.id)) return null;
          optionIds.add(option.id);
        }
      }
      if (linkage.kind === "clinical" && evidence.refusal === null && evidence.refusalMessage === null) {
        if (!object(evidence.case) || (caseId !== null && (evidence.case.mode !== "existing" || evidence.case.id !== caseId))
          || (linkage.needsCase ? evidence.case.mode === "none" : evidence.case.mode !== "none"
            || evidence.case.title !== null || !Array.isArray(evidence.case.options) || evidence.case.options.length !== 0)) return null;
      }
      rowKeys.add(key);
      rows.push({ key, clinical: linkage.kind === "clinical", expectedScheduled: INVOICE_TEMPLATE_SCHEDULED_ROW });
      lines.push({ line: lineIndex, stepKey: step.key, serviceId: service.id, description: service.name, quantity: 1,
        ...(quote ? {priceQuote:quote} : {}),
        unitPriceMinor: raw.unitPriceMinor, toothCode: expectedSite.site.toothCode, scope: expectedSite.site.scope,
        episodeTeeth: expectedSite.site.episodeTeeth === null ? null : [...expectedSite.site.episodeTeeth],
        surfaces: expectedSite.site.surfaces, caseId, doctorId: selection.doctorId, sessions: step.sessions.length, sessionPlan });
    }
  }
  if (sites.size !== 0 || lines.length !== response.lines.length || rows.length !== payload.lines.length
    || payload.lines.some((line, index) => !object(line) || line.line !== index)) return null;
  const decoded = readInvoiceSelectionPreview(payload, rows, existingPlanId);
  if (!decoded) return null;
  const accepted: InvoiceTemplatePreview = { templateId: template.id, version: response.version, lines };
  return { ...decoded, template: accepted, rows };
}
