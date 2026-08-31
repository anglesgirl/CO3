import ky from 'ky';
import getUrl from '../requestManager';

let DomParser = require('react-native-html-parser').DOMParser;

export async function fetchLoginAuthenticityToken() {
  try {
    let html = await ky.get("https://archiveofourown.org/users/login?return_to=%2F").text();
    html = html.replace("<br \\>", '');
    if (html.includes("You are already logged in to an account. Please log out and try again.")) {
      throw "already logged in.";
    }
    // 兼容旧版 childNodes[0] 取法，但用更稳的 selector（修复空白文本节点导致 token 为空）
    const doc = new DomParser().parseFromString(html, "text/html");
    const form = doc.getElementById("new_user");
    let token = null;
    if (form) {
      // 优先用 query 方式（更可靠）
      try {
        // react-native-html-parser 的 DOM 实现支持 getElementsByTagName
        const inputs = form.getElementsByTagName ? form.getElementsByTagName('input') : [];
        for (let i = 0; i < inputs.length; i++) {
          const inp = inputs[i];
          const name = inp.getAttribute ? inp.getAttribute('name') : null;
          if (name === 'authenticity_token') { token = inp.getAttribute('value'); break; }
        }
      } catch {}
      if (!token) {
        try {
          // 兜底：遍历 childNodes 跳过文本节点
          for (let i = 0; i < form.childNodes.length; i++) {
            const n = form.childNodes[i];
            if (n.getAttribute && n.getAttribute('name') === 'authenticity_token') { token = n.getAttribute('value'); break; }
          }
        } catch {}
      }
      if (!token) {
        // 最后兜底：原逻辑
        try { token = form.childNodes[0].getAttribute('value'); } catch {}
      }
    }
    if (!token || token.length < 20) {
      console.error('[fetchToken] token missing or too short', token);
      throw new Error('authenticity_token not found');
    }
    console.log('[fetchToken] ok len', token.length);
    return token;
  } catch (e) {
    console.error("An error occurred while running fetchLoginAuthenticityToken", e);
    throw e;
  }
}

export async function fetchKudoAuthenticityToken(workId) {
  try {
    let html = await getUrl("http://archiveofourown.org/works/" + workId);
    html = html.replace("<br \\>", '');

    const doc = new DomParser().parseFromString(html, "text/html");
    const kudoForm = doc.getElementById("new_kudo");

    if (!kudoForm) {
      throw new Error("Kudo form not found on the page");
    }

    // Find the authenticity token input within the form
    const tokenInput = kudoForm.childNodes[0];

    if (!tokenInput) {
      throw new Error("Authenticity token not found in kudo form");
    }

    return tokenInput.getAttribute('value');

  } catch (e) {
    console.error("An error occurred while running fetchKudoAuthenticityToken", e);
    throw e; // Re-throw to allow caller to handle
  }
}
