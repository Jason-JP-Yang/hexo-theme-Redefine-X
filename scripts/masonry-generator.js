"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// Optional: exif-parser for auto-exif reading from image files
let ExifParser = null;
try { ExifParser = require("exif-parser"); } catch (e) {}

/* ==================== Translation System ==================== */

const LANGUAGE_ALIASES = { jp: "ja" };
const LANGUAGE_CACHE = new Map();

function normalizeLanguageKey(language) {
  if (!language) return "en";
  const raw = String(language).trim();
  if (!raw) return "en";
  if (LANGUAGE_ALIASES[raw]) return LANGUAGE_ALIASES[raw];
  const base = raw.split("-")[0];
  if (LANGUAGE_ALIASES[base]) return LANGUAGE_ALIASES[base];
  return raw;
}

function loadLanguageContent(hexoInstance) {
  const language = Array.isArray(hexoInstance.config.language)
    ? hexoInstance.config.language[0] || "en"
    : hexoInstance.config.language || "en";
  const normalized = normalizeLanguageKey(language);
  const languageDir = path.join(hexoInstance.theme_dir, "languages");

  let filePath = path.join(languageDir, `${normalized}.yml`);
  if (!fs.existsSync(filePath)) {
    const base = normalized.split("-")[0];
    filePath = path.join(languageDir, `${base}.yml`);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(languageDir, "en.yml");
    }
  }

  if (LANGUAGE_CACHE.has(filePath)) return LANGUAGE_CACHE.get(filePath);
  let content = {};
  try { content = yaml.load(fs.readFileSync(filePath, "utf8")) || {}; } catch (e) {}
  LANGUAGE_CACHE.set(filePath, content);
  return content;
}

function getNestedValue(source, key) {
  if (!source || !key) return undefined;
  return key.split(".").reduce((acc, part) => {
    if (acc && Object.prototype.hasOwnProperty.call(acc, part)) return acc[part];
    return undefined;
  }, source);
}

function getTranslator(hexoInstance) {
  const content = loadLanguageContent(hexoInstance);
  return (key, fallback, ...values) => {
    const value = getNestedValue(content, key);
    if (value !== undefined && value !== null && value !== key) {
      let result = String(value);
      if (values.length > 0) {
        let idx = 0;
        result = result.replace(/%s/g, () => values[idx++] ?? "");
      }
      return result;
    }
    if (fallback !== undefined && fallback !== null) {
      let result = String(fallback);
      if (values.length > 0) {
        let idx = 0;
        result = result.replace(/%s/g, () => values[idx++] ?? "");
      }
      return result;
    }
    return key;
  };
}

/* ==================== EXIF Data Processing ==================== */

// Mapping from masonry.yml keys (camelCase/mixed) to standard EXIF field names
const YML_KEY_MAP = {
  'make': 'Make', 'model': 'Model', 'lensModel': 'LensModel',
  'exposureTime': 'ExposureTime', 'aperture': 'Aperture',
  'ISOSpeedRatings': 'ISOSpeedRatings', 'focalLength': 'FocalLength',
  'exposureProgram': 'ExposureProgram', 'meteringMode': 'MeteringMode',
  'flash': 'Flash', 'dateTimeOriginal': 'DateTimeOriginal',
  'GPSLatitude': 'GPSLatitude', 'GPSLongitude': 'GPSLongitude',
  'GPSAltitude': 'GPSAltitude', 'whiteBalance': 'WhiteBalance',
  'focusMode': 'FocusMode', 'exposureBias': 'ExposureBias',
};

// EXIF field aliases for reading binary EXIF data (same as image-exif.js)
const EXIF_READ_MAPPINGS = {
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

function readExifFromFile(imagePath) {
  if (!ExifParser) return {};
  try {
    const buffer = fs.readFileSync(imagePath);
    const parser = ExifParser.create(buffer);
    return parser.parse().tags || {};
  } catch (e) { return {}; }
}

function getExifValue(exifData, fieldName) {
  const mappings = EXIF_READ_MAPPINGS[fieldName];
  if (!mappings) return null;
  for (const key of mappings) {
    if (exifData[key] !== undefined && exifData[key] !== null) return exifData[key];
  }
  return null;
}

function convertToDMS(value, isLatitude) {
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutesNotTruncated = (absolute - degrees) * 60;
  const minutes = Math.floor(minutesNotTruncated);
  const seconds = ((minutesNotTruncated - minutes) * 60).toFixed(2);
  const direction = isLatitude ? (value >= 0 ? "N" : "S") : (value >= 0 ? "E" : "W");
  return `${degrees}°${minutes}'${seconds}"${direction}`;
}

const EXPOSURE_PROGRAM_KEYS = {
  0: "image_exif.exposure_program.undefined", 1: "image_exif.exposure_program.manual",
  2: "image_exif.exposure_program.normal", 3: "image_exif.exposure_program.aperture_priority",
  4: "image_exif.exposure_program.shutter_priority", 5: "image_exif.exposure_program.creative",
  6: "image_exif.exposure_program.action", 7: "image_exif.exposure_program.portrait",
  8: "image_exif.exposure_program.landscape",
};

const METERING_MODE_KEYS = {
  0: "image_exif.metering_mode.unknown", 1: "image_exif.metering_mode.average",
  2: "image_exif.metering_mode.center_weighted", 3: "image_exif.metering_mode.spot",
  4: "image_exif.metering_mode.multi_spot", 5: "image_exif.metering_mode.evaluative",
  6: "image_exif.metering_mode.partial", 255: "image_exif.metering_mode.other",
};

const WHITE_BALANCE_KEYS = {
  0: "image_exif.white_balance.auto", 1: "image_exif.white_balance.manual",
};

function formatAutoExifValue(fieldName, value, t) {
  if (value === null || value === undefined || value === "") return null;
  switch (fieldName) {
    case "ExposureTime":
      if (typeof value === "number") return value < 1 ? `1/${Math.round(1 / value)}s` : `${value}s`;
      return String(value);
    case "Aperture":
      if (typeof value === "number") return `f/${value.toFixed(1)}`;
      return String(value);
    case "FocalLength":
      if (typeof value === "number") return `${value}mm`;
      return String(value);
    case "ISOSpeedRatings":
      return `ISO ${value}`;
    case "ExposureProgram":
      if (typeof value === "number") {
        const key = EXPOSURE_PROGRAM_KEYS[value];
        if (key) return t(key);
        return t("image_exif.value.program_with_number", "Program %s", value);
      }
      return String(value);
    case "MeteringMode":
      if (typeof value === "number") {
        const key = METERING_MODE_KEYS[value];
        if (key) return t(key);
        return t("image_exif.value.mode_with_number", "Mode %s", value);
      }
      return String(value);
    case "Flash":
      if (typeof value === "number") return (value & 1) ? t("image_exif.flash.on", "ON") : t("image_exif.flash.off", "OFF");
      return String(value);
    case "WhiteBalance":
      if (typeof value === "number") {
        const key = WHITE_BALANCE_KEYS[value];
        if (key) return t(key);
        return t("image_exif.value.mode_with_number", "Mode %s", value);
      }
      return String(value);
    case "GPSLatitude":
      if (typeof value === "number") return convertToDMS(value, true);
      return String(value);
    case "GPSLongitude":
      if (typeof value === "number") return convertToDMS(value, false);
      return String(value);
    case "GPSAltitude":
      if (typeof value === "number") return `${value.toFixed(1)}m`;
      return String(value);
    case "DateTimeOriginal":
      if (typeof value === "number") return new Date(value * 1000).toLocaleString();
      return String(value);
    case "ExposureBias":
      if (typeof value === "number") return `${value >= 0 ? "+" : ""}${value.toFixed(1)} EV`;
      return String(value);
    default:
      return String(value);
  }
}

/* ==================== HTML Generation ==================== */

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
 * Build EXIF info card HTML for use in imageViewer.
 * Uses the same CSS classes as image-exif.js so imageViewer styles apply.
 */
function buildExifCardHtml(title, description, exifFields, t) {
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

  const hasTitle = title && title.trim().length > 0;
  const hasDescription = description && description.trim().length > 0;

  let html = '<div class="image-exif-info-card">';

  // Header (title + description)
  if (hasTitle || hasDescription) {
    html += '<div class="image-exif-header"><div class="image-exif-header-content">';
    if (hasTitle) html += `<div class="image-exif-title">${escapeHtml(title)}</div>`;
    if (hasDescription) html += `<div class="image-exif-description">${escapeHtml(description)}</div>`;
    html += '</div></div>';
  }

  // Group EXIF fields by category
  const cameraInfo = [];
  const lensInfo = [];
  const exposureInfo = [];
  const otherInfo = [];

  if (exifFields.Make) cameraInfo.push({ label: fieldLabels.make, value: exifFields.Make });
  if (exifFields.Model) cameraInfo.push({ label: fieldLabels.model, value: exifFields.Model });
  if (exifFields.DateTimeOriginal) cameraInfo.push({ label: fieldLabels.datetimeOriginal, value: exifFields.DateTimeOriginal });

  if (exifFields.LensModel) lensInfo.push({ label: fieldLabels.lensModel, value: exifFields.LensModel });
  if (exifFields.FocalLength) lensInfo.push({ label: fieldLabels.focalLength, value: exifFields.FocalLength });
  if (exifFields.FocusMode) lensInfo.push({ label: fieldLabels.focusMode, value: exifFields.FocusMode });

  if (exifFields.ExposureTime) exposureInfo.push({ label: fieldLabels.exposureTime, value: exifFields.ExposureTime });
  if (exifFields.Aperture) exposureInfo.push({ label: fieldLabels.aperture, value: exifFields.Aperture });
  if (exifFields.ISOSpeedRatings) exposureInfo.push({ label: fieldLabels.iso, value: exifFields.ISOSpeedRatings });
  if (exifFields.ExposureProgram) exposureInfo.push({ label: fieldLabels.exposureProgram, value: exifFields.ExposureProgram });
  if (exifFields.ExposureBias) exposureInfo.push({ label: fieldLabels.exposureBias, value: exifFields.ExposureBias });
  if (exifFields.MeteringMode) exposureInfo.push({ label: fieldLabels.meteringMode, value: exifFields.MeteringMode });

  if (exifFields.Flash) otherInfo.push({ label: fieldLabels.flash, value: exifFields.Flash });
  if (exifFields.WhiteBalance) otherInfo.push({ label: fieldLabels.whiteBalance, value: exifFields.WhiteBalance });
  if (exifFields.GPSLatitude) otherInfo.push({ label: fieldLabels.gpsLatitude, value: exifFields.GPSLatitude });
  if (exifFields.GPSLongitude) otherInfo.push({ label: fieldLabels.gpsLongitude, value: exifFields.GPSLongitude });
  if (exifFields.GPSAltitude) otherInfo.push({ label: fieldLabels.gpsAltitude, value: exifFields.GPSAltitude });

  const hasSections = cameraInfo.length > 0 || lensInfo.length > 0 || exposureInfo.length > 0 || otherInfo.length > 0;

  if (hasSections) {
    html += '<div class="image-exif-data">';

    const renderSection = (items, icon, label, className) => {
      if (items.length === 0) return '';
      let s = `<div class="image-exif-section ${className}">`;
      s += `<div class="image-exif-section-title"><i class="fa-solid ${icon}"></i> ${label}</div>`;
      s += '<div class="image-exif-items">';
      for (const item of items) {
        s += `<div class="image-exif-item"><span class="image-exif-label">${item.label}</span><span class="image-exif-value">${escapeHtml(item.value)}</span></div>`;
      }
      s += '</div></div>';
      return s;
    };

    html += renderSection(cameraInfo, 'fa-camera', sectionLabels.camera, 'image-exif-camera');
    html += renderSection(lensInfo, 'fa-circle-dot', sectionLabels.lens, 'image-exif-lens');
    html += renderSection(exposureInfo, 'fa-sun', sectionLabels.exposure, 'image-exif-exposure');
    html += renderSection(otherInfo, 'fa-circle-info', sectionLabels.other, 'image-exif-other');

    html += '</div>';
  }

  html += '</div>';
  return html;
}

/* ==================== Generator ==================== */

hexo.extend.generator.register('masonry_pages', function(locals) {
  const masonryData = locals.data.masonry;
  if (!masonryData) return [];

  const t = getTranslator(hexo);
  const sourceDir = hexo.source_dir;
  
  // Get comment setting from theme config
  const commentEnabled = hexo.theme.config.comment && hexo.theme.config.comment.enable ? true : false;

  // Extract custom title if present
  let collectionTitle = 'Masonry Collection 瀑布流相册合集';
  const configItem = masonryData.find(item => item.title && !item.links_category);
  if (configItem) {
    collectionTitle = configItem.title;
  }

  // Filter out the config item to get only categories
  const categories = masonryData.filter(item => item.links_category);

  /**
   * Resolve local image file path for auto-exif reading
   */
  function resolveLocalImage(imagePath) {
    if (!imagePath) return null;
    const cleanPath = imagePath.split('#')[0].split('?')[0];
    if (cleanPath.startsWith('http://') || cleanPath.startsWith('https://')) return null;

    let decoded;
    try { decoded = decodeURIComponent(cleanPath); } catch { decoded = cleanPath; }

    const candidates = [
      path.join(sourceDir, 'masonry', decoded),
      path.join(sourceDir, decoded),
      path.join(sourceDir, 'build', 'masonry', decoded),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch (e) {}
    }
    return null;
  }

  /**
   * Process a single image entry from masonry.yml
   * Extracts manual EXIF fields, reads auto-EXIF if enabled,
   * and generates the EXIF info card HTML for imageViewer
   */
  function processImage(image, pageAutoExif) {
    const processed = { ...image };

    // Extract manual EXIF fields from yml
    const exifFields = {};
    for (const [ymlKey, exifKey] of Object.entries(YML_KEY_MAP)) {
      if (image[ymlKey] !== undefined && image[ymlKey] !== null && String(image[ymlKey]).trim() !== '') {
        exifFields[exifKey] = String(image[ymlKey]);
      }
    }

    // Auto-EXIF reading from image file
    const imageAutoExif = image['auto-exif'];
    const autoExif = imageAutoExif !== undefined ? imageAutoExif : pageAutoExif;

    if (autoExif) {
      const localPath = resolveLocalImage(image.image);
      if (localPath) {
        const rawExif = readExifFromFile(localPath);
        // Read and format auto-EXIF values; manual fields take priority
        for (const fieldName of Object.keys(EXIF_READ_MAPPINGS)) {
          if (!exifFields[fieldName]) {
            const rawValue = getExifValue(rawExif, fieldName);
            const formatted = formatAutoExifValue(fieldName, rawValue, t);
            if (formatted) {
              exifFields[fieldName] = formatted;
            }
          }
        }
      } else {
        hexo.log && hexo.log.debug("[masonry-exif] Local image not found for auto-exif: " + image.image);
      }
    }

    // Determine if this image has info to show in imageViewer
    const hasExifFields = Object.keys(exifFields).length > 0;
    const hasDescription = image.description && String(image.description).trim().length > 0;
    processed.hasExifInfo = hasDescription || hasExifFields;

    if (processed.hasExifInfo) {
      processed.exifCardHtml = buildExifCardHtml(
        image.title || '',
        image.description || '',
        exifFields,
        t
      );
    }

    return processed;
  }

  const pages = [];

  // 1. Prepare data for the collection page (Links style)
  const collectionData = categories.map(category => {
    return {
      ...category,
      list: category.list.map(item => {
        const pageTitle = item['page-title'] || item.name;
        return {
          ...item,
          link: `/masonry/${pageTitle}/`
        };
      })
    };
  });

  // 2. Generate the Collection Page
  pages.push({
    path: 'masonry/links/index.html',
    data: {
      type: 'masonry-links',
      title: collectionTitle,
      masonry_items: collectionData,
      layout: 'page',
      comment: false
    },
    layout: 'page'
  });

  // 3. Generate Individual Masonry Pages with EXIF processing
  // Pick up pre-generated reaction data from masonry-reactions.js (before_generate filter)
  const allReactions = hexo._masonryReactions || {};
  const giscusConfig = hexo.theme.config?.comment?.config?.giscus || {};

  categories.forEach(category => {
    category.list.forEach(item => {
        if (item.images && item.images.length > 0) {
            const pageTitle = item['page-title'] || item.name;
            const pagePath = `masonry/${pageTitle}/`;
            const pageAutoExif = item['auto-exif'] || false;
            const processedImages = item.images.map(img => processImage(img, pageAutoExif));

            // Attach reaction data if available
            const reactionsInfo = allReactions[pagePath] || null;

            pages.push({
                path: `masonry/${pageTitle}/index.html`,
                data: {
                    type: 'masonry',
                    title: item['page-title'] || item.name,
                    images: processedImages,
                    content: '',
                    layout: 'page',
                    comment: commentEnabled,
                    // Masonry reactions data for the frontend
                    masonryReactions: reactionsInfo ? {
                        repo: giscusConfig.repo || '',
                        repoId: giscusConfig.repo_id || '',
                        categoryId: giscusConfig.category_id || '',
                        discussionTerm: `[masonry-reactions] ${pagePath}`,
                        discussionNumber: reactionsInfo.discussionNumber,
                        imageReactions: reactionsInfo.imageReactions,
                    } : null,
                },
                layout: 'page'
            });
        }
    });
  });

  return pages;
});
