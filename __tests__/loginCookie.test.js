jest.mock('../main/web/account/fetchAuthenticityToken', () => ({
  fetchLoginAuthenticityToken: jest.fn(),
}));
jest.mock('../main/storage/Credentials', () => ({}));
jest.mock('../main/app', () => ({ navigationRef: {} }));
jest.mock('react-native-toast-message', () => ({ show: jest.fn() }));
jest.mock('i18next', () => ({ t: key => key }));
jest.mock('../main/web/echKy', () => ({
  echUrl: jest.fn(async () => 'http://127.0.0.1:12345/'),
}));

import { parseAuthenticatedUsername, validateCookie } from '../main/web/account/login';
import { echUrl } from '../main/web/echKy';

describe('validateCookie', () => {
  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      headers: { get: jest.fn(() => null) },
    }));
  });

  it('extracts only the signed-in AO3 username, not an arbitrary profile link', () => {
    expect(parseAuthenticatedUsername(`
      <a href="/users/someone_else">Other user</a>
      <div id="greeting"><a href="/users/Actual_User">Hi</a></div>
    `)).toBe('Actual_User');
    expect(parseAuthenticatedUsername('<a href="/users/someone_else">Other user</a>')).toBeNull();
  });

  it('recognizes the current user from AO3 navigation when greeting markup changes', () => {
    expect(parseAuthenticatedUsername(`
      <nav class="primary navigation actions" role="navigation">
        <li class="dropdown"><a href="/users/Actual_User">Hi, Actual_User!</a></li>
      </nav>
    `)).toBe('Actual_User');
  });

  it('validates the session through the ECH URL with a timeout signal', async () => {
    await expect(validateCookie('session-token')).resolves.toBe(true);

    expect(echUrl).toHaveBeenCalledWith('https://archiveofourown.org/');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});
