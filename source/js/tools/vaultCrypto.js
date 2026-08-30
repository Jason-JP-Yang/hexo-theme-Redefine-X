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

export async function openJSON(key, sealed) {
  return JSON.parse(await openText(key, sealed));
}

export function vaultPrefix() {
  return String((window.theme && window.theme.backend && window.theme.backend.vault_prefix) || "/v")
    .replace(/\/+$/, "");
}

export function siteRoot() {
  return String((window.config && window.config.root) || "/").replace(/\/+$/, "");
}

/**
 * Every blob this fetches is ciphertext, so it is cached like any other static
 * file. `no-store` here used to force a fresh download of every card, every
 * image and every grid on every navigation — a cost paid for no secrecy, since
 * what a cache would be holding is unreadable without a key that never leaves
 * this module.
 */
export async function fetchSealed(path) {
  const res = await fetch(siteRoot() + path);
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

/**
 * Where one sealed image is published. The post key is mixed into the NAME as
 * well as the key: two encrypted items that share an image (an avatar, a banner)
 * would otherwise claim one path and seal it under two different asset keys, and
 * whichever the build wrote last would be the only one that ever opened.
 *
 * Mirrors `assetPath` in scripts/lib/vault-crypto.js byte for byte.
 */
export async function assetPath(rawPostKey, hash) {
  const hex = await sha256Hex("rdfx-asset-path|" + bytesToB64url(rawPostKey) + "|" + hash);
  return hex.slice(0, 32);
}

/**
 * How a tag or a category is named in a URL fragment. A fragment never reaches
 * a server, but it does survive being copied out of the address bar, so what
 * travels is a hash: only a reader who can already decrypt the metadata can turn
 * it back into a name.
 */
export function taxHash(kind, name) {
  return sha256Hex("rdfx-tax|" + kind + "|" + name).then((hex) => hex.slice(0, 16));
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

// Which key opens which sealed image, recorded when a decrypted fragment is
// mounted. Kept apart from the URL cache so an image can be resolved long after
// its article was mounted — which is exactly what lazy loading needs.
const assetKeys = new Map();
const assetCache = new Map();
const assetInflight = new Map();

/** Record the key for every sealed image in `root`. Fetches nothing. */
export function bindAssets(root, rawPostKey) {
  for (const node of root.querySelectorAll("[data-vault-asset]")) {
    const hash = node.getAttribute("data-vault-asset");
    if (hash) assetKeys.set(hash, rawPostKey);
  }
}

async function openAsset(hash) {
  const raw = assetKeys.get(hash);
  if (!raw) return "";
  const sealed = await fetchSealed(`${vaultPrefix()}/a/${await assetPath(raw, hash)}.bin`);
  if (!sealed) return "";
  const bytes = await openBlob(await assetKey(raw, hash), sealed);
  const url = URL.createObjectURL(new Blob([bytes], { type: sniffType(bytes) }));
  assetCache.set(hash, url);
  return url;
}

/** The blob: URL for one sealed image. Fetched and decrypted once, however many
 *  callers ask for it and however close together. Never rejects. */
export function assetURL(hash) {
  if (!hash) return Promise.resolve("");
  const cached = assetCache.get(hash);
  if (cached) return Promise.resolve(cached);

  let job = assetInflight.get(hash);
  if (!job) {
    job = openAsset(hash).catch(() => "");
    assetInflight.set(hash, job);
    job.then(() => assetInflight.delete(hash));
  }
  return job;
}

/**
 * Bind every sealed image in `root`, and resolve now ONLY the ones the lazyload
 * pipeline will never drive — an article banner, a cover on a listing card.
 * Anything carrying `data-src` is an img-preloader and is left to the observer,
 * so mounting an article with fifty images costs one fetch rather than fifty.
 */
export async function revealAssets(root, rawPostKey) {
  bindAssets(root, rawPostKey);
  await Promise.all(
    Array.from(root.querySelectorAll("[data-vault-asset]:not([data-src])"), async (node) => {
      const url = await assetURL(node.getAttribute("data-vault-asset"));
      if (!url) return;
      node.setAttribute("src", url);
      node.removeAttribute("data-vault-asset");
    })
  );
}

export function dropAssetCache() {
  assetCache.forEach((url) => URL.revokeObjectURL(url));
  assetCache.clear();
  assetKeys.clear();
  assetInflight.clear();
}
