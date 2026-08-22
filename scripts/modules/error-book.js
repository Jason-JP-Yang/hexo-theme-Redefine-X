"use strict";

/**
 * Module: Error Book (interactive 错题本)
 * hexo-theme-redefine-x
 *
 * Turns a plain, marker-per-line block of Markdown into a deck of interactive
 * revision cards. Two card types, both auto-detected from what the block
 * contains rather than from anything the author has to declare:
 *
 *   • a card that carries two or more lettered options is MULTIPLE CHOICE
 *   • any other card is a WRITTEN answer — with a fill-in box when a key answer
 *     was given, and without one when the question is open-ended
 *
 * SYNTAX (every marker sits at the start of a line; everything after it, up to
 * the next marker, is ordinary Markdown and may span paragraphs):
 *
 *   Q:  the question stem — starts a new card
 *   A:  … J:   a lettered option (multiple choice only)
 *   X:  why the option directly above is wrong
 *   =   the correct answer — a letter for MC, the key answer for written ones
 *       (write `a | b` to accept alternatives)
 *   !   what I answered last time and got wrong
 *   T:  optional topic chips for the card
 *   S:  the full solution — also implied by any unmarked text after `=` / `!`
 *
 * A Markdown heading ends the current card and returns to ordinary prose, so a
 * book can be organised by topic without any wrapper per section. Text before
 * the first `Q:` is rendered as ordinary prose too.
 *
 * USAGE:
 *   {% errorbook %} … {% enderrorbook %}   anywhere in a post, or
 *   errorbook: true                        in the front matter, which treats
 *                                          the whole post body as one book
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

/* ================================================================== */
/*  Strings                                                           */
/* ================================================================== */

const FALLBACK_STRINGS = {
  mc: "Multiple choice",
  written: "Written answer",
  open: "Open response",
  review: "Last incorrect attempt",
  answer: "Show answer",
  mine: "I answered",
  yours: "You answered",
  correct: "Correct answer",
  solution: "Solution",
  check: "Check",
  clear: "Clear",
  placeholder: "Final answer",
};

let cachedStrings = null;

function getStrings() {
  if (cachedStrings) return cachedStrings;

  const dir = path.join(__dirname, "../../languages");
  const language = String(hexo.config.language || "en");
  let loaded = null;

  for (const name of [`${language}.yml`, "en.yml"]) {
    try {
      const doc = yaml.load(fs.readFileSync(path.join(dir, name), "utf8"));
      if (doc && doc.error_book) {
        loaded = doc.error_book;
        break;
      }
    } catch (e) {
      // Missing or unreadable translation — try the next candidate.
    }
  }

  cachedStrings = Object.assign({}, FALLBACK_STRINGS, loaded || {});
  return cachedStrings;
}

/* ================================================================== */
/*  Parsing                                                           */
/* ================================================================== */

// Option letters stop at J so that X (why-wrong), S (solution) and T (tags)
// can never collide with an option marker.
const RE_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const RE_HEADING = /^[ \t]{0,3}#{1,6}\s/;
const RE_QUESTION = /^[ \t]{0,3}(?:Q|Question)[ \t]*\d*[ \t]*[:.)、][ \t]?(.*)$/i;
const RE_OPTION = /^[ \t]{0,3}([A-J])[ \t]*[:.)、][ \t]?(.*)$/;
const RE_WHY = /^[ \t]{0,3}(?:X|Why)[ \t]*[:.)、][ \t]?(.*)$/i;
const RE_ANSWER = /^[ \t]{0,3}(?:=[ \t]*|(?:Ans|Answer)[ \t]*[:.)][ \t]*)(.*)$/i;
const RE_MINE = /^[ \t]{0,3}(?:!(?!\[)[ \t]*|(?:My|Mine)[ \t]*[:.)][ \t]*)(.*)$/i;
const RE_SOLUTION = /^[ \t]{0,3}(?:S|Sol|Solution)[ \t]*[:.)][ \t]?(.*)$/i;
const RE_TAGS = /^[ \t]{0,3}(?:T|Tag|Tags)[ \t]*[:.)][ \t]?(.*)$/i;

function newCard() {
  return {
    kind: "card",
    stem: [],
    options: [],
    whyMine: [],
    solution: [],
    answer: "",
    mine: "",
    tags: "",
  };
}

/**
 * Split a book into an ordered list of prose blocks and cards.
 *
 * The state machine exists for one reason: once a solution has started, the
 * only markers still recognised are `Q:` and a heading. A solution is the one
 * field likely to contain lines that merely LOOK like markers — "A. because …"
 * inside a written explanation being the obvious case — and mis-reading one of
 * those silently tears the card in half.
 */
function parseBook(raw) {
  const lines = String(raw || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];

  let prose = [];
  let card = null;
  let state = "prose"; // prose | stem | option | why | meta | solution
  let fence = null;

  const flushProse = () => {
    if (prose.join("\n").trim()) blocks.push({ kind: "prose", text: prose.join("\n") });
    prose = [];
  };

  const flushCard = () => {
    if (card) blocks.push(card);
    card = null;
  };

  const lastOption = () => card.options[card.options.length - 1];

  const append = (line) => {
    switch (state) {
      case "stem":
        card.stem.push(line);
        break;
      case "option":
        lastOption().text.push(line);
        break;
      case "why":
        (card.options.length ? lastOption().why : card.whyMine).push(line);
        break;
      case "solution":
        card.solution.push(line);
        break;
      case "meta":
        // `=` and `!` are single-line fields. Blank lines after them belong to
        // nothing; the first line of real content opens the solution.
        if (!line.trim()) return;
        state = "solution";
        card.solution.push(line);
        break;
      default:
        prose.push(line);
    }
  };

  for (const line of lines) {
    const fenceHere = line.match(RE_FENCE);

    // Nothing inside a fenced code block is a marker.
    if (fence) {
      append(line);
      if (fenceHere && fenceHere[1][0] === fence[0] && fenceHere[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceHere) {
      fence = fenceHere[1];
      append(line);
      continue;
    }

    const question = line.match(RE_QUESTION);
    if (question) {
      flushProse();
      flushCard();
      card = newCard();
      state = "stem";
      if (question[1].trim()) card.stem.push(question[1]);
      continue;
    }

    if (state === "prose") {
      prose.push(line);
      continue;
    }

    // A heading closes the current card and hands the page back to prose.
    if (RE_HEADING.test(line)) {
      flushCard();
      state = "prose";
      prose.push(line);
      continue;
    }

    if (state !== "solution") {
      const option = line.match(RE_OPTION);
      if (option) {
        card.options.push({
          letter: option[1],
          text: option[2].trim() ? [option[2]] : [],
          why: [],
        });
        state = "option";
        continue;
      }

      const why = line.match(RE_WHY);
      if (why) {
        const bucket = card.options.length ? lastOption().why : card.whyMine;
        bucket.length = 0;
        if (why[1].trim()) bucket.push(why[1]);
        state = "why";
        continue;
      }

      const answer = line.match(RE_ANSWER);
      if (answer) {
        card.answer = answer[1].trim();
        state = "meta";
        continue;
      }

      const mine = line.match(RE_MINE);
      if (mine) {
        card.mine = mine[1].trim();
        state = "meta";
        continue;
      }

      const tags = line.match(RE_TAGS);
      if (tags) {
        card.tags = tags[1].trim();
        state = "meta";
        continue;
      }

      const solution = line.match(RE_SOLUTION);
      if (solution) {
        state = "solution";
        if (solution[1].trim()) card.solution.push(solution[1]);
        continue;
      }
    }

    append(line);
  }

  flushProse();
  flushCard();
  return blocks;
}

/* ================================================================== */
/*  Rendering                                                         */
/* ================================================================== */

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdown(text) {
  const source = (Array.isArray(text) ? text.join("\n") : String(text || "")).trim();
  if (!source) return "";
  return hexo.render.renderSync({ text: source, engine: "markdown" }).trim();
}

/**
 * Headings written inside a card are demoted to styled paragraphs, the way
 * `folding` does it: a card is a fragment of a page, and its internal headings
 * have no business in the article's table of contents.
 */
function renderField(text) {
  return renderMarkdown(text)
    .replace(/<(h[1-6])([^>]*)>/gi, (_, tag) => `<p class="${tag.toLowerCase()}">`)
    .replace(/<\/h[1-6]>/gi, "</p>");
}

/** Same, minus the paragraph wrapper when the field is a single paragraph. */
function renderInline(text) {
  const html = renderField(text);
  const single = html.match(/^<p>([\s\S]*)<\/p>$/);
  return single && !/<p[\s>]/i.test(single[1]) ? single[1] : html;
}

function pickLetters(value) {
  const found = String(value || "").toUpperCase().match(/[A-J]/g);
  return found ? Array.from(new Set(found)) : [];
}

function collapse(inner, extraClass) {
  return (
    `<div class="eb-collapse${extraClass ? " " + extraClass : ""}">` +
    `<div class="eb-collapse-inner">${inner}</div>` +
    `</div>`
  );
}

function chip(kind, icon, label, valueHTML) {
  return (
    `<span class="eb-chip eb-chip--${kind}">` +
    `<i class="fa-solid ${icon}" aria-hidden="true"></i>` +
    `<span class="eb-chip-label">${esc(label)}</span>` +
    `<span class="eb-chip-value">${valueHTML}</span>` +
    `</span>`
  );
}

function buildOptions(card) {
  const correct = pickLetters(card.answer);

  const items = card.options.map((option) => {
    const letter = option.letter.toUpperCase();
    const why = renderField(option.why);
    const isCorrect = correct.includes(letter);

    return (
      `<li class="eb-option" data-eb-letter="${esc(letter)}">` +
      `<div class="eb-opt-hit" role="button" tabindex="0">` +
      `<span class="eb-opt-key">${esc(letter)}</span>` +
      `<span class="eb-opt-text markdown-body">${renderInline(option.text)}</span>` +
      `<i class="eb-opt-mark fa-solid" aria-hidden="true"></i>` +
      `</div>` +
      (why && !isCorrect
        ? collapse(`<div class="eb-why markdown-body">${why}</div>`, "eb-why-wrap")
        : "") +
      `</li>`
    );
  });

  return `<ol class="eb-options">${items.join("")}</ol>`;
}

function buildVerdict(card, isMC, S) {
  const correctLetters = pickLetters(card.answer);
  const mineLetters = pickLetters(card.mine);

  const correctValue =
    isMC && correctLetters.length ? esc(correctLetters.join(" / ")) : renderInline(card.answer);
  const mineValue =
    isMC && mineLetters.length ? esc(mineLetters.join(" / ")) : renderInline(card.mine);

  const chips =
    (card.mine ? chip("mine", "fa-xmark", S.mine, mineValue) : "") +
    (card.answer ? chip("right", "fa-check", S.correct, correctValue) : "");

  return chips ? `<div class="eb-verdict eb-verdict--record">${chips}</div>` : "";
}

function buildCard(card, index, S) {
  const isMC = card.options.length >= 2;
  const hasKey = card.answer !== "";
  const type = isMC ? "mc" : "long";

  const badge = isMC ? S.mc : hasKey ? S.written : S.open;
  const stem = renderField(card.stem);
  const solution = renderField(card.solution);
  const whyMine = renderField(card.whyMine);
  const verdict = buildVerdict(card, isMC, S);

  const tags = card.tags
    .split(/[,，、|]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => `<span class="eb-tag">${esc(tag)}</span>`)
    .join("");

  const head =
    `<div class="eb-head">` +
    `<span class="eb-no">${String(index).padStart(2, "0")}</span>` +
    `<span class="eb-type">${esc(badge)}</span>` +
    (tags ? `<span class="eb-tags">${tags}</span>` : "") +
    `</div>`;

  // The fill-in box exists only where there is a key answer to check against.
  // An open-ended question has nothing a string comparison could rule on, so it
  // gets the reveal button alone.
  const field =
    !isMC && hasKey
      ? `<form class="eb-answer" novalidate>` +
        `<input class="eb-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"` +
        ` placeholder="${esc(S.placeholder)}" aria-label="${esc(S.placeholder)}">` +
        `<button class="eb-check" type="submit">${esc(S.check)}</button>` +
        `</form>`
      : "";

  const reviewBody =
    verdict +
    `<div class="eb-verdict eb-verdict--live" hidden` +
    ` data-eb-yours="${esc(S.yours)}" data-eb-correct="${esc(S.correct)}"></div>` +
    (whyMine ? `<div class="eb-whymine markdown-body">${whyMine}</div>` : "") +
    (solution
      ? `<div class="eb-solution markdown-body">` +
        `<span class="eb-solution-label">${esc(S.solution)}</span>${solution}</div>`
      : "");

  const hasReview = Boolean(verdict || whyMine || solution);
  const label = card.mine ? S.review : S.answer;

  // Anything the reader can answer can also be un-answered. The button ships
  // hidden and the runtime reveals it the moment a card has a state to clear.
  const canAnswer = isMC || hasKey;

  const foot =
    hasReview || canAnswer
      ? `<div class="eb-foot">` +
        (hasReview
          ? `<button class="eb-review-toggle" type="button" aria-expanded="false">` +
            `<i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>` +
            `<span>${esc(label)}</span>` +
            `<i class="eb-caret fa-solid fa-chevron-down" aria-hidden="true"></i>` +
            `</button>`
          : "") +
        (canAnswer
          ? `<button class="eb-clear" type="button" hidden>` +
            `<i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i>` +
            `<span>${esc(S.clear)}</span>` +
            `</button>`
          : "") +
        `</div>`
      : "";

  return (
    `<article class="eb-card eb-card--${type}" data-eb-type="${type}"` +
    ` data-eb-answer="${esc(card.answer)}" data-eb-mine="${esc(card.mine)}">` +
    head +
    (stem ? `<div class="eb-stem markdown-body">${stem}</div>` : "") +
    (isMC ? buildOptions(card) : "") +
    field +
    foot +
    (hasReview ? collapse(reviewBody, "eb-review") : "") +
    `</article>`
  );
}

/* ================================================================== */
/*  Tag                                                               */
/* ================================================================== */

// Cards are numbered across the whole post, not per block, so a book split by
// topic headings still reads 01, 02, 03 … down the page.
const counters = new Map();

function nextIndex(ctx) {
  const key = (ctx && (ctx.source || ctx.path)) || "__error_book__";
  const value = (counters.get(key) || 0) + 1;
  counters.set(key, value);
  return value;
}

function errorBook(args, content) {
  const S = getStrings();
  const blocks = parseBook(content);

  const html = blocks
    .map((block) =>
      block.kind === "prose"
        ? `<div class="eb-prose markdown-body">${renderMarkdown(block.text)}</div>`
        : buildCard(block, nextIndex(this), S),
    )
    .join("");

  return `<div class="error-book" data-error-book>${html}</div>`;
}

hexo.extend.tag.register("errorbook", errorBook, { ends: true });
hexo.extend.tag.register("error-book", errorBook, { ends: true });
hexo.extend.tag.register("ebook", errorBook, { ends: true });

/**
 * `errorbook: true` in the front matter wraps the whole body, so a dedicated
 * error-book post needs no wrapper markers at all.
 *
 * Priority 6 puts this after the MathJax extractor (5) and before Hexo's
 * backtick code-block filter (10): math inside the body has already been lifted
 * out into placeholders by the time the body becomes a Nunjucks block, which is
 * what keeps `$…$` working inside cards.
 */
hexo.extend.filter.register(
  "before_post_render",
  function (data) {
    counters.set(data.source || data.path || "__error_book__", 0);

    if (data.errorbook !== true && data.error_book !== true) return data;
    if (/\{%\s*(?:error-?book|ebook)\b/i.test(data.content)) return data;

    data.content = `{% errorbook %}\n${data.content}\n{% enderrorbook %}`;
    return data;
  },
  6,
);
