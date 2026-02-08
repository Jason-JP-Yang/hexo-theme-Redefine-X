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
const yaml = require("js-yaml");

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
  FocalLength: ["FocalLengthIn35mmFormat", "FocalLength", "focalLength"],
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

const EXPOSURE_PROGRAM_KEYS = {
  0: "image_exif.exposure_program.undefined",
  1: "image_exif.exposure_program.manual",
  2: "image_exif.exposure_program.normal",
  3: "image_exif.exposure_program.aperture_priority",
  4: "image_exif.exposure_program.shutter_priority",
  5: "image_exif.exposure_program.creative",
  6: "image_exif.exposure_program.action",
  7: "image_exif.exposure_program.portrait",
  8: "image_exif.exposure_program.landscape",
};

const METERING_MODE_KEYS = {
  0: "image_exif.metering_mode.unknown",
  1: "image_exif.metering_mode.average",
  2: "image_exif.metering_mode.center_weighted",
  3: "image_exif.metering_mode.spot",
  4: "image_exif.metering_mode.multi_spot",
  5: "image_exif.metering_mode.evaluative",
  6: "image_exif.metering_mode.partial",
  255: "image_exif.metering_mode.other",
};

const WHITE_BALANCE_KEYS = {
  0: "image_exif.white_balance.auto",
  1: "image_exif.white_balance.manual",
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
    throw new Error("[image-exif] Content must include one image. Use ![description](path/to/image).");
  }

  if (imageMatches.length > 1) {
    throw new Error("[image-exif] Only one image is allowed. Detected " + imageMatches.length + " images.");
  }

  // Check for exif-info comment block
  const exifInfoMatches = content.match(/<!--\s*exif-info[\s\S]*?-->/g);

  if (exifInfoMatches && exifInfoMatches.length > 1) {
    throw new Error("[image-exif] Only one exif-info block is allowed. Detected " + exifInfoMatches.length + " blocks.");
  }

  // Check for other content that shouldn't be there
  const cleanedContent = content
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "")           // Remove image
    .replace(/<!--\s*exif-info[\s\S]*?-->/g, "")        // Remove exif-info comment
    .replace(/<!--[^>]*-->/g, "")                       // Remove other HTML comments (Hexo placeholders)
    .trim();

  if (cleanedContent.length > 0) {
    // Check if remaining content is just whitespace or newlines
    const meaningfulContent = cleanedContent.replace(/\s+/g, "");
    if (meaningfulContent.length > 0) {
      throw new Error("[image-exif] Content must contain one image and one optional exif-info block. Extra content: " + cleanedContent.substring(0, 50) + "...");
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
  const commentMatch = content.match(/<!--\s*exif-info([\s\S]*?)-->/);
  if (!commentMatch) return {};

  const rawContent = commentMatch[1];
  const info = {};
  
  // Get all valid keys from mappings
  const validKeys = Object.keys(EXIF_FIELD_MAPPINGS);
  
  // Construct regex to find all "Key:" occurrences
  // We sort keys by length descending to ensure longer keys match first (though not strictly necessary given the current key set, it's safer)
  // e.g. if we had "Flash" and "FlashMode", we'd want to match "FlashMode:" before "Flash:"
  const sortedKeys = [...validKeys].sort((a, b) => b.length - a.length);
  const keyPattern = sortedKeys.join("|");
  const regex = new RegExp(`(${keyPattern}):`, "g");
  
  const matches = [];
  let match;
  
  // Find all key matches
  while ((match = regex.exec(rawContent)) !== null) {
    matches.push({
      key: match[1],
      index: match.index,
      endIndex: match.index + match[0].length
    });
  }
  
  // Extract values between keys
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    
    // Value is the text between the end of current key and the start of next key (or end of string)
    const valueStartIndex = current.endIndex;
    const valueEndIndex = next ? next.index : rawContent.length;
    
    const value = rawContent.substring(valueStartIndex, valueEndIndex).trim();
    
    if (value) {
      info[current.key] = value;
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
    hexoLog && hexoLog.warn("[image-exif] exif-parser not installed. Auto EXIF reading is disabled. Run npm install exif-parser");
    return {};
  }

  try {
    const buffer = fs.readFileSync(imagePath);
    const parser = ExifParser.create(buffer);
    const result = parser.parse();
    return result.tags || {};
  } catch (e) {
    hexoLog && hexoLog.debug("[image-exif] Failed to read EXIF data: " + imagePath + " - " + e.message);
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
 * Convert decimal degrees to DMS (Degrees, Minutes, Seconds)
 */
function convertToDMS(value, isLatitude) {
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutesNotTruncated = (absolute - degrees) * 60;
  const minutes = Math.floor(minutesNotTruncated);
  const seconds = ((minutesNotTruncated - minutes) * 60).toFixed(2);
  
  let direction = "";
  if (isLatitude) {
    direction = value >= 0 ? "N" : "S";
  } else {
    direction = value >= 0 ? "E" : "W";
  }
  
  return `${degrees}°${minutes}'${seconds}"${direction}`;
}

const LANGUAGE_ALIASES = {
  jp: "ja",
};

const LANGUAGE_CACHE = new Map();

function formatString(template, values) {
  let index = 0;
  return template.replace(/%s/g, () => {
    const value = values[index];
    index += 1;
    return value !== undefined ? value : "";
  });
}

function resolveLanguageDir() {
  return path.join(__dirname, "../..", "languages");
}

function normalizeLanguageKey(language) {
  if (!language) return "en";
  const raw = String(language).trim();
  if (!raw) return "en";
  if (LANGUAGE_ALIASES[raw]) return LANGUAGE_ALIASES[raw];
  const base = raw.split("-")[0];
  if (LANGUAGE_ALIASES[base]) return LANGUAGE_ALIASES[base];
  return raw;
}

function resolveLanguageFilePath(language) {
  const languageDir = resolveLanguageDir();
  const normalized = normalizeLanguageKey(language);
  const directPath = path.join(languageDir, `${normalized}.yml`);
  if (fs.existsSync(directPath)) return directPath;
  const base = normalized.split("-")[0];
  const basePath = path.join(languageDir, `${base}.yml`);
  if (base !== normalized && fs.existsSync(basePath)) return basePath;
  return path.join(languageDir, "en.yml");
}

function loadLanguageContent(hexo) {
  const language = getPrimaryLanguage(hexo);
  const filePath = resolveLanguageFilePath(language);
  if (LANGUAGE_CACHE.has(filePath)) return LANGUAGE_CACHE.get(filePath);
  let content = {};
  try {
    content = yaml.load(fs.readFileSync(filePath, "utf8")) || {};
  } catch (e) {
    content = {};
  }
  LANGUAGE_CACHE.set(filePath, content);
  return content;
}

function getNestedValue(source, key) {
  if (!source || !key) return undefined;
  return key.split(".").reduce((acc, part) => {
    if (acc && Object.prototype.hasOwnProperty.call(acc, part)) {
      return acc[part];
    }
    return undefined;
  }, source);
}

function getTranslator(hexo) {
  const languageContent = loadLanguageContent(hexo);
  return (key, fallback, ...values) => {
    const value = getNestedValue(languageContent, key);
    if (value !== undefined && value !== null && value !== key) {
      return values.length ? formatString(String(value), values) : value;
    }
    if (fallback !== undefined && fallback !== null) {
      return values.length ? formatString(String(fallback), values) : fallback;
    }
    return key;
  };
}

function getPrimaryLanguage(hexo) {
  const language = hexo?.config?.language;
  if (Array.isArray(language)) {
    return language[0] || "en";
  }
  return language || "en";
}

/**
 * Format EXIF value for display
 */
function formatExifValue(fieldName, value, t, locale) {
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
        const key = EXPOSURE_PROGRAM_KEYS[value];
        if (key) return t(key);
        return t("image_exif.value.program_with_number", "Program %s", value);
      }
      return value;

    case "MeteringMode":
      if (typeof value === "number") {
        const key = METERING_MODE_KEYS[value];
        if (key) return t(key);
        return t("image_exif.value.mode_with_number", "Mode %s", value);
      }
      return value;

    case "Flash":
      if (typeof value === "number") {
        return (value & 1) ? t("image_exif.flash.on", "ON") : t("image_exif.flash.off", "OFF");
      }
      return value;

    case "WhiteBalance":
      if (typeof value === "number") {
        const key = WHITE_BALANCE_KEYS[value];
        if (key) return t(key);
        return t("image_exif.value.mode_with_number", "Mode %s", value);
      }
      return value;

    case "GPSLatitude":
      if (typeof value === "number") {
        return convertToDMS(value, true);
      }
      return value;

    case "GPSLongitude":
      if (typeof value === "number") {
        return convertToDMS(value, false);
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
        return date.toLocaleString(locale);
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
function buildMergedInfo(autoExifData, customInfo, autoExifEnabled, t, locale) {
  const result = {};
  const fields = Object.keys(EXIF_FIELD_MAPPINGS);

  for (const field of fields) {
    // Custom info has priority
    if (customInfo[field]) {
      if (customInfo[field].toLowerCase() !== "false") {
        result[field] = customInfo[field];
      }
    } else if (autoExifEnabled && autoExifData) {
      const value = getExifValue(autoExifData, field);
      const formatted = formatExifValue(field, value, t, locale);
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
  const t = getTranslator(hexo);
  const sectionLabels = {
    camera: t("image_exif.section.camera", "Camera"),
    lens: t("image_exif.section.lens", "Lens"),
    exposure: t("image_exif.section.exposure", "Exposure"),
    other: t("image_exif.section.other", "Other"),
  };
  const fieldLabels = {
    make: t("image_exif.field.make", "Make"),
    model: t("image_exif.field.model", "Model"),
    datetimeOriginal: t("image_exif.field.datetime_original", "Date Taken"),
    lensModel: t("image_exif.field.lens_model", "Lens"),
    focalLength: t("image_exif.field.focal_length", "Focal Length"),
    focusMode: t("image_exif.field.focus_mode", "Focus Mode"),
    exposureTime: t("image_exif.field.exposure_time", "Shutter"),
    aperture: t("image_exif.field.aperture", "Aperture"),
    iso: t("image_exif.field.iso", "ISO"),
    exposureProgram: t("image_exif.field.exposure_program", "Exposure Program"),
    exposureBias: t("image_exif.field.exposure_bias", "Exposure Compensation"),
    meteringMode: t("image_exif.field.metering_mode", "Metering Mode"),
    flash: t("image_exif.field.flash", "Flash"),
    whiteBalance: t("image_exif.field.white_balance", "White Balance"),
    gpsLatitude: t("image_exif.field.gps_latitude", "Latitude"),
    gpsLongitude: t("image_exif.field.gps_longitude", "Longitude"),
    gpsAltitude: t("image_exif.field.gps_altitude", "Altitude"),
  };

  // Check if we have any data to display
  const hasTitle = title && title.trim().length > 0;
  const hasDescription = description && description.trim().length > 0;
  const hasExifData = Object.keys(exifInfo).length > 0;

  if (!hasTitle && !hasDescription && !hasExifData) {
    throw new Error("[image-exif] At least one of title, description, or EXIF info is required.");
  }

  // Check for Simple Mode (No EXIF data, but has image info)
  if (!hasExifData && (hasTitle || hasDescription)) {
    let captionContent = "";
    
    if (hasTitle) {
      // Use strong tag for bold title as requested
      captionContent += `<strong class="image-exif-title">${escapeHtml(title)}</strong>`;
    }
    
    if (hasDescription) {
      if (hasTitle) captionContent += "<br>";
      captionContent += escapeHtml(description);
    }
    
    return `
<figure class="image-caption image-exif-simple-container">
  <img src="${escapeHtmlAttr(imageInfo.path)}" alt="${escapeHtmlAttr(description)}" class="image-exif-img" data-no-img-handle="true" />
  <figcaption>${captionContent}</figcaption>
</figure>
`;
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
    <button class="image-exif-toggle-btn" aria-label="${escapeHtmlAttr(t("image_exif.ui.toggle", "Toggle EXIF data"))}">
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
  if (exifInfo.Make) cameraInfo.push({ label: fieldLabels.make, value: exifInfo.Make });
  if (exifInfo.Model) cameraInfo.push({ label: fieldLabels.model, value: exifInfo.Model });
  if (exifInfo.DateTimeOriginal) cameraInfo.push({ label: fieldLabels.datetimeOriginal, value: exifInfo.DateTimeOriginal });

  // Lens info
  if (exifInfo.LensModel) lensInfo.push({ label: fieldLabels.lensModel, value: exifInfo.LensModel });
  if (exifInfo.FocalLength) lensInfo.push({ label: fieldLabels.focalLength, value: exifInfo.FocalLength });
  if (exifInfo.FocusMode) lensInfo.push({ label: fieldLabels.focusMode, value: exifInfo.FocusMode });

  // Exposure info
  if (exifInfo.ExposureTime) exposureInfo.push({ label: fieldLabels.exposureTime, value: exifInfo.ExposureTime });
  if (exifInfo.Aperture) exposureInfo.push({ label: fieldLabels.aperture, value: exifInfo.Aperture });
  if (exifInfo.ISOSpeedRatings) exposureInfo.push({ label: fieldLabels.iso, value: exifInfo.ISOSpeedRatings });
  if (exifInfo.ExposureProgram) exposureInfo.push({ label: fieldLabels.exposureProgram, value: exifInfo.ExposureProgram });
  if (exifInfo.ExposureBias) exposureInfo.push({ label: fieldLabels.exposureBias, value: exifInfo.ExposureBias });
  if (exifInfo.MeteringMode) exposureInfo.push({ label: fieldLabels.meteringMode, value: exifInfo.MeteringMode });

  // Other info
  if (exifInfo.Flash) otherInfo.push({ label: fieldLabels.flash, value: exifInfo.Flash });
  if (exifInfo.WhiteBalance) otherInfo.push({ label: fieldLabels.whiteBalance, value: exifInfo.WhiteBalance });
  if (exifInfo.GPSLatitude) otherInfo.push({ label: fieldLabels.gpsLatitude, value: exifInfo.GPSLatitude });
  if (exifInfo.GPSLongitude) otherInfo.push({ label: fieldLabels.gpsLongitude, value: exifInfo.GPSLongitude });
  if (exifInfo.GPSAltitude) otherInfo.push({ label: fieldLabels.gpsAltitude, value: exifInfo.GPSAltitude });

  // Build EXIF sections
  let exifHTML = "";

  if (cameraInfo.length > 0 || lensInfo.length > 0 || exposureInfo.length > 0 || otherInfo.length > 0) {
    exifHTML = '<div class="image-exif-data">';

    if (cameraInfo.length > 0) {
      exifHTML += '<div class="image-exif-section image-exif-camera">';
      exifHTML += `<div class="image-exif-section-title"><i class="fa-solid fa-camera"></i> ${sectionLabels.camera}</div>`;
      exifHTML += '<div class="image-exif-items">';
      for (const item of cameraInfo) {
        exifHTML += `<div class="image-exif-item"><span class="image-exif-label">${item.label}</span><span class="image-exif-value">${escapeHtml(item.value)}</span></div>`;
      }
      exifHTML += '</div></div>';
    }

    if (lensInfo.length > 0) {
      exifHTML += '<div class="image-exif-section image-exif-lens">';
      exifHTML += `<div class="image-exif-section-title"><i class="fa-solid fa-circle-dot"></i> ${sectionLabels.lens}</div>`;
      exifHTML += '<div class="image-exif-items">';
      for (const item of lensInfo) {
        exifHTML += `<div class="image-exif-item"><span class="image-exif-label">${item.label}</span><span class="image-exif-value">${escapeHtml(item.value)}</span></div>`;
      }
      exifHTML += '</div></div>';
    }

    if (exposureInfo.length > 0) {
      exifHTML += '<div class="image-exif-section image-exif-exposure">';
      exifHTML += `<div class="image-exif-section-title"><i class="fa-solid fa-sun"></i> ${sectionLabels.exposure}</div>`;
      exifHTML += '<div class="image-exif-items">';
      for (const item of exposureInfo) {
        exifHTML += `<div class="image-exif-item"><span class="image-exif-label">${item.label}</span><span class="image-exif-value">${escapeHtml(item.value)}</span></div>`;
      }
      exifHTML += '</div></div>';
    }

    if (otherInfo.length > 0) {
      exifHTML += '<div class="image-exif-section image-exif-other">';
      exifHTML += `<div class="image-exif-section-title"><i class="fa-solid fa-circle-info"></i> ${sectionLabels.other}</div>`;
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
  const t = getTranslator(hexo);
  const locale = getPrimaryLanguage(hexo);

  try {
    // Parse arguments
    const { title, autoExif } = parseArgs(args);

    // Validate content structure
    validateContent(content, hexoLog);

    // Extract image info
    const imageInfo = extractImageInfo(content);
    if (!imageInfo) {
      throw new Error("[image-exif] Failed to parse image information.");
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
        hexoLog && hexoLog.debug("[image-exif] Local image not found. Skipping auto EXIF read: " + imageInfo.path);
      }
    }

    // Merge EXIF info (custom has priority)
    const mergedInfo = buildMergedInfo(autoExifData, customInfo, autoExif, t, locale);

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
