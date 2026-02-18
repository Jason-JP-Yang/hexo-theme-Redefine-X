"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// ----------------------------------------------------------------------------
// Configuration Management
// ----------------------------------------------------------------------------

/**
 * User-facing config:
 *   encoder: "sharp" | "libaom-av1" | "libsvtav1"  (default: "sharp")
 *   quality: 0-100   (0 = smallest file / worst quality, 100 = best quality)
 *   effort:  0-10    (0 = fastest / least CPU, 10 = slowest / best compression)
 *
 * Internally mapped to encoder-specific parameters.
 */
class ConfigManager {
  static get() {
    const config = hexo.theme.config.plugins?.minifier?.imagesOptimize || {};
    const encoder = (config.encoder || "sharp").toLowerCase().trim();
    const quality = Math.max(0, Math.min(100, config.quality ?? 65));
    const effort = Math.max(0, Math.min(10, config.effort ?? 5));
    const cpuCount = os.cpus().length || 4;

    return {
      ENABLE_AVIF: config.AVIF_COMPRESS ?? true,
      ENABLE_SVG: config.SVGO_COMPRESS ?? false,
      MAX_PIXELS: config.IMG_MAX_PIXELS || 2073600,
      EXCLUDE: config.EXCLUDE || [],
      encoder,
      quality,
      effort,
      // Derived encoder-specific params
      ...ConfigManager._deriveParams(encoder, quality, effort),
      // Concurrency: use all CPUs for sharp; half for ffmpeg (ffmpeg processes use multiple threads internally)
      MAX_CONCURRENCY: encoder === "sharp"
        ? Math.max(1, cpuCount - 1)
        : Math.max(1, Math.floor(cpuCount / 2)),
      CPU_COUNT: cpuCount,
    };
  }

  /**
   * Convert unified quality (0-100) and effort (0-10) to encoder-specific params.
   */
  static _deriveParams(encoder, quality, effort) {
    switch (encoder) {
      case "sharp":
        return {
          sharp_quality: quality,           // sharp avif quality: 1-100
          sharp_effort: Math.round(effort * 0.9), // sharp effort: 0-9
        };
      case "libaom-av1": {
        // CRF: quality 100 -> crf 0 (lossless-ish), quality 0 -> crf 63
        const crf = Math.round(63 - (quality / 100) * 63);
        // cpu-used: effort 0 -> 8 (fastest), effort 10 -> 0 (slowest/best)
        const cpuUsed = Math.round(8 - (effort / 10) * 8);
        return {
          aom_crf: crf,
          aom_cpuUsed: Math.max(0, Math.min(8, cpuUsed)),
        };
      }
      case "libsvtav1": {
        // CRF: quality 100 -> crf 0, quality 0 -> crf 63
        const crf = Math.round(63 - (quality / 100) * 63);
        // preset: effort 0 -> 12 (fastest), effort 10 -> 0 (slowest/best)
        // svtav1 preset range: 0-13, practical: 0-12
        const preset = Math.round(12 - (effort / 10) * 12);
        return {
          svt_crf: crf,
          svt_preset: Math.max(0, Math.min(12, preset)),
        };
      }
      default:
        return {};
    }
  }
}

// ----------------------------------------------------------------------------
// Image Metadata Utilities
// ----------------------------------------------------------------------------

class ImageMeta {
  /**
   * Detect image properties using ffprobe: dimensions, pixel format, frame count.
   */
  static async probe(inputPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,pix_fmt,nb_frames,codec_name,r_frame_rate",
        "-of", "json",
        inputPath,
      ], { shell: false });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("close", (code) => {
        try {
          const data = JSON.parse(stdout);
          const s = data.streams?.[0];
          if (!s) return reject(new Error("No video stream found"));
          const nbFrames = parseInt(s.nb_frames, 10);
          const isAnimated = nbFrames > 1;
          const hasAlpha = /rgba|bgra|pal8|ya|gbrap|yuva/i.test(s.pix_fmt || "");
          resolve({
            width: s.width,
            height: s.height,
            pixFmt: s.pix_fmt,
            codec: s.codec_name,
            nbFrames: isNaN(nbFrames) ? 1 : nbFrames,
            isAnimated,
            hasAlpha,
          });
        } catch {
          reject(new Error(`ffprobe parse error: ${stderr}`));
        }
      });
      proc.on("error", (err) => reject(err));
    });
  }
}

// ----------------------------------------------------------------------------
// Core Processing Logic
// ----------------------------------------------------------------------------

class ImageProcessor {
  static async process(fileInfo) {
    const { absPath, outputPath, isBitmap, isSvg } = fileInfo;
    const outDir = path.dirname(outputPath);
    await fs.promises.mkdir(outDir, { recursive: true });

    if (isBitmap) {
      return await this.processAvif(absPath, outputPath);
    } else if (isSvg) {
      return await this.processSvg(absPath, outputPath);
    }
  }

  static async processAvif(inputPath, outputPath) {
    const config = ConfigManager.get();
    const meta = await ImageMeta.probe(inputPath);

    // Determine effective encoder with fallback logic
    let encoder = config.encoder;

    // libsvtav1 cannot encode alpha; fall back to libaom-av1
    if (encoder === "libsvtav1" && meta.hasAlpha) {
      hexo.log.debug(`[minifier] ${path.basename(inputPath)}: libsvtav1 doesn't support alpha, falling back to libaom-av1`);
      encoder = "libaom-av1";
    }
    // libsvtav1 cannot encode animated sequences; fall back to libaom-av1
    if (encoder === "libsvtav1" && meta.isAnimated) {
      hexo.log.debug(`[minifier] ${path.basename(inputPath)}: libsvtav1 doesn't support animation, falling back to libaom-av1`);
      encoder = "libaom-av1";
    }
    // sharp cannot encode animated images to AVIF; fall back to libaom-av1
    if (encoder === "sharp" && meta.isAnimated) {
      hexo.log.debug(`[minifier] ${path.basename(inputPath)}: sharp doesn't support animated AVIF, falling back to libaom-av1`);
      encoder = "libaom-av1";
    }

    let result;
    if (encoder === "sharp") {
      result = await this._encodeSharp(inputPath, outputPath, meta, config);
    } else if (encoder === "libaom-av1") {
      result = await this._encodeLibaom(inputPath, outputPath, meta, config);
    } else {
      // libsvtav1
      result = await this._encodeSvtav1(inputPath, outputPath, meta, config);
    }

    // Validate output
    if (!fs.existsSync(outputPath)) throw new Error("Output file not created");
    const stat = await fs.promises.stat(outputPath);
    if (stat.size === 0) {
      await fs.promises.unlink(outputPath);
      throw new Error("Output file is 0 bytes");
    }
    return { size: stat.size };
  }

  // --------------------------------------------------------------------------
  // Sharp encoder
  // --------------------------------------------------------------------------
  static async _encodeSharp(inputPath, outputPath, meta, config) {
    const sharp = require("sharp");
    const { targetWidth, targetHeight } = this._calcScale(meta, config);

    let pipeline = sharp(inputPath);

    // Resize if needed
    if (targetWidth !== meta.width || targetHeight !== meta.height) {
      pipeline = pipeline.resize(targetWidth, targetHeight, {
        fit: "inside",
        withoutEnlargement: true,
        kernel: sharp.kernel.lanczos3,
      });
    }

    const info = await pipeline
      .avif({
        quality: config.sharp_quality,
        effort: config.sharp_effort,
      })
      .toFile(outputPath);

    return { size: info.size };
  }

  // --------------------------------------------------------------------------
  // libaom-av1 encoder (via ffmpeg)
  // --------------------------------------------------------------------------
  static async _encodeLibaom(inputPath, outputPath, meta, config) {
    const { targetWidth, targetHeight } = this._calcScale(meta, config);
    const cpuCount = config.CPU_COUNT;
    const cpuUsed = config.aom_cpuUsed ?? 4;
    const crf = config.aom_crf ?? 30;
    // tiles: split across available cores
    const tileCols = Math.min(4, Math.max(1, Math.floor(Math.log2(cpuCount))));
    const tileRows = Math.min(4, Math.max(1, Math.floor(Math.log2(cpuCount / tileCols))));

    const isStill = !meta.isAnimated;

    if (meta.hasAlpha && !meta.isAnimated) {
      // Alpha still image: dual-stream approach
      // IMPORTANT: "format=rgba" between scale and split prevents ffmpeg's
      // auto-negotiation from stripping alpha before alphaextract can use it.
      const alphaArgs = [
        "-y", "-i", inputPath,
        "-filter_complex",
        `[0]scale=${targetWidth}:${targetHeight}:flags=lanczos,format=rgba,split=2[main][alpha];[alpha]alphaextract[alpha]`,
        "-map", "[main]", "-map", "[alpha]",
        "-c:v:0", "libaom-av1",
        "-pix_fmt:0", "yuv420p",
        "-crf:0", String(crf),
        "-b:v:0", "0",
        "-cpu-used:0", String(cpuUsed),
        "-row-mt:0", "1",
        "-tiles:0", `${tileCols}x${tileRows}`,
        "-c:v:1", "libaom-av1",
        "-pix_fmt:1", "gray",
        "-crf:1", String(crf),
        "-b:v:1", "0",
        "-cpu-used:1", String(cpuUsed),
        "-aom-params:1", "matrix-coefficients=bt709",
        "-still-picture", "1",
        outputPath,
      ];
      try {
        await this.runFfmpeg(alphaArgs);
      } catch (alphaErr) {
        // Fallback: if alpha encoding fails, encode without alpha
        hexo.log.debug(`[minifier] ${path.basename(inputPath)}: alpha encoding failed, retrying without alpha: ${alphaErr.message.split('\n')[0]}`);
        try { await fs.promises.unlink(outputPath); } catch {}
        const fallbackArgs = [
          "-y", "-i", inputPath,
          "-vf", `scale=${targetWidth}:${targetHeight}:flags=lanczos`,
          "-c:v", "libaom-av1",
          "-pix_fmt", "yuv420p",
          "-crf", String(crf),
          "-b:v", "0",
          "-cpu-used", String(cpuUsed),
          "-row-mt", "1",
          "-tiles", `${tileCols}x${tileRows}`,
          "-still-picture", "1",
          outputPath,
        ];
        await this.runFfmpeg(fallbackArgs);
      }
    } else if (meta.hasAlpha && meta.isAnimated) {
      // Animated with alpha: drop alpha (animated AVIF alpha dual-stream is unreliable)
      hexo.log.debug(`[minifier] ${path.basename(inputPath)}: animated + alpha, encoding without alpha`);
      const args = [
        "-y", "-i", inputPath,
        "-vf", `scale=${targetWidth}:${targetHeight}:flags=lanczos`,
        "-c:v", "libaom-av1",
        "-pix_fmt", "yuv420p",
        "-crf", String(crf),
        "-b:v", "0",
        "-cpu-used", String(cpuUsed),
        "-row-mt", "1",
        "-tiles", `${tileCols}x${tileRows}`,
        outputPath,
      ];
      await this.runFfmpeg(args);
    } else {
      // No alpha
      const scaleFilter = `scale=${targetWidth}:${targetHeight}:flags=lanczos`;
      const args = [
        "-y", "-i", inputPath,
        "-vf", scaleFilter,
        "-c:v", "libaom-av1",
        "-pix_fmt", "yuv420p",
        "-crf", String(crf),
        "-b:v", "0",
        "-cpu-used", String(cpuUsed),
        "-row-mt", "1",
        "-tiles", `${tileCols}x${tileRows}`,
        ...(isStill ? ["-still-picture", "1"] : []),
        outputPath,
      ];
      await this.runFfmpeg(args);
    }
  }

  // --------------------------------------------------------------------------
  // libsvtav1 encoder (via ffmpeg) – no alpha, no animation
  // --------------------------------------------------------------------------
  static async _encodeSvtav1(inputPath, outputPath, meta, config) {
    const { targetWidth, targetHeight } = this._calcScale(meta, config);
    const cpuCount = config.CPU_COUNT;
    const preset = config.svt_preset ?? 4;
    const crf = config.svt_crf ?? 35;

    // SVT-AV1 threading: controls parallelism via -svtav1-params
    // lp = logical processors to use (pin-count); tile-rows/tile-columns for tiling
    const tileCols = Math.min(4, Math.max(0, Math.floor(Math.log2(cpuCount))));
    const tileRows = Math.min(4, Math.max(0, Math.floor(Math.log2(cpuCount / Math.max(1, 1 << tileCols)))));

    const svtParams = [
      "tune=0",
      `lp=${Math.max(1, cpuCount)}`,
      `tile-rows=${tileRows}`,
      `tile-columns=${tileCols}`,
    ].join(":");

    // Use 8-bit yuv420p to reduce memory (the 10le was causing OOM on large images)
    const args = [
      "-y", "-i", inputPath,
      "-vf", `scale=${targetWidth}:${targetHeight}:flags=lanczos`,
      "-c:v", "libsvtav1",
      "-crf", String(crf),
      "-preset", String(preset),
      "-pix_fmt", "yuv420p",
      "-svtav1-params", svtParams,
      outputPath,
    ];

    await this.runFfmpeg(args);
  }

  // --------------------------------------------------------------------------
  // Dimension calculation
  // --------------------------------------------------------------------------
  static _calcScale(meta, config) {
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

    return { targetWidth, targetHeight };
  }

  // --------------------------------------------------------------------------
  // SVG processing (unchanged)
  // --------------------------------------------------------------------------
  static async processSvg(inputPath, outputPath) {
    const { optimize } = require("svgo");
    const svgData = await fs.promises.readFile(inputPath, "utf8");

    const result = optimize(svgData, {
      path: inputPath,
      multipass: true,
      floatPrecision: 2,
      plugins: [{
        name: "preset-default",
        params: {
          overrides: {
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
              forceAbsolutePath: false,
            },
          },
        },
      },
        "removeDimensions",
        "reusePaths",
        "removeOffCanvasPaths",
        "removeScripts",
      ],
    });

    if (result.error) throw new Error(result.error);

    await fs.promises.writeFile(outputPath, result.data);
    const stat = await fs.promises.stat(outputPath);
    return { size: stat.size };
  }

  // --------------------------------------------------------------------------
  // FFmpeg runner
  // --------------------------------------------------------------------------
  static runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", args, { shell: false });
      let stderr = "";
      proc.stderr.on("data", (data) => (stderr += data));
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
      });
      proc.on("error", (err) => reject(err));
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
      this.queue.push({ taskFn, resolve, reject });
      this.processNext();
    });
  }

  async processNext() {
    if (this.active >= this.concurrency || this.queue.length === 0) return;

    this.active++;
    const { taskFn, resolve, reject } = this.queue.shift();

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

    // Try exact match first
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

    // Fallback: try .jpg <-> .jpeg alternative extension
    const ext = path.extname(decodedRel).toLowerCase();
    const altExtMap = { ".jpg": ".jpeg", ".jpeg": ".jpg" };
    const altExt = altExtMap[ext];
    if (altExt) {
      const altRel = decodedRel.slice(0, decodedRel.length - ext.length) + altExt;

      abs = path.join(hexo.source_dir || "", altRel);
      if (fs.existsSync(abs)) return { abs, rel: altRel };

      if (hexo.theme_dir) {
        abs = path.join(hexo.theme_dir, "source", altRel);
        if (fs.existsSync(abs)) return { abs, rel: altRel };
      }
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
  hexo.log.info(`[minifier] Encoder: ${config.encoder} | Quality: ${config.quality} | Effort: ${config.effort} | Concurrency: ${config.MAX_CONCURRENCY}`);
  hexo.log.debug("[minifier] Scanning images...");

  const files = await gatherFiles();
  hexo.log.info(`[minifier] Found ${files.length} candidate files.`);

  const tasks = files.map(absPath => processFile(absPath, config));
  await Promise.all(tasks);

  hexo.log.info(`[minifier] Processed ${tasks.length} images. ${successfulConversions.size} optimized.`);

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

  // Check EXCLUDE patterns
  const excludePatterns = config.EXCLUDE || [];
  const relPathWithSlash = "/" + relPath;
  for (const pattern of excludePatterns) {
    try {
      if (new RegExp(pattern).test(relPathWithSlash)) {
        hexo.log.debug(`[minifier] Excluded: ${relPath} (matched ${pattern})`);
        return;
      }
    } catch {
      // If pattern is not valid regex, do simple string match
      if (relPathWithSlash.includes(pattern)) {
        hexo.log.debug(`[minifier] Excluded: ${relPath} (matched ${pattern})`);
        return;
      }
    }
  }

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

function replaceImagesInHtml(str) {
  if (!str || typeof str !== "string" || str.length === 0) return str;

  const config = ConfigManager.get();

  const processTag = (tagContent, attrName) => {
    if (/\bdata-no-avif\b/i.test(tagContent)) return null;

    const attrRegex = new RegExp(`\\b${attrName}\\s*=\\s*("|')([^"']*)\\1`, "i");
    const match = tagContent.match(attrRegex);
    if (!match) return null;

    const originalSrc = match[2];
    if (!originalSrc || /^data:|^blob:|^https?:\/\/|^\/\//i.test(originalSrc)) return null;

    const local = PathManager.resolveSourceImagePath(originalSrc.split("#")[0].split("?")[0]);
    if (!local) return null;

    // Optimistic check: based on config only, independent of processing state
    const ext = path.extname(local.rel).toLowerCase();
    const isBitmap = PathManager.isSupportedBitmap(ext);
    const isSvg = PathManager.isSupportedSvg(ext);

    if ((!isBitmap && !isSvg) ||
      (isBitmap && !config.ENABLE_AVIF) ||
      (isSvg && !config.ENABLE_SVG)) {
      return null;
    }

    const { routePath } = PathManager.buildOptimizedPath(local.rel, isBitmap);
    const url = encodeURI(path.posix.join(hexo.config.root || "/", routePath));

    // Inject data-original-src to preserve the link to the original image
    return tagContent.replace(match[0], `${attrName}="${url}" data-original-src="${originalSrc}"`);
  };

  str = str.replace(/<img\b[^>]*>/gim, (tag) => processTag(tag, "src") || tag);
  // Match img-preloader div with either single or double quotes for class attribute
  str = str.replace(/<div\b[^>]*class=(["'])[^"']*img-preloader[^"']*\1[^>]*>/gim, (tag) => processTag(tag, "data-src") || tag);

  return str;
}

// Register filters
// 1. Run before img-handle (Priority 5)
hexo.extend.filter.register("after_post_render", function (data) {
  if (data.content) {
    data.content = replaceImagesInHtml(data.content);
  }
  return data;
}, 5);

// 2. Run for full page
hexo.extend.filter.register("after_render:html", replaceImagesInHtml);

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
