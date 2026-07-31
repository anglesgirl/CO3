import fs from 'fs';
import path from 'path';

const read = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('debug logging', () => {
  it('opens Debug after three About-logo taps and enables logging', () => {
    const source = read('main/screens/more/AboutScreen.jsx');
    expect(source).toContain('logoTapCount.current !== 3');
    expect(source).toContain('await setDebugEnabled(true)');
    expect(source).toContain("navigation.push('Debug'");
  });

  it('records bookmark request outcomes without storing session secrets', () => {
    const source = read('main/web/other/bookmarks.js');
    const logger = read('main/utils/debugLog.js');
    expect(source).toContain("debugLog('bookmark'");
    expect(source).toContain('POST HTTP');
    expect(logger).toContain('_otwarchive_session=<redacted>');
  });

  it('records reader WebView image proxy events', () => {
    const source = read('main/screens/chapterReader.jsx');
    expect(source).toContain("debugLog('reader', data.message)");
    expect(read('main/web/worksScreen/fetchChapter.js')).toContain("message: '[image proxy] ' + message");
  });
});
