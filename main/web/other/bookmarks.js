import { getRealUsername } from '../account/accountIdentity';
import { parseWorkElements } from '../browse/fetchWorks';
import getUrl from '../requestManager';

let DomParser = require('react-native-html-parser').DOMParser;

export async function fetchBookmarks(page, username, pseud, noWebview = false) {
  let url;
  try {
    const resolvedUsername = username || await getRealUsername();
    if (pseud) {
      url = `https://archiveofourown.org/users/${resolvedUsername}/pseuds/${encodeURIComponent(pseud)}/bookmarks?page=${page}`;
    } else {
      url = `https://archiveofourown.org/users/${resolvedUsername}/bookmarks?page=${page}`;
    }

    console.log(`Fetching bookmarks from: ${url}`);
    const response = await getUrl(url, noWebview);
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

    let workElements = Array.from(olElements[0].getElementsByTagName("li"))
      .filter(li => li.getAttribute("class")?.includes("bookmark blurb"));

    if (workElements.length === 0) {
      workElements = Array.from(olElements[1].getElementsByTagName("li"))
        .filter(li => li.getAttribute("class")?.includes("bookmark blurb"));
    }

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

    const pageResponse = await fetch(url, {
      credentials: 'include',
      headers: { 'User-Agent': userAgent }
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

    // 【必须 urlencoded】RN 的 fetch 会把 FormData 序列化成 multipart/form-data，
    // 而 AO3(Rails) 只认 application/x-www-form-urlencoded —— 用 FormData 提交会被静默忽略。
    const params = new URLSearchParams();
    params.append('authenticity_token', token);
    params.append('bookmark[pseud_id]', pseudId);
    params.append('bookmark[private]', '0');
    params.append('bookmark[rec]', '0');
    params.append('commit', 'Create');

    const postResponse = await fetch(`https://archiveofourown.org/works/${workId}/bookmarks`, {
      method: 'POST',
      body: params.toString(),
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://archiveofourown.org',
        'Referer': url,
        'User-Agent': userAgent,
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