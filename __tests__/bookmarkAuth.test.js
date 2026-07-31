import fs from 'fs';
import path from 'path';
import { parseBookmarkForm, parseMarkForLaterForm } from '../main/web/ao3FormParser';

jest.mock('../main/storage/Credentials', () => ({
  getCredsToken: jest.fn(),
}));

import { getCredsToken } from '../main/storage/Credentials';
import { getSessionHeaders } from '../main/web/sessionHeaders';

const read = relativePath =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('ECH authenticated actions', () => {
  it('builds an explicit AO3 session cookie', () => {
    const source = read('main/web/sessionHeaders.js');
    expect(source).toContain('getCredsToken');
    expect(source).toContain('_otwarchive_session=');
    expect(source).toContain('user_credentials=1');
  });

  it('returns the stored token as an explicit Cookie header', async () => {
    getCredsToken.mockResolvedValue('session-token');
    await expect(getSessionHeaders()).resolves.toEqual({
      Cookie: 'user_credentials=1; _otwarchive_session=session-token',
    });
  });

  it('adds the session cookie to bookmark listing, GET, and POST requests', () => {
    const source = read('main/web/other/bookmarks.js');
    expect(source).toContain('const sessionHeaders = await getSessionHeaders()');
    expect(source.match(/\.\.\.sessionHeaders/g)).toHaveLength(2);
    expect(source).toContain('headers: await getSessionHeaders()');
  });

  it('recognizes an AO3 create redirect or its followed Show Bookmark page as success', () => {
    const source = read('main/web/other/bookmarks.js');
    expect(source).toContain("redirect: 'manual'");
    expect(source).toContain('postResponse.status >= 300 && postResponse.status < 400');
    expect(source).toContain('function isBookmarkShowPage(html)');
    expect(source).toContain('function bookmarkShowPageMatchesWork(html, workId)');
    expect(source).toContain('if (bookmarkShowPageMatchesWork(postHtml, workId))');
    expect(source).toContain('AO3 did not confirm bookmark creation');
  });

  it('adds the session cookie to mark-for-later GET and POST requests', () => {
    const source = read('main/web/other/markedLater.js');
    expect(source).toContain('const sessionHeaders = await getSessionHeaders()');
    expect(source.match(/\.\.\.sessionHeaders/g)).toHaveLength(2);
  });

  it('parses bookmark fields without depending on attribute order', () => {
    const source = read('main/web/ao3FormParser.js');
    expect(source).toContain('DomParser');
    expect(source).toContain("getAttribute('name')");
    expect(source).toContain("getAttribute('selected')");
  });

  it('extracts reordered AO3 bookmark and mark-for-later forms', () => {
    const bookmark = parseBookmarkForm(`
      <input value="csrf-token" type="hidden" name="authenticity_token">
      <select name="bookmark[pseud_id]">
        <option value="12">First</option>
        <option selected="selected" value="34">Current</option>
      </select>
    `);
    const markedLater = parseMarkForLaterForm(`
      <input value="csrf-token" name="authenticity_token" type="hidden">
      <form method="post" action="/works/99/mark_for_later"></form>
    `);
    expect(bookmark).toEqual({ token: 'csrf-token', pseudId: '34' });
    expect(markedLater).toEqual({
      token: 'csrf-token',
      action: '/works/99/mark_for_later',
    });
  });
});
