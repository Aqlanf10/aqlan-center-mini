import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { CephTracer } from "../../components/CephTracer";
import { normalizeCephDiagnosis, sameCephCalibrationState } from "../../lib/ceph-completion-snapshot";
import sourceFixture from "./ceph-source-fixture.json";
import { CEPH_ENGINE_VERSION, CEPH_ENGINE_SOURCE_SHA256 } from "../../lib/ceph-engine-identity";
import type { CephCompletionSources } from "../../lib/ceph-source-review";
import { REQUIRED_LANDMARKS } from "../../lib/ceph";

const query = new URLSearchParams(location.search);
type Landmark = { code: string; x: number; y: number; source: "manual" | "suggested" };
const storageKey = "synthetic-ceph-fixture";
const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null") || {
  landmarks: query.has("review") ? REQUIRED_LANDMARKS.map((code, i) => ({ code, x: code === "S" ? 300 : 650 + i * 10, y: code === "S" ? 250 : 400 + i * 5, source: code === "S" && !query.has("manual") ? "suggested" : "manual" })) : query.has("guides") ? [{ code: "S", x: 250, y: 200, source: "manual" }, { code: "N", x: 450, y: 200, source: "manual" }] : [],
  diagnosis: null,
  calibration: query.has("review") ? { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 } : null, mmPerPixel: query.has("review") ? 0.1 : null,
};
const writes: any[] = [];
const completionSources: CephCompletionSources = {state:"available",identity:{schemaVersion:1,documentId:990003,
  imageSha256:sourceFixture.imageSha256,referenceSetKey:sourceFixture.referenceSet.key,referenceSetSha256:sourceFixture.referenceSetSha256,
  engineVersion:CEPH_ENGINE_VERSION,engineSourceSha256:CEPH_ENGINE_SOURCE_SHA256},referenceSet:sourceFixture.referenceSet};
const api = { completionSources, completions: [] as unknown[], writes, hydratedAfterLoad: false, offline: false, saved, unexpected: [] as string[] };
(window as any).__ceph = api;
window.fetch = async (input, init) => {
  if (String(input) === "/api/ceph/990001/complete" && init?.method === "POST") {
    api.completions.push(JSON.parse(String(init.body)));
    // Deliberately no fake clinical success. Exercise the real client conflict
    // path while a newer server source identity must never replace the review.
    return new Response(JSON.stringify({message:"Synthetic source changed; reopen review",completionSources:{
      ...completionSources,identity:{...completionSources.identity,imageSha256:"f".repeat(64)}}}),{status:409,headers:{"Content-Type":"application/json"}});
  }
  if (String(input) !== "/api/ceph/990001" || init?.method !== "PATCH") {
    api.unexpected.push(String(input)); throw new Error("Unexpected fixture request " + input);
  }
  const edit = JSON.parse(String(init.body)); writes.push(edit);
  if (api.offline) throw new TypeError("Synthetic offline");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (edit.expectedLandmarks) {
    const touched = new Set([...(edit.landmarks || []).map((p: Landmark) => p.code), ...(edit.removeLandmarks || [])]);
    const actual = saved.landmarks.filter((p: Landmark) => touched.has(p.code));
    const normalize = (points: Landmark[]) => JSON.stringify([...points].sort((a,b)=>a.code.localeCompare(b.code)));
    if (normalize(actual) !== normalize(edit.expectedLandmarks)) return json({ message: "Synthetic edit conflict" }, 409);
  }
  if (edit.calibration) {
    const { x1, y1, x2, y2, mm } = edit.calibration;
    const current = { calibration: saved.calibration, mmPerPixel: saved.mmPerPixel };
    const desired = { calibration: edit.calibration, mmPerPixel: mm / Math.hypot(x2-x1,y2-y1) };
    if (!sameCephCalibrationState(current, desired) && !sameCephCalibrationState(current, edit.expectedCalibration))
      return json({ message: "Synthetic calibration conflict" }, 409);
  }
  if (edit.diagnosis) {
    const desired = normalizeCephDiagnosis(edit.diagnosis), current = saved.diagnosis ?? null;
    if (!("expectedDiagnosis" in edit) || (JSON.stringify(current) !== JSON.stringify(desired)
      && JSON.stringify(current) !== JSON.stringify(edit.expectedDiagnosis))) return json({ message: "Synthetic diagnosis conflict" }, 409);
    saved.diagnosis = desired;
  }
  saved.landmarks = saved.landmarks.filter((p: Landmark) => !(edit.removeLandmarks || []).includes(p.code));
  for (const point of edit.landmarks || []) {
    saved.landmarks = saved.landmarks.filter((p: Landmark) => p.code !== point.code); saved.landmarks.push(point);
  }
  if (edit.calibration) {
    saved.calibration = edit.calibration;
    const { x1, y1, x2, y2, mm } = edit.calibration;
    saved.mmPerPixel = mm / Math.hypot(x2-x1,y2-y1);
  }
  sessionStorage.setItem(storageKey, JSON.stringify(saved));
  return json({ ok: true, mmPerPixel: saved.mmPerPixel, calibration: saved.calibration, ...(edit.diagnosis ? { diagnosis: saved.diagnosis } : {}) });
};
const tree = <CephTracer readOnly={query.has("readonly")} patientName="Synthetic geometry only" patientBirthYear={1990}
  analysis={{ id: 990001, patientId: 990002, documentId: 990003, status: "draft", orthoCaseId: null,
    phase: "pretreatment", xrayDate: null, device: null, refSet: "builtin_default", calibration: saved.calibration,
    mmPerPixel: saved.mmPerPixel, note: null, createdBy: "Synthetic", createdAt: "2026-11-05T00:00:00Z", completedBy: null, completedAt: null, findings: null }}
  initialLandmarks={saved.landmarks}
  completionSources={completionSources}
  stamped={null} refValues={null} refSetName={null} diagnosis={saved.diagnosis ? { ...saved.diagnosis, createdBy: "Synthetic", updatedAt: "2026-11-05T00:00:00Z" } : null} />;
async function main() {
  const root = document.getElementById("root")!;
  if (query.has("hydrate")) {
    root.innerHTML = renderToString(tree);
    await Promise.all(Array.from(root.querySelectorAll("img")).map(img => img.decode()));
    (window as any).__ceph.hydratedAfterLoad = true;
    hydrateRoot(root, tree);
  } else createRoot(root).render(tree);
}
void main();
