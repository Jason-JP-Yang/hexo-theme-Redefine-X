// ─── Colour helpers ───────────────────────────────────────────────────────────
export function hexToRgb(hex) {
  hex = hex.replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function luminance(r, g, b) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
export function contrastTextColor(bgHex) {
  const [r, g, b] = hexToRgb(bgHex);
  return luminance(r, g, b) > 0.38 ? "#1a1a1a" : "#ffffff";
}

// ─── Time formatting ──────────────────────────────────────────────────────────
export function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

// ─── Small utils ──────────────────────────────────────────────────────────────
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
export function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {
    return false;
  }
}

// ─── Compact-layout constants ─────────────────────────────────────────────────
export const PAD = 8;
export const GAP_X = 6;
export const GAP_Y = 8;
export const LABEL_PAD = 28;
export const TAIL = 12;
export const AVATAR_OVERLAP = 10;
export const EMOJI_TOP_MIN = 18;
export const MIN_READABLE_W = 96;
export const MIN_PANEL_W = 300;        // floor for the panel width, compact + normal + expanded
export const MAX_BUBBLE_CAP = 280;
export const MAX_BUBBLE_FRAC = 0.46;
export const MAX_LANES = 4;
export const MAX_JITTER = 8;
export const EMOJI_RIGHT_EXTRA = 14;
export const COMPACT_RATIO = 0.80;

// ─── Expand-mode constants ────────────────────────────────────────────────────
export const GLIDE = "cubic-bezier(0.16,1,0.3,1)";
export const FRAME_MS = 480;
export const BAND_GAP = 12;
export const EXPAND_GAP_TOP = 12;
export const EXPAND_GAP_SIDE = 10;
export const LIST_GAP_Y = 10;
export const LIST_MAX_W = 460;
export const STATUS_LEFT_RESERVE = 68;
export const EMOJI_TOP_EXTRA = 15;
export const EMOJI_W_PAD = 34;
export const EXPAND_FILL_RATIO = 0.8;
export const ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000;
export const WRAP_QUERY = "(max-width: 768px)";

// ─── Bubble cross-fade timings ────────────────────────────────────────────────
export const FADE_OUT_MS = 200;
export const FADE_IN_MS = 260;
export const FADE_BLUR = "blur(6px)";
