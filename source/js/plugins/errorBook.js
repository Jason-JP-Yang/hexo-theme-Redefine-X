/**
 * Error Book — card interactions
 *
 * Cards are inert HTML until this runs; everything below is the behaviour the
 * markup describes rather than any layout decision, so nothing here measures or
 * writes a pixel value. The two reveal animations are pure CSS grid tracks.
 *
 * The rule the whole module is built around: a right answer reveals NOTHING.
 * Only a wrong one is worth explaining, the recorded past mistake is always one
 * deliberate click away, and any state the reader creates they can also clear.
 */
(function () {
  "use strict";

  const OPEN = "is-open";

  function escapeHTML(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Key answers are short by design, so comparison is deliberately forgiving
   * about the things that carry no meaning: spacing, full-width punctuation and
   * a trailing stop.
   */
  function normalize(value) {
    return String(value == null ? "" : value)
      .toLowerCase()
      .replace(/[\s　]+/g, "")
      .replace(/[，、]/g, ",")
      .replace(/[。．]/g, ".")
      .replace(/（/g, "(")
      .replace(/）/g, ")")
      .replace(/[.,;:!?]+$/, "");
  }

  function setOpen(element, open) {
    if (element) element.classList.toggle(OPEN, open);
  }

  function chip(kind, icon, label, valueHTML) {
    return (
      '<span class="eb-chip eb-chip--' +
      kind +
      '"><i class="fa-solid ' +
      icon +
      '" aria-hidden="true"></i><span class="eb-chip-label">' +
      escapeHTML(label) +
      '</span><span class="eb-chip-value">' +
      valueHTML +
      "</span></span>"
    );
  }

  function initCard(card) {
    if (card.dataset.ebReady === "1") return;
    card.dataset.ebReady = "1";

    const review = card.querySelector(".eb-review");
    const toggle = card.querySelector(".eb-review-toggle");
    const clear = card.querySelector(".eb-clear");
    const record = card.querySelector(".eb-verdict--record");
    const live = card.querySelector(".eb-verdict--live");
    const form = card.querySelector(".eb-answer");
    const input = form ? form.querySelector(".eb-input") : null;

    const showRecord = () => {
      if (record) record.hidden = false;
      if (live) live.hidden = true;
    };

    const showLive = (html) => {
      if (!live) return;
      live.innerHTML = html;
      live.hidden = false;
      if (record) record.hidden = true;
    };

    const openReview = (open) => {
      setOpen(review, open);
      if (toggle) {
        toggle.classList.toggle(OPEN, open);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      }
    };

    const setAnswered = (answered) => {
      if (clear) clear.hidden = !answered;
    };

    // ── multiple choice ─────────────────────────────────────────────
    const answers = (card.dataset.ebAnswer || "").toUpperCase().match(/[A-J]/g) || [];

    const isRight = (option) =>
      answers.indexOf((option.dataset.ebLetter || "").toUpperCase()) !== -1;

    const settle = (option, right) => {
      const mark = option.querySelector(".eb-opt-mark");

      option.classList.remove("is-right", "is-wrong");
      option.classList.add(right ? "is-right" : "is-wrong");

      if (mark) {
        mark.classList.remove("fa-check", "fa-xmark");
        mark.classList.add(right ? "fa-check" : "fa-xmark");
      }
    };

    // Asking for the recorded mistake is asking for the whole card: every
    // option gets ruled on, right one included, and every reason unfolds.
    const revealAll = () => {
      card.querySelectorAll(".eb-option").forEach((option) => {
        const right = isRight(option);
        settle(option, right);
        setOpen(option.querySelector(".eb-why-wrap"), !right);
      });
    };

    card.querySelectorAll(".eb-option").forEach((option) => {
      const hit = option.querySelector(".eb-opt-hit");
      const why = option.querySelector(".eb-why-wrap");
      const right = isRight(option);

      if (!hit) return;

      const choose = () => {
        const answered =
          option.classList.contains("is-right") || option.classList.contains("is-wrong");

        // A second click on an option already ruled on just folds its reason
        // back away, so a card can be re-read without being reset.
        if (answered) {
          if (why) setOpen(why, !why.classList.contains(OPEN));
          return;
        }

        settle(option, right);

        if (right) card.classList.add("is-solved");
        else setOpen(why, true);

        setAnswered(true);
      };

      hit.addEventListener("click", choose);
      hit.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          choose();
        }
      });
    });

    // ── written answer ──────────────────────────────────────────────
    if (form) {
      const accepted = (card.dataset.ebAnswer || "")
        .split("|")
        .map(normalize)
        .filter(Boolean);

      const liveChips = (given) => {
        const recorded = card.querySelector(".eb-verdict--record .eb-chip--right .eb-chip-value");
        const correctHTML = recorded
          ? recorded.innerHTML
          : escapeHTML(card.dataset.ebAnswer || "");

        return (
          chip("mine", "fa-xmark", live ? live.dataset.ebYours : "", escapeHTML(given)) +
          chip("right", "fa-check", live ? live.dataset.ebCorrect : "", correctHTML)
        );
      };

      form.addEventListener("submit", (event) => {
        event.preventDefault();

        const given = input ? input.value : "";
        if (!given.trim()) {
          if (input) input.focus();
          return;
        }

        const right = accepted.indexOf(normalize(given)) !== -1;
        form.classList.toggle("is-right", right);
        form.classList.toggle("is-wrong", !right);
        setAnswered(true);

        if (right) {
          showRecord();
          openReview(false);
          return;
        }

        showLive(liveChips(given));
        openReview(true);
      });
    }

    // ── the recorded mistake ────────────────────────────────────────
    if (toggle && review) {
      toggle.addEventListener("click", () => {
        // Open when closed; also open when the panel is currently showing a
        // live attempt, since that click is a request for the recorded one.
        const showingLive = live && !live.hidden;
        const open = !review.classList.contains(OPEN) || showingLive;

        showRecord();
        openReview(open);

        if (open) {
          revealAll();
          setAnswered(true);
        }
      });
    }

    // ── back to a blank card ────────────────────────────────────────
    if (clear) {
      clear.addEventListener("click", () => {
        card.classList.remove("is-solved");

        card.querySelectorAll(".eb-option").forEach((option) => {
          option.classList.remove("is-right", "is-wrong");

          const mark = option.querySelector(".eb-opt-mark");
          if (mark) mark.classList.remove("fa-check", "fa-xmark");

          setOpen(option.querySelector(".eb-why-wrap"), false);
        });

        if (form) form.classList.remove("is-right", "is-wrong");
        if (input) input.value = "";

        showRecord();
        openReview(false);
        setAnswered(false);
      });
    }
  }

  function initErrorBook() {
    document.querySelectorAll(".eb-card").forEach(initCard);
  }

  document.addEventListener("DOMContentLoaded", initErrorBook);

  try {
    swup.hooks.on("page:view", initErrorBook);
  } catch (e) {}
})();
