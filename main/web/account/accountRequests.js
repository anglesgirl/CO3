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

// Deliberately NOT spoofing a browser User-Agent. The TLS handshake is done by
// the Go proxy, so claiming to be Chrome produces a fingerprint/UA mismatch that
// Cloudflare flags with a 403. Plain requests — exactly what the rest of the app
// sends for browsing — pass fine.
const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
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

// Cloudflare sometimes 403s a "cold" request to a form page. Fetching the home
// page first gives the proxy's cookie jar a session, after which the form loads.
async function fetchWithWarmup(path) {
  try {
    return await ky.get(BASE + path, { headers: BROWSER_HEADERS }).text();
  } catch (e) {
    const status = e?.response?.status;
    if (status !== 403 && status !== 503) throw e;
    try {
      await ky.get(BASE + '/', { headers: BROWSER_HEADERS }).text();
    } catch {}
    try {
      return await ky
        .get(BASE + path, {
          headers: { ...BROWSER_HEADERS, Referer: BASE + '/' },
        })
        .text();
    } catch (e2) {
      const s2 = e2?.response?.status;
      if (s2 === 403 || s2 === 503) {
        throw new Error(
          'AO3 is currently blocking automated requests (HTTP ' +
            s2 +
            '). Please try again later.',
        );
      }
      throw e2;
    }
  }
}

async function getForm(path) {
  const html = await fetchWithWarmup(path);
  return { html, token: extractAuthenticityToken(html) };
}

/**
 * Requests a password-reset email. `login` may be a username or an email.
 * Resolves with a message to show the user; rejects with AO3's error text.
 */
export async function requestPasswordReset(login) {
  if (!login || !login.trim()) throw new Error('Enter your username or email.');

  // Replay AO3's own form (hidden fields included) rather than guessing names.
  const html0 = await fetchWithWarmup('/users/password/new');
  const { fields, action } = parseFormFields(html0, 'new_user');
  if (!fields.authenticity_token) {
    fields.authenticity_token = extractAuthenticityToken(html0);
  }
  const nLogin = findField(fields, 'user[login]', 'user[email]', 'login', 'email');
  if (!nLogin) {
    throw new Error('Could not read AO3\'s reset form (the site may have changed).');
  }
  const body = { ...fields, [nLogin]: login.trim(), commit: 'Reset Password' };

  const path = action.startsWith('http')
    ? action.replace(BASE, '')
    : action || '/users/password';
  const { res, html } = await postForm(path, body, BASE + '/users/password/new');

  const outcome = readOutcome(html);
  if (outcome) {
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.message;
  }
  // If AO3 handed the form back, the submission did NOT go through — reporting
  // success here would leave the user waiting for an email that never comes.
  if (/name="user\[login\]"|id="new_user"/i.test(html)) {
    throw new Error(
      'AO3 did not accept the request. Check the username/email and try again.',
    );
  }
  if (res.ok || res.redirected) {
    return 'If that account exists, a reset email is on its way. Check your spam folder.';
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

/**
 * Loads the signup form for an invitation token. AO3 has used more than one URL
 * shape for this over the years, so we try each and use whichever responds with
 * an actual form instead of assuming one and failing with a bare 404.
 */
export async function getSignupForm(token) {
  const tk = encodeURIComponent(token);
  const candidates = [
    `/signup/${tk}`,
    `/users/new?invitation_token=${tk}`,
    `/invitations/${tk}/signup`,
    `/invitations/${tk}`,
  ];

  let lastStatus = null;
  for (const path of candidates) {
    let html;
    try {
      html = await ky.get(BASE + path, { headers: BROWSER_HEADERS }).text();
    } catch (e) {
      lastStatus = e?.response?.status ?? lastStatus;
      continue; // 404 on this shape — try the next
    }

    if (/invitation.{0,60}(invalid|already been used|not found|expired)/i.test(html)) {
      throw new Error('This invitation link is invalid, expired, or already used.');
    }
    const { fields, action } = parseFormFields(html);
    const hasLogin = !!findField(fields, 'user[login]', 'login');
    if (!hasLogin) continue; // not the sign-up form — keep looking

    if (!fields.authenticity_token) {
      fields.authenticity_token = extractAuthenticityToken(html);
    }
    return { fields, action, referer: BASE + path };
  }

  if (lastStatus === 404) {
    throw new Error(
      'AO3 did not recognise this invitation link (404). Make sure you copied the full link from the invitation email.',
    );
  }
  throw new Error(
    'Could not open the sign-up form. The invitation may be invalid or AO3 may be blocking the request.',
  );
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
