"use strict";

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

function isExternalOrDataUrl(src) {
  const s = String(src).trim();
  return (
    s.startsWith("data:") ||
    s.startsWith("blob:") ||
    /^https?:\/\//i.test(s) ||
    s.startsWith("//")
  );
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

        // Follow redirects
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
  // 1) Prefer explicit width/height in tag
  const fromTag = tryGetDimensionsFromTag(imgTag);
  if (fromTag) return fromTag;

  const s = String(src).trim();

  // 2) data: URL
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

  // 3) blob: URL can't be resolved at build time
  if (s.startsWith("blob:")) return null;

  // 4) Remote URL
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

  // 5) Local path
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

  // Normalize path segment from URL
  const siteRoot = hexo.config.root || "/";
  let rel = rawSrc;
  if (siteRoot !== "/" && rel.startsWith(siteRoot)) {
    rel = rel.slice(siteRoot.length);
  }
  rel = rel.replace(/^\//, "");

  // Some content may contain URI-encoded characters
  const relDecoded = (() => {
    try {
      return decodeURIComponent(rel);
    } catch {
      return rel;
    }
  })();

  const candidates = [];

  // 1) Site source dir: source/<rel>
  if (hexo.source_dir) {
    candidates.push(path.join(hexo.source_dir, relDecoded));
  }

  // 2) Theme source dir: themes/<theme>/source/<rel>
  if (hexo.theme_dir) {
    candidates.push(path.join(hexo.theme_dir, "source", relDecoded));
  }

  // 3) Relative to current post/page source file directory
  const sourcePath = data && (data.full_source || data.source);
  if (sourcePath) {
    const sourceFullPath = path.isAbsolute(sourcePath)
      ? sourcePath
      : path.join(hexo.source_dir || "", sourcePath);
    candidates.push(path.join(path.dirname(sourceFullPath), relDecoded));
  }

  // 4) If raw src itself is a relative path, also try from source dir directly
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

function makeInlineLoadingSvgDataUri(width, height) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  // Keep the markup minimal; encode into a data URI so it is 100% synchronous (no extra request).
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect x="0" y="0" rx="24" ry="24" width="${w}" height="${h}" style="fill: #e0e0e0;">` +
    `<animate attributeName="opacity" values="1;0.6;1" dur="1.5s" repeatCount="indefinite" />` +
    `</rect></svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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

      // Skip if already processed
      if (/\blazyload\b/i.test(imgTag) || /\bdata-src\b/i.test(imgTag)) {
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

      let dims = await getImageDimensions(originalSrc, imgTag, data);
      if (!dims || !dims.width || !dims.height) {
        dims = DEFAULT_FALLBACK_DIMENSIONS;
        if (hexo?.log?.warn) {
          hexo.log.warn(
            `[redefine-x][lazyload] Unable to detect image size, fallback to ${dims.width}x${dims.height}: ${originalSrc}`,
          );
        }
      }

      const placeholderSrc = makeInlineLoadingSvgDataUri(dims.width, dims.height);

      // Replace src with inline placeholder
      let out = imgTag.replace(/\bsrc\s*=\s*(["'])([^"']*)\1/i, function () {
        return `src="${placeholderSrc}"`;
      });

      // Inject lazyload + data-src + width/height (if missing)
      const inject = [];
      inject.push(" lazyload");
      inject.push(` data-src="${escapeHtmlAttr(originalSrc)}"`);

      if (!/\bwidth\s*=\s*/i.test(out)) {
        inject.push(` width="${dims.width}"`);
      }
      if (!/\bheight\s*=\s*/i.test(out)) {
        inject.push(` height="${dims.height}"`);
      }

      out = out.replace(/\s*\/?>\s*$/i, function (tagEnd) {
        return `${inject.join("")}${tagEnd}`;
      });

      result += out;
    }

    result += data.content.slice(lastIndex);
    data.content = result;

    return data;
  },
  1,
);
