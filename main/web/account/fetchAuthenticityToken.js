import ky from 'ky';
import getUrl from '../requestManager';
import { diagEvent } from '../../utils/diag';

let DomParser = require('react-native-html-parser').DOMParser;

/**
 * 在表单里找 authenticity_token 隐藏字段。
 *
 * 旧实现两处（登录 / kudos）都是直接取 form.childNodes[0] —— 靠位置取值，
 * AO3 页面结构一变就取错值，且失败是静默的（返回 undefined 拼进表单），
 * 表现成"登录/点赞莫名其妙失败"。这里改为按 name 查找，保留旧逻辑兜底。
 */
function pickTokenFromForm(form) {
  const nodes = (form && form.childNodes) || [];
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (n && typeof n.getAttribute === 'function' && n.getAttribute('name') === 'authenticity_token') {
      return n;
    }
  }
  return nodes[0] || null;
}

/**
 * 按 name 取表单里的字段（先扫直接子节点，再退回 getElementsByTagName 兜底）。
 * 用于 commit 按钮 —— HAR 实证：commit 值随页面语言变化（中文页"用户登录"、英文页"Log in"），
 * 写死会让"表单字段"与页面不一致，故一律从实际登录页读取。
 */
function pickFieldByName(form, name) {
  if (!form) return null;
  const direct = (form && form.childNodes) || [];
  for (let i = 0; i < direct.length; i += 1) {
    const n = direct[i];
    if (n && typeof n.getAttribute === 'function' && n.getAttribute('name') === name) return n;
  }
  const tags = ['input', 'button'];
  for (let t = 0; t < tags.length; t += 1) {
    let list = null;
    try {
      list = form.getElementsByTagName ? form.getElementsByTagName(tags[t]) : null;
    } catch (_) {
      list = null;
    }
    if (!list) continue;
    for (let i = 0; i < list.length; i += 1) {
      const n = list[i];
      if (n && typeof n.getAttribute === 'function' && n.getAttribute('name') === name) return n;
    }
  }
  return null;
}


export async function fetchLoginAuthenticityToken() {
  const fields = await fetchLoginFormFields();
  return fields.token;
}

/**
 * 取登录页上的 authenticity_token 与 commit 值。
 * HAR 对齐（2026-08-31）：成功请求的 body 是
 *   authenticity_token=...&user[login]=...&user[password]=...&commit=用户登录
 * commit 就是表单提交按钮的 value，随站点语言变化，必须从页面实际读取。
 */
export async function fetchLoginFormFields() {
  try {
    // 登录链路第 1 步：取登录页（走 ECH 拦截器）
    diagEvent('login_step', { step: 'get_login_page' });
    let html = await ky.get("https://archiveofourown.org/users/login").text();
    diagEvent('login_step', {
      step: 'login_page_html',
      len: html.length,
      already: html.includes('You are already logged in to an account') ? 'yes' : 'no',
      cf: html.includes('_cf_chl_opt') || html.includes('challenge-platform') ? 'yes' : 'no',
      form: html.includes('new_user') ? 'yes' : 'no',
    });
    html = html.replace("<br \\>", ''); //Before you ask, no. I don't know. I don't need them anyway. /shrug
    if (html.includes("You are already logged in to an account. Please log out and try again.")) {
      throw "already logged in.";
    }
    const doc = new DomParser().parseFromString(html, "text/html");
    const form = doc.getElementById("new_user"); // 登录表单
    if (!form) {
      // 页面里没有登录表单：通常意味着拿到的是 CF 挑战页/错误页，而不是登录页
      diagEvent('login_step', { step: 'form_missing', len: html.length, cf: html.includes('_cf_chl_opt') ? 'yes' : 'no' });
      throw new Error(
        `登录表单 #new_user 未找到（HTML ${html.length} 字符，疑似 CF 挑战页或未登录态异常）`,
      );
    }
    // 旧实现直接取 form.childNodes[0] 的 value —— 靠位置取值，AO3 页面结构一变就取错值，
    // 表现是"登录一直失败但看不出原因"。改为按 name 查找隐藏字段，并保留旧逻辑兜底。
    const node = pickTokenFromForm(form);
    const token = node && typeof node.getAttribute === 'function' ? node.getAttribute('value') : null;
    if (!token) {
      diagEvent('login_step', { step: 'csrf_missing' });
      throw new Error('authenticity_token 提取失败（表单存在但取不到隐藏字段的值）');
    }
    const commitNode = pickFieldByName(form, 'commit');
    const commit =
      (commitNode && typeof commitNode.getAttribute === 'function' && commitNode.getAttribute('value')) ||
      'Log in';
    diagEvent('login_step', { step: 'csrf_ok', len: token.length, commit: String(commit).slice(0, 20) });
    return { token, commit };
  } catch (e) {
    console.error("An error occurred while running fetchLoginFormFields", e);
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
    const tokenInput = pickTokenFromForm(kudoForm);

    if (!tokenInput) {
      throw new Error("Authenticity token not found in kudo form");
    }

    return tokenInput.getAttribute('value');

  } catch (e) {
    console.error("An error occurred while running fetchKudoAuthenticityToken", e);
    throw e; // Re-throw to allow caller to handle
  }
}
