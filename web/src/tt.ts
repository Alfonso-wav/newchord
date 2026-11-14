// El CSP exige Trusted Types: un Worker o un worklet solo se crean con una URL que pase por aquí,
// y aquí solo pasan las del propio origen.
type Policy = { createScriptURL(url: string): unknown };

let policy: Policy | null | undefined;

export function scriptURL(url: string): string {
  const u = new URL(url, location.href);
  if (u.origin !== location.origin) throw new Error(`script de otro origen: ${u.origin}`);
  const tt = (globalThis as { trustedTypes?: { createPolicy(n: string, r: { createScriptURL(s: string): string }): Policy } }).trustedTypes;
  policy ??= tt?.createPolicy('cryptopo-script', { createScriptURL: (s) => s }) ?? null;
  return (policy ? policy.createScriptURL(u.href) : u.href) as string;
}
