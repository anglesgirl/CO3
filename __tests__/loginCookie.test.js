jest.mock('../main/web/account/fetchAuthenticityToken', () => ({
  fetchLoginAuthenticityToken: jest.fn(async () => 'csrf-token'),
}));
jest.mock('../main/storage/Credentials', () => ({
  setCredsToken: jest.fn(async () => {}),
  deleteCredsToken: jest.fn(async () => {}),
  deleteCredsPasswd: jest.fn(async () => {}),
  hasStoredPassword: jest.fn(async () => false),
  setCredsPasswd: jest.fn(async () => {}),
  setLastLogin: jest.fn(async () => {}),
  setUsernameOnly: jest.fn(async () => {}),
}));
jest.mock('../main/app', () => ({ navigationRef: {} }));
jest.mock('react-native-toast-message', () => ({ show: jest.fn() }));
jest.mock('i18next', () => ({ t: key => key }));
jest.mock('../main/web/echKy', () => ({
  echUrl: jest.fn(async () => 'http://127.0.0.1:12345/'),
}));

import login, {
  parseAuthenticatedUsername,
  validateCookie,
  checkSession,
} from '../main/web/account/login';
import { echUrl } from '../main/web/echKy';

const SIGNED_IN_HTML = `
  <nav class="primary navigation actions">
    <li class="dropdown"><a href="/users/Actual_User">Hi, Actual_User!</a></li>
  </nav>
`;

function mockResponse({ status = 200, headers = {}, body = '', url = '' } = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    statusText: String(status),
    ok: status >= 200 && status < 300,
    url,
    headers: { get: name => lower[String(name).toLowerCase()] ?? null },
    text: async () => body,
  };
}

describe('parseAuthenticatedUsername', () => {
  it('extracts only the signed-in AO3 username, not an arbitrary profile link', () => {
    expect(parseAuthenticatedUsername(`
      <a href="/users/someone_else">Other user</a>
      <div id="greeting"><a href="/users/Actual_User">Hi</a></div>
    `)).toBe('Actual_User');
    expect(parseAuthenticatedUsername('<a href="/users/someone_else">Other user</a>')).toBeNull();
  });

  it('recognizes the current user from AO3 navigation when greeting markup changes', () => {
    expect(parseAuthenticatedUsername(SIGNED_IN_HTML)).toBe('Actual_User');
  });
});

describe('validateCookie', () => {
  it('validates the session through the ECH URL with a timeout signal', async () => {
    global.fetch = jest.fn(async () => mockResponse({ body: SIGNED_IN_HTML }));

    await expect(validateCookie('session-token')).resolves.toBe(true);

    expect(echUrl).toHaveBeenCalledWith('https://archiveofourown.org/');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:12345/',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('reports an invalid session when the page has no signed-in markup', async () => {
    global.fetch = jest.fn(async () => mockResponse({ body: '<p>Log in</p>' }));
    await expect(validateCookie('stale-token')).resolves.toBe(false);
  });

  it('does not treat a Cloudflare challenge page as a lost session', async () => {
    global.fetch = jest.fn(async () =>
      mockResponse({ body: '<script>window._cf_chl_opt={}</script>' }),
    );
    await expect(validateCookie('token')).resolves.toBe(true);
  });

  it('honours user_credentials being cleared even with a comma-laden Expires', async () => {
    global.fetch = jest.fn(async () =>
      mockResponse({
        headers: {
          'set-cookie':
            'user_credentials=; path=/; max-age=0; expires=Tue, 25 Aug 2026 13:13:38 GMT',
        },
        body: SIGNED_IN_HTML,
      }),
    );
    await expect(validateCookie('token')).resolves.toBe(false);
  });
});

describe('login', () => {
  // Real AO3 behaviour (verified 2026-08-11 with curl): a wrong password still
  // returns a _otwarchive_session cookie and 302s to /auth_error. Only a
  // successful login also sets user_credentials=1.
  it('rejects wrong credentials even though AO3 hands out a session cookie', async () => {
    global.fetch = jest.fn(async () =>
      mockResponse({
        status: 302,
        headers: {
          location: 'https://archiveofourown.org/auth_error',
          'set-cookie':
            '_otwarchive_session=abc123; path=/; expires=Tue, 25 Aug 2026 13:13:38 GMT; HttpOnly',
        },
      }),
    );

    await expect(login('user', 'wrong')).rejects.toMatchObject({
      code: 'BAD_CREDENTIALS',
    });
  });

  it('returns the session token when AO3 grants user_credentials', async () => {
    global.fetch = jest.fn(async () =>
      mockResponse({
        status: 302,
        headers: {
          location: 'https://archiveofourown.org/',
          'set-cookie':
            '_otwarchive_session=good-token; path=/; expires=Tue, 25 Aug 2026 13:13:38 GMT, user_credentials=1; path=/',
        },
      }),
    );

    await expect(login('user', 'right')).resolves.toBe('good-token');
  });

  it('flags Cloudflare blocks separately from bad credentials', async () => {
    global.fetch = jest.fn(async () => mockResponse({ status: 403 }));
    await expect(login('user', 'pw')).rejects.toMatchObject({ code: 'CF_CHALLENGE' });
  });
});

describe('checkSession', () => {
  it('reports ok with the resolved username', async () => {
    global.fetch = jest.fn(async () => mockResponse({ body: SIGNED_IN_HTML }));
    await expect(checkSession('token')).resolves.toEqual({
      ok: true,
      username: 'Actual_User',
    });
  });

  it('reports not-ok instead of throwing when the request fails', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    });
    await expect(checkSession('token')).resolves.toEqual({ ok: false, username: null });
  });
});
