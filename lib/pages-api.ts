import type { NextApiRequest, NextApiResponse } from "next";

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
type Methods = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Handler>>;
/** Dispatch only the explicitly registered methods. Match App Router's implicit HEAD and OPTIONS. */
export function definePagesApi(methods: Methods) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const method = req.method ?? "";
    if (method === "OPTIONS") {
      const allow = [...Object.keys(methods), "OPTIONS", ...(methods.GET ? ["HEAD"] : [])].sort();
      res.setHeader("Allow", allow.join(", ")); res.status(204).end(); return;
    }
    const handler = methods[method === "HEAD" ? "GET" : method as keyof Methods];
    if (!handler) { res.status(405).end(); return; }
    await handler(req, res);
  };
}
