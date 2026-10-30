/** Accept only same-origin paths, including after URL parsing normalizes backslashes. */
export function authorReturnPath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return "/";
  return value;
}
