
export function originAllowed(
  host: string,
  origin: string | undefined,
  referer: string | undefined,
  requireOrigin: boolean,
): boolean {
  if (!requireOrigin) return true;
  const expected = origin || referer;
  if (!expected) return false;
  try {
    const u = new URL(expected);
    return u.host === host || u.host === host.replace(/:\d+$/, "") || expected.includes(host);
  } catch {
    return false;
  }
}
