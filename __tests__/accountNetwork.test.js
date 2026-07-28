import { isLoggedInPage, withTimeout } from '../main/web/account/session';

describe('account session network handling', () => {
  test('recognizes a logged-in AO3 page', () => {
    const html = '<nav><a href="/users/logout">Log Out</a></nav>';
    expect(isLoggedInPage(html)).toBe(true);
  });

  test('recognizes a logged-out AO3 page', () => {
    const html = '<a id="login-dropdown" href="/users/login">Log In</a>';
    expect(isLoggedInPage(html)).toBe(false);
  });

  test('rejects a stalled request instead of loading forever', async () => {
    jest.useFakeTimers();
    const stalled = new Promise(() => {});
    const request = withTimeout(stalled, 1000);

    jest.advanceTimersByTime(1000);
    await expect(request).rejects.toThrow('timed out');
    jest.useRealTimers();
  });
});
