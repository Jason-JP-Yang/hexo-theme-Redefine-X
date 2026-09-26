/**
 * Guide mocks — the glyphs drawn here.
 *
 * Apple's app icons are Apple's own (apple.js). What is drawn here is what was
 * not supplied: the Mac's Finder and Trash, Windows' taskbar, the browsers'
 * marks, Google's sign-in G, GitHub's passkey glyph and the phones' status bar.
 * Vector, so sharp at any camera zoom.
 *
 * Gradient ids carry a per-drawing number, because a world is rebuilt on every
 * loop and two drawings may be on the page at once.
 */

let seq = 0;

const lin = (id, a, b, x2 = 0, y2 = 1) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;

function draw(body, defs = "") {
  return `<svg viewBox="0 0 60 60" aria-hidden="true" focusable="false">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
}

// ─── the Mac's Dock ──────────────────────────────────────────
export function finder() {
  return draw(
    '<rect width="60" height="60" rx="13.2" fill="#EAF4FF"/><path fill="#1E8CF7" d="M13.2 0H33c-2.6 7.8-4.4 15.4-4.7 24.2h5c-.6 11.4.6 24 3.3 35.8H13.2A13.2 13.2 0 0 1 0 46.8V13.2A13.2 13.2 0 0 1 13.2 0z"/>' +
      '<rect x="17.8" y="17.5" width="3" height="9.5" rx="1.5" fill="#1C1C1E"/><rect x="39" y="17.5" width="3" height="9.5" rx="1.5" fill="#1C1C1E"/>' +
      '<path d="M17 39.5c7.6 5.3 18.4 5.3 26 0" fill="none" stroke="#1C1C1E" stroke-width="2.4" stroke-linecap="round"/>',
  );
}

// The Dock's Trash is the one icon with no tile under it.
export function trash() {
  const g = `gdi${++seq}`;
  return draw(
    `<path fill="url(#${g})" d="M14.5 17h31l-3 34.5a3.4 3.4 0 0 1-3.4 3.1H20.9a3.4 3.4 0 0 1-3.4-3.1z" stroke="#9A9AA3" stroke-width=".8"/>` +
      '<g stroke="#A5A5AD" stroke-width=".9"><line x1="22" y1="21" x2="23.4" y2="51"/><line x1="30" y1="21" x2="30" y2="51"/><line x1="38" y1="21" x2="36.6" y2="51"/></g>' +
      '<rect x="12.5" y="13.5" width="35" height="4.6" rx="2.3" fill="#D8D8DE" stroke="#9A9AA3" stroke-width=".8"/>',
    lin(g, "#F2F2F6", "#C9C9D0"),
  );
}

// ─── browsers and systems ────────────────────────────────────
export function chrome() {
  const sector = (color, rot) =>
    `<path fill="${color}" transform="rotate(${rot} 30 30)" d="M30 30 L30 6 A24 24 0 0 1 50.78 42 Z"/>`;
  return draw(
    sector("#EA4335", -60) + sector("#FBBC05", 60) + sector("#34A853", 180) +
      '<circle cx="30" cy="30" r="11.2" fill="#fff"/><circle cx="30" cy="30" r="8.8" fill="#4285F4"/>',
  );
}

export function edge() {
  const g = `gdi${++seq}`;
  return draw(
    `<path fill="url(#${g}a)" d="M51.6 38.3c-1.8 6.5-9.2 14.7-21.4 14.7-9.9 0-17.2-6.9-17.2-15.2 0-8.9 7.8-14 15.2-14 6.4 0 10.4 3.4 10.4 7 0 2.1-1.5 3.5-3.4 3.5-3 0-2.2-3.7-7.4-3.7-3.7 0-6.8 2.8-6.8 6.8 0 5.5 5.4 9.7 12 9.7 7.2 0 13.9-3.7 18.6-8.8z"/>` +
      `<path fill="url(#${g}b)" d="M8.3 29.1C9.9 16.4 19.6 7 31.2 7c12.4 0 21.8 9.6 21.8 21.6 0 6.3-4.1 10.2-9.7 10.2-4.7 0-6.6-2.3-6.6-4.5 0-3.8 3.2-4.9 3.2-9.3C39.9 18.9 34.1 15 28 15c-8.8 0-16.5 6.4-19.7 14.1z"/>`,
    lin(`${g}a`, "#34C1F6", "#1062C6", 1, 0) + lin(`${g}b`, "#3DDC84", "#0C8A72", 0, 1),
  );
}

export function windowsLogo() {
  const g = `gdi${++seq}`;
  return draw(
    `<g fill="url(#${g})"><rect x="8" y="8" width="21" height="21" rx="1.2"/><rect x="31" y="8" width="21" height="21" rx="1.2"/>` +
      `<rect x="8" y="31" width="21" height="21" rx="1.2"/><rect x="31" y="31" width="21" height="21" rx="1.2"/></g>`,
    lin(g, "#4FC3FF", "#0067C0", 1, 1),
  );
}

export function explorer() {
  return draw(
    '<path fill="#E9A81C" d="M7 16a4 4 0 0 1 4-4h11.5l5 5H49a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4z"/>' +
      '<rect x="7" y="21" width="46" height="28" rx="4" fill="#FFCD4A"/><rect x="7" y="37" width="46" height="5" fill="#0F6CBD"/>',
  );
}

export function taskView() {
  return draw(
    '<rect x="9" y="16" width="30" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="3.2"/>' +
      '<rect x="21" y="24" width="30" height="22" rx="4" fill="currentColor" opacity=".35"/>',
  );
}

// Google's sign-in mark, as its branding guidelines publish it for buttons.
export function googleG() {
  return (
    '<svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">' +
    '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"/>' +
    '<path fill="#34A853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z"/>' +
    '<path fill="#FBBC05" d="M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04z"/>' +
    '<path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"/>' +
    "</svg>"
  );
}

// GitHub's passkey glyph: a person with a key.
export function passkey() {
  return (
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor">' +
    '<circle cx="6" cy="4.4" r="3"/><path d="M1 13.2C1 10.6 3.2 8.9 6 8.9c1.2 0 2.3.3 3.1.8a3.9 3.9 0 0 0-.6 2.1c0 .7.2 1.4.5 2H1.6a.6.6 0 0 1-.6-.6z"/>' +
    '<path d="M12.3 8.9a2.9 2.9 0 0 0-1.4 5.5v1.2l.9.9.9-.9-.6-.6.6-.6-.5-.5a2.9 2.9 0 0 0 .1-5zm0 1.2a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6z"/>' +
    "</svg>"
  );
}

// ─── status bar glyphs ───────────────────────────────────────
export const STATUS = {
  signal:
    '<svg viewBox="0 0 18 12" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></svg>',
  wifi:
    '<svg viewBox="0 0 16 12" aria-hidden="true"><path d="M8 11.6 5.6 9.2a3.4 3.4 0 0 1 4.8 0zM3.5 7.1a6.4 6.4 0 0 1 9 0l1.4-1.4a8.4 8.4 0 0 0-11.8 0zM.7 4.3a10.4 10.4 0 0 1 14.6 0L16 3.6 14.7 2.3a12.4 12.4 0 0 0-13.4 0L0 3.6z"/></svg>',
  battery:
    '<svg viewBox="0 0 27 12" aria-hidden="true"><rect x=".5" y=".5" width="23" height="11" rx="3.2" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="20" height="8" rx="2"/><path d="M25 4v4a1.9 1.9 0 0 0 0-4z" opacity=".45"/></svg>',
};
