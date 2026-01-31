"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// Configuration
// We read configuration from hexo.theme.config.plugins.minifier.imagesOptimize
// Defaults are provided if config is missing
const getConfig = () => {
    const config = hexo.theme.config.plugins?.minifier?.imagesOptimize || {};
    return {
        ENABLE: config.AVIF_COMPRESS ?? true,
        MAX_PIXELS: config.IMG_MAX_PIXELS || 2073600, // 1920x1080 limit
        TARGET_CRF: config.AVIF_TARGET_CRF || 25, // "25%" quality/compression balance
        ENCODER_PRESET: config.ENCODER_PRESET || 4, // Prioritize quality
        MAX_CONCURRENCY: Math.max(1, Math.floor((os.cpus().length || 2) / 2))
    };
};

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
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", ["-i", inputPath], { shell: false });
      let stderr = "";
      proc.stderr.on("data", (data) => (stderr += data));
      proc.on("close", () => {
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
  const config = getConfig();
  
  // Calculate scaling
  let targetWidth = width;
  let targetHeight = height;
  const pixels = width * height;
  
  if (pixels > config.MAX_PIXELS) {
    const scale = Math.sqrt(config.MAX_PIXELS / pixels);
    targetWidth = Math.floor(width * scale);
    targetHeight = Math.floor(height * scale);
  }

  // Ensure even dimensions for YUV420
  if (targetWidth % 2 !== 0) targetWidth -= 1;
  if (targetHeight % 2 !== 0) targetHeight -= 1;
  
  targetWidth = Math.max(2, targetWidth);
  targetHeight = Math.max(2, targetHeight);

  // Prepare args
  const args = [
    "-y", // Overwrite
    "-i", inputPath,
    "-vf", `scale=${targetWidth}:${targetHeight}:flags=lanczos`,
    "-c:v", "libsvtav1",
    "-crf", String(config.TARGET_CRF),
    "-preset", String(config.ENCODER_PRESET),
    "-pix_fmt", "yuv420p10le",
    "-svtav1-params", "tune=0",
    outputPath
  ];

  await runCommand("ffmpeg", args);
  
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

const queue = new TaskQueue(Math.max(1, Math.floor((os.cpus().length || 2) / 2)));
// Global set to track successfully processed source files (relative paths)
const successfulConversions = new Set();

// ----------------------------------------------------------------------------
// Helpers & Path Logic
// ----------------------------------------------------------------------------

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
  return e === ".jpg" || e === ".jpeg" || e === ".png" || e === ".gif" || e === ".webp";
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

function resolveSourceImagePath(src) {
    const rel = normalizeRootPath(src);
    if (!rel) return null;
    if (rel.toLowerCase().startsWith("build/")) return null;
  
    const decodedRel = (() => {
      try { return decodeURIComponent(rel); } catch { return rel; }
    })();
  
    // Check successful conversions first
    // This allows us to know if we have a valid AVIF for this source
    // We check both direct match or if file exists on disk
    
    // Logic: 
    // 1. Check if file exists in source or theme
    // 2. Return absolute path
    
    let abs = path.join(hexo.source_dir || "", decodedRel);
    if (abs && fs.existsSync(abs)) return { abs, rel: decodedRel };
  
    if (hexo.theme_dir) {
      abs = path.join(hexo.theme_dir, "source", decodedRel);
      if (abs && fs.existsSync(abs)) return { abs, rel: decodedRel };
    }
  
    return null;
}

// ----------------------------------------------------------------------------
// Phase 1: Pre-process ALL images before generation
// ----------------------------------------------------------------------------

async function scanAndProcessAllImages() {
    const config = getConfig();
    if (!config.ENABLE) {
        hexo.log.debug("[redefine-x][avif] AVIF compression disabled in config.");
        return;
    }
    
    // Update queue concurrency if needed (optional, here we just set it initially)
    queue.concurrency = config.MAX_CONCURRENCY;

    hexo.log.info("[redefine-x][avif] Scanning and processing all source images...");
    
    const sourceDir = hexo.source_dir;
    const themeSourceDir = hexo.theme_dir ? path.join(hexo.theme_dir, "source") : null;
    
    // Recursive file finder
    async function getFiles(dir) {
        let results = [];
        if (!fs.existsSync(dir)) return results;
        
        const list = await fs.promises.readdir(dir);
        for (const file of list) {
            const filePath = path.join(dir, file);
            const stat = await fs.promises.stat(filePath);
            if (stat && stat.isDirectory()) {
                // Skip build dir to avoid recursion loop
                if (file === "build") continue;
                results = results.concat(await getFiles(filePath));
            } else {
                results.push(filePath);
            }
        }
        return results;
    }

    let files = await getFiles(sourceDir);
    if (themeSourceDir) {
        files = files.concat(await getFiles(themeSourceDir));
    }

    const tasks = [];

    for (const absPath of files) {
        const ext = path.extname(absPath).toLowerCase();
        if (!isSupportedBitmap(ext)) continue;

        // Determine relative path for Hexo
        let relPath;
        if (absPath.startsWith(sourceDir)) {
            relPath = absPath.slice(sourceDir.length);
        } else if (themeSourceDir && absPath.startsWith(themeSourceDir)) {
            relPath = absPath.slice(themeSourceDir.length);
        } else {
            continue;
        }
        
        // Normalize relPath
        if (relPath.startsWith(path.sep)) relPath = relPath.slice(1);
        relPath = relPath.replace(/\\/g, "/"); // Ensure POSIX for consistency
        
        // Skip if inside build/ (double safety)
        if (relPath.startsWith("build/")) continue;

        const { outputPath, routePath } = buildAvifPaths(relPath);

        // Enqueue Task
        const task = queue.enqueue(async () => {
             // Check cache
             try {
                const inStat = await fs.promises.stat(absPath);
                // Check if output exists
                try {
                    const outStat = await fs.promises.stat(outputPath);
                    if (outStat.mtimeMs >= inStat.mtimeMs && outStat.size > 0) {
                        // Cached
                        hexo.route.set(routePath, () => fs.createReadStream(outputPath));
                        successfulConversions.add(relPath);
                        return;
                    }
                } catch {}
             } catch (e) {
                 return; // Input missing?
             }

             // Generate
             const outDir = path.dirname(outputPath);
             await fs.promises.mkdir(outDir, { recursive: true });

             try {
                 const meta = await getImageMetadata(absPath);
                 const res = await encodeAvif(absPath, outputPath, meta);
                 
                 hexo.log.info(`[redefine-x][avif] Generated: ${relPath} -> ${routePath} (${(res.size/1024).toFixed(2)} KB)`);
                 
                 // Register route
                 hexo.route.set(routePath, () => fs.createReadStream(outputPath));
                 successfulConversions.add(relPath);
                 
             } catch (err) {
                 hexo.log.warn(`[redefine-x][avif] Failed: ${relPath} -> ${err.message}`);
                 // Do NOT add to successfulConversions -> Original will be kept
             }
        });
        
        tasks.push(task);
    }

    await Promise.all(tasks);
    hexo.log.info(`[redefine-x][avif] Processed ${tasks.length} images. ${successfulConversions.size} AVIFs ready.`);
    
    // IMMEDIATE CLEANUP: Remove original routes NOW if possible
    // Hexo might not have loaded routes yet if this is before_generate?
    // But 'before_generate' runs after load. So routes should exist.
    const routes = hexo.route.list();
    let removedCount = 0;
    
    // We iterate successful conversions and remove their original counterparts
    for (const relPath of successfulConversions) {
        // Hexo routes usually match the relative path (e.g. "images/foo.jpg")
        // Our relPath is "images/foo.jpg" (POSIX)
        // Check if route exists
        if (hexo.route.get(relPath)) {
             hexo.route.remove(relPath);
             removedCount++;
        }
    }
    
    if (removedCount > 0) {
        hexo.log.info(`[redefine-x][avif] Prevented ${removedCount} original images from being output.`);
    }
}

hexo.extend.filter.register("before_generate", scanAndProcessAllImages);

// ----------------------------------------------------------------------------
// Phase 2: HTML Replacement (Simplified)
// ----------------------------------------------------------------------------

hexo.extend.filter.register("after_render:html", function (str, data) {
    if (!str || typeof str !== "string" || str.length === 0) return str;

    // Synchronous replacement logic since files are already processed
    // We rely on 'successfulConversions' Set or checking route existence
    
    const processTag = (tagContent, attrName) => {
        if (/\bdata-no-avif\b/i.test(tagContent)) return null;

        const attrRegex = new RegExp(`\\b${attrName}\\s*=\\s*("|')([^"']*)\\1`, "i");
        const match = tagContent.match(attrRegex);
        if (!match) return null;

        const originalSrc = match[2];
        if (!originalSrc || /^data:|^blob:|^https?:\/\/|^\/\//i.test(originalSrc)) return null;

        const normalizedSrc = stripQueryAndHash(originalSrc);
        const ext = path.extname(normalizedSrc).toLowerCase();
        if (!isSupportedBitmap(ext)) return null;

        // Resolve local file to get relative path
        const local = resolveSourceImagePath(normalizedSrc);
        if (!local) return null;

        // Check if we successfully converted this file
        // local.rel is the key we stored in successfulConversions
        // Note: successfulConversions stores POSIX paths
        const relKey = local.rel.replace(/\\/g, "/");
        
        if (successfulConversions.has(relKey)) {
             const { url } = buildAvifPaths(local.rel);
             return tagContent.replace(match[0], `${attrName}="${url}"`);
        }
        
        return null;
    };

    // Replace <img>
    str = str.replace(/<img\b[^>]*>/gim, (tag) => {
        return processTag(tag, "src") || tag;
    });

    // Replace <div class="img-preloader">
    str = str.replace(/<div\b[^>]*class="[^"]*img-preloader[^"]*"[^>]*>/gim, (tag) => {
        return processTag(tag, "data-src") || tag;
    });

    return str;
});

// ----------------------------------------------------------------------------
// Phase 3: Cleanup Hook (Double Safety)
// ----------------------------------------------------------------------------

hexo.extend.filter.register("after_generate", function () {
    // This hook is now a safety net. 
    // Most removals should happen in 'before_generate'.
    // But if Hexo added routes back (unlikely for source files if removed?), we check again.
    
    const routes = hexo.route.list();
    const toDelete = [];
    
    for (const relPath of successfulConversions) {
        if (hexo.route.get(relPath)) {
            hexo.route.remove(relPath);
            toDelete.push(relPath);
        }
    }

    if (toDelete.length > 0) {
         hexo.log.info(`[redefine-x][avif] (Safety) Removed ${toDelete.length} original images from routes.`);
    }
    
    // Explicitly clean up public folder for any originals that might have slipped through
    // or existed from previous runs if 'clean' wasn't run.
    if (hexo.public_dir) {
        let cleaned = 0;
        let synced = 0;

        // 1. Remove originals from public
        for (const relPath of successfulConversions) {
            const publicPath = path.join(hexo.public_dir, relPath);
            if (fs.existsSync(publicPath)) {
                try {
                    fs.unlinkSync(publicPath);
                    cleaned++;
                } catch {}
            }
        }

        // 2. Ensure AVIFs exist in public (Fix for first-run issue)
        for (const relPath of successfulConversions) {
            const { outputRel, outputPath } = buildAvifPaths(relPath);
            const publicAvifPath = path.join(hexo.public_dir, outputRel);
            
            if (!fs.existsSync(publicAvifPath)) {
                try {
                    const publicDir = path.dirname(publicAvifPath);
                    if (!fs.existsSync(publicDir)) {
                        fs.mkdirSync(publicDir, { recursive: true });
                    }
                    fs.copyFileSync(outputPath, publicAvifPath);
                    synced++;
                } catch (e) {
                    hexo.log.warn(`[redefine-x][avif] Failed to sync AVIF to public: ${outputRel} - ${e.message}`);
                }
            }
        }

        if (cleaned > 0) {
            hexo.log.info(`[redefine-x][avif] Cleaned ${cleaned} original files from public folder.`);
        }
        if (synced > 0) {
            hexo.log.info(`[redefine-x][avif] Manually synced ${synced} AVIF files to public folder.`);
        }
    }
});

// Cleanup build dir on clean
hexo.extend.filter.register("after_clean", function () {
  if (!hexo.env.args["include-minify"]) {
    hexo.log.info("[redefine-x][avif] Build directory cleanup skipped (use --include-minify to clean).");
    return;
  }

  const buildDir = path.join(hexo.source_dir || "", "build");
  try {
    fs.rmSync(buildDir, { recursive: true, force: true });
    hexo.log.info("[redefine-x][avif] Cleaned build directory.");
  } catch {
    // ignore
  }
});
