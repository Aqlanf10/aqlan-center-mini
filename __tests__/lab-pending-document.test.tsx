import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dispatchOrder } from "./fixtures/lab-dispatch";
import { toLabDispatchExternal } from "../lib/lab";
vi.mock("../components/SettingsProvider",()=>({useSetting:()=>"Synthetic clinic"}));
import { LabPrescriptionModal } from "../components/LabPrescriptionModal";
describe("pending lab document regression",()=>{
 it("does not claim the visit date is a dispatch date",()=>expect(toLabDispatchExternal(dispatchOrder({status:"needed"})).sentDate).toBe("لم يُرسل بعد"));
 it("shows neutral tooth27 without inventing its bridge role",()=>{
  const html=renderToStaticMarkup(<LabPrescriptionModal order={dispatchOrder({status:"needed",toothNumbers:null,toothCode:27})} onClose={()=>{}}/>);
  expect(html).toContain('data-lab-tooth="27"');
  expect(html).toContain("دور غير محدد");
  expect(html).not.toContain("SYNTHETIC_PRIVATE_PATIENT");
 });
});
