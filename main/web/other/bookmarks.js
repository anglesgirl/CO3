import { getUsername } from '../../storage/Credentials';
import { parseWorkElements } from '../browse/fetchWorks';
import getUrl from '../requestManager';
import { echUrl } from '../echKy';
import { getSessionHeaders } from '../sessionHeaders';

let DomParser = require('react-native-html-parser').DOMParser;

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
    // getUrl supplies ECH routing. Also send the persisted session explicitly:
    // the loopback proxy owns a separate cookie jar from CookieManager.
    const sessionHeaders = await getSessionHeaders();
    const response = await getUrl(url, noWebview, sessionHeaders);
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

    // AO3 can render a single list (or a list of filters before the results).
    // Search every list instead of assuming olElements[1] exists.
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
    const url = `https://archiveofourown.org/works/${workId}/bookmarks/new`;
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

    // Keep the upstream AO3 form flow intact. The only additions are the local
    // ECH route and an explicit saved session, because restarting the proxy
    // must not discard the authenticated CookieManager state.
    const sessionHeaders = await getSessionHeaders();
    const pageResponse = await fetch(await echUrl(url), {
      credentials: 'include',
      headers: { 'User-Agent': userAgent, ...sessionHeaders }
    });

    const html = await pageResponse.text();

    const getAttributeValue = (tagString, attributeName) => {
      const regex = new RegExp(`${attributeName}="([^"]+)"`, 'i');
      const match = tagString.match(regex);
      return match ? match[1] : null;
    };

    const tokenTagMatch = html.match(/<input[^>]*name="authenticity_token"[^>]*>/i);
    if (!tokenTagMatch) throw new Error('Authenticity token tag not found');
    const token = getAttributeValue(tokenTagMatch[0], 'value');

    const pseudTagMatch = html.match(/<input[^>]*name="bookmark\[pseud_id\]"[^>]*>/i);

    let pseudId = null;
    if (pseudTagMatch) {
      pseudId = getAttributeValue(pseudTagMatch[0], 'value');
    } else {
      const selectMatch = html.match(/<select[^>]*name="bookmark\[pseud_id\]"[^>]*>[\s\S]*?<option[^>]*value="([^"]+)"[^>]*selected/i);
      pseudId = selectMatch ? selectMatch[1] : null;
    }

    if (!token || !pseudId) {
      throw new Error(`Extraction failed. Token: ${!!token}, Pseud: ${!!pseudId}`);
    }

    const formData = new FormData();
    formData.append('authenticity_token', token);
    formData.append('bookmark[pseud_id]', pseudId);
    formData.append('bookmark[private]', '0');
    formData.append('bookmark[rec]', '0');
    formData.append('commit', 'Create');

    const postResponse = await fetch(await echUrl(`https://archiveofourown.org/works/${workId}/bookmarks`), {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': url,
        'User-Agent': userAgent,
        ...sessionHeaders,
      }
    });

    if (postResponse.ok || postResponse.status === 302) {
      console.log('Bookmarked successfully!');
      return true;
    }

    throw new Error(`Post failed with status: ${postResponse.status}`);

  } catch (error) {
    console.error('Error bookmarking:', error);
    throw error;
  }
}
