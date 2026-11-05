import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { CephTracer } from "../../components/CephTracer";

const query = new URLSearchParams(location.search);
type Landmark = { code: string; x: number; y: number; source: "manual" | "suggested" };
const storageKey = "synthetic-ceph-fixture";
const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null") || {
  landmarks: query.has("guides") ? [{ code: "S", x: 250, y: 200, source: "manual" }, { code: "N", x: 450, y: 200, source: "manual" }] : [],
  calibration: null, mmPerPixel: null,
};
const writes: any[] = [];
const api = { writes, hydratedAfterLoad: false, offline: false, saved, unexpected: [] as string[] };
(window as any).__ceph = api;
window.fetch = async (input, init) => {
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
  return json({ ok: true, mmPerPixel: saved.mmPerPixel });
};
const tree = <CephTracer patientName="Synthetic geometry only" patientBirthYear={1990}
  analysis={{ id: 990001, patientId: 990002, documentId: 990003, status: "draft", orthoCaseId: null,
    phase: "pretreatment", xrayDate: null, device: null, refSet: "", calibration: saved.calibration,
    mmPerPixel: saved.mmPerPixel, note: null, createdBy: "Synthetic", createdAt: "2026-11-05T00:00:00Z", completedBy: null, completedAt: null, findings: null }}
  initialLandmarks={saved.landmarks}
  stamped={null} refValues={null} refSetName={null} diagnosis={null} />;
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
