import { fetchChapterWithTheme } from '../web/worksScreen/fetchChapter';

/**
 * Navigate to the next chapter
 * @param {Object} params - Navigation parameters
 * @param {string} params.workId - Current work ID
 * @param {string} params.currentChapterId - Current chapter ID
 * @param {Array} params.chapterList - Array of chapter objects with id and title
 * @param {number} params.currentChapterIndex - Current chapter index
 * @param {Object} params.currentTheme - Theme object
 * @param {Function} params.onChapterChange - Callback when chapter changes
 * @param {Object} params.historyDAO - History storage access object
 * @returns {Promise<Object|null>} - New chapter data or null if no next chapter
 */
export const navigateToNextChapter = async ({
                                              workId,
                                              currentChapterId,
                                              chapterList,
                                              currentChapterIndex,
                                              currentTheme,
                                              onChapterChange,
                                              historyDAO,
                                              settingsDAO
                                            }) => {
  // Check if there's a next chapter
  if (currentChapterIndex >= chapterList.length - 1) {
    console.log('Already at the last chapter');
    return null;
  }

  const nextChapterIndex = currentChapterIndex + 1;
  const nextChapter = chapterList[nextChapterIndex];

  if (!nextChapter) {
    console.log('Next chapter not found in chapter list');
    return null;
  }

  // Fetch the next chapter content
  const nextChapterContent = await fetchChapterWithTheme(
    workId,
    nextChapter.id,
    currentTheme,
    settingsDAO
  );

  // Record in history
  if (historyDAO) {
    await recordChapterRead(historyDAO, workId, nextChapter.id, nextChapter.title);
  }

  // Prepare chapter data
  const chapterData = {
    workId,
    chapterId: nextChapter.id,
    chapterTitle: nextChapter.title,
    chapterIndex: nextChapterIndex,
    // fetchChapterWithTheme 返回的是 {html, body, css} 对象 —— 必须取 .html，
    // 否则整个对象会被当成 HTML 传给 WebView，触发
    // "Value for html cannot be cast from ReadableNativeMap to String" 崩溃。
    htmlContent: nextChapterContent && nextChapterContent.html,
    rawBody: nextChapterContent && nextChapterContent.body,
    rawCss: nextChapterContent && nextChapterContent.css,
    hasNextChapter: nextChapterIndex < chapterList.length - 1,
    hasPreviousChapter: nextChapterIndex > 0,
  };

  // Call the change callback
  if (onChapterChange) {
    onChapterChange(chapterData);
  }

  return chapterData;
};

/**
 * Navigate to the previous chapter
 * @param {Object} params - Navigation parameters
 * @param {string} params.workId - Current work ID
 * @param {string} params.currentChapterId - Current chapter ID
 * @param {Array} params.chapterList - Array of chapter objects with id and title
 * @param {number} params.currentChapterIndex - Current chapter index
 * @param {Object} params.currentTheme - Theme object
 * @param {Function} params.onChapterChange - Callback when chapter changes
 * @param {Object} params.historyDAO - History storage access object
 * @returns {Promise<Object|null>} - Previous chapter data or null if no previous chapter
 */
export const navigateToPreviousChapter = async ({
                                                  workId,
                                                  currentChapterId,
                                                  chapterList,
                                                  currentChapterIndex,
                                                  currentTheme,
                                                  onChapterChange,
                                                  historyDAO,
                                                  settingsDAO
                                                }) => {
if (currentChapterIndex <= 0) {
      console.log('Already at the first chapter');
      return null;
    }

    const previousChapterIndex = currentChapterIndex - 1;
    const previousChapter = chapterList[previousChapterIndex];

    if (!previousChapter) {
      console.log('Previous chapter not found in chapter list');
      return null;
    }

    // Fetch the previous chapter content
    const previousChapterContent = await fetchChapterWithTheme(
      workId,
      previousChapter.id,
      currentTheme,
      settingsDAO
    );

    // Record in history
    if (historyDAO) {
      await recordChapterRead(historyDAO, workId, previousChapter.id, previousChapter.title);
    }

    // Prepare chapter data
    const chapterData = {
      workId,
      chapterId: previousChapter.id,
      chapterTitle: previousChapter.title,
      chapterIndex: previousChapterIndex,
      htmlContent: previousChapterContent && previousChapterContent.html,
      rawBody: previousChapterContent && previousChapterContent.body,
      rawCss: previousChapterContent && previousChapterContent.css,
      hasNextChapter: previousChapterIndex < chapterList.length - 1,
      hasPreviousChapter: previousChapterIndex > 0,
    };

    // Call the change callback
    if (onChapterChange) {
      onChapterChange(chapterData);
    }

    return chapterData;
};

/**
 * Record a chapter as read in the history
 * @param {Object} historyDAO - History storage access object
 * @param {string} workId - Work ID
 * @param {string} chapterId - Chapter ID
 * @param {string} chapterTitle - Chapter title
 */
const recordChapterRead = async (historyDAO, workId, chapterId, chapterTitle) => {
  try {
    if (!historyDAO || !historyDAO.addHistoryEntry) {
      console.log('History DAO not available or method not found');
      return;
    }

    const historyEntry = {
      workId,
      chapterId,
      chapterTitle,
      timestamp: Date.now(),
      progress: 0,
    };

    await historyDAO.addHistoryEntry(historyEntry);
    console.log(`Chapter ${chapterId} recorded in history`);
  } catch (error) {
    console.error('Error recording chapter in history:', error);
  }
};
