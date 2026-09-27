/* main hexo */

"use strict";

/**
 * The installable app: manifest.json and the icons it names.
 *
 * Two pictures, because the platforms want two different things. A home screen
 * (iOS, iPadOS, macOS, Android) masks whatever it is given into its own shape
 * and paints transparency black, so it gets an OPAQUE full-bleed square made
 * from `defaults.avatar` and draws the rounded corners itself. A desktop shelf
 * (Windows, Linux, ChromeOS) shows the icon as it is, so it gets
 * `defaults.favicon`, whose own outline is the shape.
 *
 * The PNGs are rendered once into source/build/pwa/, beside the AVIF cache and
 * keyed the same way — by the source picture's content hash. sharp's resampling
 * and zlib are not byte-identical across machines, and a runner has to publish
 * the bytes a local build committed, not a near copy of them.
 *
 * Every size is checked against what the installers actually demand: Chrome
 * wants a real 192px and 512px PNG (a PNG claiming `sizes: any` does not
 * count), Android a maskable one, iOS a 180px touch icon.
 */

const fs = require("fs");
const path = require("path");
const { BuildIndex } = require("./lib/build-index");

const DIR = "pwa";
const INDEX_FILE = ".pwa.json";
// Bump when the drawing below changes: every cached icon is redrawn.
const SPEC = 1;

// `reach` is how far from the centre the picture's content may extend, as a
// share of the side. Maskable icons must keep it inside the spec's safe circle
// (radius 0.4); a touch icon only loses its corners to the squircle.
const ICONS = [
  { file: "icon-192.png", size: 192, from: "favicon", purpose: "any" },
  { file: "icon-512.png", size: 512, from: "favicon", purpose: "any" },
  { file: "maskable-192.png", size: 192, from: "avatar", reach: 0.38, purpose: "maskable" },
  { file: "maskable-512.png", size: 512, from: "avatar", reach: 0.38, purpose: "maskable" },
  { file: "apple-touch-icon.png", size: 180, from: "avatar", reach: 0.44 },
];

const PNG = { compressionLevel: 9, adaptiveFiltering: true };
const WHITE = { r: 255, g: 255, b: 255 };

let rendered = [];

function appName(theme, config) {
  return (theme.info && theme.info.title) || config.title || "Blog";
}

/** A picture named in the config, found in the site's source or the theme's. */
function resolveSource(url) {
  if (!url || /^(https?:)?\/\//i.test(url) || /^data:/i.test(url)) return null;
  const root = hexo.config.root || "/";
  let rel = String(url).split(/[?#]/)[0];
  if (root !== "/" && rel.startsWith(root)) rel = rel.slice(root.length);
  try {
    rel = decodeURIComponent(rel.replace(/^\/+/, ""));
  } catch (e) {
    return null;
  }
  for (const base of [hexo.source_dir, path.join(hexo.theme_dir, "source")]) {
    const abs = path.join(base, rel);
    if (fs.existsSync(abs)) return { abs, rel };
  }
  return null;
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    return -1;
  }
}

/** An SVG is rasterised at a density that gives the largest icon real pixels. */
async function input(sharp, abs) {
  if (!/\.svg$/i.test(abs)) return fs.promises.readFile(abs);
  const meta = await sharp(abs).metadata();
  const density = Math.min(2400, Math.ceil((72 * 1024) / Math.max(meta.width || 1, meta.height || 1)));
  return sharp(abs, { density }).png().toBuffer();
}

/**
 * Distance from the centre to the farthest pixel that is not background, in
 * source pixels. Measured rather than assumed: a face on a white square has its
 * content in a band across the middle, and shrinking the whole square into the
 * safe circle would leave a speck.
 */
function reachOf(data, w, h, bg) {
  const cx = w / 2;
  const cy = h / 2;
  let far = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 24) continue;
      if (a >= 250 && Math.abs(data[i] - bg.r) + Math.abs(data[i + 1] - bg.g) + Math.abs(data[i + 2] - bg.b) < 48) {
        continue;
      }
      const dx = Math.abs(x + 0.5 - cx) + 0.5;
      const dy = Math.abs(y + 0.5 - cy) + 0.5;
      far = Math.max(far, dx * dx + dy * dy);
    }
  }
  return Math.sqrt(far);
}

async function render(sharp, icon, abs, out) {
  const src = await input(sharp, abs);
  const { size } = icon;

  if (!icon.reach) {
    await sharp(src)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3" })
      .png(PNG)
      .toFile(out);
    return;
  }

  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  // The picture's own corner, so the margin the safe zone adds is the colour it
  // already stands on; a transparent picture stands on white.
  const bg = data[3] >= 250 ? { r: data[0], g: data[1], b: data[2] } : WHITE;
  const reach = reachOf(data, w, h, bg);
  const side = Math.max(w, h);
  const k = reach > 0 ? Math.min(size / side, (icon.reach * size) / reach) : size / side;
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));

  const art = await sharp(src)
    .resize(cw, ch, { fit: "fill", kernel: "lanczos3" })
    .flatten({ background: bg })
    .png()
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 3, background: bg } })
    .composite([{ input: art, left: Math.round((size - cw) / 2), top: Math.round((size - ch) / 2) }])
    .png(PNG)
    .toFile(out);
}

async function renderIcons() {
  rendered = [];
  const defaults = (hexo.theme.config || {}).defaults || {};
  const favicon = resolveSource(defaults.favicon);
  const avatar = resolveSource(defaults.avatar);
  const sources = { favicon: favicon || avatar, avatar: avatar || favicon };
  if (!sources.favicon) {
    hexo.log.warn("[pwa] defaults.favicon and defaults.avatar name no local picture — the app has no icon.");
    return;
  }

  let sharp;
  try {
    sharp = require("sharp");
  } catch (e) {
    hexo.log.warn("[pwa] sharp is not installed — the app has no icon.");
    return;
  }

  const buildDir = path.join(hexo.source_dir, "build");
  const outDir = path.join(buildDir, DIR);
  const index = new BuildIndex(buildDir, INDEX_FILE);
  const live = new Set();
  await fs.promises.mkdir(outDir, { recursive: true });

  for (const icon of ICONS) {
    const src = sources[icon.from];
    const key = `${DIR}/${icon.file}`;
    const out = path.join(outDir, icon.file);
    const spec = `${SPEC}:${icon.size}:${icon.reach || 0}:${src.rel}`;
    live.add(key);

    if (!index.hit(key, src.abs, (e) => e.spec === spec && sizeOf(out) === e.outSize)) {
      try {
        await render(sharp, icon, src.abs, out);
      } catch (e) {
        hexo.log.warn(`[pwa] Could not render ${key}: ${e.message}`);
        continue;
      }
      index.record(key, src.abs, { spec, outSize: sizeOf(out) });
      hexo.log.info(`[pwa] Rendered ${key} from ${src.rel}`);
    }
    rendered.push(Object.assign({ abs: out, route: `build/${key}` }, icon));
  }

  index.prune(live);
  index.flush();
  // An icon this table no longer names would still be published from source/.
  for (const name of fs.readdirSync(outDir)) {
    if (!live.has(`${DIR}/${name}`)) fs.rmSync(path.join(outDir, name), { force: true });
  }
}

hexo.extend.filter.register("before_generate", renderIcons);

hexo.extend.generator.register("redefine_manifest", function () {
  const theme = hexo.theme.config || {};
  const config = hexo.config;
  const root = config.root || "/";
  const colors = theme.colors || {};
  const name = appName(theme, config);
  const lang = [].concat(config.language || [])[0];

  const manifest = {
    id: root,
    name,
    short_name: name,
    description: config.description || "",
    lang: lang && lang !== "default" ? lang : undefined,
    start_url: root,
    scope: root,
    // What makes iOS treat the Home Screen entry as an installed app, which is
    // the precondition for it delivering Web Push at all.
    display: "standalone",
    theme_color: colors.primary || "#A31F34",
    background_color: colors.default_mode === "dark" ? "#202124" : "#ffffff",
    icons: rendered
      .filter((icon) => icon.purpose)
      .map((icon) => ({
        src: root + icon.route,
        sizes: `${icon.size}x${icon.size}`,
        type: "image/png",
        purpose: icon.purpose,
      })),
  };

  // The icons are routed here as well as by Hexo's own asset pass: a picture
  // rendered during THIS build was not in source/ when that pass looked.
  return [{ path: "manifest.json", data: JSON.stringify(manifest, null, 2) }].concat(
    rendered.map((icon) => ({ path: icon.route, data: () => fs.createReadStream(icon.abs) }))
  );
});

/** What head.ejs links: the rendered icons, or "" where the favicon has to stand in. */
hexo.extend.helper.register("pwa_icons", function () {
  const root = hexo.config.root || "/";
  const url = (file) => {
    const icon = rendered.find((i) => i.file === file);
    return icon ? root + icon.route : "";
  };
  return {
    name: appName(this.theme || hexo.theme.config || {}, hexo.config),
    icon: url("icon-192.png"),
    touch: url("apple-touch-icon.png"),
  };
});
