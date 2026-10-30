import { createHash } from "node:crypto";
import { parseLoginPhotoAsset } from "../login-photo";
import { validateLoginPhotoBytes } from "../login-photo-server";
import type { ValidatedDocument } from "./validate";

/**
 * Called inside isolated SQL replay, before commit/cutover. The settings row is
 * the authority, not a caller-supplied filename or a loosely related manifest
 * entry. Missing legacy settings are compatible; nonblank invalid values fail.
 */
export function loginPhotoRestoreProblem(
  raw: string,
  documents: readonly ValidatedDocument[],
): string | null {
  if (!raw.trim()) return null;
  const asset = parseLoginPhotoAsset(raw);
  if (!asset) return "بيانات صورة الدخول المستعادة غير صالحة؛ الاستعادة مرفوضة.";
  const matches = documents.filter(document => document.relativePath === asset.key);
  if (matches.length !== 1) return "صورة الدخول المحددة غير موجودة مرة واحدة في الأرشيف؛ الاستعادة مرفوضة.";
  const document = matches[0];
  const bytes = Buffer.from(document.bytes);
  if (document.manifest.storageKey !== asset.key
    || document.manifest.sha256 !== asset.sha256
    || document.manifest.sizeBytes !== asset.sizeBytes
    || document.sha256 !== asset.sha256
    || bytes.length !== asset.sizeBytes
    || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    return "صورة الدخول لا تطابق بياناتها المستعادة أو مفتاح الأرشيف؛ الاستعادة مرفوضة.";
  }
  const actual = validateLoginPhotoBytes(bytes, asset.mimeType);
  if (!actual || actual.key !== asset.key
    || actual.width !== asset.width || actual.height !== asset.height) {
    return "محتوى صورة الدخول أو أبعادها لا يطابق البيانات المستعادة؛ الاستعادة مرفوضة.";
  }
  return null;
}
