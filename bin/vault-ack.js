#!/usr/bin/env node
"use strict";

/**
 * Marks every keyring entry as registered, after the admin console has taken
 * the block the build printed. Run from the SITE root: `npm run vault:ack`.
 */

const store = require("../scripts/lib/vault-store");

try {
  const n = store.acknowledge();
  console.log(
    n
      ? `[vault] ${n} post${n === 1 ? "" : "s"} marked as registered.`
      : "[vault] nothing pending."
  );
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
