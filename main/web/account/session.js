const DEFAULT_TIMEOUT_MS = 15000;

export function withTimeout(promise, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isLoggedInPage(html = '') {
  if (/href=["'][^"']*\/users\/logout/i.test(html)) return true;
  if (/id=["']login-dropdown["']/i.test(html)) return false;
  return !/href=["'][^"']*\/users\/login/i.test(html);
}
