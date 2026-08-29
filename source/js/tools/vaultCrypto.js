/**
 * Browser half of the vault crypto. Mirrors scripts/lib/vault-crypto.js byte for
 * byte; the management console and the reader both import it.
 *
 * Keys are imported NON-EXTRACTABLE and live only in the caller's closure.
 */

const enc = new TextEncoder();

export function b64urlToBytes(str) {
  const s = String(str);
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function importAesKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}

/** RFC 5869 with an empty salt, matching the Node side. */
export async function hkdfKey(ikm, info) {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
    base,
    256
  );
  return importAesKey(new Uint8Array(bits));
}

/** Every blob in this system is iv ‖ ciphertext ‖ tag. */
export async function openBlob(key, sealed) {
  const bytes = new Uint8Array(sealed);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12) },
    key,
    bytes.subarray(12)
  );
  return new Uint8Array(plain);
}

export async function openText(key, sealed) {
  return new TextDecoder().decode(await openBlob(key, sealed));
}

export function vaultPrefix() {
  return String((window.theme && window.theme.backend && window.theme.backend.vault_prefix) || "/v")
    .replace(/\/+$/, "");
}

export function siteRoot() {
  return String((window.config && window.config.root) || "/").replace(/\/+$/, "");
}

export async function fetchSealed(path) {
  const res = await fetch(siteRoot() + path, { cache: "no-store" });
  return res.ok ? res.arrayBuffer() : null;
}

/** A bento variant is addressed and keyed by the SET of post keys it renders. */
function variantMaterial(page, rawKeys) {
  return (
    "rdfx-grid|" + page + "|" + rawKeys.map((k) => bytesToB64url(k)).sort().join(",")
  );
}

export async function variantPath(page, rawKeys) {
  return (await sha256Hex(variantMaterial(page, rawKeys))).slice(0, 16);
}

export function variantKey(page, rawKeys) {
  return hkdfKey(enc.encode(variantMaterial(page, rawKeys)), "rdfx-grid-key");
}

export function assetKey(rawPostKey, hash) {
  return hkdfKey(rawPostKey, "rdfx-asset|" + hash);
}

function sniffType(bytes) {
  if (bytes.length > 12 && String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === "ftyp") {
    return "image/avif";
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return "image/webp";
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  return "application/octet-stream";
}

const assetCache = new Map();

/** Swap every sealed image reference in `root` for a blob: URL. Never rejects. */
export async function revealAssets(root, rawPostKey) {
  await Promise.all(
    Array.from(root.querySelectorAll("[data-vault-asset]"), async (node) => {
      const hash = node.getAttribute("data-vault-asset");
      if (!hash) return;
      try {
        let url = assetCache.get(hash);
        if (!url) {
          const sealed = await fetchSealed(`${vaultPrefix()}/a/${hash}.bin`);
          if (!sealed) return;
          const bytes = await openBlob(await assetKey(rawPostKey, hash), sealed);
          url = URL.createObjectURL(new Blob([bytes], { type: sniffType(bytes) }));
          assetCache.set(hash, url);
        }
        node.setAttribute(node.hasAttribute("data-src") ? "data-src" : "src", url);
        node.removeAttribute("data-vault-asset");
      } catch (e) {
        /* leave the placeholder rather than breaking the layout */
      }
    })
  );
}

export function dropAssetCache() {
  assetCache.forEach((url) => URL.revokeObjectURL(url));
  assetCache.clear();
}
