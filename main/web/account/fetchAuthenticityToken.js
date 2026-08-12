import ky from '../echKy';
import getUrl from '../requestManager';
import { fetchViaWebView } from '../WebviewFetcher';

let DomParser = require('react-native-html-parser').DOMParser;

// CF challenge 页面特征：检测到就不再硬解析 HTML，改走 WebView 弹窗验证。
function isCFChallenge(html) {
  return (
    typeof html === 'string' &&
    (html.includes('_cf_chl_opt') ||
      html.includes('challenge-platform') ||
      html.includes('challenges.cloudflare.com'))
  );
}

// 从 HTML 提取登录表单的 authenticity_token。
// 返回 null 表示页面不是可解析的登录表单（挑战页/已登录页/网络错误页）。
function extractLoginToken(html) {
  try {
    const doc = new DomParser().parseFromString(html, 'text/html');
    const form = doc.getElementById('new_user');
    if (!form) return null;
    return form.childNodes[0]?.getAttribute?.('value') ?? null;
  } catch {
    return null;
  }
}

export async function fetchLoginAuthenticityToken() {
  try {
    let html = await ky.get('https://archiveofourown.org/users/login').text();
    html = html.replace('<br \\>', ''); // Before you ask, no. I don't know. I don't need them anyway. /shrug

    if (html.includes('You are already logged in to an account. Please log out and try again.')) {
      throw 'already logged in.';
    }

    // CF challenge 页面：弹 WebView 验证窗口让用户完成验证。
    // 验证通过后 cf_clearance cookie 会写入 Go 代理的 cookie jar，
    // 之后重新请求即可拿到真实登录表单。
    if (isCFChallenge(html)) {
      console.log('[AUTH] CF challenge on login form, opening verification window');
      try {
        html = await fetchViaWebView('https://archiveofourown.org/users/login');
        if (!isCFChallenge(html)) {
          const token = extractLoginToken(html);
          if (token) return token;
        }
      } catch (e) {
        console.warn('[AUTH] WebView verification failed:', e?.message ?? e);
        // 继续走下面的 token 提取，失败则抛原始错误。
      }
    }

    const token = extractLoginToken(html);
    if (token) return token;

    // 拿到 HTML 但解析不出 token —— 明确报错，避免诡异的 TypeError。
    throw new Error('AO3 returned a Cloudflare challenge page for the login form');
  } catch (e) {
    console.error('An error occurred while running fetchLoginAuthenticityToken', e);
    throw e;
  }
}

export async function fetchKudoAuthenticityToken(workId) {
  try {
    let html = await getUrl('http://archiveofourown.org/works/' + workId);
    html = html.replace('<br \\>', '');

    const doc = new DomParser().parseFromString(html, 'text/html');
    const kudoForm = doc.getElementById('new_kudo');

    if (!kudoForm) {
      throw new Error('Kudo form not found on the page');
    }

    // Find the authenticity token input within the form
    const tokenInput = kudoForm.childNodes[0];

    if (!tokenInput) {
      throw new Error('Authenticity token not found in kudo form');
    }

    return tokenInput.getAttribute('value');

  } catch (e) {
    console.error('An error occurred while running fetchKudoAuthenticityToken', e);
    throw e; // Re-throw to allow caller to handle
  }
}
