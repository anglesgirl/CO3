import { firstHistoryItemForDoubleTap } from '../main/utils/historyNavigation';

describe('history double tap navigation', () => {
  it('does nothing when history is empty', () => {
    expect(firstHistoryItemForDoubleTap([], 'history')).toBeNull();
  });

  it('ignores double taps from other navigation tabs', () => {
    expect(firstHistoryItemForDoubleTap([{ workId: 1 }], 'library')).toBeNull();
  });

  it('returns the newest item for the history tab', () => {
    const item = { workId: 42 };
    expect(firstHistoryItemForDoubleTap([item], 'history')).toBe(item);
  });
});
