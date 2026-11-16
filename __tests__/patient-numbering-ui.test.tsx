import {readFileSync} from "node:fs";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {beforeEach,expect,it,vi} from "vitest";
const auth=vi.hoisted(()=>({session:null as null|{role:string;username:string}}));
vi.mock("../components/SessionProvider",()=>({useSession:()=>auth.session}));
import {PatientNumberEditor} from "../components/patient/PatientNumberEditor";
import PatientNumberingPage from "../app/settings/patient-numbering/page";
beforeEach(()=>{auth.session=null;});
it.each([null,"doctor","reception","assistant","cashier","accountant"])("does not render standalone edit controls for %s",role=>{
 auth.session=role?{role,username:"synthetic"}:null;
 expect(renderToStaticMarkup(<PatientNumberEditor patientId={42} onChanged={()=>{}}/>)).toBe("");
 expect(renderToStaticMarkup(<PatientNumberingPage/>)).toContain("لا توجد صلاحية");
});
it("offers a separately labeled explicit edit, never a demographic field",()=>{
 auth.session={role:"admin",username:"synthetic"};
 const html=renderToStaticMarkup(<PatientNumberEditor patientId={42} onChanged={()=>{}}/>);
 expect(html).toContain('aria-label="تعديل رقم ملف المريض"');expect(html).toContain("تعديل رقم الملف");expect(html).not.toContain("<input");
});
it("explains future-only floor and fixed P-prefix without claiming an unverified next number",()=>{
 auth.session={role:"admin",username:"synthetic"};const html=renderToStaticMarkup(<PatientNumberingPage/>);
 expect(html).toContain('dir="rtl"');expect(html).toContain("P-07000");expect(html).toContain("لا يعيد هذا الإعداد ترقيم المرضى السابقين");expect(html).toContain("تحديث المعاينة");
});

it("mounts the identity editor outside demographics and resets it with the exact patient/session owner",()=>{
 const source=readFileSync("app/patients/[id]/page.tsx","utf8");
 expect(source).toContain('admin ? <div className="mb-4"><PatientNumberEditor key={alertScope} patientId={patient.id} onChanged={() => void load()}');
 expect(source.indexOf("<PatientNumberEditor")).toBeLessThan(source.indexOf("{editing ? ("));
});

it("binds settings drafts to session ownership and synchronously fences queued load/cancel during save",()=>{
 const settings=readFileSync("app/settings/patient-numbering/page.tsx","utf8"),editor=readFileSync("components/patient/PatientNumberEditor.tsx","utf8");
 expect(settings).toContain('key={JSON.stringify([session.username, session.role, session.permissions ?? null])}');
 expect(settings).toContain('const load = useCallback(async () => {\n    if (saving.current) return;');
 expect(editor).toContain('async function load() {\n    if (saving.current) return;');
 expect(editor).toContain('onClick={()=>{if(saving.current)return;generation.current++');
});
