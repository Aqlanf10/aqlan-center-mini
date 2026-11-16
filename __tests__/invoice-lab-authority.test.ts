import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("../lib/db",()=>({getSettingsInTransaction:vi.fn(async()=>({}))}));
vi.mock("../lib/session",()=>({revalidateSessionInTransaction:vi.fn(async(session)=>session)}));
import {validateInvoiceTemplateInTransaction,InvoiceTemplateAuthorizationError,InvoiceTemplateAuthorityError} from "../lib/invoice-template-db";
import {revalidateSessionInTransaction} from "../lib/session";
import type {DbClient} from "../lib/db";
const source={patientId:91,items:[]};
function args(role:string){const session={userId:17,username:"synthetic",role,expiresAt:Date.now()+100000} as never;return {patientId:91,items:[{labWork:{intentId:"synthetic"}}],actorRole:role,idempotencyKey:null,requestHash:null,baseCurrency:"YER",discountMinor:0,note:null,createdBy:"synthetic",catalogueAuthority:{source,fingerprint:"synthetic",session}} as unknown as Parameters<typeof validateInvoiceTemplateInTransaction>[1];}
beforeEach(()=>vi.mocked(revalidateSessionInTransaction).mockImplementation(async(session)=>session));
describe("invoice clinical laboratory authority intersection",()=>{
 it.each(["reception","cashier"])("keeps %s monetary authority from granting clinical prescription edits",async(role)=>{const client={query:vi.fn(async()=>({rows:[]}))} as unknown as DbClient;await expect(validateInvoiceTemplateInTransaction(client,args(role))).rejects.toBeInstanceOf(InvoiceTemplateAuthorizationError);expect(revalidateSessionInTransaction).toHaveBeenCalled();});
 it("rejects detached lab payload without authoritative sealed source",async()=>{const input=args("admin");delete input.catalogueAuthority;const client={query:vi.fn()} as unknown as DbClient;await expect(validateInvoiceTemplateInTransaction(client,input)).rejects.toBeInstanceOf(InvoiceTemplateAuthorizationError);expect(client.query).not.toHaveBeenCalled();});
 it("revoked session cannot submit even as admin",async()=>{vi.mocked(revalidateSessionInTransaction).mockResolvedValue(null);const client={query:vi.fn(async()=>({rows:[]}))} as unknown as DbClient;await expect(validateInvoiceTemplateInTransaction(client,args("admin"))).rejects.toBeInstanceOf(InvoiceTemplateAuthorizationError);});
 it("allows active admin through the role gate to sealed payload validation",async()=>{const client={query:vi.fn(async()=>({rows:[]}))} as unknown as DbClient;await expect(validateInvoiceTemplateInTransaction(client,args("admin"))).rejects.toBeInstanceOf(InvoiceTemplateAuthorityError);});
});
