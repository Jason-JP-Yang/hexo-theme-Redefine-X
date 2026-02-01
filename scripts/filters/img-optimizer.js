"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// ----------------------------------------------------------------------------
// Configuration Management
// ----------------------------------------------------------------------------

class ConfigManager {
  static get() {
    const config = hexo.theme.config.plugins?.minifier?.imagesOptimize || {};
    return {
      ENABLE_AVIF: config.AVIF_COMPRESS ?? true,
      ENABLE_SVG: config.SVGO_COMPRESS ?? false,
      MAX_PIXELS: config.IMG_MAX_PIXELS || 2073600, // 1920x1080 limit
      TARGET_CRF: config.AVIF_TARGET_CRF || 25,
      ENCODER_PRESET: config.ENCODER_PRESET || 4,
      MAX_CONCURRENCY: Math.max(1, Math.floor((os.cpus().length || 2) / 2))
    };
  }
}

// ----------------------------------------------------------------------------
// Core Processing Logic
// ----------------------------------------------------------------------------

class ImageProcessor {
  static async process(fileInfo) {
    const {
      absPath,
      outputPath,
      isBitmap,
      isSvg
    } = fileInfo;
    const outDir = path.dirname(outputPath);

    await fs.promises.mkdir(outDir, {
      recursive: true
    });

    if (isBitmap) {
      return await this.processAvif(absPath, outputPath);
    } else if (isSvg) {
      return await this.processSvg(absPath, outputPath);
    }
  }

  static async processAvif(inputPath, outputPath) {
    const config = ConfigManager.get();
    const meta = await this.getImageMetadata(inputPath);

    // Calculate scaling
    let targetWidth = meta.width;
    let targetHeight = meta.height;
    const pixels = meta.width * meta.height;

    if (pixels > config.MAX_PIXELS) {
      const scale = Math.sqrt(config.MAX_PIXELS / pixels);
      targetWidth = Math.floor(meta.width * scale);
      targetHeight = Math.floor(meta.height * scale);
    }

    // Ensure even dimensions for YUV420
    if (targetWidth % 2 !== 0) targetWidth -= 1;
    if (targetHeight % 2 !== 0) targetHeight -= 1;

    targetWidth = Math.max(2, targetWidth);
    targetHeight = Math.max(2, targetHeight);

    const args = [
      "-y",
      "-i", inputPath,
      "-vf", `scale=${targetWidth}:${targetHeight}:flags=lanczos`,
      "-c:v", "libsvtav1",
      "-crf", String(config.TARGET_CRF),
      "-preset", String(config.ENCODER_PRESET),
      "-pix_fmt", "yuv420p10le",
      "-svtav1-params", "tune=0",
      outputPath
    ];

    await this.runFfmpeg(args);

    if (!fs.existsSync(outputPath)) throw new Error("Output file not created");
    const stat = await fs.promises.stat(outputPath);
    if (stat.size === 0) {
      await fs.promises.unlink(outputPath);
      throw new Error("Output file is 0 bytes");
    }

    return {
      size: stat.size
    };
  }

  static async processSvg(inputPath, outputPath) {
    // Direct require as requested by user. 
    // Note: 'svgo' package exports CommonJS entry point via "require" condition in package.json
    const {
      optimize
    } = require("svgo");

    const svgData = await fs.promises.readFile(inputPath, "utf8");

    const result = optimize(svgData, {
      path: inputPath,
      multipass: true, // Enable multipass for better compression
      floatPrecision: 2, // Aggressive float precision
      plugins: [{
        name: "preset-default",
        params: {
          overrides: {
            removeViewBox: false, // Keep viewBox to avoid scaling issues
            // Aggressive cleanups
            cleanupIds: true,
            removeHiddenElems: true,
            removeEmptyText: true,
            convertShapeToPath: true,
            moveElemsAttrsToGroup: true,
            moveGroupAttrsToElems: true,
            collapseGroups: true,
            convertPathData: {
              floatPrecision: 2,
              transformPrecision: 2,
              makeArcs: undefined,
              noSpaceAfterFlags: true,
              forceAbsolutePath: false
            }
          }
        }
      },
        "removeDimensions", // Remove width/height if viewBox exists
        "reusePaths", // Re-use paths for better compression
        "removeOffCanvasPaths",
        "removeScriptElement", // Security
        "removeStyleElement" // Use attrs instead
      ]
    });

    if (result.error) {
      throw new Error(result.error);
    }

    await fs.promises.writeFile(outputPath, result.data);
    const stat = await fs.promises.stat(outputPath);
    return {
      size: stat.size
    };
  }

  static runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", args, {
        shell: false
      });
      let stderr = "";
      proc.stderr.on("data", (data) => (stderr += data));
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
      });
      proc.on("error", (err) => reject(err));
    });
  }

  static async getImageMetadata(inputPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", ["-i", inputPath], {
        shell: false
      });
      let stderr = "";
      proc.stderr.on("data", (data) => (stderr += data));
      proc.on("close", () => {
        const match = stderr.match(/Stream #\d+:\d+.*Video:.*?\s(\d+)x(\d+)/);
        if (match) {
          resolve({
            width: parseInt(match[1], 10),
            height: parseInt(match[2], 10)
          });
        } else {
          reject(new Error("Could not determine image dimensions"));
        }
      });
    });
  }
}

// ----------------------------------------------------------------------------
// Task Queue
// ----------------------------------------------------------------------------

class TaskQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
  }

  enqueue(taskFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        taskFn,
        resolve,
        reject
      });
      this.processNext();
    });
  }

  async processNext() {
    if (this.active >= this.concurrency || this.queue.length === 0) return;

    this.active++;
    const {
      taskFn,
      resolve,
      reject
    } = this.queue.shift();

    try {
      const result = await taskFn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.active--;
      this.processNext();
    }
  }
}

// ----------------------------------------------------------------------------
// Path & Route Utilities
// ----------------------------------------------------------------------------

class PathManager {
  static isSupportedBitmap(ext) {
    return [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext.toLowerCase());
  }

  static isSupportedSvg(ext) {
    return ext.toLowerCase() === ".svg";
  }

  static buildOptimizedPath(relPath, isBitmap) {
    const posixRel = relPath.replace(/\\/g, "/");
    const ext = path.posix.extname(posixRel);
    const base = path.posix.basename(posixRel, ext);
    const dir = path.posix.dirname(posixRel);
    const relDir = dir === "." ? "" : dir;

    const targetExt = isBitmap ? ".avif" : ext; // SVGs keep extension, bitmaps go to AVIF
    const outputRel = path.posix.join("build", relDir, `${base}${targetExt}`);
    const outputPath = path.join(hexo.source_dir || "", outputRel);

    return {
      outputRel,
      outputPath,
      routePath: outputRel
    };
  }

  static normalizeRootPath(src) {
    const s = String(src).trim();
    const siteRoot = hexo.config.root || "/";
    let rel = s;
    if (siteRoot !== "/" && rel.startsWith(siteRoot)) {
      rel = rel.slice(siteRoot.length);
      if (!rel.startsWith("/")) rel = `/${rel}`;
    }
    if (!rel.startsWith("/")) return null;
    return rel.replace(/^\/+/, "");
  }

  static resolveSourceImagePath(src) {
    const rel = this.normalizeRootPath(src);
    if (!rel || rel.toLowerCase().startsWith("build/")) return null;

    const decodedRel = (() => {
      try {
        return decodeURIComponent(rel);
      } catch {
        return rel;
      }
    })();

    let abs = path.join(hexo.source_dir || "", decodedRel);
    if (fs.existsSync(abs)) return {
      abs,
      rel: decodedRel
    };

    if (hexo.theme_dir) {
      abs = path.join(hexo.theme_dir, "source", decodedRel);
      if (fs.existsSync(abs)) return {
        abs,
        rel: decodedRel
      };
    }

    return null;
  }
}

// ----------------------------------------------------------------------------
// Main Plugin Logic
// ----------------------------------------------------------------------------

const successfulConversions = new Set();
const queue = new TaskQueue(2);

async function scanAndProcessAllImages() {
  const config = ConfigManager.get();
  if (!config.ENABLE_AVIF && !config.ENABLE_SVG) {
    hexo.log.debug("[minifier] Image optimization disabled.");
    return;
  }

  queue.concurrency = config.MAX_CONCURRENCY;
  hexo.log.debug("[minifier] Scanning images...");

  const files = await gatherFiles();
  hexo.log.debug(`[minifier] Found ${files.length} candidate files.`);

  const tasks = files.map(absPath => processFile(absPath, config));
  await Promise.all(tasks);

  hexo.log.debug(`[minifier] Processed ${tasks.length} images. ${successfulConversions.size} optimized.`);

  cleanupRoutes();
}

async function gatherFiles() {
  const sourceDir = hexo.source_dir;
  const themeSourceDir = hexo.theme_dir ? path.join(hexo.theme_dir, "source") : null;

  let files = await recursiveReadDir(sourceDir);
  if (themeSourceDir) {
    files = files.concat(await recursiveReadDir(themeSourceDir));
  }
  return files;
}

async function recursiveReadDir(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  const list = await fs.promises.readdir(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = await fs.promises.stat(filePath);
    if (stat && stat.isDirectory()) {
      if (file === "build") continue;
      results = results.concat(await recursiveReadDir(filePath));
    } else {
      results.push(filePath);
    }
  }
  return results;
}

async function processFile(absPath, config) {
  const ext = path.extname(absPath).toLowerCase();
  const isBitmap = PathManager.isSupportedBitmap(ext);
  const isSvg = PathManager.isSupportedSvg(ext);

  if ((!isBitmap && !isSvg) ||
    (isBitmap && !config.ENABLE_AVIF) ||
    (isSvg && !config.ENABLE_SVG)) {
    return;
  }

  let relPath;
  if (absPath.startsWith(hexo.source_dir)) {
    relPath = absPath.slice(hexo.source_dir.length);
  } else if (hexo.theme_dir && absPath.startsWith(path.join(hexo.theme_dir, "source"))) {
    relPath = absPath.slice(path.join(hexo.theme_dir, "source").length);
  } else {
    return;
  }

  if (relPath.startsWith(path.sep)) relPath = relPath.slice(1);
  relPath = relPath.replace(/\\/g, "/");

  if (relPath.startsWith("build/")) return;

  const {
    outputPath,
    routePath
  } = PathManager.buildOptimizedPath(relPath, isBitmap);

  await queue.enqueue(async () => {
    try {
      // Cache check
      try {
        const inStat = await fs.promises.stat(absPath);
        const outStat = await fs.promises.stat(outputPath);
        if (outStat.mtimeMs >= inStat.mtimeMs && outStat.size > 0) {
          hexo.route.set(routePath, () => fs.createReadStream(outputPath));
          successfulConversions.add(relPath);
          return;
        }
      } catch { }

      const res = await ImageProcessor.process({
        absPath,
        outputPath,
        isBitmap,
        isSvg
      });

      hexo.log.info(`[minifier] Generated: ${relPath} -> ${routePath} (${(res.size / 1024).toFixed(2)} KB)`);

      hexo.route.set(routePath, () => fs.createReadStream(outputPath));
      successfulConversions.add(relPath);
    } catch (err) {
      hexo.log.warn(`[minifier] Failed: ${relPath} -> ${err.message}`);
    }
  });
}

function cleanupRoutes() {
  const routes = hexo.route.list();
  let removed = 0;
  for (const relPath of successfulConversions) {
    if (hexo.route.get(relPath)) {
      hexo.route.remove(relPath);
      removed++;
    }
  }
  if (removed > 0) hexo.log.info(`[minifier] Removed ${removed} original images from routes.`);
}

// ----------------------------------------------------------------------------
// HTML Replacement
// ----------------------------------------------------------------------------

hexo.extend.filter.register("after_render:html", function (str) {
  if (!str || typeof str !== "string" || str.length === 0) return str;

  const processTag = (tagContent, attrName) => {
    if (/\bdata-no-avif\b/i.test(tagContent)) return null;

    const attrRegex = new RegExp(`\\b${attrName}\\s*=\\s*("|')([^"']*)\\1`, "i");
    const match = tagContent.match(attrRegex);
    if (!match) return null;

    const originalSrc = match[2];
    if (!originalSrc || /^data:|^blob:|^https?:\/\/|^\/\//i.test(originalSrc)) return null;

    const local = PathManager.resolveSourceImagePath(originalSrc.split("#")[0].split("?")[0]);
    if (!local) return null;

    const relKey = local.rel.replace(/\\/g, "/");
    if (successfulConversions.has(relKey)) {
      const ext = path.extname(local.rel);
      const isBitmap = PathManager.isSupportedBitmap(ext);
      const {
        routePath
      } = PathManager.buildOptimizedPath(local.rel, isBitmap);
      const url = encodeURI(path.posix.join(hexo.config.root || "/", routePath));
      return tagContent.replace(match[0], `${attrName}="${url}"`);
    }
    return null;
  };

  str = str.replace(/<img\b[^>]*>/gim, (tag) => processTag(tag, "src") || tag);
  str = str.replace(/<div\b[^>]*class="[^"]*img-preloader[^"]*"[^>]*>/gim, (tag) => processTag(tag, "data-src") || tag);

  return str;
});

// ----------------------------------------------------------------------------
// Hooks
// ----------------------------------------------------------------------------

hexo.extend.filter.register("before_generate", scanAndProcessAllImages);

hexo.extend.filter.register("after_generate", function () {
  // Safety Cleanup & Public Sync
  const toDelete = [];
  for (const relPath of successfulConversions) {
    if (hexo.route.get(relPath)) {
      hexo.route.remove(relPath);
      toDelete.push(relPath);
    }
  }
  if (toDelete.length > 0) hexo.log.debug(`[minifier] (Safety) Removed ${toDelete.length} originals.`);

  if (hexo.public_dir) {
    let cleaned = 0,
      synced = 0;
    for (const relPath of successfulConversions) {
      // Remove original from public
      const publicPath = path.join(hexo.public_dir, relPath);
      try {
        if (fs.existsSync(publicPath)) {
          fs.unlinkSync(publicPath);
          cleaned++;
        }
      } catch { }

      // Sync optimized to public
      const ext = path.extname(relPath);
      const isBitmap = PathManager.isSupportedBitmap(ext);
      const {
        outputPath,
        routePath
      } = PathManager.buildOptimizedPath(relPath, isBitmap);
      const publicDest = path.join(hexo.public_dir, routePath);

      if (!fs.existsSync(publicDest)) {
        try {
          const dir = path.dirname(publicDest);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, {
            recursive: true
          });
          fs.copyFileSync(outputPath, publicDest);
          synced++;
        } catch (e) {
          hexo.log.warn(`[minifier] Sync failed: ${routePath} - ${e.message}`);
        }
      }
    }
    if (cleaned > 0) hexo.log.info(`[minifier] Cleaned ${cleaned} files from public.`);
    if (synced > 0) hexo.log.info(`[minifier] Synced ${synced} optimized files to public.`);
  }
});

hexo.extend.filter.register("after_clean", function () {
  if (!hexo.env.args["include-minify"]) {
    hexo.log.info("[minifier] Build cleanup skipped (use --include-minify).");
    return;
  }
  const buildDir = path.join(hexo.source_dir || "", "build");
  try {
    fs.rmSync(buildDir, {
      recursive: true,
      force: true
    });
    hexo.log.info("[minifier] Cleaned build dir.");
  } catch { }
});