"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// Configuration
const MAX_PIXELS = 2073600; // 1920x1080 limit
const TARGET_CRF = 25; // "25%" quality/compression balance
const ENCODER_PRESET = 4; // Prioritize quality (lower is slower/better)
const MAX_CONCURRENCY = Math.max(1, Math.floor((os.cpus().length || 2) / 2)); // Conservative concurrency for SVT-AV1

// ----------------------------------------------------------------------------
// FFmpeg & Process Logic
// ----------------------------------------------------------------------------

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { shell: false });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => (stdout += data));
    proc.stderr.on("data", (data) => (stderr += data));

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (err) => reject(err));
  });
}

async function getImageMetadata(inputPath) {
  try {
    // Use ffmpeg -i to probe since ffprobe might not be aliased/available separately
    // We expect a failure exit code usually if we don't provide output, but we catch the stderr
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", ["-i", inputPath], { shell: false });
      let stderr = "";
      proc.stderr.on("data", (data) => (stderr += data));
      proc.on("close", () => {
        // Parse dimensions from stderr
        // Pattern: Stream #0:0... Video: ... 1920x1080 ...
        const match = stderr.match(/Stream #\d+:\d+.*Video:.*?\s(\d+)x(\d+)/);
        if (match) {
          resolve({ width: parseInt(match[1], 10), height: parseInt(match[2], 10) });
        } else {
          reject(new Error("Could not determine image dimensions from ffmpeg output"));
        }
      });
    });
  } catch (e) {
    throw e;
  }
}

async function encodeAvif(inputPath, outputPath, options) {
  const { width, height } = options;
  
  // Calculate scaling
  let targetWidth = width;
  let targetHeight = height;
  const pixels = width * height;
  
  if (pixels > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / pixels);
    targetWidth = Math.floor(width * scale);
    targetHeight = Math.floor(height * scale);
  }

  // Ensure even dimensions for YUV420
  if (targetWidth % 2 !== 0) targetWidth -= 1;
  if (targetHeight % 2 !== 0) targetHeight -= 1;
  
  // Safety check: ensure at least 2x2
  targetWidth = Math.max(2, targetWidth);
  targetHeight = Math.max(2, targetHeight);

  // Prepare args
  const args = [
    "-y", // Overwrite
    "-i", inputPath,
    "-vf", `scale=${targetWidth}:${targetHeight}:flags=lanczos`, // High quality scaling
    "-c:v", "libsvtav1",
    "-crf", String(TARGET_CRF),
    "-preset", String(ENCODER_PRESET),
    "-pix_fmt", "yuv420p10le", // 10-bit color for better quality
    "-svtav1-params", "tune=0", // 0 = Visual Quality
    outputPath
  ];

  await runCommand("ffmpeg", args);
  
  // Verification
  if (!fs.existsSync(outputPath)) {
    throw new Error("Output file not created");
  }
  const stat = await fs.promises.stat(outputPath);
  if (stat.size === 0) {
    await fs.promises.unlink(outputPath);
    throw new Error("Output file is 0 bytes");
  }

  return { ok: true, size: stat.size };
}

// ----------------------------------------------------------------------------
// Queue System
// ----------------------------------------------------------------------------

class TaskQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.active >= this.concurrency || this.queue.length === 0) return;

    this.active++;
    const { fn, resolve, reject } = this.queue.shift();

    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.active--;
      this.process();
    }
  }
}

const queue = new TaskQueue(MAX_CONCURRENCY);
const taskCache = new Map();

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
  return e === ".jpg" || e === ".jpeg" || e === ".png" || e === ".gif";
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

// ----------------------------------------------------------------------------
// Hexo Filters
// ----------------------------------------------------------------------------

hexo.extend.filter.register(
  "after_render:html",
  async function (str, data) {
    // Basic validation
    if (!str || typeof str !== "string" || str.length === 0) return str;

    const pending = [];

    // Helper to process tags (img or div) is integrated into the loop below for async handling.


    // We need to capture all matches and decide what to do.
    // Since we need to wait for tasks to finish to know if we should use AVIF or Original,
    // we can't do simple synchronous replace.
    
    // Strategy: Find all matches, start tasks, wait for all tasks, THEN replace.
    
    const matches = [];
    
    // 1. <img> tags
    const imgRegex = /<img\b[^>]*>/gim;
    let match;
    while ((match = imgRegex.exec(str)) !== null) {
        matches.push({
            type: 'img',
            tag: match[0],
            index: match.index,
            attr: 'src'
        });
    }
    
    // 2. <div class="img-preloader">
    const divRegex = /<div\b[^>]*class="[^"]*img-preloader[^"]*"[^>]*>/gim;
    while ((match = divRegex.exec(str)) !== null) {
        matches.push({
            type: 'div',
            tag: match[0],
            index: match.index,
            attr: 'data-src'
        });
    }
    
    // Sort matches by index reverse to allow easy replacement without messing up indices? 
    // Actually, string slicing is better.
    matches.sort((a, b) => a.index - b.index);
    
    let result = "";
    let lastIndex = 0;
    
    for (const m of matches) {
        // Append text before this match
        result += str.slice(lastIndex, m.index);
        lastIndex = m.index + m.tag.length;
        
        // Process
        const tagContent = m.tag;
        const attrName = m.attr;
        
        // --- Same Logic as processTag but async-aware ---
        let newTag = null;
        
        // Skip if marked
        if (!/\bdata-no-avif\b/i.test(tagContent)) {
            const attrRegex = new RegExp(`\\b${attrName}\\s*=\\s*("|')([^"']*)\\1`, "i");
            const srcMatch = tagContent.match(attrRegex);
            
            if (srcMatch) {
                const originalSrc = srcMatch[2];
                // Checks...
                if (originalSrc && 
                    !/^data:|^blob:/i.test(originalSrc) && 
                    !/^https?:\/\//i.test(originalSrc) && !originalSrc.startsWith("//")) {
                        
                    const normalizedSrc = stripQueryAndHash(originalSrc);
                    const ext = path.extname(normalizedSrc).toLowerCase();
                    
                    if (isSupportedBitmap(ext)) {
                        const local = resolveSourceImagePath(normalizedSrc);
                        if (local) {
                            const { outputPath, url, routePath } = buildAvifPaths(local.rel);
                            const cacheKey = `${local.abs}|${outputPath}`;
                            
                            // Ensure task is running/cached
                            let task = taskCache.get(cacheKey);
                            if (!task) {
                                // Check disk cache
                                let isCached = false;
                                try {
                                    const inStat = fs.statSync(local.abs);
                                    const outStat = fs.statSync(outputPath);
                                    if (outStat.mtimeMs >= inStat.mtimeMs && outStat.size > 0) {
                                        isCached = true;
                                    }
                                } catch {}
                                
                                if (isCached) {
                                    hexo.route.set(routePath, () => fs.createReadStream(outputPath));
                                    task = Promise.resolve({ ok: true, skipped: "cached" });
                                } else {
                                    // Enqueue
                                    task = queue.enqueue(async () => {
                                        const outDir = path.dirname(outputPath);
                                        await fs.promises.mkdir(outDir, { recursive: true });
                                        try {
                                            const meta = await getImageMetadata(local.abs);
                                            const r = await encodeAvif(local.abs, outputPath, meta);
                                            hexo.log.info(`[redefine-x][avif] Generated: ${local.rel} -> ${routePath} (${(r.size/1024).toFixed(2)} KB)`);
                                            hexo.route.set(routePath, () => fs.createReadStream(outputPath));
                                            return { ok: true };
                                        } catch (err) {
                                            hexo.log.warn(`[redefine-x][avif] Failed: ${local.rel} -> ${err.message}`);
                                            return { ok: false };
                                        }
                                    });
                                }
                                taskCache.set(cacheKey, task);
                            }
                            
                            // Wait for result
                            const res = await task;
                            if (res.ok) {
                                newTag = tagContent.replace(srcMatch[0], `${attrName}="${url}"`);
                            }
                        }
                    }
                }
            }
        }
        
        result += newTag || tagContent;
    }
    
    result += str.slice(lastIndex);
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
      }
    }
  });

  if (deleted.length > 0) {
    hexo.log.info(`[redefine-x][avif] Removed ${deleted.length} original images from output routes.`);
    
    // CRITICAL FIX: Manually remove the files from public directory
    // because they might have been written before we removed the route.
    if (hexo.public_dir) {
        for (const route of deleted) {
            const publicPath = path.join(hexo.public_dir, route);
            if (fs.existsSync(publicPath)) {
                try {
                    fs.unlinkSync(publicPath);
                    // Try to remove empty parent directory? (Optional, skipping for safety)
                } catch (e) {
                    hexo.log.warn(`[redefine-x][avif] Failed to delete original file from public: ${publicPath}`);
                }
            }
        }
    }
  }
});

// Cleanup build dir on clean
hexo.extend.filter.register("after_clean", function () {
  if (hexo.env.args["exclude-minify"]) {
    hexo.log.info("[redefine-x][avif] Build directory cleanup skipped (--exclude-minify).");
    return;
  }

  const buildDir = path.join(hexo.source_dir || "", "build");
  try {
    fs.rmSync(buildDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
