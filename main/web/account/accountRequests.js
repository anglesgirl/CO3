// accountRequests.js — native (in-app) versions of the two AO3 account flows
// that used to bounce the user out to a browser:
//
//   * password reset   GET /users/password/new  -> POST /users/password
//   * invitation       GET /invite_requests/new -> POST /invite_requests
//
// Both requests go through the local ECH proxy, so they work on networks where
// AO3 is blocked (an external browser would simply fail there).

import ky, { echUrl } from '../echKy';

const BASE = 'https://archiveofourown.org';

const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
};

// Pulls the Rails CSRF token out of a form page. Attribute order varies, so we
// look for the input by name and then read its value either side of the name.
function extractAuthenticityToken(html) {
  const patterns = [
    /name="authenticity_token"[^>]*\bvalue="([^"]+)"/i,
    /\bvalue="([^"]+)"[^>]*name="authenticity_token"/i,
    /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtml(m[1]);
  }
  throw new Error('Could not find the form token (AO3 may have changed).');
}

function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(s) {
  return decodeHtml(String(s).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// AO3 reports the outcome in a flash message; reading that keeps us correct
// even when the exact wording changes.
function readOutcome(html) {
  const notice = html.match(
    /<div[^>]*class="[^"]*flash[^"]*notice[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  );
  if (notice) return { ok: true, message: stripTags(notice[1]) };

  const error = html.match(
    /<div[^>]*class="[^"]*(?:flash[^"]*error|error)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  );
  if (error) {
    const msg = stripTags(error[1]);
    if (msg) return { ok: false, message: msg };
  }
  return null;
}

async function postForm(path, fields, referer) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);

  const res = await fetch(await echUrl(BASE + path), {
    method: 'POST',
    body,
    credentials: 'include',
    headers: { ...BROWSER_HEADERS, Referer: referer },
  });
  const html = await res.text();
  return { res, html };
}

async function getForm(path) {
  const html = await ky.get(BASE + path, { headers: BROWSER_HEADERS }).text();
  return { html, token: extractAuthenticityToken(html) };
}

/**
 * Requests a password-reset email. `login` may be a username or an email.
 * Resolves with a message to show the user; rejects with AO3's error text.
 */
export async function requestPasswordReset(login) {
  if (!login || !login.trim()) throw new Error('Enter your username or email.');
  const { token } = await getForm('/users/password/new');
  const { res, html } = await postForm(
    '/users/password',
    {
      authenticity_token: token,
      'user[login]': login.trim(),
      commit: 'Reset Password',
    },
    BASE + '/users/password/new',
  );

  const outcome = readOutcome(html);
  if (outcome) {
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.message;
  }
  // A redirect away from the form is AO3's usual success signal.
  if (res.ok || res.redirected) {
    return 'If that account exists, a reset email is on its way.';
  }
  throw new Error(`Request failed (HTTP ${res.status}).`);
}

// --- registration (invitation -> signup -> activation) --------------------

/**
 * Accepts either a full invitation URL from AO3's email or a bare token, and
 * returns the token. Handles both /signup/TOKEN and ?invitation_token=TOKEN.
 */
export function extractInvitationToken(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Paste the invitation link from your email.');
  const q = s.match(/invitation_token=([A-Za-z0-9_-]+)/i);
  if (q) return q[1];
  const p = s.match(/\/signup\/([A-Za-z0-9_-]+)/i);
  if (p) return p[1];
  const inv = s.match(/\/invitations\/([A-Za-z0-9_-]+)/i);
  if (inv) return inv[1];
  if (/^[A-Za-z0-9_-]+$/.test(s)) return s; // already a bare token
  throw new Error('That does not look like an AO3 invitation link.');
}

/**
 * Reads every <input> of the signup form so we can replay AO3's own hidden
 * fields instead of guessing them. Returns { fields, action }.
 */
function parseFormFields(html, formHint = 'new_user') {
  // Narrow to the signup form when we can find it.
  let scope = html;
  const formRe = new RegExp(
    `<form[^>]*(?:id="${formHint}"|action="[^"]*\\/users")[^>]*>([\\s\\S]*?)<\\/form>`,
    'i',
  );
  const fm = html.match(formRe);
  if (fm) scope = fm[0];

  const action = (scope.match(/<form[^>]*action="([^"]+)"/i) || [])[1] || '/users';

  const fields = {};
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(scope)) !== null) {
    const tag = m[0];
    const name = (tag.match(/\bname="([^"]+)"/i) || [])[1];
    if (!name) continue;
    const type = ((tag.match(/\btype="([^"]+)"/i) || [])[1] || 'text').toLowerCase();
    const value = decodeHtml((tag.match(/\bvalue="([^"]*)"/i) || [])[1] ?? '');
    // Keep hidden values verbatim; remember other fields so we can fill them.
    if (type === 'hidden' || value) fields[name] = value;
    else if (!(name in fields)) fields[name] = '';
  }
  return { fields, action: decodeHtml(action) };
}

// Finds the real field name for a logical one (AO3 uses user[login] etc.).
function findField(fields, ...candidates) {
  const names = Object.keys(fields);
  for (const c of candidates) {
    const exact = names.find(n => n.toLowerCase() === c.toLowerCase());
    if (exact) return exact;
  }
  for (const c of candidates) {
    const loose = names.find(n => n.toLowerCase().includes(c.toLowerCase()));
    if (loose) return loose;
  }
  return null;
}

/** Loads the signup form for an invitation token. */
export async function getSignupForm(token) {
  const path = `/signup/${encodeURIComponent(token)}`;
  const html = await ky.get(BASE + path, { headers: BROWSER_HEADERS }).text();

  if (/invitation.{0,40}(invalid|already been used|not found)/i.test(html)) {
    throw new Error('This invitation link is invalid or has already been used.');
  }
  const { fields, action } = parseFormFields(html);
  if (!fields.authenticity_token) {
    fields.authenticity_token = extractAuthenticityToken(html);
  }
  return { fields, action, referer: BASE + path };
}

/**
 * Creates the AO3 account. Returns a message for the user (AO3 then emails an
 * activation link, which activateAccount() can finish).
 */
export async function registerAccount({
  token,
  username,
  email,
  password,
  passwordConfirm,
}) {
  if (!username?.trim()) throw new Error('Choose a username.');
  if (!email?.trim()) throw new Error('Enter your email address.');
  if (!password) throw new Error('Choose a password.');
  if (password !== passwordConfirm) throw new Error('The passwords do not match.');

  const { fields, action, referer } = await getSignupForm(token);

  const nLogin = findField(fields, 'user[login]', 'login');
  const nEmail = findField(fields, 'user[email]', 'email');
  const nPass = findField(fields, 'user[password]', 'password');
  const nConfirm = findField(fields, 'user[password_confirmation]', 'password_confirmation');
  const nAge = findField(fields, 'user[age_over_13]', 'age_over_13');
  const nTos = findField(fields, 'user[terms_of_service]', 'terms_of_service');

  const body = { ...fields };
  if (nLogin) body[nLogin] = username.trim();
  if (nEmail) body[nEmail] = email.trim();
  if (nPass) body[nPass] = password;
  if (nConfirm) body[nConfirm] = passwordConfirm;
  if (nAge) body[nAge] = '1';
  if (nTos) body[nTos] = '1';
  if (!body.invitation_token) body.invitation_token = token;
  body.commit = 'Create Account';

  const path = action.startsWith('http')
    ? action.replace(BASE, '')
    : action || '/users';
  const { res, html } = await postForm(path, body, referer);

  const outcome = readOutcome(html);
  if (outcome) {
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.message;
  }
  // Rails renders the form again (with an error list) when validation fails.
  const errList = html.match(
    /<(?:div|ul)[^>]*(?:id|class)="[^"]*error[^"]*"[^>]*>([\s\S]*?)<\/(?:div|ul)>/i,
  );
  if (errList) {
    const msg = stripTags(errList[1]);
    if (msg) throw new Error(msg);
  }
  if (res.ok || res.redirected) {
    return 'Account created. Check your email for the activation link.';
  }
  throw new Error(`Sign-up failed (HTTP ${res.status}).`);
}

/**
 * Finishes registration by following the activation link from AO3's email.
 * Accepts the full URL (or just its path).
 */
export async function activateAccount(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Paste the activation link from your email.');

  let path;
  try {
    path = s.startsWith('http') ? new URL(s).pathname + new URL(s).search : s;
  } catch {
    throw new Error('That does not look like an activation link.');
  }
  if (!path.startsWith('/')) path = '/' + path;

  const html = await ky.get(BASE + path, { headers: BROWSER_HEADERS }).text();
  const outcome = readOutcome(html);
  if (outcome) {
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.message;
  }
  return 'Activation link opened. Try logging in now.';
}

/**
 * Requests an AO3 invitation for `email`.
 * Resolves with a message to show the user; rejects with AO3's error text.
 */
export async function requestInvitation(email) {
  if (!email || !email.trim()) throw new Error('Enter your email address.');
  const { token } = await getForm('/invite_requests/new');
  const { res, html } = await postForm(
    '/invite_requests',
    {
      authenticity_token: token,
      'invite_request[email]': email.trim(),
      commit: 'Add me to the list!',
    },
    BASE + '/invite_requests/new',
  );

  const outcome = readOutcome(html);
  if (outcome) {
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.message;
  }
  if (res.ok || res.redirected) {
    return 'Your invitation request has been submitted.';
  }
  throw new Error(`Request failed (HTTP ${res.status}).`);
}
