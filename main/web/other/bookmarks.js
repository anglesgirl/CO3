import { getUsername } from '../../storage/Credentials';
import { parseWorkElements } from '../browse/fetchWorks';
import ky from '../echKy';
import { getEchStatus } from '../echKy';
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
    // A proxy restart has an empty native cookie jar. Always attach the stored
    // AO3 session to bookmark reads, otherwise AO3 silently serves a login page
    // and the UI appears as an empty/unresponsive bookmark screen.
    const sessionHeaders = await getSessionHeaders();
    const response = await ky.get(url, {
      headers: Object.assign({ Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, sessionHeaders),
    }).text();
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
    const sessionHeaders = await getSessionHeaders();

    // Do not claim to be Chrome: TLS is performed by Go, and an artificial
    // browser UA creates a TLS/UA mismatch that Cloudflare can reject.
    const pageResponse = await fetch(await echUrl(url), {
      credentials: 'include',
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...sessionHeaders },
    });

    if (!pageResponse.ok) {
      const status = await getEchStatus();
      throw new Error(`Bookmark form failed: HTTP ${pageResponse.status}; ECH: ${status}`);
    }

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
        ...sessionHeaders,
      },
    });

    if (postResponse.ok || postResponse.status === 302) {
      console.log('Bookmarked successfully!');
      return true;
    }

    const status = await getEchStatus();
    throw new Error(`Bookmark post failed: HTTP ${postResponse.status}; ECH: ${status}`);

  } catch (error) {
    console.error('Error bookmarking:', error);
    throw error;
  }
}
