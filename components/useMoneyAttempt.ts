"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { moneyAttempts, type MoneyRequest } from "@/lib/money-attempt";
import { useSession } from "./SessionProvider";

export function useMoneyAttempt(owner: string, visible = true, viewKey = owner) {
  const session = useSession();
  const scope = JSON.stringify([session?.username, session?.role, session?.permissions ?? null, owner]);
  const snapshot = useCallback(() => moneyAttempts.get(scope), [scope]);
  const attempt = useSyncExternalStore(moneyAttempts.subscribe, snapshot, () => null);
  const lifetime = useRef<object | null>(null);
  const token = useMemo(() => ({ scope, visible, viewKey }), [scope, visible, viewKey]);
  useLayoutEffect(() => {
    lifetime.current = token.visible ? token : null;
    return () => { lifetime.current = null; };
  }, [token]);
  const run = async (request?: MoneyRequest) => {
    if (!session || lifetime.current !== token) return null;
    const result = await moneyAttempts.run(scope, request);
    return token === lifetime.current ? result : null;
  };
  return { attempt, run, consume: (confirmed: NonNullable<typeof attempt>) => moneyAttempts.consume(scope, confirmed) };
}
