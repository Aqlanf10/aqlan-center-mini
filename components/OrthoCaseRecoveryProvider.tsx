"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { makeIntakeRecoveryLedger, type IntakeRecoveryLedger } from "@/lib/ortho-assessment-intake-owner";
import { makeStudyRecoveryLedger, type StudyRecoveryLedger } from "@/lib/ortho-case-study-recovery";
import { makeRetentionRecoveryLedger, type RetentionRecoveryLedger } from "@/lib/ortho-retention-recovery";
type Recovery = { intake: IntakeRecoveryLedger; study: StudyRecoveryLedger; retention: RetentionRecoveryLedger };
const Context = createContext<Recovery | null>(null);
/** One bounded in-memory lifetime above temporary patient/case/tab views.
 * No payload list is exposed to UI. Hard reload/crash still loses this memory. */
export function OrthoCaseRecoveryProvider({children}:{children:React.ReactNode}) {
  const [recovery] = useState<Recovery>(()=>({intake:makeIntakeRecoveryLedger(),study:makeStudyRecoveryLedger(),retention:makeRetentionRecoveryLedger()}));
  useEffect(()=>{
    const beforeUnload=(event:BeforeUnloadEvent)=>{
      if(recovery.intake.needsUnloadWarning()||recovery.study.needsUnloadWarning()||recovery.retention.needsUnloadWarning()){event.preventDefault();event.returnValue="";}
    };
    window.addEventListener("beforeunload",beforeUnload);return()=>window.removeEventListener("beforeunload",beforeUnload);
  },[recovery]);
  return <Context.Provider value={recovery}>{children}</Context.Provider>;
}
export function useOrthoIntakeRecovery(): IntakeRecoveryLedger | null { return useContext(Context)?.intake??null; }
export function useOrthoStudyRecovery(): StudyRecoveryLedger | null { return useContext(Context)?.study??null; }

export function useOrthoRetentionRecovery(): RetentionRecoveryLedger | null { return useContext(Context)?.retention??null; }
