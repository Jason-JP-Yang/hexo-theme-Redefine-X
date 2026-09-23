/**
 * Theme Redefine
 * welcome.js
 */
const { version } = require("../../package.json");
const https = require("https");

// The version service answers on a custom domain, which sits behind the zone's
// bot protection: a CI runner is handed a "Just a moment..." challenge instead
// of JSON, so the banner and the CDN probe silently went missing on every
// runner build. workers.dev is outside the zone. Hardcoded, because the API is
// its own Worker and no config in the theme points at it.
const VERSION_API =
  process.env.CI || process.env.GITHUB_ACTIONS
    ? `https://redefine-x-version-api.jiepengyang.workers.dev/api/v2/info`
    : `https://redefine-x-version.jason-yang.top/api/v2/info`;

hexo.on("ready", async () => {
  const timeout = 3000;

  async function fetchRedefineInfo() {
    return new Promise((resolve, reject) => {
      https
        .get(
          VERSION_API,
          { timeout: timeout },
          (response) => {
            if (response.statusCode < 200 || response.statusCode > 299) {
              logFailedInfo();
              return reject(
                new Error(
                  `Failed to load page, status code: ${response.statusCode}`,
                ),
              );
            }
            let data = "";
            response.on("data", (chunk) => {
              data += chunk;
            });
            response.on("end", () => {
              try {
                const jsonData = JSON.parse(data);

                if (jsonData.status !== "success") {
                  logFailedInfo();
                  return reject(
                    new Error(`Failed to fetch data: ${jsonData.message}`),
                  );
                }                
                
                logInfo(jsonData);
                checkVersionAndCDNAvailability(jsonData);
                resolve();
              } catch (error) {
                logFailedInfo();
                reject(new Error(`JSON parse failed: ${error.message}`));
              }
            });
          },
        )
        .on("error", (error) => {
          reject(error);
        });
    });
  }

  try {
    await fetchRedefineInfo();
  } catch (error) {
    hexo.log.warn(`Check latest version failed: ${error}`);
    hexo.locals.set(`cdnTestStatus_jsdelivr`, 404);
    hexo.locals.set(`cdnTestStatus_unpkg`, 404);
    hexo.locals.set(`cdnTestStatus_cdnjs`, 404);
    hexo.locals.set(`cdnTestStatus_zstatic`, 404);
    hexo.locals.set(`cdnTestStatus_npmmirror`, 404);
  }
});

// The box is drawn to one width whatever the version strings are, so the
// console's build log can fit it to a line and stack its rows without a seam.
const BANNER_ART = [
  "██████╗ ███████╗██████╗ ███████╗███████╗██╗███╗   ██╗███████╗   ██╗  ██╗",
  "██╔══██╗██╔════╝██╔══██╗██╔════╝██╔════╝██║████╗  ██║██╔════╝   ╚██╗██╔╝",
  "██████╔╝█████╗  ██║  ██║█████╗  █████╗  ██║██╔██╗ ██║█████╗█████╗╚███╔╝",
  "██╔══██╗██╔══╝  ██║  ██║██╔══╝  ██╔══╝  ██║██║╚██╗██║██╔══╝╚════╝██╔██╗",
  "██║  ██║███████╗██████╔╝███████╗██║     ██║██║ ╚████║███████╗   ██╔╝ ██╗",
  "╚═╝  ╚═╝╚══════╝╚═════╝ ╚══════╝╚═╝     ╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝  ╚═╝",
];
const BANNER_INNER = 85;

function banner(status) {
  const width = (text) => [...text].length;
  const row = (text = "") => "|" + text + " ".repeat(Math.max(0, BANNER_INNER - width(text))) + "|";
  const center = (text) => row(" ".repeat(Math.max(0, Math.floor((BANNER_INNER - width(text)) / 2))) + text);
  const left = " ".repeat(Math.floor((BANNER_INNER - Math.max(...BANNER_ART.map(width))) / 2));
  const rule = "+" + "=".repeat(BANNER_INNER) + "+";
  return [
    "",
    rule,
    row(),
    ...BANNER_ART.map((line) => row(left + line)),
    row(),
    center(status),
    center("https://github.com/Jason-JP-Yang/hexo-theme-Redefine-X"),
    rule,
  ].join("\n");
}

function logInfo(data) {
  hexo.log.info(banner(`current v${version}  latest v${data.npmVersion}`));
}

function logFailedInfo() {
  hexo.log.info(banner(`current v${version}  fetch latest failed`));
}

function checkVersionAndCDNAvailability(data) {
  if (data.npmVersion > version) {
    hexo.log.warn(
      `\x1b[33m%s\x1b[0m`,
      `Redefine-X v${version} is outdated, please update to v${data.npmVersion}!`,
    );
  }

  // jsdelivr - 推荐CDN
  if (data.jsdelivrCDN) {
    hexo.log.info(
      `\x1b[32m%s\x1b[0m`,
      `CDN available: jsDelivr (Recommended)`,
    );
    hexo.locals.set(`cdnTestStatus_jsdelivr`, 200);
  } else {
    hexo.log.warn(`\x1b[31m%s\x1b[0m`, `jsDelivr CDN is unavailable yet.`);
    hexo.locals.set(`cdnTestStatus_jsdelivr`, 404);
  }

  // unpkg
  if (data.unpkgCDN) {
    hexo.log.info(`\x1b[32m%s\x1b[0m`, `CDN available: unpkg`);
    hexo.locals.set(`cdnTestStatus_unpkg`, 200);
  } else {
    hexo.log.warn(`\x1b[31m%s\x1b[0m`, `unpkg CDN is unavailable yet.`);
    hexo.locals.set(`cdnTestStatus_unpkg`, 404);
  }

  // cdnjs
  if (data.cdnjsCDN) {
    hexo.log.info(`\x1b[32m%s\x1b[0m`, `CDN available: CDNJS`);
    hexo.locals.set(`cdnTestStatus_cdnjs`, 200);
  } else {
    hexo.log.warn(`\x1b[31m%s\x1b[0m`, `CDNJS CDN is unavailable yet.`);
    hexo.locals.set(`cdnTestStatus_cdnjs`, 404);
  }

  // zstatic
  if (data.zstaticCDN) {
    hexo.log.info(`\x1b[32m%s\x1b[0m`, `CDN available: ZStatic`);
    hexo.locals.set(`cdnTestStatus_zstatic`, 200);
  } else {
    hexo.log.warn(`\x1b[31m%s\x1b[0m`, `ZStatic CDN is unavailable yet.`);
    hexo.locals.set(`cdnTestStatus_zstatic`, 404);
  }

  // npmmirror
  if (data.npmmirrorCDN) {
    hexo.log.info(`\x1b[32m%s\x1b[0m`, `CDN available: NPMMirror`);
    hexo.locals.set(`cdnTestStatus_npmmirror`, 200);
  } else {
    hexo.log.warn(`\x1b[31m%s\x1b[0m`, `NPMMirror CDN is unavailable yet.`);
    hexo.locals.set(`cdnTestStatus_npmmirror`, 404);
  }
}
