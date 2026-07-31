import fs from 'fs';
import path from 'path';

const read = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('bookmark quick actions', () => {
  it('uses a remove action for cards displayed in the bookmark list', () => {
    expect(read('main/screens/more/BookmarksScreen.jsx')).toContain('isBookmark={true}');
    const card = read('main/components/Library/BookCard.jsx');
    expect(card).toContain('isBookmark = false');
    expect(card).toContain('isBookmark={isBookmark}');
  });

  it('refreshes the bookmark list after a successful removal', () => {
    const modal = read('main/components/Library/QuickActionsModal.jsx');
    expect(modal).toContain('bookmark, removeBookmark');
    expect(modal).toContain('const operation = isBookmark ? removeBookmark(work) : bookmark(work);');
    expect(modal).toContain('onUpdate?.();');
    expect(modal).not.toContain('if (isBookmark) onUpdate?.();');
  });
});
