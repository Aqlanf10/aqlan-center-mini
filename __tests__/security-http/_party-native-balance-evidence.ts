import { createHash } from "node:crypto";

export const PARTY_NATIVE_BALANCE_EVIDENCE_FILES = [
  "party-native-balances-desktop-1280.png",
  "party-native-balances-mobile-390.png",
] as const;

export interface PartyNativeBalanceEvidenceMember {
  filename: typeof PARTY_NATIVE_BALANCE_EVIDENCE_FILES[number];
  mime: "image/png";
  bytes: Buffer;
}

const PREFIX = "SYNTHETIC_PARTY_NATIVE_BALANCE_EVIDENCE_V1";
const CHUNK_CHARACTERS = 4096;
const MAX_MEMBER_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** Only exact PNG buffers returned by the built-page synthetic paired witness.
 * Call after both viewports, isolation/no-write checks and context teardown pass.
 * These ready-state images do not picture loading/unavailable states, or prove
 * the remainder of the security suite or CI passed. No filesystem or network IO.
 * Validate and prepare both members before writing the first log frame.
 */
export function emitPartyNativeBalanceEvidence(members: readonly PartyNativeBalanceEvidenceMember[]): void {
  if (!Array.isArray(members) || members.length !== PARTY_NATIVE_BALANCE_EVIDENCE_FILES.length) {
    throw new Error("Party native balance evidence requires exactly two allowlisted PNGs");
  }
  const byName = new Map<string, PartyNativeBalanceEvidenceMember>();
  let totalBytes = 0;
  for (const member of members) {
    if (!member || !PARTY_NATIVE_BALANCE_EVIDENCE_FILES.some(name => name === member.filename)
      || byName.has(member.filename)) {
      throw new Error("Party native balance evidence has an unknown or duplicate filename");
    }
    if (member.mime !== "image/png" || !Buffer.isBuffer(member.bytes) || member.bytes.length === 0
      || member.bytes.length > MAX_MEMBER_BYTES
      || member.bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("Party native balance evidence MIME, size or PNG signature rejected");
    }
    totalBytes += member.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("Party native balance evidence exceeds the 2 MiB aggregate limit");
    }
    byName.set(member.filename, member);
  }
  // Read only these two bounded provenance fields, never arbitrary environment text.
  const candidateRunId = process.env.GITHUB_RUN_ID ?? "";
  const candidateCheckoutSha = process.env.GITHUB_SHA ?? "";
  const runId = candidateRunId.length >= 1 && candidateRunId.length <= 24 && !/[^0-9]/.test(candidateRunId)
    ? candidateRunId : "unavailable";
  const checkoutSha = [40, 64].includes(candidateCheckoutSha.length) && !/[^a-f0-9]/.test(candidateCheckoutSha)
    ? candidateCheckoutSha : "unavailable";
  const prepared = PARTY_NATIVE_BALANCE_EVIDENCE_FILES.map((file, index) => {
    const member = byName.get(file);
    if (!member) throw new Error("Party native balance evidence is missing an allowlisted PNG");
    const base64 = member.bytes.toString("base64");
    return { base64, metadata: {
      scope: "party-native-balances", file, mime: member.mime, bytes: member.bytes.length,
      sha256: createHash("sha256").update(member.bytes).digest("hex"),
      chunks: Math.ceil(base64.length / CHUNK_CHARACTERS), runId, checkoutSha, synthetic: true,
      scene: "ready-native-badges", viewportWidth: index === 0 ? 1280 : 390,
      assertionScope: "paired-browser-witness-only",
    } };
  });
  for (const { base64, metadata } of prepared) {
    const identity = JSON.stringify(metadata);
    console.log(`${PREFIX} BEGIN ${identity}`);
    for (let index = 0; index < metadata.chunks; index++) {
      console.log(`${PREFIX} CHUNK ${metadata.file} ${index + 1}/${metadata.chunks} ${base64.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS)}`);
    }
    console.log(`${PREFIX} END ${identity}`);
  }
}
