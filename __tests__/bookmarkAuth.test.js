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
    expect(source.match(/\.\.\.sessionHeaders/g)).toHaveLength(3);
    expect(source).toContain('headers: await getSessionHeaders()');
  });

  it('uses the established AO3 browser-shaped bookmark request', () => {
    const source = read('main/web/other/bookmarks.js');
    expect(source).toContain("const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'");
    expect(source).toContain("'User-Agent': userAgent");
    expect(source).not.toContain("redirect: 'manual'");
    expect(source).toContain('if (postResponse.ok || postResponse.status === 302)');
  });

  it('verifies the saved work only after the add request completes', () => {
    const source = read('main/web/other/bookmarks.js');
    expect(source).toContain('async function verifyBookmarkInList(workId)');
    expect(source).toContain('verifyBookmarkInList(workId).catch');
    expect(source).toContain('return true;');
  });

  it('supports removing a bookmark from its AO3 list form', () => {
    const source = read('main/web/other/bookmarks.js');
    expect(source).toContain('export async function removeBookmark(work)');
    expect(source).toContain("body.append('_method', 'delete')");
    expect(source).toContain('findBookmarkDeleteForm');
  });

  it('does not turn an eventual bookmark-list lookup into an add failure', () => {
    const source = read('main/web/other/bookmarks.js');
    expect(source).toContain('Verification failed after successful add');
    expect(source).not.toContain('AO3 accepted the request, but the work was not found');
  });

  it('uses AO3 selected pseud values before falling back to an input', () => {
    const source = read('main/web/ao3FormParser.js');
    expect(source).toContain("const pseudId = selected?.[1] || parsePseudSelect(doc) || input?.getAttribute('value') || null;");
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
