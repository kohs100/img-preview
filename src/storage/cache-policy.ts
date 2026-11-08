/** Only image namespaces are public-cacheable; indexes and key envelopes are not. */
export function imageCacheControl(key: string): string {
  return /^(source|processed)\//.test(key)
    ? "public, max-age=300, s-maxage=86400"
    : "no-store";
}
