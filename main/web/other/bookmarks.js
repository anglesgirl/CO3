import { getUsername } from '../../storage/Credentials';
import { parseWorkElements } from '../browse/fetchWorks';
import getUrl from '../requestManager';
import { echUrl } from '../echKy';
import { parseBookmarkForm } from '../ao3FormParser';
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
    const sessionHeaders = await getSessionHeaders();

    const pageResponse = await fetch(await echUrl(url), {
      credentials: 'include',
      headers: { 'User-Agent': userAgent, ...sessionHeaders }
    });

    if (!pageResponse.ok) throw new Error(`Bookmark form failed: ${pageResponse.status}`);

    const html = await pageResponse.text();
    const { token, pseudId } = parseBookmarkForm(html);

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
