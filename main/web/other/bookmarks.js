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

function isBookmarkShowPage(html) {
  return /<title>\s*Show Bookmark\s*\|\s*Archive of Our Own/i.test(String(html));
}

function bookmarkShowPageMatchesWork(html, workId) {
  const source = String(html);
  const workUrl = `/works/${workId}`;
  return isBookmarkShowPage(source)
    && (source.includes(`bookmarkable_id&quot; value=&quot;${workId}`)
      || source.includes(`bookmarkable_id" value="${workId}`)
      || source.includes(workUrl));
}

function ao3FormError(html) {
  const text = String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = text.match(/(?:Errors?\s*)?([^.!]{3,160}(?:already bookmarked|can't be blank|is invalid|could not be saved)[^.!]{0,80})/i);
  return match?.[1]?.trim() || null;
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
    const sessionHeaders = await getSessionHeaders();

    console.log('[AO3 bookmark] loading form', url);
    await debugLog('bookmark', `GET form ${url}`);
    const pageResponse = await fetch(await echUrl(url), {
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...sessionHeaders },
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

    const formData = new FormData();
    formData.append('authenticity_token', token);
    formData.append('bookmark[pseud_id]', pseudId);
    formData.append('bookmark[private]', '0');
    formData.append('bookmark[rec]', '0');
    formData.append('commit', 'Create');

    const postUrl = `https://archiveofourown.org/works/${workId}/bookmarks`;
    const postResponse = await fetch(await echUrl(postUrl), {
      method: 'POST',
      body: formData,
      // A successful Rails create is a redirect. Do not follow it, otherwise
      // fetch turns it into a generic 200 and the caller cannot tell success
      // from an unchanged/new-bookmark form.
      redirect: 'manual',
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': url,
        ...sessionHeaders,
      },
    });

    // AO3 creates bookmarks with a redirect. A 200 response is the returned
    // form (usually validation failure), not proof that a bookmark was added.
    if (postResponse.status >= 300 && postResponse.status < 400) {
      const location = postResponse.headers.get('location') || '(none)';
      console.log('[AO3 bookmark] created', workId, postResponse.status, location);
      await debugLog('bookmark', `POST HTTP ${postResponse.status}; Location=${location}`);
      return true;
    }

    const postHtml = await postResponse.text();
    await debugLog('bookmark', `POST HTTP ${postResponse.status}; body=${postHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)}`);
    // Android fetch follows AO3's create redirect despite redirect: 'manual',
    // leaving us on the successful “Show Bookmark” page with HTTP 200.
    if (bookmarkShowPageMatchesWork(postHtml, workId)) {
      await debugLog('bookmark', `Created after followed redirect; HTTP ${postResponse.status}; work=${workId}`);
      return true;
    }
    if (isBookmarkShowPage(postHtml)) {
      throw new Error(`AO3 returned a bookmark page for a different work (expected ${workId})`);
    }
    if (isLoginPage(postHtml)) {
      throw new Error('AO3 session was rejected while creating the bookmark');
    }
    const formError = ao3FormError(postHtml);
    if (formError) throw new Error(`AO3 rejected the bookmark: ${formError}`);

    throw new Error(`AO3 did not confirm bookmark creation (HTTP ${postResponse.status}); ECH: ${await getEchStatus()}`);

  } catch (error) {
    console.error('Error bookmarking:', error);
    await debugLog('bookmark', `Failed: ${error?.message ?? String(error)}`);
    throw error;
  }
}
