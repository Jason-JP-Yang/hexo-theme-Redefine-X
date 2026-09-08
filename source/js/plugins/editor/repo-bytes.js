/**
 * Base64 for the repository layer.
 *
 * Its own module so the drivers can decode without importing the façade that
 * imports them.
 */

export function toBase64(input) {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  // Chunked: `apply` on a multi-megabyte array overflows the argument list.
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(String(text || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeText(base64) {
  return new TextDecoder().decode(fromBase64(base64));
}
