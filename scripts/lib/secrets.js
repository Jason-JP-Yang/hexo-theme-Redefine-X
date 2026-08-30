"use strict";

/**
 * Build-time secrets. Nothing here may ever be written into a config file or
 * reach the browser — `config-export.js` does not export any of it.
 *
 *   .env              KEY=value lines. GISCUS_AUTHOR_PAT, VAULT_MASTER.
 *   .vault/keys.json  { "<postId>": { "key": "<b64url 32B>", "slug": "<10 chars>" } }
 *
 * Both live at the SITE root (next to _config.yml), not in the theme, and both
 * are gitignored.
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const ENV_FILE = path.join(ROOT, ".env");
const VAULT_DIR = path.join(ROOT, ".vault");
const VAULT_FILE = path.join(VAULT_DIR, "keys.json");

let envCache = null;

function loadEnv() {
  if (envCache) return envCache;
  envCache = {};
  let text;
  try {
    text = fs.readFileSync(ENV_FILE, "utf8");
  } catch (e) {
    return envCache;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length > 1 &&
      ((value[0] === '"' && value.endsWith('"')) ||
        (value[0] === "'" && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) envCache[key] = value;
  }
  return envCache;
}

/** A secret from .env, falling back to the real process environment (CI). */
function env(name) {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  return loadEnv()[name] || "";
}

/** The post keyring, or null when the file does not exist. */
function readKeyring() {
  let text;
  try {
    text = fs.readFileSync(VAULT_FILE, "utf8");
  } catch (e) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    throw new Error(`.vault/keys.json is not valid JSON: ${e.message}`);
  }
}

function writeKeyring(map) {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  fs.writeFileSync(VAULT_FILE, JSON.stringify(map, null, 2) + "\n", "utf8");
}

module.exports = { env, readKeyring, writeKeyring, ROOT, VAULT_FILE };
