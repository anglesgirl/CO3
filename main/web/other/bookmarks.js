import { getUsername } from '../../storage/Credentials';
import { parseWorkElements } from '../browse/fetchWorks';
import getUrl from '../requestManager';
import { echUrl } from '../echKy';
import { getEchStatus } from '../echKy';
import { parseBookmarkForm } from '../ao3FormParser';
import { getSessionHeaders } from '../sessionHeaders';
import { debugLog } from '../../utils/debugLog';

let DomParser = require('react-native-html-parser').DOMParser;

function isLoginPage(html) {
  return /<form[^>]+(?:id|class)=["'][^"']*new_user\b/i.test(String(html))
    || /You need to log in to access this page/i.test(String(html));
}

function ao3FormError(html) {
  const text = String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = text.match(/(?:Errors?\s*)?([^.!]{3,160}(?:already bookmarked|can't be blank|is invalid|could not be saved)[^.!]{0,80})/i);
  return match?.[1]?.trim() || null;
}

async function verifyBookmarkInList(workId) {
  const username = await getUsername();
  if (!username) throw new Error('Cannot verify bookmark: AO3 username is unavailable');
  const url = `https://archiveofourown.org/users/${encodeURIComponent(username)}/bookmarks?page=1`;
  const html = await getUrl(url, false, { headers: await getSessionHeaders() });
  if (isLoginPage(html)) throw new Error('AO3 session was rejected while verifying bookmarks');
  const found = new RegExp(`/works/${workId}(?:["'#?]|/)`, 'i').test(html);
  await debugLog('bookmark', `Verification page=1 work=${workId}; found=${found}`);
  return found;
}

function findBookmarkId(html, workId) {
  const doc = new DomParser().parseFromString(html, 'text/html');
  const items = Array.from(doc.getElementsByTagName('li'));
  const item = items.find(li => Array.from(li.getElementsByTagName('a')).some(a =>
    new RegExp(`/works/${workId}(?:["'#?]|/)`, 'i').test(a.getAttribute('href') || ''),
  ));
  return item?.getAttribute('id')?.match(/^bookmark_(\d+)$/i)?.[1] || null;
}

// Extracts the CSRF token needed to delete a bookmark, directly from the
// bookmark list page (the same page the browser uses as its referrer).
// AO3 renders each bookmark with either a delete <form> containing
// _method=delete, or a link with data-method="delete" that relies on the
// page-level meta csrf-token. Both paths are covered.
function findDeleteTokenInList(html, bookmarkId) {
  const doc = new DomParser().parseFromString(html, 'text/html');

  // Path 1: a <form> whose action targets this bookmark and contains _method=delete
  const forms = Array.from(doc.getElementsByTagName('form'));
  for (const form of forms) {
    const action = form.getAttribute('action') || '';
    if (!new RegExp(`bookmarks/${bookmarkId}(?:$|[/?#])`, 'i').test(action)) continue;
    const inputs = Array.from(form.getElementsByTagName('input'));
    const hasDeleteMethod = inputs.some(i =>
      i.getAttribute('name') === '_method' && i.getAttribute('value') === 'delete',
    );
    if (!hasDeleteMethod) continue;
    const tokenInput = inputs.find(i => i.getAttribute('name') === 'authenticity_token');
    if (tokenInput) return tokenInput.getAttribute('value');
  }

  // Path 2: a link with data-method="delete" — Rails UJS uses the meta csrf-token
  const links = Array.from(doc.getElementsByTagName('a'));
  const hasDeleteLink = links.some(a => {
    const href = a.getAttribute('href') || '';
    return new RegExp(`bookmarks/${bookmarkId}(?:$|[/?#])`, 'i').test(href)
      && a.getAttribute('data-method') === 'delete';
  });
  if (hasDeleteLink) {
    const meta = Array.from(doc.getElementsByTagName('meta')).find(
      m => m.getAttribute('name') === 'csrf-token',
    );
    const token = meta?.getAttribute('content');
    if (token) return token;
  }

  // Regex fallback for both paths (when the DOM parser misses attributes)
  const formRegex = new RegExp(
    `<form[^>]*action="[^"]*bookmarks/${bookmarkId}[^"]*"[^>]*>([\\s\\S]*?)</form>`, 'i',
  );
  const formMatch = html.match(formRegex);
  if (formMatch && /name=["']_method["']\s+value=["']delete["']/i.test(formMatch[1])) {
    const tokenMatch = formMatch[1].match(/name=["']authenticity_token["']\s+value=["']([^"']+)["']/i);
    if (tokenMatch) return tokenMatch[1];
  }
  if (new RegExp(`<a[^>]*href="[^"]*bookmarks/${bookmarkId}[^"]*"[^>]*data-method=["']delete["']`, 'i').test(html)) {
    const metaMatch = html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i);
    if (metaMatch) return metaMatch[1];
  }

  return null;
}

async function verifyBookmarkRemoved(workId) {
  const username = await getUsername();
  const url = `https://archiveofourown.org/users/${encodeURIComponent(username)}/bookmarks?page=1`;
  const html = await getUrl(url, false, { headers: await getSessionHeaders() });
  if (isLoginPage(html)) throw new Error('AO3 session was rejected while verifying bookmark removal');
  const found = new RegExp(`/works/${workId}(?:["'#?]|/)`, 'i').test(html);
  await debugLog('bookmark', `Removal verification page=1 work=${workId}; found=${found}`);
  return !found;
}

export async function removeBookmark(work) {
  const workId = work?.id;
  try {
    if (!workId || !/^\d+$/.test(String(workId))) {
      throw new Error(`Cannot remove bookmark: invalid work id (${String(workId)})`);
    }
    const username = await getUsername();
    const listUrl = `https://archiveofourown.org/users/${encodeURIComponent(username)}/bookmarks?page=1`;
    const sessionHeaders = await getSessionHeaders();
    const listHtml = await getUrl(listUrl, false, { headers: sessionHeaders });
    const bookmarkId = findBookmarkId(listHtml, workId);
    if (!bookmarkId) {
      throw new Error(`Could not find bookmark ${workId} in the loaded bookmark list`);
    }
    const token = findDeleteTokenInList(listHtml, bookmarkId);
    if (!token) {
      await debugLog('bookmark', `Delete token not found in list HTML for bookmark ${bookmarkId}; HTML length=${listHtml.length}`);
      throw new Error(`Could not find the delete token for bookmark ${bookmarkId}`);
    }
    const deleteUrl = `https://archiveofourown.org/bookmarks/${bookmarkId}`;
    // Matches AO3's browser delete request: Rails method override and CSRF
    // token encoded as application/x-www-form-urlencoded, not multipart.
    const body = `_method=delete&authenticity_token=${encodeURIComponent(token)}`;
    const response = await fetch(await echUrl(deleteUrl), {
      method: 'POST',
      body,
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': listUrl,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...sessionHeaders,
      },
    });
    const responseHtml = await response.text();
    const error = ao3FormError(responseHtml);
    await debugLog('bookmark', `Remove work=${workId}; bookmark=${bookmarkId}; HTTP ${response.status}; action=${deleteUrl}; formError=${error || '(none)'}`);
    if (!response.ok && response.status !== 302) {
      throw new Error(`Bookmark removal failed with HTTP ${response.status}`);
    }
    if (error) throw new Error(error);
    // AO3 can serve a stale bookmark-list response immediately after its
    // delete redirect. Keep this diagnostic-only so a successful delete is
    // never presented as a failure because of list caching or ordering.
    verifyBookmarkRemoved(workId).catch(error =>
      debugLog('bookmark', `Removal verification failed after successful delete: ${error?.message ?? String(error)}`),
    );
    return true;
  } catch (error) {
    await debugLog('bookmark', `Remove failed: ${error?.message ?? String(error)}`);
    throw error;
  }
}

export async function fetchBookmarks(page, username, pseud, noWebview = false) {
  let url;
  try {
    const resolvedUsername = username || await getUsername();
    if (pseud) {
      url = `https://archiveofourown.org/users/${resolvedUsername}/pseuds/${encodeURIComponent(pseud)}/bookmarks?page=${page}`;
    } else {
      url = `https://archiveofourown.org/users/${resolvedUsername}/bookmarks?page=${page}`;
    }

    console.log(`Fetching bookmarks from: ${url}`);
    const response = await getUrl(url, noWebview, {
      headers: await getSessionHeaders(),
    });
    if (isLoginPage(response)) {
      throw new Error('AO3 session was rejected while loading bookmarks');
    }
    const doc = new DomParser().parseFromString(response, "text/html");

    const mainDiv = doc.getElementById("main");

    if (!mainDiv) {
      console.log("No main div found");
      return null;
    }

    const olElements = mainDiv.getElementsByTagName("ol");
    if (!olElements || olElements.length === 0) {
      console.log("No ol element found");
      return null;
    }

    const workElements = Array.from(olElements).flatMap(list =>
      Array.from(list.getElementsByTagName('li')).filter(li =>
        li.getAttribute('class')?.includes('bookmark blurb'),
      ),
    );

    return parseWorkElements(workElements);

  } catch (error) {
    throw error;
  } finally {
    console.log("finished loading", url);
  }
}

export async function bookmark(work) {
  try {
    const workId = work.id;
    await debugLog('bookmark', `Start work=${workId}`);
    if (!workId || !/^\d+$/.test(String(workId))) {
      throw new Error(`Cannot bookmark this work: invalid work id (${String(workId)})`);
    }
    const url = `https://archiveofourown.org/works/${workId}/bookmarks/new`;
    // AO3 accepts the Android request reliably when it carries the desktop UA
    // used by the original bookmark implementation.
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const sessionHeaders = await getSessionHeaders();

    console.log('[AO3 bookmark] loading form', url);
    await debugLog('bookmark', `GET form ${url}`);
    const pageResponse = await fetch(await echUrl(url), {
      credentials: 'include',
      // Keep this GET byte-for-byte aligned with the last confirmed-working
      // Android bookmark flow. The later verification runs only after POST.
      headers: { 'User-Agent': userAgent, ...sessionHeaders },
    });

    if (!pageResponse.ok) {
      await debugLog('bookmark', `Form failed HTTP ${pageResponse.status}`);
      throw new Error(`Bookmark form failed: HTTP ${pageResponse.status}; ECH: ${await getEchStatus()}`);
    }

    const html = await pageResponse.text();
    if (isLoginPage(html)) {
      throw new Error('AO3 session was rejected while loading the bookmark form');
    }
    const { token, pseudId } = parseBookmarkForm(html);
    await debugLog('bookmark', `Form HTTP ${pageResponse.status}; token=${!!token}; pseud=${!!pseudId}`);

    if (!token || !pseudId) {
      throw new Error(`Extraction failed. Token: ${!!token}, Pseud: ${!!pseudId}`);
    }

    // Match AO3's browser form submission. AO3 expects this form to be URL
    // encoded, including its optional fields when they are empty.
    const formData = [
      ['authenticity_token', token],
      ['bookmark[pseud_id]', pseudId],
      ['bookmark[bookmarker_notes]', ''],
      ['bookmark[tag_string]', ''],
      ['bookmark[collection_names]', ''],
      ['bookmark[private]', '0'],
      ['bookmark[rec]', '0'],
      ['commit', 'Create'],
    ].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');

    const postUrl = `https://archiveofourown.org/works/${workId}/bookmarks`;
    const postResponse = await fetch(await echUrl(postUrl), {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': url,
        'User-Agent': userAgent,
        ...sessionHeaders,
      },
    });

    await debugLog('bookmark', `POST completed HTTP ${postResponse.status}; redirected=${postResponse.redirected}; final=${postResponse.url || '(hidden)'}`);
    // Restore the original Android behavior: allow fetch to follow AO3's
    // redirect and use its final successful response as the completion signal.
    if (postResponse.ok || postResponse.status === 302) {
      console.log('[AO3 bookmark] request completed', workId, postResponse.status);
      // Submit first and only then inspect the list. This check never changes
      // the AO3 create request or blocks it from reaching the server.
      verifyBookmarkInList(workId).catch(error =>
        debugLog('bookmark', `Verification failed after successful add: ${error?.message ?? String(error)}`),
      );
      return true;
    }
    throw new Error(`Bookmark request failed with HTTP ${postResponse.status}; ECH: ${await getEchStatus()}`);

  } catch (error) {
    console.error('Error bookmarking:', error);
    await debugLog('bookmark', `Failed: ${error?.message ?? String(error)}`);
    throw error;
  }
}
