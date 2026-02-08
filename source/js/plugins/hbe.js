import { main } from "../main.js";
import { initTOC } from "../layouts/toc.js";
import { initTocToggle } from "../tools/tocToggle.js";

export function initHBE() {
  const cryptoObj = window.crypto || window.msCrypto;
  const storage = window.localStorage;

  const storageName = "hexo-blog-encrypt:#" + window.location.pathname;
  const keySalt = textToArray("too young too simple");
  const ivSalt = textToArray("sometimes naive!");

  // As we can't detect the wrong password with AES-CBC,
  // so adding an empty div and check it when decrption.
  const knownPrefix = "<hbe-prefix></hbe-prefix>";

  const mainElement = document.getElementById("hexo-blog-encrypt");
  const wrongPassMessage = mainElement.dataset["wpm"];
  const wrongHashMessage = mainElement.dataset["whm"];
  const dataElement = mainElement.getElementsByTagName("script")["hbeData"];
  const encryptedData = dataElement.innerText;
  const HmacDigist = dataElement.dataset["hmacdigest"];

  function hexToArray(s) {
    return new Uint8Array(
      s.match(/[\da-f]{2}/gi).map((h) => {
        return parseInt(h, 16);
      }),
    );
  }

  function textToArray(s) {
    var i = s.length;
    var n = 0;
    var ba = new Array();

    for (var j = 0; j < i; ) {
      var c = s.codePointAt(j);
      if (c < 128) {
        ba[n++] = c;
        j++;
      } else if (c > 127 && c < 2048) {
        ba[n++] = (c >> 6) | 192;
        ba[n++] = (c & 63) | 128;
        j++;
      } else if (c > 2047 && c < 65536) {
        ba[n++] = (c >> 12) | 224;
        ba[n++] = ((c >> 6) & 63) | 128;
        ba[n++] = (c & 63) | 128;
        j++;
      } else {
        ba[n++] = (c >> 18) | 240;
        ba[n++] = ((c >> 12) & 63) | 128;
        ba[n++] = ((c >> 6) & 63) | 128;
        ba[n++] = (c & 63) | 128;
        j += 2;
      }
    }
    return new Uint8Array(ba);
  }

  function arrayBufferToHex(arrayBuffer) {
    if (
      typeof arrayBuffer !== "object" ||
      arrayBuffer === null ||
      typeof arrayBuffer.byteLength !== "number"
    ) {
      throw new TypeError("Expected input to be an ArrayBuffer");
    }

    var view = new Uint8Array(arrayBuffer);
    var result = "";
    var value;

    for (var i = 0; i < view.length; i++) {
      value = view[i].toString(16);
      result += value.length === 1 ? "0" + value : value;
    }

    return result;
  }

  async function getExecutableScript(oldElem) {
    let out = document.createElement("script");
    const attList = [
      "type",
      "text",
      "src",
      "crossorigin",
      "defer",
      "referrerpolicy",
    ];
    attList.forEach((att) => {
      if (oldElem[att]) out[att] = oldElem[att];
    });

    return out;
  }

  async function convertHTMLToElement(content) {
    let out = document.createElement("div");
    out.innerHTML = content;
    out.querySelectorAll("script").forEach(async (elem) => {
      elem.replaceWith(await getExecutableScript(elem));
    });

    return out;
  }

  function getKeyMaterial(password) {
    let encoder = new TextEncoder();
    return cryptoObj.subtle.importKey(
      "raw",
      encoder.encode(password),
      {
        name: "PBKDF2",
      },
      false,
      ["deriveKey", "deriveBits"],
    );
  }

  function getHmacKey(keyMaterial) {
    return cryptoObj.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: keySalt.buffer,
        iterations: 1024,
      },
      keyMaterial,
      {
        name: "HMAC",
        hash: "SHA-256",
        length: 256,
      },
      true,
      ["verify"],
    );
  }

  function getDecryptKey(keyMaterial) {
    return cryptoObj.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: keySalt.buffer,
        iterations: 1024,
      },
      keyMaterial,
      {
        name: "AES-CBC",
        length: 256,
      },
      true,
      ["decrypt"],
    );
  }

  function getIv(keyMaterial) {
    return cryptoObj.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: ivSalt.buffer,
        iterations: 512,
      },
      keyMaterial,
      16 * 8,
    );
  }

  async function verifyContent(key, content) {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(content);

    let signature = hexToArray(HmacDigist);

    const result = await cryptoObj.subtle.verify(
      {
        name: "HMAC",
        hash: "SHA-256",
      },
      key,
      signature,
      encoded,
    );
    console.log(`Verification result: ${result}`);
    if (!result) {
      alert(wrongHashMessage);
      console.log(`${wrongHashMessage}, got `, signature, ` but proved wrong.`);
    }
    return result;
  }

  async function decrypt(decryptKey, iv, hmacKey) {
    let typedArray = hexToArray(encryptedData);

    const result = await cryptoObj.subtle
      .decrypt(
        {
          name: "AES-CBC",
          iv: iv,
        },
        decryptKey,
        typedArray.buffer,
      )
      .then(async (result) => {
        const decoder = new TextDecoder();
        const decoded = decoder.decode(result);

        // check the prefix, if not then we can sure here is wrong password.
        if (!decoded.startsWith(knownPrefix)) {
          throw "Decode successfully but not start with KnownPrefix.";
        }

        const hideButton = document.createElement("button");
        hideButton.textContent = "Encrypt again";
        hideButton.type = "button";
        hideButton.classList.add("hbe-button");
        hideButton.addEventListener("click", () => {
          window.localStorage.removeItem(storageName);
          window.location.reload();
        });

        document.getElementById("hexo-blog-encrypt").style.display = "inline";
        document.getElementById("hexo-blog-encrypt").innerHTML = "";
        document
          .getElementById("hexo-blog-encrypt")
          .appendChild(await convertHTMLToElement(decoded));
        document.getElementById("hexo-blog-encrypt").appendChild(hideButton);

        // Trigger lazy loading for any preloaders in decrypted content
        import("../layouts/lazyload.js").then((module) => {
          if (module.forceLoadAllPreloaders) {
            module.forceLoadAllPreloaders();
          }
        }).catch(() => {
          // Fallback: try to load preloaders directly
          document.querySelectorAll(".img-preloader").forEach((preloader) => {
            if (preloader.dataset.loaded !== "true") {
              const src = preloader.dataset.src;
              if (src) {
                const img = document.createElement("img");
                img.src = src;
                img.alt = preloader.dataset.alt || "";
                if (preloader.parentNode) {
                  preloader.parentNode.replaceChild(img, preloader);
                }
              }
            }
          });
        });

        // // load Redefine Page components
        main.refresh();
        rebuildTOC();
        initTOC();
        initTocToggle().pageAsideHandleOfTOC(true);

        // trigger event
        var event = new Event("hexo-blog-decrypt");
        window.dispatchEvent(event);

        return await verifyContent(hmacKey, decoded);
      })
      .catch((e) => {
        alert(wrongPassMessage);
        console.log(e);
        return false;
      });

    return result;
  }

  function rebuildTOC() {
    const container = document.getElementById("hexo-blog-encrypt");
    if (!container) return;

    const headers = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
    if (headers.length === 0) return;

    let tocContainer = document.querySelector(".toc-content-container");
    if (!tocContainer) {
      const postPageContainer = document.querySelector(".post-page-container");
      if (postPageContainer) {
        tocContainer = document.createElement("div");
        tocContainer.className = "toc-content-container";
        postPageContainer.appendChild(tocContainer);
      } else {
        return;
      }
    }

    let tocHTML = '<div class="post-toc-wrap"><div class="post-toc">';
    tocHTML += '<div class="toc-title">Catalog</div>';
    
    const pageTitleElem = document.querySelector(".article-title-regular") || document.querySelector(".article-title-cover");
    const pageTitle = pageTitleElem ? pageTitleElem.innerText : document.title;
    
    tocHTML += `<div class="page-title">${pageTitle}</div>`;
    tocHTML += '<ol class="nav">';

    headers.forEach((header, index) => {
      if (!header.id) {
        header.id = "hbe-" + index + "-" + header.textContent.trim().replace(/\s+/g, "-");
      }
      const level = header.tagName.substring(1);
      tocHTML += `
        <li class="nav-item nav-level-${level}">
          <a class="nav-link" href="#${header.id}">
            <span class="nav-text">${header.textContent}</span>
          </a>
        </li>`;
    });

    tocHTML += "</ol></div></div>";
    tocContainer.innerHTML = tocHTML;
  }

  function hbeLoader() {
    const oldStorageData = JSON.parse(storage.getItem(storageName));

    if (oldStorageData) {
      console.log(
        `Password got from localStorage(${storageName}): `,
        oldStorageData,
      );

      const sIv = hexToArray(oldStorageData.iv).buffer;
      const sDk = oldStorageData.dk;
      const sHmk = oldStorageData.hmk;

      cryptoObj.subtle
        .importKey(
          "jwk",
          sDk,
          {
            name: "AES-CBC",
            length: 256,
          },
          true,
          ["decrypt"],
        )
        .then((dkCK) => {
          cryptoObj.subtle
            .importKey(
              "jwk",
              sHmk,
              {
                name: "HMAC",
                hash: "SHA-256",
                length: 256,
              },
              true,
              ["verify"],
            )
            .then((hmkCK) => {
              decrypt(dkCK, sIv, hmkCK).then((result) => {
                if (!result) {
                  storage.removeItem(storageName);
                }
              });
            });
        });
    }

    mainElement.addEventListener("keydown", async (event) => {
      if (event.isComposing || event.key === "Enter") {
        const password = document.getElementById("hbePass").value;
        const keyMaterial = await getKeyMaterial(password);
        const hmacKey = await getHmacKey(keyMaterial);
        const decryptKey = await getDecryptKey(keyMaterial);
        const iv = await getIv(keyMaterial);

        decrypt(decryptKey, iv, hmacKey).then((result) => {
          console.log(`Decrypt result: ${result}`);
          if (result) {
            cryptoObj.subtle.exportKey("jwk", decryptKey).then((dk) => {
              cryptoObj.subtle.exportKey("jwk", hmacKey).then((hmk) => {
                const newStorageData = {
                  dk: dk,
                  iv: arrayBufferToHex(iv),
                  hmk: hmk,
                };
                storage.setItem(storageName, JSON.stringify(newStorageData));
              });
            });
          }
        });
      }
    });
  }

  hbeLoader();
}

// initHBE();
