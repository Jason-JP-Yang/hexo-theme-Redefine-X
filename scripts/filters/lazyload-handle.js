"use strict";

/**
 * Redefine-X Image Preloader - Build Phase
 * 
 * This filter transforms <img> tags into <div class="img-preloader"> containers
 * that will be processed by JavaScript at runtime for progressive loading.
 */

const fs = require("fs");
const path = require("path");
const imageSize = require("image-size");
const http = require("http");
const https = require("https");

const DEFAULT_FALLBACK_DIMENSIONS = { width: 1000, height: 500 };
const REMOTE_MAX_BYTES = 12 * 1024 * 1024; // 12MB safety cap
const REMOTE_TIMEOUT_MS = 8000;
const REMOTE_MAX_REDIRECTS = 3;

const remoteSizeCache = new Map();

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/\"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripQueryAndHash(url) {
  return String(url).split("#")[0].split("?")[0];
}

function normalizeRemoteUrl(src) {
  const s = String(src).trim();
  if (s.startsWith("//")) return `https:${s}`;
  return s;
}

function decodeDataUrlToBuffer(src) {
  const s = String(src);
  if (!s.startsWith("data:")) return null;
  const commaIndex = s.indexOf(",");
  if (commaIndex === -1) return null;
  const meta = s.slice(5, commaIndex);
  const data = s.slice(commaIndex + 1);
  const isBase64 = /;base64/i.test(meta);
  try {
    return isBase64
      ? Buffer.from(data, "base64")
      : Buffer.from(decodeURIComponent(data), "utf8");
  } catch {
    return null;
  }
}

function fetchUrlBuffer(urlString, redirectsLeft = REMOTE_MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (e) {
      reject(e);
      return;
    }

    const client = parsed.protocol === "http:" ? http : https;
    const req = client.request(
      parsed,
      {
        method: "GET",
        headers: {
          "User-Agent": "hexo-redefine-x-lazyload/1.0",
          Accept: "image/*,*/*;q=0.8",
        },
      },
      (res) => {
        const status = res.statusCode || 0;

        if (
          [301, 302, 303, 307, 308].includes(status) &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).toString();
          fetchUrlBuffer(nextUrl, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }

        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > REMOTE_MAX_BYTES) {
            req.destroy(new Error("Remote image too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );

    req.setTimeout(REMOTE_TIMEOUT_MS, () => {
      req.destroy(new Error("Remote image request timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

async function getImageDimensions(src, imgTag, data) {
  const fromTag = tryGetDimensionsFromTag(imgTag);
  if (fromTag) return fromTag;

  const s = String(src).trim();

  if (s.startsWith("data:")) {
    const buffer = decodeDataUrlToBuffer(s);
    if (buffer) {
      try {
        const size = imageSize(buffer);
        if (size && size.width && size.height) return { width: size.width, height: size.height };
      } catch {
        // ignore
      }
    }
    return null;
  }

  if (s.startsWith("blob:")) return null;

  if (/^https?:\/\//i.test(s) || s.startsWith("//")) {
    const normalized = normalizeRemoteUrl(s);
    if (!remoteSizeCache.has(normalized)) {
      remoteSizeCache.set(
        normalized,
        (async () => {
          const buffer = await fetchUrlBuffer(normalized);
          const size = imageSize(buffer);
          if (size && size.width && size.height) return { width: size.width, height: size.height };
          return null;
        })(),
      );
    }

    try {
      return await remoteSizeCache.get(normalized);
    } catch {
      return null;
    }
  }

  const localPath = resolveLocalImagePath(s, data);
  if (localPath) {
    try {
      const size = imageSize(localPath);
      if (size && size.width && size.height) return { width: size.width, height: size.height };
    } catch {
      // ignore
    }
  }

  return null;
}

function resolveLocalImagePath(src, data) {
  const rawSrc = stripQueryAndHash(src);

  const siteRoot = hexo.config.root || "/";
  let rel = rawSrc;
  if (siteRoot !== "/" && rel.startsWith(siteRoot)) {
    rel = rel.slice(siteRoot.length);
  }
  rel = rel.replace(/^\//, "");

  const relDecoded = (() => {
    try {
      return decodeURIComponent(rel);
    } catch {
      return rel;
    }
  })();

  const candidates = [];

  if (hexo.source_dir) {
    candidates.push(path.join(hexo.source_dir, relDecoded));
  }

  if (hexo.theme_dir) {
    candidates.push(path.join(hexo.theme_dir, "source", relDecoded));
  }

  const sourcePath = data && (data.full_source || data.source);
  if (sourcePath) {
    const sourceFullPath = path.isAbsolute(sourcePath)
      ? sourcePath
      : path.join(hexo.source_dir || "", sourcePath);
    candidates.push(path.join(path.dirname(sourceFullPath), relDecoded));
  }

  if (hexo.source_dir && !rawSrc.startsWith("/")) {
    const rawDecoded = (() => {
      try {
        return decodeURIComponent(rawSrc);
      } catch {
        return rawSrc;
      }
    })();
    candidates.push(path.join(hexo.source_dir, rawDecoded));
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function tryGetDimensionsFromTag(imgTag) {
  const widthMatch = imgTag.match(/\bwidth\s*=\s*(["']?)(\d+)\1/i);
  const heightMatch = imgTag.match(/\bheight\s*=\s*(["']?)(\d+)\1/i);
  const width = widthMatch ? Number(widthMatch[2]) : null;
  const height = heightMatch ? Number(heightMatch[2]) : null;
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }
  return null;
}

/**
 * Extract alt text from img tag
 */
function extractAltText(imgTag) {
  const altMatch = imgTag.match(/\balt\s*=\s*(["'])([^"']*)\1/i);
  return altMatch ? altMatch[2] : "";
}

/**
 * Extract class from img tag
 */
function extractClass(imgTag) {
  const classMatch = imgTag.match(/\bclass\s*=\s*(["'])([^"']*)\1/i);
  return classMatch ? classMatch[2] : "";
}

/**
 * Build the img-preloader div container
 */
function buildPreloaderDiv(src, dims, alt, originalClass) {
  const w = dims.width;
  const h = dims.height;
  const aspectRatio = (w / h).toFixed(6);
  
  const classes = ["img-preloader"];
  if (originalClass) {
    classes.push(originalClass);
  }

  return `<div class="${classes.join(" ")}" ` +
    `data-src="${escapeHtmlAttr(src)}" ` +
    `data-width="${w}" ` +
    `data-height="${h}" ` +
    `data-alt="${escapeHtmlAttr(alt)}" ` +
    `style="aspect-ratio: ${aspectRatio}; max-width: 100%;">` +
    `<svg viewBox="0 0 ${w} ${h}" class="img-preloader-shim" style="width: 100%; height: auto; display: block; opacity: 0; pointer-events: none;"></svg>` +
    `<div class="img-preloader-skeleton"></div>` +
    `</div>`;
}

hexo.extend.filter.register(
  "after_post_render",
  async function (data) {
    const theme = hexo.theme.config;
    if (!theme?.articles?.lazyload) return data;
    if (!data || typeof data.content !== "string" || data.content.length === 0) return data;

    const imgRegex = /<img\b[^>]*>/gim;
    let result = "";
    let lastIndex = 0;
    let match;

    while ((match = imgRegex.exec(data.content)) !== null) {
      const imgTag = match[0];
      const start = match.index;
      const end = imgRegex.lastIndex;
      result += data.content.slice(lastIndex, start);
      lastIndex = end;

      // Skip if marked with data-no-lazyload
      if (/\bdata-no-lazyload\b/i.test(imgTag)) {
        result += imgTag;
        continue;
      }

      const srcMatch = imgTag.match(/\bsrc\s*=\s*(["'])([^"']*)\1/i);
      if (!srcMatch) {
        result += imgTag;
        continue;
      }

      const originalSrc = srcMatch[2];
      if (!originalSrc) {
        result += imgTag;
        continue;
      }

      // Skip data: URLs (already inline) and blob: URLs
      if (originalSrc.startsWith("data:") || originalSrc.startsWith("blob:")) {
        result += imgTag;
        continue;
      }

      let dims = await getImageDimensions(originalSrc, imgTag, data);
      if (!dims || !dims.width || !dims.height) {
        dims = DEFAULT_FALLBACK_DIMENSIONS;
        if (hexo?.log?.warn) {
          hexo.log.warn(
            `[redefine-x][lazyload] Unable to detect image size, fallback to ${dims.width}x${dims.height}: ${originalSrc}`,
          );
        }
      }

      const alt = extractAltText(imgTag);
      const originalClass = extractClass(imgTag);
      
      // Replace <img> with <div class="img-preloader">
      const preloaderDiv = buildPreloaderDiv(originalSrc, dims, alt, originalClass);
      result += preloaderDiv;
    }

    result += data.content.slice(lastIndex);
    data.content = result;

    return data;
  },
  20,
);
