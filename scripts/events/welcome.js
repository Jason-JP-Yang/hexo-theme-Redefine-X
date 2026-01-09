/**
 * Theme Redefine
 * welcome.js
 */
const { randomUUID } = require("crypto");
const { version } = require("../../package.json");
const https = require("https");

hexo.on("ready", async () => {
  const timeout = 3000;

  async function sendAnalytics() {
    try {
      const umami = require('@umami/node');
      umami.default.init({
        websiteId: '323f4275-3b46-4bf6-a378-c39d75e4f996',
        hostUrl: 'https://analytics.jason-yang.top',
        sessionId: randomUUID(),
      });
      
      // Store umami instance globally for analytics use
      hexo._umamiInstance = umami.default;
      await umami.default.track({ tag: `v${version}`, url: '/api/v2/info' });
    } catch (error) {
      hexo.log.warn(`Analytics tracking failed: ${error.message}`);
    }
  }

  async function fetchRedefineInfo() {
    return new Promise((resolve, reject) => {
      https
        .get(
          `https://redefine-x-version.jason-yang.top/api/v2/info`,
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

  await sendAnalytics();
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
  hexo._welcomeFinished = true;
});

function logInfo(data) {
  hexo.log.info(
    `
      +=====================================================================================+
      |                                                                                     |
      |      ██████╗ ███████╗██████╗ ███████╗███████╗██╗███╗   ██╗███████╗   ██╗  ██╗       |
      |      ██╔══██╗██╔════╝██╔══██╗██╔════╝██╔════╝██║████╗  ██║██╔════╝   ╚██╗██╔╝       |
      |      ██████╔╝█████╗  ██║  ██║█████╗  █████╗  ██║██╔██╗ ██║█████╗█████╗╚███╔╝        |
      |      ██╔══██╗██╔══╝  ██║  ██║██╔══╝  ██╔══╝  ██║██║╚██╗██║██╔══╝╚════╝██╔██╗        |
      |      ██║  ██║███████╗██████╔╝███████╗██║     ██║██║ ╚████║███████╗   ██╔╝ ██╗       |
      |      ╚═╝  ╚═╝╚══════╝╚═════╝ ╚══════╝╚═╝     ╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝  ╚═╝       |
      |                                                                                     |
      |                             current v${version}  latest v${data.npmVersion}                           |
      |                 https://github.com/Jason-JP-Yang/hexo-theme-Redefine-X              |
      +=====================================================================================+
                      `,
  );
}

function logFailedInfo() {
  hexo.log.info(
    `
      +=====================================================================================+
      |                                                                                     |
      |      ██████╗ ███████╗██████╗ ███████╗███████╗██╗███╗   ██╗███████╗   ██╗  ██╗       |
      |      ██╔══██╗██╔════╝██╔══██╗██╔════╝██╔════╝██║████╗  ██║██╔════╝   ╚██╗██╔╝       |
      |      ██████╔╝█████╗  ██║  ██║█████╗  █████╗  ██║██╔██╗ ██║█████╗█████╗╚███╔╝        |
      |      ██╔══██╗██╔══╝  ██║  ██║██╔══╝  ██╔══╝  ██║██║╚██╗██║██╔══╝╚════╝██╔██╗        |
      |      ██║  ██║███████╗██████╔╝███████╗██║     ██║██║ ╚████║███████╗   ██╔╝ ██╗       |
      |      ╚═╝  ╚═╝╚══════╝╚═════╝ ╚══════╝╚═╝     ╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝  ╚═╝       |
      |                                                                                     |
      |                          current v${version}  fetch latest failed                        |
      |                   https://github.com/Jason-JP-Yang/hexo-theme-Redefine-X            |
      +=====================================================================================+
       `,
  );
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
