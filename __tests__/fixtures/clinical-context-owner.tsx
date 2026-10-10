import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useClinicalNavigationContext } from "../../components/useClinicalNavigationContext";
import type { ClinicalNavigationContext } from "../../lib/patient-navigation";

type Props = { patientId: number; authority: string; context?: ClinicalNavigationContext; invalid?: boolean };
const requests: { id: number; signal: AbortSignal | null; resolve: (response: Response) => void }[] = [];
let setProps: (props: Props) => void = () => { throw new Error("Fixture not mounted"); };
// This is explicitly controlled transport, not a claim about HTTP/PG. Ignore abort to exercise body fencing.
window.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
  requests.push({ id: requests.length + 1, signal: init?.signal ?? null, resolve });
})) as typeof fetch;
declare global {
  interface Window {
    __clinicalOwner: {
      set(props: Props): void;
      requests(): { id: number; aborted: boolean }[];
      respond(id: number, value: unknown, status?: number): void;
    };
  }
}
window.__clinicalOwner = {
  set: (props) => setProps(props),
  requests: () => requests.map((request) => ({ id: request.id, aborted: request.signal?.aborted ?? false })),
  respond: (id, value, status = 200) => {
    const request = requests.find((one) => one.id === id);
    if (!request) throw new Error("Unknown fixture request");
    request.resolve(new Response(JSON.stringify(value), { status }));
  },
};
function Fixture() {
  const [props, update] = useState<Props>({ patientId: 11, authority: "A", context: { orthoCaseId: 51 } });
  useLayoutEffect(() => { setProps = update; }, []);
  const state = useClinicalNavigationContext(props.patientId, props.context, props.invalid ?? false, props.authority);
  return <output id="clinical-owner-result" data-ready={state.ready}>{state.error ?? (state.ready ? JSON.stringify(state.context ?? {}) : "loading")}</output>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
