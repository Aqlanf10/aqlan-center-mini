/** Restrict documentary input to bounded JSON-shaped data, without invoking accessors. */
export function assertRetentionData(value: unknown, maxNodes = 2000): void {
  let remaining = maxNodes;
  function visit(v: unknown, depth: number): void {
    if (--remaining < 0 || depth > 12) throw new Error("invalid_retention_data");
    if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object") throw new Error("invalid_retention_data");
    const array = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error("invalid_retention_data");
    const keys = Reflect.ownKeys(v);
    if (keys.length > remaining || array && (v.length > 5000 || keys.length !== v.length + 1)) throw new Error("invalid_retention_data");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)
        || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length)) throw new Error("invalid_retention_data");
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("invalid_retention_data");
      visit(descriptor.value, depth + 1);
    }
  }
  visit(value, 0);
}
