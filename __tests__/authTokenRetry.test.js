jest.mock('../main/web/echKy', () => ({
  __esModule: true,
  // ky.get(url) returns a Response-like object synchronously; .text() is async.
  // Mock must return the object (with a .text() returning a Promise), NOT an
  // async fn whose promise only resolves to it.
  default: {
    get: jest.fn(() => ({
      text: async () => '<html>mock page</html>',
    })),
  },
  clearAuthCookies: jest.fn(async () => {}),
}));
jest.mock('../main/web/requestManager', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../main/web/WebviewFetcher', () => ({
  __esModule: true,
  fetchViaWebView: jest.fn(async () => '<html>verified</html>'),
}));
jest.mock('react-native-html-parser', () => ({
  DOMParser: class {
    parseFromString() {
      return {
        getElementById: () => null,
      };
    }
  },
}));

import ky, { clearAuthCookies } from '../main/web/echKy';
import { fetchLoginAuthenticityToken } from '../main/web/account/fetchAuthenticityToken';

describe('fetchLoginAuthenticityToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const alreadyLoggedInPage = () => ({
    text: async () =>
      '<html>You are already logged in to an account. Please log out and try again.</html>',
  });

  it('clears stale proxy cookies when AO3 reports already logged in, then retries', async () => {
    ky.get.mockImplementation(alreadyLoggedInPage);

    await fetchLoginAuthenticityToken().catch(() => {});

    expect(clearAuthCookies).toHaveBeenCalledTimes(1);
    // After clearing, it retries the login page fetch.
    expect(ky.get).toHaveBeenCalledTimes(2);
  });

  it('throws only after the single retry still reports already logged in', async () => {
    ky.get.mockImplementation(alreadyLoggedInPage);

    await expect(fetchLoginAuthenticityToken()).rejects.toThrow('already logged in.');

    expect(clearAuthCookies).toHaveBeenCalledTimes(1);
    expect(ky.get).toHaveBeenCalledTimes(2);
  });
});