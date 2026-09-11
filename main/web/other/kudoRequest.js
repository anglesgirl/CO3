import { fetchKudoAuthenticityToken } from '../account/fetchAuthenticityToken';

export default async function sendKudo(workId) {
  try {
    // Get the authenticity token
    const authenticityToken = await fetchKudoAuthenticityToken(workId);

    // 【必须 urlencoded】FormData 会被 RN 发成 multipart，AO3 只认 urlencoded（同登录那个坑）
    const params = new URLSearchParams();
    params.append('authenticity_token', authenticityToken);
    params.append('kudo[commentable_id]', workId);
    params.append('kudo[commentable_type]', 'Work');
    params.append('commit', 'Kudos ♥');

    // Send the kudos request
    const response = await fetch('https://archiveofourown.org/kudos', {
      method: 'POST',
      body: params.toString(),
      credentials: 'include',
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://archiveofourown.org',
        Referer: `https://archiveofourown.org/works/${workId}`,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        // Cookie 不再手写：由 OkHttp 的 cookieJar（CookieManager）自动注入。
        // 手写反而会用存下来的旧 token 覆盖掉正确 cookie。
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to send kudos: ${response.status} ${response.statusText}`,
      );
    }

    // Check if kudos was successful by examining the response
    // AO3 typically redirects back to the work page after successful kudos
    if (response.url.includes(`/works/${workId}`)) {
      console.log('Kudos sent successfully!');
      return true;
    }

    const responseText = await response.text();
    if (
      responseText.includes('Thank you for leaving kudos!') ||
      responseText.includes('already left kudos')
    ) {
      console.log('Kudos processed (may have already been given)');
      return true;
    }

    console.warn('Kudos request completed but success unclear');
    console.log(response);
    return false;
  } catch (error) {
    console.error('Error sending kudos:', error);
    throw error;
  }
}
