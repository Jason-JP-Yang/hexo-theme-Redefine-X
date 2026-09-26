/**
 * Guide mocks — the three GitHub pages between Follow and following.
 *
 * Signing in to continue to giscus, creating an account, and authorizing giscus,
 * as GitHub draws them: the dark sign-in and authorize pages, and the split
 * sign-up page with GitHub's own starfield and mascots (images/guide). GitHub's
 * pages are in English everywhere, so these are not translated.
 *
 * On a desktop a page is laid out at 1600 × n CSS pixels — the window the
 * reference screenshots were taken in — and scaled into the browser's page area
 * (`view`, {w, h}), so it keeps the proportions GitHub gives it. On a phone
 * (`view` null) it is laid out at the phone's own width.
 */

import { googleG, passkey } from "./icons.js";

const WIDE = 1600;

function root(cls, view, dark = false) {
  const kind = `gd-gh ${cls}${dark ? " is-dark" : ""}`;
  if (!view) return `<div class="${kind} is-narrow">`;
  const s = view.w / WIDE;
  return `<div class="${kind} is-wide" style="--gd-ghs:${s.toFixed(5)};height:${(view.h / s).toFixed(1)}px">`;
}

const field = (cls, type = "", placeholder = "") =>
  `<span class="gd-gh-input ${cls} ${type}"><span class="gd-val"></span><i class="gd-caret"></i>` +
  (placeholder ? `<span class="gd-gh-ph">${placeholder}</span>` : "") +
  "</span>";

// giscus's app logo is its gem on white.
const giscus = (cls) => `<span class="gd-gh-giscus ${cls}"></span>`;

export function signin(view = null) {
  return (
    root("gd-gh-signin", view, true) +
    '<div class="gd-gh-col">' +
    giscus("gd-gh-logo") +
    "<h1>Sign in to <b>GitHub</b><br>to continue to <b>giscus</b></h1>" +
    '<div class="gd-gh-fields"><label>Username or email address</label>' +
    field("gd-f-login") +
    '<span class="gd-gh-label-row"><label>Password</label><a>Forgot password?</a></span>' +
    field("gd-f-password", "is-secret") +
    '<span class="gd-gh-btn is-green gd-f-signin">Sign in</span></div>' +
    '<span class="gd-gh-or"><span>or</span></span>' +
    `<span class="gd-gh-btn is-alt">${passkey()}Continue with passkey</span>` +
    `<span class="gd-gh-btn is-alt">${googleG()}Continue with Google</span>` +
    '<span class="gd-gh-btn is-alt"><i class="fa-brands fa-apple" aria-hidden="true"></i>Continue with Apple</span>' +
    '<p class="gd-gh-new">New to GitHub? <a class="gd-f-create">Create an account</a></p>' +
    "</div></div>"
  );
}

export function signup(view = null) {
  const perks = [
    ["Access to GitHub Copilot", "Increase your productivity and accelerate software development."],
    ["Unlimited repositories", "Collaborate securely on public and private projects."],
    ["Integrated code reviews", "Boost code quality with built-in review tools."],
    ["Automated workflows", "Save time with CI/CD integrations and GitHub Actions."],
    ["Community support", "Connect with developers worldwide for instant feedback and insights."],
  ];
  const side =
    '<div class="gd-gh-space"><div class="gd-gh-space-in"><h2>Create your free account</h2>' +
    "<p>Explore GitHub's core features for individuals and organizations.</p>" +
    '<b class="gd-gh-incl">See what\'s included <i class="fa-solid fa-chevron-up" aria-hidden="true"></i></b>' +
    `<ul>${perks.map(([h, p]) => `<li><i class="fa-solid fa-check" aria-hidden="true"></i><span><b>${h}</b>${p}</span></li>`).join("")}</ul>` +
    '</div><span class="gd-gh-mascots"></span></div>';
  const hint = (s) => `<small>${s}</small>`;
  const form =
    '<div class="gd-gh-form"><h1>Sign up for GitHub</h1>' +
    `<span class="gd-gh-btn is-alt">${googleG()}Continue with Google</span>` +
    '<span class="gd-gh-btn is-alt"><i class="fa-brands fa-apple" aria-hidden="true"></i>Continue with Apple</span>' +
    '<span class="gd-gh-or"><span>or</span></span>' +
    '<div class="gd-gh-fields"><label>Email<sup>*</sup></label>' +
    field("gd-f-email", "", "Email") +
    "<label>Password<sup>*</sup></label>" +
    field("gd-f-pass", "is-secret", "Password") +
    hint("Password should be at least 15 characters OR at least 8 characters including a number and a lowercase letter.") +
    "<label>Username<sup>*</sup></label>" +
    field("gd-f-user", "", "Username") +
    hint("Username may only contain alphanumeric characters or single hyphens, and cannot begin or end with a hyphen.") +
    '</div><div class="gd-gh-submit"><label>Your Country/Region<sup>*</sup></label>' +
    '<span class="gd-gh-input gd-gh-select">United States of America<i class="fa-solid fa-chevron-down" aria-hidden="true"></i></span>' +
    hint("For compliance reasons, we're required to collect country information to send you occasional updates and announcements.") +
    '<label class="gd-gh-pref">Email preferences</label>' +
    '<span class="gd-gh-check"><i></i>Receive occasional product updates and announcements</span>' +
    '<span class="gd-gh-btn is-green is-big gd-f-go">Create account <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span>' +
    '<p class="gd-gh-terms">By creating an account, you agree to the <a>Terms of Service</a>. For more information about GitHub\'s privacy practices, see the <a>GitHub Privacy Statement</a>. We\'ll occasionally send you account-related emails.</p>' +
    "</div></div>";
  return `${root("gd-gh-signup", view)}${view ? side : ""}<div class="gd-gh-right">${form}</div></div>`;
}

export function authorize(view = null, login = "your-name") {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return (
    root("gd-gh-auth", view, true) +
    '<div class="gd-gh-col">' +
    `<div class="gd-gh-pair">${giscus("gd-gh-app")}<i class="gd-gh-dash"></i>` +
    '<i class="fa-regular fa-shield-check gd-gh-shield" aria-hidden="true"></i><i class="gd-gh-dash"></i>' +
    '<span class="gd-gh-mark"><i class="fa-brands fa-github" aria-hidden="true"></i></span></div>' +
    '<h1><a>giscus</a> by <a>giscus</a><br><span>wants access to your GitHub account</span></h1>' +
    '<div class="gd-gh-box"><b class="gd-gh-box-h">Authorizing allows this app to</b>' +
    `<span class="gd-gh-perm"><i class="fa-solid fa-check" aria-hidden="true"></i>Verify your GitHub identity (${esc(login)})</span>` +
    '<span class="gd-gh-perm"><i class="fa-solid fa-check" aria-hidden="true"></i>Know which resources you can access</span>' +
    '<span class="gd-gh-perm"><i class="fa-solid fa-check" aria-hidden="true"></i>Act on your behalf <a>What does this mean?</a></span>' +
    '<hr><span class="gd-gh-meta"><i class="fa-regular fa-ban" aria-hidden="true"></i><span><a>giscus</a> is not owned or operated by GitHub</span></span>' +
    '<span class="gd-gh-meta"><i class="fa-regular fa-clock" aria-hidden="true"></i>Created 6 years ago</span>' +
    '<span class="gd-gh-meta"><i class="fa-regular fa-building" aria-hidden="true"></i>More than 1K GitHub users</span></div>' +
    // Pressed, it turns into GitHub's disabled "Authorizing…" while the redirect loads.
    '<span class="gd-gh-btn is-green is-big gd-f-auth"><span class="gd-gh-idle">Authorize</span>' +
    '<span class="gd-gh-busy"><i class="gd-gh-spin"></i>Authorizing…</span></span>' +
    '<span class="gd-gh-btn is-alt is-big">Cancel</span>' +
    '<p class="gd-gh-redirect">Authorizing will redirect to<br><b>https://giscus.app</b></p>' +
    "</div></div>"
  );
}
