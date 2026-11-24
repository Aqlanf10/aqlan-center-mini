"use client";

import { useEffect, useMemo, useState } from "react";
import { acknowledgeFinancialCommand, readFinancialJournal, reserveFinancialCommand,
  type FinancialJournal, type FinancialRecoveryControl } from "@/lib/financial-command-journal";
import { DebtRepaymentPanel, restoreDebtCommand, type DebtRepaymentCommand } from "../DebtRepaymentPanel";

export function ReceptionDebtRepayments({ patientId, actor, revision, onChanged, onHold }: {
  patientId: number; actor: string; revision: number; onChanged: () => void; onHold: (held: boolean) => void;
}) {
  const scope = useMemo(() => ({ actor, patientId }), [actor, patientId]);
  const [journal, setJournal] = useState<FinancialJournal | null>(null);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState<DebtRepaymentCommand | null>(null);
  useEffect(() => {
    let current = true;
    readFinancialJournal(scope).then(saved => {
      if (!current) return;
      const command = saved.command?.kind === "debt" ? restoreDebtCommand(saved.command, patientId, actor) : null;
      setRecovery(command);
      setJournal(saved);
    }).catch(() => { if (current) setError("تعذّر التحقق من أمر التحصيل المحفوظ."); });
    return () => { current = false; };
  }, [actor, patientId, scope, revision]);
  const control: FinancialRecoveryControl = {
    revision: journal?.revision ?? 0, ready: !!journal && !error && (!journal.command || journal.command.kind === "debt"),
    error: error || null,
    reserve: async (command, expectedRevision) => {
      try {
        setJournal(await reserveFinancialCommand(scope, expectedRevision, command));
        return true;
      } catch { setError("تغيّرت محاولة التحصيل المحفوظة. حدّث الحساب قبل المتابعة."); return false; }
    },
    acknowledge: async command => { setJournal(await acknowledgeFinancialCommand(scope, command)); },
  };
  if (error) return <p role="alert">{error}</p>;
  return <DebtRepaymentPanel patientId={patientId} refreshKey={revision} recovery={recovery} onRecoveryChange={setRecovery}
    enabled={control.ready} financialRecovery={control} onChanged={onChanged} onHold={onHold} />;
}
