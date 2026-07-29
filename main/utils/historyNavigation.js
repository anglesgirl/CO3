export function firstHistoryItemForDoubleTap(history, screenId) {
  if (screenId !== 'history' || !Array.isArray(history)) {
    return null;
  }

  return history[0] ?? null;
}
