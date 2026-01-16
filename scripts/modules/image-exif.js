"use strict";

/**
 * Module: Image with EXIF
 * hexo-theme-redefine-x
 * 
 * Usage:
 * {% exifimage [title] [auto-exif: bool (optional, default true)] %}
 * ![Description](path/to/image)
 * <!-- exif-info
 * Make:
 * Model:
 * LensModel:
 * ExposureTime:
 * Aperture:
 * ISOSpeedRatings:
 * FocalLength: 50mm
 * ExposureProgram: 
 * MeteringMode: 
 * Flash: 
 * DateTimeOriginal: 
 * GPSLatitude: 
 * GPSLongitude: 
 * GPSAltitude:
 * WhiteBalance: 
 * FocusMode: 
 * ExposureBias: 
 * -->
 * {% endexifimage %}
 * 
 * NOTE: Uses HTML comment syntax (<!-- exif-info ... -->) instead of code blocks
 * to avoid Hexo's code block preprocessing which replaces them with placeholders.
 */

const fs = require("fs");
const path = require("path");

// Try to load exif-parser, if not available, auto-exif will be disabled
let ExifParser = null;
try {
  ExifParser = require("exif-parser");
} catch (e) {
  // exif-parser not installed
}

// EXIF field mapping for different camera brands
const EXIF_FIELD_MAPPINGS = {
  Make: ["Make", "make", "CameraMake"],
  Model: ["Model", "model", "CameraModel"],
  LensModel: ["LensModel", "LensInfo", "Lens", "lensModel", "LensType"],
  ExposureTime: ["ExposureTime", "exposureTime", "ShutterSpeed", "ShutterSpeedValue"],
  Aperture: ["FNumber", "ApertureValue", "Aperture", "aperture", "fNumber"],
  ISOSpeedRatings: ["ISO", "ISOSpeedRatings", "isoSpeedRatings", "PhotographicSensitivity"],
  FocalLength: ["FocalLength", "focalLength", "FocalLengthIn35mmFormat"],
  ExposureProgram: ["ExposureProgram", "exposureProgram"],
  MeteringMode: ["MeteringMode", "meteringMode"],
  Flash: ["Flash", "flash", "FlashMode"],
  DateTimeOriginal: ["DateTimeOriginal", "dateTimeOriginal", "CreateDate", "DateCreated"],
  GPSLatitude: ["GPSLatitude", "gpsLatitude", "latitude"],
  GPSLongitude: ["GPSLongitude", "gpsLongitude", "longitude"],
  GPSAltitude: ["GPSAltitude", "gpsAltitude", "altitude"],
  WhiteBalance: ["WhiteBalance", "whiteBalance"],
  FocusMode: ["FocusMode", "focusMode", "AFMode"],
  ExposureBias: ["ExposureBiasValue", "ExposureCompensation", "exposureBias", "exposureCompensation"],
};

// Exposure program mapping
const EXPOSURE_PROGRAM_MAP = {
  0: "未定义",
  1: "手动",
  2: "自动",
  3: "光圈优先",
  4: "快门优先",
  5: "创意程序",
  6: "动作程序",
  7: "肖像模式",
  8: "风景模式",
};

// Metering mode mapping
const METERING_MODE_MAP = {
  0: "未知",
  1: "平均测光",
  2: "中央重点",
  3: "点测光",
  4: "多点测光",
  5: "评价测光",
  6: "局部测光",
  255: "其他",
};

// Flash mode mapping
const FLASH_MODE_MAP = {
  0: "未闪光",
  1: "闪光",
  5: "闪光（无返回光）",
  7: "闪光（有返回光）",
  8: "禁止闪光",
  9: "强制闪光",
  13: "强制闪光（无返回光）",
  15: "强制闪光（有返回光）",
  16: "未闪光（强制禁止）",
  24: "自动（未闪光）",
  25: "自动闪光",
  29: "自动（无返回光）",
  31: "自动（有返回光）",
};

// White balance mapping
const WHITE_BALANCE_MAP = {
  0: "自动",
  1: "手动",
};

/**
 * Parse arguments from tag
 */
function parseArgs(args) {
  let title = "";
  let autoExif = true;

  const argsStr = args.join(" ");

  // Check for auto-exif parameter
  const autoExifMatch = argsStr.match(/auto-exif\s*:\s*(true|false)/i);
  if (autoExifMatch) {
    autoExif = autoExifMatch[1].toLowerCase() === "true";
  }

  // Extract title (everything before auto-exif or the whole string)
  const titlePart = argsStr.replace(/auto-exif\s*:\s*(true|false)/i, "").trim();
  if (titlePart) {
    title = titlePart;
  }

  return { title, autoExif };
}

/**
 * Validate content structure - must contain exactly one image and optionally one exif-info comment
 */
function validateContent(content, hexoLog) {
  // Check for markdown image pattern
  const imageMatches = content.match(/!\[([^\]]*)\]\(([^)]+)\)/g);

  if (!imageMatches || imageMatches.length === 0) {
    throw new Error("[image-exif] 内容必须包含一张图片。请使用 ![description](path/to/image) 格式。");
  }

  if (imageMatches.length > 1) {
    throw new Error("[image-exif] 内容只能包含一张图片，检测到 " + imageMatches.length + " 张图片。");
  }

  // Check for exif-info comment block
  const exifInfoMatches = content.match(/<!--\s*exif-info\s*\n[\s\S]*?-->/g);

  if (exifInfoMatches && exifInfoMatches.length > 1) {
    throw new Error("[image-exif] 内容最多只能包含一个 exif-info 块，检测到 " + exifInfoMatches.length + " 个。");
  }

  // Check for other content that shouldn't be there
  const cleanedContent = content
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "")           // Remove image
    .replace(/<!--\s*exif-info\s*\n[\s\S]*?-->/g, "")   // Remove exif-info comment
    .replace(/<!--[^>]*-->/g, "")                       // Remove other HTML comments (Hexo placeholders)
    .trim();

  if (cleanedContent.length > 0) {
    // Check if remaining content is just whitespace or newlines
    const meaningfulContent = cleanedContent.replace(/\s+/g, "");
    if (meaningfulContent.length > 0) {
      throw new Error("[image-exif] 内容只能包含一张图片和一个可选的 exif-info 块，发现额外内容: " + cleanedContent.substring(0, 50) + "...");
    }
  }

  return true;
}

/**
 * Extract image info from markdown
 */
function extractImageInfo(content) {
  const imageMatch = content.match(/!\[([^\]]*)\]\(([^)]+)\)/);
  if (!imageMatch) return null;

  return {
    description: imageMatch[1] || "",
    path: imageMatch[2],
  };
}

/**
 * Extract custom exif-info from HTML comment block
 */
function extractCustomInfo(content) {
  // Match <!-- exif-info ... --> pattern
  const commentMatch = content.match(/<!--\s*exif-info\s*\n([\s\S]*?)-->/);
  if (!commentMatch) return {};

  const lines = commentMatch[1].split("\n");
  const info = {};

  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.substring(0, colonIndex).trim();
    const value = line.substring(colonIndex + 1).trim();

    if (key && value) {
      info[key] = value;
    }
  }

  return info;
}

/**
 * Resolve local image path
 */
function resolveLocalImagePath(src, hexo, data) {
  const rawSrc = src.split("#")[0].split("?")[0];

  const siteRoot = hexo.config.root || "/";
  let rel = rawSrc;
  if (siteRoot !== "/" && rel.startsWith(siteRoot)) {
    rel = rel.slice(siteRoot.length);
  }
  rel = rel.replace(/^\//, "");

  let relDecoded;
  try {
    relDecoded = decodeURIComponent(rel);
  } catch {
    relDecoded = rel;
  }

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
    let rawDecoded;
    try {
      rawDecoded = decodeURIComponent(rawSrc);
    } catch {
      rawDecoded = rawSrc;
    }
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

/**
 * Read EXIF data from image file
 */
function readExifData(imagePath, hexoLog) {
  if (!ExifParser) {
    hexoLog && hexoLog.warn("[image-exif] exif-parser 未安装，自动 EXIF 读取已禁用。请运行 npm install exif-parser");
    return {};
  }

  try {
    const buffer = fs.readFileSync(imagePath);
    const parser = ExifParser.create(buffer);
    const result = parser.parse();
    return result.tags || {};
  } catch (e) {
    hexoLog && hexoLog.debug("[image-exif] 无法读取 EXIF 数据: " + imagePath + " - " + e.message);
    return {};
  }
}

/**
 * Get value from EXIF data using field mappings
 */
function getExifValue(exifData, fieldName) {
  const mappings = EXIF_FIELD_MAPPINGS[fieldName];
  if (!mappings) return null;

  for (const mapping of mappings) {
    if (exifData[mapping] !== undefined && exifData[mapping] !== null) {
      return exifData[mapping];
    }
  }
  return null;
}

/**
 * Format EXIF value for display
 */
function formatExifValue(fieldName, value) {
  if (value === null || value === undefined || value === "") return null;

  switch (fieldName) {
    case "ExposureTime":
      if (typeof value === "number") {
        if (value < 1) {
          return `1/${Math.round(1 / value)}s`;
        }
        return `${value}s`;
      }
      return value;

    case "Aperture":
      if (typeof value === "number") {
        return `f/${value.toFixed(1)}`;
      }
      return value;

    case "FocalLength":
      if (typeof value === "number") {
        return `${value}mm`;
      }
      return value;

    case "ISOSpeedRatings":
      return `ISO ${value}`;

    case "ExposureProgram":
      if (typeof value === "number") {
        return EXPOSURE_PROGRAM_MAP[value] || `程序 ${value}`;
      }
      return value;

    case "MeteringMode":
      if (typeof value === "number") {
        return METERING_MODE_MAP[value] || `模式 ${value}`;
      }
      return value;

    case "Flash":
      if (typeof value === "number") {
        return FLASH_MODE_MAP[value] || (value > 0 ? "闪光" : "未闪光");
      }
      return value;

    case "WhiteBalance":
      if (typeof value === "number") {
        return WHITE_BALANCE_MAP[value] || `模式 ${value}`;
      }
      return value;

    case "GPSLatitude":
    case "GPSLongitude":
      if (typeof value === "number") {
        return value.toFixed(6) + "°";
      }
      return value;

    case "GPSAltitude":
      if (typeof value === "number") {
        return `${value.toFixed(1)}m`;
      }
      return value;

    case "DateTimeOriginal":
      if (typeof value === "number") {
        // Unix timestamp
        const date = new Date(value * 1000);
        return date.toLocaleString("zh-CN");
      }
      return value;

    case "ExposureBias":
      if (typeof value === "number") {
        const sign = value >= 0 ? "+" : "";
        return `${sign}${value.toFixed(1)} EV`;
      }
      return value;

    default:
      return String(value);
  }
}

/**
 * Build merged EXIF info from auto-read and custom data
 */
function buildMergedInfo(autoExifData, customInfo, autoExifEnabled) {
  const result = {};
  const fields = Object.keys(EXIF_FIELD_MAPPINGS);

  for (const field of fields) {
    // Custom info has priority
    if (customInfo[field]) {
      result[field] = customInfo[field];
    } else if (autoExifEnabled && autoExifData) {
      const value = getExifValue(autoExifData, field);
      const formatted = formatExifValue(field, value);
      if (formatted) {
        result[field] = formatted;
      }
    }
  }

  return result;
}

/**
 * Generate HTML for image with EXIF info
 */
function generateHTML(imageInfo, title, description, exifInfo, hexo) {
  const theme = hexo.theme.config;
  const imageCaptionStyle = theme?.articles?.style?.image_caption || "block";

  // Check if we have any data to display
  const hasTitle = title && title.trim().length > 0;
  const hasDescription = description && description.trim().length > 0;
  const hasExifData = Object.keys(exifInfo).length > 0;

  if (!hasTitle && !hasDescription && !hasExifData) {
    throw new Error("[image-exif] 必须至少有一项数据（title、description 或 EXIF 信息）。");
  }

  // Build info card content
  const infoItems = [];
  
  // Header container (title + description + toggle button)
  let headerHtml = '<div class="image-exif-header">';
  headerHtml += '<div class="image-exif-header-content">';
  
  // Add title
  if (hasTitle) {
    headerHtml += `<div class="image-exif-title">${escapeHtml(title)}</div>`;
  }

  // Add description
  if (hasDescription) {
    headerHtml += `<div class="image-exif-description">${escapeHtml(description)}</div>`;
  }
  
  headerHtml += '</div>'; // Close header-content
  
  // Add toggle button for block mode (default collapsed)
  headerHtml += `
    <button class="image-exif-toggle-btn" aria-label="Toggle EXIF data">
      <i class="fa-solid fa-chevron-down"></i>
    </button>
  `;
  
  headerHtml += '</div>'; // Close header
  
  infoItems.push(headerHtml);

  // Group EXIF info by category for compact display
  const cameraInfo = [];
  const exposureInfo = [];
  const lensInfo = [];
  const otherInfo = [];

  // Camera info
  if (exifInfo.Make) cameraInfo.push({ label: "品牌", value: exifInfo.Make });
  if (exifInfo.Model) cameraInfo.push({ label: "机型", value: exifInfo.Model });
  if (exifInfo.DateTimeOriginal) cameraInfo.push({ label: "拍摄时间", value: exifInfo.DateTimeOriginal });

  // Lens info
  if (exifInfo.LensModel) lensInfo.push({ label: "镜头", value: exifInfo.LensModel });
  if (exifInfo.FocalLength) lensInfo.push({ label: "焦距", value: exifInfo.FocalLength });
  if (exifInfo.FocusMode) lensInfo.push({ label: "对焦模式", value: exifInfo.FocusMode });

  // Exposure info
  if (exifInfo.ExposureTime) exposureInfo.push({ label: "快门", value: exifInfo.ExposureTime });
  if (exifInfo.Aperture) exposureInfo.push({ label: "光圈", value: exifInfo.Aperture });
  if (exifInfo.ISOSpeedRatings) exposureInfo.push({ label: "感光度", value: exifInfo.ISOSpeedRatings });
  if (exifInfo.ExposureProgram) exposureInfo.push({ label: "曝光程序", value: exifInfo.ExposureProgram });
  if (exifInfo.ExposureBias) exposureInfo.push({ label: "曝光补偿", value: exifInfo.ExposureBias });
  if (exifInfo.MeteringMode) exposureInfo.push({ label: "测光模式", value: exifInfo.MeteringMode });

  // Other info
  if (exifInfo.Flash) otherInfo.push({ label: "闪光灯", value: exifInfo.Flash });
  if (exifInfo.WhiteBalance) otherInfo.push({ label: "白平衡", value: exifInfo.WhiteBalance });
  if (exifInfo.GPSLatitude) otherInfo.push({ label: "纬度", value: exifInfo.GPSLatitude });
  if (exifInfo.GPSLongitude) otherInfo.push({ label: "经度", value: exifInfo.GPSLongitude });
  if (exifInfo.GPSAltitude) otherInfo.push({ label: "海拔", value: exifInfo.GPSAltitude });

  // Build EXIF sections
  let exifHTML = "";

  if (cameraInfo.length > 0 || lensInfo.length > 0 || exposureInfo.length > 0 || otherInfo.length > 0) {
    exifHTML = '<div class="image-exif-data">';

    if (cameraInfo.length > 0) {
      exifHTML += '<div class="image-exif-section image-exif-camera">';
      exifHTML += '<div class="image-exif-section-title"><i class="fa-solid fa-camera"></i> 相机</div>';
      exifHTML += '<div class="image-exif-items">';
      for (const item of cameraInfo) {
        exifHTML += `<div class="image-exif-item"><span class="image-exif-label">${item.label}</span><span class="image-exif-value">${escapeHtml(item.value)}</span></div>`;
      }
      exifHTML += '</div></div>';
    }

    if (lensInfo.length > 0) {
      exifHTML += '<div class="image-exif-section image-exif-lens">';
      exifHTML += '<div class="image-exif-section-title"><i class="fa-solid fa-circle-dot"></i> 镜头</div>';
      exifHTML += '<div class="image-exif-items">';
      for (const item of lensInfo) {
        exifHTML += `<div class="image-exif-item"><span class="image-exif-label">${item.label}</span><span class="image-exif-value">${escapeHtml(item.value)}</span></div>`;
      }
      exifHTML += '</div></div>';
    }

    if (exposureInfo.length > 0) {
      exifHTML += '<div class="image-exif-section image-exif-exposure">';
      exifHTML += '<div class="image-exif-section-title"><i class="fa-solid fa-sun"></i> 曝光</div>';
      exifHTML += '<div class="image-exif-items">';
      for (const item of exposureInfo) {
        exifHTML += `<div class="image-exif-item"><span class="image-exif-label">${item.label}</span><span class="image-exif-value">${escapeHtml(item.value)}</span></div>`;
      }
      exifHTML += '</div></div>';
    }

    if (otherInfo.length > 0) {
      exifHTML += '<div class="image-exif-section image-exif-other">';
      exifHTML += '<div class="image-exif-section-title"><i class="fa-solid fa-circle-info"></i> 其他</div>';
      exifHTML += '<div class="image-exif-items">';
      for (const item of otherInfo) {
        exifHTML += `<div class="image-exif-item"><span class="image-exif-label">${item.label}</span><span class="image-exif-value">${escapeHtml(item.value)}</span></div>`;
      }
      exifHTML += '</div></div>';
    }

    exifHTML += '</div>';
  }

  const isFloat = imageCaptionStyle === "float";
  const layoutClass = isFloat ? "image-exif-float" : "image-exif-block";

  const infoCardHtml = `
  <div class="image-exif-info-card">
    ${infoItems.join("\n    ")}
    ${exifHTML}
  </div>`;

  // Build final HTML
  const html = isFloat
    ? `
<figure class="image-exif-container ${layoutClass}" data-no-img-handle="true">
  <div class="image-exif-image-wrapper">
    <img src="${escapeHtmlAttr(imageInfo.path)}" alt="${escapeHtmlAttr(description)}" class="image-exif-img" />
    ${infoCardHtml}
  </div>
</figure>
`
    : `
<figure class="image-exif-container ${layoutClass}" data-no-img-handle="true">
  <div class="image-exif-image-wrapper">
    <img src="${escapeHtmlAttr(imageInfo.path)}" alt="${escapeHtmlAttr(description)}" class="image-exif-img" />
  </div>
  ${infoCardHtml}
</figure>
`;

  return html;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape HTML attribute
 */
function escapeHtmlAttr(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Main tag handler
 */
function imageExifTag(args, content) {
  const hexoLog = hexo.log;

  try {
    // Parse arguments
    const { title, autoExif } = parseArgs(args);

    // Validate content structure
    validateContent(content, hexoLog);

    // Extract image info
    const imageInfo = extractImageInfo(content);
    if (!imageInfo) {
      throw new Error("[image-exif] 无法解析图片信息。");
    }

    // Extract custom info from comment block
    const customInfo = extractCustomInfo(content);

    // Read EXIF data if auto-exif is enabled
    let autoExifData = {};
    if (autoExif) {
      // Try to resolve local image path
      const localPath = resolveLocalImagePath(imageInfo.path, hexo, this);
      if (localPath) {
        autoExifData = readExifData(localPath, hexoLog);
      } else {
        hexoLog && hexoLog.debug("[image-exif] 无法找到本地图片文件，跳过自动 EXIF 读取: " + imageInfo.path);
      }
    }

    // Merge EXIF info (custom has priority)
    const mergedInfo = buildMergedInfo(autoExifData, customInfo, autoExif);

    // Generate HTML
    const html = generateHTML(
      imageInfo,
      title,
      imageInfo.description,
      mergedInfo,
      hexo
    );

    return html;
  } catch (e) {
    hexoLog && hexoLog.error(e.message);
    throw e;
  }
}

// Register the tag with a unique name to avoid conflicts with Hexo/Nunjucks built-in 'image'
// Usage: {% exifimage [title] [auto-exif:bool] %} ... {% endexifimage %}
hexo.extend.tag.register("exifimage", imageExifTag, { ends: true });
