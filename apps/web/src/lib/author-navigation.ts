/** Normalize before returning a local path: dot segments can expose a leading //. */
export function authorReturnPath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return "/";
  const url = new URL(value, "https://site.invalid");
  if (url.origin !== "https://site.invalid" || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
