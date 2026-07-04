import { createHash } from "node:crypto";
import type { PageRow } from "../db/page-store.js";
import type { TextRow } from "../db/text-store.js";
import { COMPRESSION_ENABLED } from "./memory-config.js";

/** Normalized gen_package fingerprint — same content must always produce the same stamp. */
export function computeTextContentStamp(text: TextRow | null): string | null {
  if (!text?.genPackage?.trim()) return null;
  const normalized = text.genPackage.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/** True when the canonical text needs (re)compression — always false when compression is disabled. */
export function postNeedsCompress(page: PageRow, text: TextRow | null): boolean {
  if (!COMPRESSION_ENABLED) return false;
  if (!text?.genPackage?.trim()) return false;
  const stamp = computeTextContentStamp(text);
  if (!stamp) return false;
  if (text.genExtract === null) return true;
  if (text.broken) return true;
  if (page.memoryContentStamp !== stamp) return true;
  return false;
}
