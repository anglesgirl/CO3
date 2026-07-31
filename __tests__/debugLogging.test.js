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
    expect(source).toContain('Opening chapter=${chapterID || workId}; images=${imageCount}');
    expect(source).toContain("WebView: document images='");
    expect(read('main/web/worksScreen/fetchChapter.js')).toContain("message: '[image proxy] ' + message");
  });

  it('captures console output and uncaught errors while debugging is enabled', () => {
    const source = read('main/utils/debugLog.js');
    const app = read('main/app.jsx');
    expect(source).toContain("['log', 'warn', 'error'].forEach");
    expect(source).toContain('console[level] = (...args)');
    expect(app).toContain('installDebugConsoleCapture()');
    expect(app).toContain("debugLog('uncaught'");
  });
});
