"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Worker, isMainThread, parentPort } = require("worker_threads");

// Configuration
const MAX_PIXELS = 4_000_000; // Increased limit
const MAX_BYTES = 40 * 1024; // 40KB
const QUALITY_STEPS = [45, 35, 25];
const MAX_WORKERS = Math.max(1, (os.cpus()?.length || 2) - 1);

// ----------------------------------------------------------------------------
// Worker Thread Logic
// ----------------------------------------------------------------------------
if (!isMainThread) {
  const sharp = require("sharp");
  // Disable sharp cache to prevent process hang
  sharp.cache(false);

  async function encodeAvif(inputPath, outputPath, targetWidth, targetHeight, maxBytes) {
    let lastBuffer = null;
    let lastQuality = QUALITY_STEPS[QUALITY_STEPS.length - 1];

    for (const quality of QUALITY_STEPS) {
      try {
        const buffer = await sharp(inputPath, { failOn: "none" })
          .rotate()
          .resize({
            width: targetWidth,
            height: targetHeight,
            fit: "inside",
            withoutEnlargement: true,
          })
          .avif({ quality, effort: 4 })
          .toBuffer();

        lastBuffer = buffer;
        lastQuality = quality;

        if (buffer.length <= maxBytes) {
          await fs.promises.writeFile(outputPath, buffer);
          return { ok: true, quality, size: buffer.length };
        }
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // Fallback: shrink dimensions if quality reduction wasn't enough
    if (lastBuffer && lastBuffer.length > maxBytes) {
      try {
        const shrinkRatio = Math.sqrt(maxBytes / lastBuffer.length);
        const shrinkWidth = Math.max(1, Math.floor(targetWidth * shrinkRatio));
        const shrinkHeight = Math.max(1, Math.floor(targetHeight * shrinkRatio));

        const buffer = await sharp(inputPath, { failOn: "none" })
          .rotate()
          .resize({
            width: shrinkWidth,
            height: shrinkHeight,
            fit: "inside",
            withoutEnlargement: true,
          })
          .avif({ quality: lastQuality, effort: 4 })
          .toBuffer();

        await fs.promises.writeFile(outputPath, buffer);
        return { ok: true, quality: lastQuality, size: buffer.length, resized: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    return { ok: false, error: "unable_to_compress" };
  }

  async function processTask(task) {
    const { inputPath, outputPath, maxPixels, maxBytes } = task;

    if (!fs.existsSync(inputPath)) {
      return { ok: false, error: "input_missing" };
    }

    const outDir = path.dirname(outputPath);
    await fs.promises.mkdir(outDir, { recursive: true });

    try {
      // Check cache validity based on mtime
      const inStat = await fs.promises.stat(inputPath);
      try {
        const outStat = await fs.promises.stat(outputPath);
        if (outStat.mtimeMs >= inStat.mtimeMs && outStat.size > 0) {
          return { ok: true, skipped: "cached" };
        }
      } catch {
        // Output doesn't exist, proceed
      }

      const meta = await sharp(inputPath, { failOn: "none" }).metadata();
      if (!meta || !meta.width || !meta.height) {
        return { ok: false, error: "metadata_missing" };
      }

      const width = meta.width;
      const height = meta.height;
      const pixels = width * height;
      const scale = pixels > maxPixels ? Math.sqrt(maxPixels / pixels) : 1;

      const targetWidth = Math.max(1, Math.floor(width * scale));
      const targetHeight = Math.max(1, Math.floor(height * scale));

      return await encodeAvif(inputPath, outputPath, targetWidth, targetHeight, maxBytes);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  parentPort.on("message", async (task) => {
    const id = task?.id;
    if (!id) return;
    
    try {
      const result = await processTask(task);
      parentPort.postMessage({ id, ...result });
    } catch (error) {
      parentPort.postMessage({
        id,
        ok: false,
        error: error?.message || String(error),
      });
    }
  });

  return;
}

// ----------------------------------------------------------------------------
// Main Thread Logic
// ----------------------------------------------------------------------------

// Helper Functions
function stripQueryAndHash(url) {
  return String(url).split("#")[0].split("?")[0];
}

function normalizeRootPath(src) {
  const s = String(src).trim();
  const siteRoot = hexo.config.root || "/";
  let rel = s;
  if (siteRoot !== "/" && rel.startsWith(siteRoot)) {
    rel = rel.slice(siteRoot.length);
    if (!rel.startsWith("/")) rel = `/${rel}`;
  }
  if (!rel.startsWith("/")) return null;
  rel = rel.replace(/^\/+/, "");
  return rel;
}

function isSupportedBitmap(ext) {
  const e = ext.toLowerCase();
  return e === ".jpg" || e === ".jpeg" || e === ".png";
}

function resolveSourceImagePath(src) {
  const rel = normalizeRootPath(src);
  if (!rel) return null;
  if (rel.toLowerCase().startsWith("build/")) return null;

  const decodedRel = (() => {
    try {
      return decodeURIComponent(rel);
    } catch {
      return rel;
    }
  })();

  // 1. Check blog source
  let abs = path.join(hexo.source_dir || "", decodedRel);
  if (abs && fs.existsSync(abs)) return { abs, rel: decodedRel };

  // 2. Check theme source
  if (hexo.theme_dir) {
    abs = path.join(hexo.theme_dir, "source", decodedRel);
    if (abs && fs.existsSync(abs)) return { abs, rel: decodedRel };
  }

  return null;
}

function buildAvifPaths(relPath) {
  const posixRel = relPath.replace(/\\/g, "/");
  const ext = path.posix.extname(posixRel);
  const base = path.posix.basename(posixRel, ext);
  const dir = path.posix.dirname(posixRel);
  const relDir = dir === "." ? "" : dir;

  const outputRel = path.posix.join("build", relDir, `${base}.avif`);
  const outputPath = path.join(hexo.source_dir || "", outputRel);
  const rawUrl = path.posix.join(hexo.config.root || "/", outputRel);
  const url = encodeURI(rawUrl);
  const routePath = outputRel;

  return { outputRel, outputPath, url, routePath };
}

// Worker Pool Implementation
class AvifWorkerPool {
  constructor() {
    this.workerCount = MAX_WORKERS;
    this.workers = [];
    this.ready = [];
    this.queue = [];
    this.inflight = new Map();
    this.nextId = 1;
    this.pending = 0;
    this.idleResolvers = [];
    this.closed = false;

    for (let i = 0; i < this.workerCount; i += 1) {
      const worker = new Worker(__filename);
      // Ensure worker doesn't keep process alive if it's the only thing left
      if (hexo.env.cmd === 'generate') {
         worker.unref(); 
      }
      
      worker.on("message", (msg) => this.handleMessage(worker, msg));
      worker.on("error", (err) => this.handleError(worker, err));
      worker.on("exit", () => this.handleExit(worker));
      
      this.workers.push(worker);
      this.ready.push(worker);
    }
  }

  enqueue(task) {
    if (this.closed) {
      return Promise.resolve({ ok: false, error: "pool_closed" });
    }

    const id = this.nextId++;
    this.pending += 1;

    return new Promise((resolve) => {
      this.queue.push({ id, task, resolve });
      this.dispatch();
    }).finally(() => {
      this.pending -= 1;
      if (this.pending === 0) {
        this.idleResolvers.splice(0).forEach((fn) => fn());
      }
    });
  }

  dispatch() {
    if (this.closed) return;
    while (this.ready.length > 0 && this.queue.length > 0) {
      const worker = this.ready.shift();
      const item = this.queue.shift();
      this.inflight.set(worker, item);
      worker.postMessage({ id: item.id, ...item.task });
    }
  }

  handleMessage(worker, msg) {
    const item = this.inflight.get(worker);
    this.inflight.delete(worker);
    this.ready.push(worker);

    if (item) {
      item.resolve(msg);
    }

    this.dispatch();
  }

  handleError(worker, err) {
    const item = this.inflight.get(worker);
    this.inflight.delete(worker);
    
    // Replace dead worker
    if (!this.closed) {
        const newWorker = new Worker(__filename);
        if (hexo.env.cmd === 'generate') newWorker.unref();
        newWorker.on("message", (msg) => this.handleMessage(newWorker, msg));
        newWorker.on("error", (e) => this.handleError(newWorker, e));
        newWorker.on("exit", () => this.handleExit(newWorker));
        this.workers = this.workers.filter(w => w !== worker).concat(newWorker);
        this.ready.push(newWorker);
    }

    if (item) {
      item.resolve({ ok: false, error: err?.message || String(err) });
    }

    this.dispatch();
  }
  
  handleExit(worker) {
      // Clean up if a worker exits unexpectedly
      const item = this.inflight.get(worker);
      if (item) {
          this.inflight.delete(worker);
          item.resolve({ ok: false, error: "worker_exited" });
      }
  }

  async idle() {
    if (this.pending === 0) return;
    await new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    
    await this.idle();
    
    const terminations = this.workers.map(async (w) => {
        try {
            await w.terminate();
        } catch(e) {
            // ignore termination errors
        }
    });
    
    await Promise.all(terminations);
    
    this.workers = [];
    this.ready = [];
    this.queue = [];
    this.inflight.clear();
  }
}

// Global state
let pool = null;
const taskCache = new Map();

function getPool() {
  if (!pool) pool = new AvifWorkerPool();
  return pool;
}

// ----------------------------------------------------------------------------
// Hexo Filters
// ----------------------------------------------------------------------------

hexo.extend.filter.register(
  "after_render:html",
  async function (str, data) {
    // Basic validation
    if (!str || typeof str !== "string" || str.length === 0) return str;

    const pending = [];

    // Helper to process tags (img or div)
    const processTag = (tagContent, attrName) => {
      // Skip if marked
      if (/\bdata-no-avif\b/i.test(tagContent)) return null;

      // Extract attribute
      const attrRegex = new RegExp(`\\b${attrName}\\s*=\\s*("|')([^"']*)\\1`, "i");
      const srcMatch = tagContent.match(attrRegex);
      if (!srcMatch) return null;

      const originalSrc = srcMatch[2];
      if (!originalSrc) return null;

      // Skip invalid schemes
      if (/^data:|^blob:/i.test(originalSrc)) return null;
      if (/^https?:\/\//i.test(originalSrc) || originalSrc.startsWith("//")) return null;

      // Check extension
      const normalizedSrc = stripQueryAndHash(originalSrc);
      const ext = path.extname(normalizedSrc).toLowerCase();
      if (!isSupportedBitmap(ext)) return null;

      // Resolve local file
      const local = resolveSourceImagePath(normalizedSrc);
      if (!local) return null;

      // Calculate paths
      const { outputPath, url, routePath } = buildAvifPaths(local.rel);
      const cacheKey = `${local.abs}|${outputPath}`;

      try {
        const inStat = fs.statSync(local.abs);
        const outStat = fs.statSync(outputPath);
        if (outStat.mtimeMs >= inStat.mtimeMs && outStat.size > 0) {
          hexo.route.set(routePath, () => fs.createReadStream(outputPath));
          taskCache.set(cacheKey, Promise.resolve({ ok: true, skipped: "cached" }));
          return tagContent.replace(srcMatch[0], `${attrName}="${url}"`);
        }
      } catch {}

      // Enqueue task if not cached
      if (!taskCache.has(cacheKey)) {
        const taskPromise = getPool()
          .enqueue({
            inputPath: local.abs,
            outputPath,
            maxPixels: MAX_PIXELS,
            maxBytes: MAX_BYTES,
          })
          .then((res) => {
            if (res?.ok) {
              // Register route
              hexo.route.set(routePath, () => fs.createReadStream(outputPath));
              if (!res.skipped) {
                hexo.log.info(`[redefine-x][img-avif] Generated: ${routePath}`);
              }
            } else if (res?.error && hexo?.log?.warn) {
                // Warning log
               // hexo.log.warn(`[redefine-x][img-avif] Failed: ${local.rel} -> ${res.error}`);
            }
            return res;
          });

        taskCache.set(cacheKey, taskPromise);
      }

      pending.push(taskCache.get(cacheKey));

      // Return replacement string
      return tagContent.replace(srcMatch[0], `${attrName}="${url}"`);
    };

    // 1. Process <img> tags
    const imgRegex = /<img\b[^>]*>/gim;
    let result = "";
    let lastIndex = 0;
    let match;

    while ((match = imgRegex.exec(str)) !== null) {
      const tag = match[0];
      const start = match.index;
      result += str.slice(lastIndex, start);
      lastIndex = imgRegex.lastIndex;

      const newTag = processTag(tag, "src");
      result += newTag || tag;
    }
    result += str.slice(lastIndex);
    str = result;

    // 2. Process <div class="img-preloader"> tags
    const divRegex = /<div\b[^>]*class="[^"]*img-preloader[^"]*"[^>]*>/gim;
    result = "";
    lastIndex = 0;

    while ((match = divRegex.exec(str)) !== null) {
      const tag = match[0];
      const start = match.index;
      result += str.slice(lastIndex, start);
      lastIndex = divRegex.lastIndex;

      const newTag = processTag(tag, "data-src");
      result += newTag || tag;
    }
    result += str.slice(lastIndex);

    // Wait for all tasks for THIS file to complete
    if (pending.length > 0) {
      await Promise.all(pending);
    }

    return result;
  },
  5
);

// Cleanup and Optimization hook
hexo.extend.filter.register("after_generate", async function () {
  // 1. Remove original images if AVIF version exists in routes
  const routes = hexo.route.list();
  const deleted = [];

  routes.forEach((route) => {
    const ext = path.extname(route).toLowerCase();
    if (isSupportedBitmap(ext)) {
      const { routePath: avifRoute } = buildAvifPaths(route);
      // If AVIF exists in the route system, remove the original bitmap route
      if (hexo.route.get(avifRoute)) {
        hexo.route.remove(route);
        deleted.push(route);
      } else {
        // If AVIF does NOT exist, it means this image was not processed/used in any HTML
        // Warn the user that this image will remain as-is
        hexo.log.warn(`[redefine-x][img-avif] Unused image detected: ${route} (kept original)`);
      }
    }
  });

  if (deleted.length > 0) {
    hexo.log.debug(`[redefine-x][img-avif] Removed ${deleted.length} original images from output.`);
  }

  // 2. Close pool
  if (pool) {
    await pool.close();
    pool = null;
  }
});

// Fallback cleanup on exit
hexo.on('exit', async () => {
    if (pool) {
        await pool.close();
        pool = null;
    }
});

// Cleanup build dir on clean
hexo.extend.filter.register("after_clean", function () {
  if (hexo.env.args["exclude-minify"]) {
    hexo.log.info("[redefine-x][img-avif] Build directory cleanup skipped (--exclude-minify).");
    return;
  }

  const buildDir = path.join(hexo.source_dir || "", "build");
  try {
    fs.rmSync(buildDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
