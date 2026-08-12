import { getUsername } from '../../storage/Credentials';
import { parseWorkElements } from '../browse/fetchWorks';
import getUrl from '../requestManager';
import { echUrl } from '../echKy';
import { parseMarkForLaterForm } from '../ao3FormParser';
import { getSessionHeaders } from '../sessionHeaders';

let DomParser = require('react-native-html-parser').DOMParser;

export async function fetchMarkedLater(page){
  const url = `https://archiveofourown.org/users/${await getUsername()}/readings?show=to-read&page=${page}`;

  const res = await getUrl(url);
  const doc = await new DomParser().parseFromString(res, "text/html");

  const workElements = Array.from(doc.getElementsByTagName("li"))
    .filter(li => li.getAttribute("class")?.includes("work blurb"));

  return parseWorkElements(workElements);
}

export async function markForLater(work) {
  try {
    const workId = work.id;
    const url = `https://archiveofourown.org/works/${workId}`;
    const sessionHeaders = await getSessionHeaders();

    const pageResponse = await fetch(await echUrl(url), {
      credentials: 'omit', // cookie 由 Go 代理 jar 管理
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...sessionHeaders,
      }
    });

    if (!pageResponse.ok) throw new Error(`Work form failed: ${pageResponse.status}`);

    const html = await pageResponse.text();
    const { action, token } = parseMarkForLaterForm(html);
    if (!action || !token) throw new Error('Mark for later form is unavailable');
    const markUrl = `https://archiveofourown.org${action}`;

    const formData = new FormData();
    formData.append('authenticity_token', token);
    formData.append('_method', 'patch');

    const response = await fetch(await echUrl(markUrl), {
      method: 'POST',
      body: formData,
      credentials: 'omit', // cookie 由 Go 代理 jar 管理
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': url,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...sessionHeaders,
      }
    });

    if (!response.ok) {
      throw new Error(
        `Failed to mark for later: ${response.status} ${response.statusText}`
      );
    }

    console.log('Marked for later successfully!');
    return true;

  } catch (error) {
    console.error('Error marking for later:', error);
    throw error;
  }
}
