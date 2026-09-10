import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Linking,
  Modal,
  NativeEventEmitter,
  NativeModules,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { WebView } from 'react-native-webview';
import Icon from 'react-native-vector-icons/MaterialIcons';
import Svg, { Circle } from 'react-native-svg';
import Slider from '@react-native-community/slider';
import { CommentsScreen } from '../components/Reader/commentsScreen';
import { getJsonSettings } from '../storage/jsonSettings';
import Toast from 'react-native-toast-message';
import { useTranslation } from 'react-i18next';
import InAppBrowser from 'react-native-inappbrowser-reborn';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PULL_THRESHOLD = 150;
const PROGRESS_SAVE_DEBOUNCE = 1000;

// ---- 本页翻译用注入脚本 ----
// 从已渲染的 DOM 提取段落（保证与屏幕上的段一一对应），并打上序号，
// 后续译文就按这个序号插到对应段落下方。
//
// 注意：AO3 原文里本来就有**空的 <p>**，必须跳过 —— 否则会给它们也插占位符，
// 看起来就是凭空多出来的空行。同时返回**真实 DOM 索引**，因为跳过空段后
// 数组下标不再等于 DOM 序号，用下标会让译文插错位置。
const EXTRACT_SEGS_JS = `
(function(){
  try {
    var ps = Array.prototype.slice.call(document.querySelectorAll('p'));
    var items = [];
    var idxs = [];
    for (var i = 0; i < ps.length; i++) {
      var t = (ps[i].textContent || '').trim();
      if (!t) continue;               // 跳过空段落，避免凭空多出空行
      ps[i].setAttribute('data-co3seg', String(i));
      items.push(t);
      idxs.push(i);
    }
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'co3_segments', items: items, idxs: idxs })
      );
    }
  } catch (e) {}
})();
true;`;

/** 移除某段的译文节点（该段翻译失败时用，避免留下空节点/占位 "…"）。 */
const removeTransJs = (i) => `
(function(){
  var el = document.querySelector('[data-co3seg="${i}"]');
  if (!el || !el.parentNode) return;
  var t = el.parentNode.querySelector('.co3-trans[data-for="${i}"]');
  if (t && t.parentNode) t.parentNode.removeChild(t);
})();`;

// 长段落切分：端侧吞吐约 15 token/s，一段 800+ 字符要十几秒，期间界面上
// 几乎看不到动静，用户会以为卡死。按句子边界切成 <=CHUNK 的块，逐块翻译后
// 拼接，这样每块几秒就能出字，观感连续。
const TRANS_CHUNK = 320;
const splitLongText = (text) => {
  const s0 = String(text || '');
  if (s0.length <= TRANS_CHUNK) return [s0];
  const pieces = s0.split(/(?<=[.!?;:。！？；：])\s+/).filter((x) => x && x.trim());
  const out = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && (cur.length + 1 + p.length) > TRANS_CHUNK) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur} ${p}` : p;
    }
  }
  if (cur) out.push(cur);
  // 兜底：万一没有句读符号（超长单句），硬切，避免一块仍然过大
  const hard = [];
  for (const c of out) {
    if (c.length <= TRANS_CHUNK * 2) {
      hard.push(c);
    } else {
      for (let i = 0; i < c.length; i += TRANS_CHUNK) hard.push(c.slice(i, i + TRANS_CHUNK));
    }
  }
  return hard;
};

// 翻译前：给每段在**下方留出空位**（占位符），用户立刻能看到"这里会出译文"，
// 而不是盯着没有变化的原文干等。
// 参数是**真实 DOM 序号数组**（已跳过空段落），避免给空段插空行。
const placeholdersJs = (idxs) => `
(function(){
  var list = ${JSON.stringify(idxs)};
  for (var k = 0; k < list.length; k++) {
    var i = list[k];
    var el = document.querySelector('[data-co3seg="' + i + '"]');
    if (!el || !el.parentNode) continue;
    var old = el.parentNode.querySelector('.co3-trans[data-for="' + i + '"]');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var d = document.createElement('p');
    d.className = 'co3-trans co3-pending';
    d.setAttribute('data-for', String(i));
    d.textContent = '…';
    el.parentNode.insertBefore(d, el.nextSibling);
  }
})();`;

/**
 * 把第 i 段的译文**就地更新**（流式：每批 token 到达都覆盖同一个节点，
 * 表现为"边翻边写"）。pending=true 保留未完成样式。
 */
const updateTransJs = (i, text, pending) => `
(function(){
  var el = document.querySelector('[data-co3seg="${i}"]');
  if (!el || !el.parentNode) return;
  var t = el.parentNode.querySelector('.co3-trans[data-for="${i}"]');
  if (!t) {
    t = document.createElement('p');
    t.className = 'co3-trans';
    t.setAttribute('data-for', '${i}');
    el.parentNode.insertBefore(t, el.nextSibling);
  }
  t.className = 'co3-trans${pending ? ' co3-pending' : ''}';
  t.textContent = ${JSON.stringify(String(text == null ? '' : text))};
})();`;

const PullIndicator = ({ progress, theme }) => {
  const size = 60;
  const strokeWidth = 5;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const strokeDashoffset = circumference - circumference * progress;

  return (
    <View style={styles.pullIndicatorContainer}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={size / 2}
          fill={theme.cardBackground}
        />
        <Circle
          stroke={theme.primaryColor}
          fill="transparent"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <Icon
        name="arrow-upward"
        size={28}
        color={theme.primaryColor}
        style={styles.pullIndicatorIcon}
      />
    </View>
  );
};

const ChapterReader = ({
                         currentTheme,
                         workId,
                         workTitle,
                         chapterTitle,
                         chapterID,
                         htmlContent,
                         currentChapterIndex,
                         totalChapters,
                         hasNextChapter,
                         hasPreviousChapter,
                         onNextChapter,
                         onPreviousChapter,
                         onProgressUpdate,
                         progressDAO,
                         historyDAO,
                         settingsDAO,
                         setScreens,
                         libraryDAO,
                         kudoHistoryDAO,
                         chapterDAO,
                         workDAO,
                       }) => {
  const { t } = useTranslation();

  const [barsVisible, setBarsVisible] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [webViewReady, setWebViewReady] = useState(false);
  const [isIncognitoMode, setIsIncognitoMode] = useState(false);
  const [commentsVisible, setCommentsVisible] = useState(false);
  const [initialProgressLoaded, setInitialProgressLoaded] = useState(false);
  const [initialScrollAttempted, setInitialScrollAttempted] = useState(false);
  const [size, setSize] = useState(1);
  const [jsonSettings, setJsonSettings] = useState();

  const [modifiedHtmlContent, setModifiedHtmlContent] = useState(htmlContent);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const webViewRef = useRef(null);
  // 本页翻译状态：原文保留，译文逐段追加在下方
  const [translating, setTranslating] = useState(false);
  const [translated, setTranslated] = useState(false);
  // 翻译进度 {done,total}；null 表示未在翻译。用于驱动顶部进度提示
  const [translateProgress, setTranslateProgress] = useState(null);
  const translatingRef = useRef(false);
  // 分块翻译时的前缀累积：{ DOM序号: 已翻完的块 }，使同一段的后续块接在已有译文后面
  const segmentPrefixRef = useRef({});
  const pendingSegsRef = useRef(null);
  const progressSaveTimeoutRef = useRef(null);
  const lastSavedProgressRef = useRef(0);

  // Apply the word replacer rule
  useEffect(() => {
    AsyncStorage.getItem('WordReplaceRules').then(rulesString => {
      if (!rulesString) {
        setModifiedHtmlContent(htmlContent);
        return;
      }

      let rules;
      try {
        rules = JSON.parse(rulesString);
      } catch (e) {
        console.warn('Failed to parse WordReplaceRules:', e);
        setModifiedHtmlContent(htmlContent);
        return;
      }

      if (!Array.isArray(rules) || rules.length === 0) {
        setModifiedHtmlContent(htmlContent);
        return;
      }

      let result = htmlContent;

      for (const rule of rules) {
        const { match, replace, caseSensitive, useRegex } = rule;

        if (!match) continue;

        let pattern;

        try {
          if (useRegex) {
            pattern = new RegExp(match, caseSensitive ? 'g' : 'gi');
          } else {
            const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            pattern = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
          }

          result = result.replace(pattern, replace ?? '');
        } catch (e) {
          console.warn(
            `Invalid word replacer rule "${rule.title || match}":`,
            e,
          );
        }
      }

      setModifiedHtmlContent(result);
    });
  }, [htmlContent]);

  // Load settings when component mounts
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await settingsDAO.getSettings();
        setIsIncognitoMode(settings.isIncognitoMode);
        setSize(settings.fontSize);
        setJsonSettings(await getJsonSettings());
      } catch (error) {
        console.error('Error loading settings:', error);
      }
    };

    loadSettings();
  }, [settingsDAO]);

  // Load initial progress when chapterID changes and not in incognito
  useEffect(() => {
    const loadInitialProgress = async () => {
      if (isIncognitoMode) {
        setInitialProgressLoaded(true);
        setScrollProgress(0); // Ensure progress is 0 in incognito
        lastSavedProgressRef.current = 0;
        return;
      }

      if (progressDAO && chapterID) {
        try {
          const savedProgress = await progressDAO.get(workId, chapterID);
          setScrollProgress(savedProgress);
          lastSavedProgressRef.current = savedProgress;
          sendWebViewCommand('scroll')
          console.log(`Initial progress loaded: ${savedProgress}`);
        } catch (error) {
          console.error('Error loading saved progress:', error);
          setScrollProgress(0);
          lastSavedProgressRef.current = 0;
        } finally {
          setInitialProgressLoaded(true);
        }
      } else {
        setInitialProgressLoaded(true); // If no progressDAO or chapterID, consider initial progress loaded
      }
    };

    // Only load initial progress if incognito mode is determined
    if (typeof isIncognitoMode === 'boolean') {
      loadInitialProgress();
    }

  }, [workId, chapterID, progressDAO, isIncognitoMode]);

  useEffect(() => {
    const manageHistory = async () => {
      if (!historyDAO || !workId || currentChapterIndex === undefined || isIncognitoMode) {
        return;
      }

      try {
        const latestEntry = await historyDAO.getLatestEntry();
        const now = new Date().getTime();
        const oneHour = 60 * 60 * 1000;

        if (
          latestEntry &&
          latestEntry.workId === workId &&
          now - latestEntry.date < oneHour
        ) {
          await historyDAO.updateChapterEnd(latestEntry.id, currentChapterIndex, now);
          console.log(`History updated for work ${workId}. End chapter is now ${currentChapterIndex}`);
        } else {
          const newEntry = {
            workId,
            date: now,
            chapter: currentChapterIndex,
            chapterEnd: currentChapterIndex,
          };
          await historyDAO.add(newEntry);
          console.log(`New history entry created for work ${workId}, chapter ${currentChapterIndex}`);
        }
      } catch (error) {
        console.error('Error managing history:', error);
      }
    };

    manageHistory();
  }, [workId, currentChapterIndex, historyDAO, isIncognitoMode]);

  // Function to send commands to the WebView
  const sendWebViewCommand = useCallback((action, payload = {}) => {
    if (webViewRef.current) {
      const message = JSON.stringify({ action, payload });
      webViewRef.current.injectJavaScript(`
        if (window.onMessageFromReactNative) {
          window.onMessageFromReactNative(${message});
        }
        true;
      `);
    }
  }, []);

  /**
   * 本页翻译：**保留原文**，译文在每段下方**逐段追加**。
   * 端侧推理一篇文章要一两分钟；边翻边追加，用户能立刻开始读原文，
   * 译文随滚动陆续出现，慢也不至于让人以为卡死。
   */
  const handleTranslate = useCallback(async () => {
    if (!webViewRef.current || translatingRef.current) return;
    translatingRef.current = true;
    setTranslating(true);
    // 点翻译后立刻收起底栏：否则它会遮住正文（用户反馈过）
    setBarsVisible(false);
    try {
      // 1) 从已渲染的 DOM 取段落：items=文本，idxs=真实 DOM 序号（空段已跳过）
      const seg = await new Promise((resolve) => {
        let settled = false;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          pendingSegsRef.current = null;
          resolve(v);
        };
        pendingSegsRef.current = finish;
        webViewRef.current.injectJavaScript(EXTRACT_SEGS_JS);
        setTimeout(() => finish(null), 4000);
      });
      const texts = seg && Array.isArray(seg.items) ? seg.items : [];
      const idxs = seg && Array.isArray(seg.idxs) ? seg.idxs : [];
      if (!texts.length || idxs.length !== texts.length) {
        Toast.show({
          type: 'error',
          text2: t('reader_translate_no_segments'),
          position: 'bottom',
          bottomOffset: 80,
          visibilityTime: 2000,
        });
        return;
      }

      // 2) 先给每段在下方留出空位（只给有内容的段，否则会凭空多出空行）
      webViewRef.current.injectJavaScript(`${placeholdersJs(idxs)}\ntrue;`);
      setTranslateProgress({ done: 0, total: texts.length });

      // 3) 按当前所选引擎分流：
      //    device(本机 AI) → 逐段流式，token 事件实时写入（边翻边看）
      //    其它(在线/机翻) → 批量请求
      const { getTranslateEngine } = require('../web/translate/settings');
      const engine = await getTranslateEngine();
      const { Hymt } = NativeModules;

      let doneN = 0;
      let failed = 0;

      if (engine === 'device' && Hymt) {
        let initOk = false;
        try {
          initOk = await Hymt.isReady();
          if (!initOk) initOk = await Hymt.init();
        } catch (e) {
          initOk = false;
        }
        if (!initOk) throw new Error(t('reader_translate_failed'));

        for (let k = 0; k < texts.length; k += 1) {
          const domIdx = idxs[k];
          // 长段落切块：每块单独流式翻译，已完成的块作为前缀累积到同一条译文里
          const chunks = splitLongText(texts[k]);
          segmentPrefixRef.current[domIdx] = '';
          let segOk = false;
          for (const chunk of chunks) {
            try {
              // translateStream 的 resolve 值即该块译文；把它累积下来，
              // 下一块的流式输出就会接在这段已经写好的文字后面。
              const part = await Hymt.translateStream(chunk, domIdx, 512);
              segmentPrefixRef.current[domIdx] =
                String(segmentPrefixRef.current[domIdx] || '') + String(part || '');
              segOk = true;
            } catch (e) {
              segmentPrefixRef.current[domIdx] = '';
              break;
            }
          }
          if (!segOk) {
            failed += 1;
            webViewRef.current.injectJavaScript(`${removeTransJs(domIdx)}\ntrue;`);
          }
          delete segmentPrefixRef.current[domIdx];
          doneN += 1;
          setTranslateProgress({ done: doneN, total: texts.length });
        }
      } else {
        const { translateTextsSmart } = require('../web/translate/bilingual');
        const BATCH = 6;
        for (let s0 = 0; s0 < texts.length; s0 += BATCH) {
          const tchunk = texts.slice(s0, s0 + BATCH);
          const ichunk = idxs.slice(s0, s0 + BATCH);
          let zh = null;
          try {
            zh = await translateTextsSmart(tchunk);
          } catch (e) {
            zh = null;
          }
          if (zh && zh.length === tchunk.length) {
            const js = tchunk
              .map((_, j) =>
                String(zh[j] || '').trim()
                  ? updateTransJs(ichunk[j], zh[j], false)
                  : removeTransJs(ichunk[j]),
              )
              .join('\n');
            webViewRef.current.injectJavaScript(`${js}\ntrue;`);
          } else {
            failed += tchunk.length;
            ichunk.forEach((di) => {
              webViewRef.current.injectJavaScript(`${removeTransJs(di)}\ntrue;`);
            });
          }
          doneN += tchunk.length;
          setTranslateProgress({ done: doneN, total: texts.length });
        }
      }

      setTranslated(true);
      if (failed > 0) {
        Toast.show({
          type: 'error',
          text2: `${t('reader_translate_done_with_fail')} (${failed})`,
          position: 'bottom',
          bottomOffset: 80,
          visibilityTime: 2500,
        });
      }
    } catch (e) {
      Toast.show({
        type: 'error',
        text2: `${t('reader_translate_failed')}: ${e.message}`,
        position: 'bottom',
        bottomOffset: 80,
        visibilityTime: 2500,
      });
    } finally {
      translatingRef.current = false;
      setTranslating(false);
      // 进度清空 -> 底栏自动恢复显示阅读进度
      setTranslateProgress(null);
    }
  }, [t]);

  // 订阅本机流式翻译的 token 事件：每批 token 到达就把对应段落的译文**就地覆盖**，
  // 界面表现为"原文下面边翻边写"。节流已在原生侧做（80ms 一次）。
  useEffect(() => {
    const { Hymt } = NativeModules;
    if (!Hymt) return undefined;
    let emitter = null;
    try {
      emitter = new NativeEventEmitter(Hymt);
    } catch (e) {
      return undefined;
    }
    const sub = emitter.addListener('hymt_token', (evt) => {
      if (!evt || !webViewRef.current) return;
      const idx = typeof evt.index === 'number' ? evt.index : -1;
      if (idx < 0) return;
      const pfx = segmentPrefixRef.current[idx] || '';
      webViewRef.current.injectJavaScript(
        `${updateTransJs(idx, pfx + String(evt.full || ''), true)}\ntrue;`,
      );
    });
    return () => {
      try {
        sub.remove();
      } catch (e) {
        // 组件卸载时移除失败可忽略
      }
    };
  }, []);

  // 翻译进度提示：由 state 统一驱动（不再每段都调 Toast.show，避免动画堆积）。
  // 这是**唯一的**翻译进度来源 —— 底栏不重复显示，两个进度条就不会打架。
  useEffect(() => {
    if (translateProgress && translateProgress.total > 0) {
      Toast.show({
        type: 'success',
        text2: `${t('reader_translate_progress')} ${translateProgress.done}/${translateProgress.total}`,
        position: 'bottom',
        bottomOffset: 80,
        autoHide: false,
      });
    } else {
      Toast.hide();
    }
  }, [translateProgress, t]);

  // Reset state when chapter changes
  useEffect(() => {
    setScrollProgress(0);
    setPullDistance(0);
    setWebViewReady(false);
    setInitialProgressLoaded(false); // Reset this so it reloads for the new chapter
    setInitialScrollAttempted(false); // Reset scroll attempt status
    lastSavedProgressRef.current = 0;

    if (progressSaveTimeoutRef.current) {
      clearTimeout(progressSaveTimeoutRef.current);
    }
  }, [currentChapterIndex, workId, chapterID]);

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: barsVisible ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [barsVisible, fadeAnim]);

  const onSliderValueChange = useCallback(
    (value) => {
      setScrollProgress(value);
      sendWebViewCommand('scrollToProgress', { progress: value });
    },
    [sendWebViewCommand],
  );

  const onSliderSlidingComplete = useCallback(
    async (value) => {
      onProgressUpdate?.(value);
      if (!isIncognitoMode) {
        if (progressSaveTimeoutRef.current) clearTimeout(progressSaveTimeoutRef.current);
        // Save immediately on slider complete
        progressDAO.set(workId, chapterID, value);
        lastSavedProgressRef.current = value; // Update last saved reference
      }
    },
    [onProgressUpdate, isIncognitoMode, workId, chapterID, progressDAO]
  );

  const toggleBars = useCallback(() => {
    setBarsVisible(!barsVisible);
  }, [barsVisible]);

  // Handle messages coming from the WebView
  const handleMessage = useCallback(
    (event) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);

        switch (data.type) {
          case 'webview-ready':
            console.log("WebView reported ready.");
            setWebViewReady(true);
            break;
          case 'co3_segments': {
            // 段落提取回传（本页翻译第一步）：
            // items = 段落文本，idxs = 各自在 DOM 里的真实序号（已跳过空段）
            if (pendingSegsRef.current) {
              pendingSegsRef.current({
                items: Array.isArray(data.items) ? data.items : [],
                idxs: Array.isArray(data.idxs) ? data.idxs : [],
              });
            }
            break;
          }
          case 'scroll': {
            const { progress } = data;
            setScrollProgress(progress);
            onProgressUpdate?.(progress);

            // Debounce saving progress
            if (!isIncognitoMode) {
              if (progressSaveTimeoutRef.current) {
                clearTimeout(progressSaveTimeoutRef.current);
              }
              progressSaveTimeoutRef.current = setTimeout(() => {
                // Only save if progress has actually changed significantly
                if (Math.abs(progress - lastSavedProgressRef.current) > 0.01) { // 1% change threshold
                  progressDAO.set(workId, chapterID, progress);
                  lastSavedProgressRef.current = progress;
                  console.log(`Progress saved: ${Math.round(progress * 100)}%`);
                }
              }, PROGRESS_SAVE_DEBOUNCE);
            }
            break;
          }
          case 'tap': {
            toggleBars();
            break;
          }
          case 'pull': {
            if (hasNextChapter) {
              setPullDistance(data.distance);
            }
            break;
          }
          case 'pullEnd': {
            if (hasNextChapter && data.distance > PULL_THRESHOLD) {
              onNextChapter?.();
            }
            setPullDistance(0);
            break;
          }
          case 'log': {
            console.log('WebView Log:', data.message);
            break;
          }
          default:
            console.log('RN: Unknown message type from WebView:', data.type);
        }
      } catch (error) {
        console.error('RN: Error handling message from WebView:', error);
      }
    },
    [
      onProgressUpdate,
      toggleBars,
      hasNextChapter,
      onNextChapter,
      isIncognitoMode,
      workId,
      chapterID,
      progressDAO,
    ]
  );

  const handleForwardButton = useCallback(async () => {
    if (hasNextChapter) {
      if (progressSaveTimeoutRef.current) clearTimeout(progressSaveTimeoutRef.current);
      if (!isIncognitoMode && scrollProgress > 0) {
        progressDAO.set(workId, chapterID, scrollProgress);
        lastSavedProgressRef.current = scrollProgress;
      }
      onNextChapter?.();
    }
  }, [hasNextChapter, onNextChapter, isIncognitoMode, scrollProgress, workId, chapterID, progressDAO]);

  const handleBackButton = useCallback(async () => {
    if (hasPreviousChapter) {
      if (progressSaveTimeoutRef.current) clearTimeout(progressSaveTimeoutRef.current);
      if (!isIncognitoMode && scrollProgress > 0) {
        progressDAO.set(workId, chapterID, scrollProgress);
        lastSavedProgressRef.current = scrollProgress;
      }
      onPreviousChapter?.();
    }
  }, [hasPreviousChapter, onPreviousChapter, isIncognitoMode, scrollProgress, workId, chapterID, progressDAO]);

  const injectedJavaScript = `
    //Initial scroll. That's not perfect since some CSS element / image might have not loaded yet and you then lose like 5% every times
    //Works fine on only text tho
    const ch = document.body.scrollHeight;
    const sh = window.innerHeight;
    const ms = Math.max(0, ch - sh);
    document.documentElement.scrollTop = ${scrollProgress} * ms;

    // Function to send logs from WebView to React Native
    function webViewLog(message) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'log', message: message }));
      }
    }
    
    // Define a global function that React Native can call
    window.onMessageFromReactNative = (message) => {
      webViewLog('WebView: Received message from RN: ' + JSON.stringify(message));
      switch (message.action) {
        case 'scrollTo':
          // Scroll to a specific position (e.g., 0 for top)
          window.scrollTo(0, message.payload.position);
          webViewLog('WebView: Scrolled to position ' + message.payload.position);
          break;
        case 'scrollToProgress':
          // Scroll based on a progress value (0 to 1)
          const contentHeight = document.body.scrollHeight;
          const scrollViewHeight = window.innerHeight;
          const maxScroll = Math.max(0, contentHeight - scrollViewHeight);
          document.documentElement.scrollTop = message.payload.progress * maxScroll;
          webViewLog('WebView: Scrolled to progress ' + message.payload.progress);
          break;
        // Add more cases for other commands as needed
        default:
          webViewLog('WebView: Unknown command from RN: ' + message.action);
      }
    };

    // Set viewport meta tag for responsiveness
    const meta = document.createElement('meta');
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no');
    meta.setAttribute('name', 'viewport');
    document.getElementsByTagName('head')[0].appendChild(meta);

    // Apply theme styles
    document.body.style.backgroundColor = '${currentTheme.backgroundColor}';
    document.body.style.color = '${currentTheme.textColor}';
    document.body.style.padding = '20px';
    document.body.style.paddingBottom = '120px';
    ${ jsonSettings && !jsonSettings.allowSelectingText &&
    "document.body.style.webkitUserSelect = 'none'; document.body.style.userSelect = 'none'"
    }
    document.body.style.webkitTapHighlightColor = 'transparent';
    document.querySelectorAll('a').forEach(a => a.style.color = '${currentTheme.primaryColor}');

    // Handle scroll events and send progress to RN
    let scrollTimeout;
    function handleScroll() {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const contentHeight = document.body.scrollHeight;
        const scrollViewHeight = window.innerHeight;
        const scrollY = window.scrollY;
        const maxScroll = contentHeight - scrollViewHeight;
        const progress = maxScroll > 0 ? Math.min(scrollY / maxScroll, 1) : 0;
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'scroll', progress }));
        }
      }, 50);
    }
    window.addEventListener('scroll', handleScroll, { passive: true });

    // Handle tap events and send to RN
    document.addEventListener('click', (e) => {
      if (e.target.closest('summary')) return;
      if (!['A', 'BUTTON', 'INPUT'].includes(e.target.tagName)) {
        e.preventDefault();
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'tap' }));
        }
      }
    });

    // Handle pull-to-refresh/next-chapter gesture
    const PULL_THRESHOLD = ${PULL_THRESHOLD};
    let touchStartY = 0;
    let isPulling = false;
    let currentPullDistance = 0;

    document.addEventListener('touchstart', (e) => {
      touchStartY = e.touches[0].clientY;
      isPulling = false;
      document.body.style.transition = 'none';
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      const isAtBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 5;
      if (!isAtBottom) return;

      const touchCurrentY = e.touches[0].clientY;
      const deltaY = touchStartY - touchCurrentY;

      if (deltaY > 0) {
        e.preventDefault();
        isPulling = true;
        currentPullDistance = deltaY;
        const elasticDistance = currentPullDistance * 0.4;
        document.body.style.transform = \`translateY(-\${elasticDistance}px)\`;
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'pull', distance: currentPullDistance }));
        }
      }
    }, { passive: false });

    document.addEventListener('touchend', (e) => {
      if (isPulling) {
        document.body.style.transition = 'transform 0.25s ease-out';
        document.body.style.transform = 'translateY(0px)';
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'pullEnd', distance: currentPullDistance }));
        }
      }
      isPulling = false;
      currentPullDistance = 0;
    });

    // Indicate that initial JavaScript has been injected and WebView is ready for commands
    webViewLog('WebView: Injected JavaScript loaded and ready.');
    true;
  `;

  const renderTopBar = () => (
    <Animated.View
      style={[
        styles.topBar,
        {
          backgroundColor: `${currentTheme.backgroundColor}E6`,
          opacity: fadeAnim,
        },
      ]}
      pointerEvents={barsVisible ? 'auto' : 'none'}
    >
      <View style={styles.titleContainer}>
        <Text
          style={[styles.workTitle, { color: currentTheme.textColor }]}
          numberOfLines={1}
        >
          {workTitle}
        </Text>
        <Text
          style={[
            styles.chapterTitle,
            { color: currentTheme.secondaryTextColor },
          ]}
          numberOfLines={1}
        >
          {chapterTitle}
        </Text>
        {isIncognitoMode && (
          <Text
            style={[
              styles.incognitoIndicator,
              { color: currentTheme.primaryColor },
            ]}
          >
            {t('reader_incognito_mode')}
          </Text>
        )}
      </View>
    </Animated.View>
  );

  const renderBottomBar = () => (
    <Animated.View
      style={[styles.bottomBar, { opacity: fadeAnim }]}
      pointerEvents={barsVisible ? 'auto' : 'none'}
    >
      {hasPreviousChapter && (
        <TouchableOpacity
          style={[
            styles.navButton,
            { backgroundColor: currentTheme.cardBackground },
          ]}
          onPress={handleBackButton}
        >
          <Icon name="chevron-left" size={24} color={currentTheme.iconColor} />
        </TouchableOpacity>
      )}

      <View
        style={[
          styles.progressContainer,
          {
            backgroundColor: currentTheme.cardBackground,
            marginLeft: hasPreviousChapter ? 15 : 0,
            marginRight: hasNextChapter ? 15 : 0,
          },
        ]}
      >
        <View style={styles.progressInfo}>
          <Text style={[styles.progressText, { color: currentTheme.textColor }]}>
            {Math.round(scrollProgress * 100)}%
          </Text>
          <Text
            style={[
              styles.chapterInfo,
              { color: currentTheme.secondaryTextColor },
            ]}
          >
            {currentChapterIndex + 1} / {totalChapters}
          </Text>
        </View>
        <Slider
          style={styles.slider}
          minimumValue={0}
          maximumValue={1}
          value={scrollProgress}
          onValueChange={onSliderValueChange}
          onSlidingComplete={onSliderSlidingComplete}
          minimumTrackTintColor={currentTheme.primaryColor}
          maximumTrackTintColor={currentTheme.inputBackground}
          thumbTintColor={currentTheme.primaryColor}
        />
      </View>

      {hasNextChapter && (
        <TouchableOpacity
          style={[
            styles.navButton,
            { backgroundColor: currentTheme.cardBackground },
          ]}
          onPress={handleForwardButton}
        >
          <Icon name="chevron-right" size={24} color={currentTheme.iconColor} />
        </TouchableOpacity>
      )}

      {/* 本页翻译：点击后才开始翻，原文保留、译文逐段追加在下方 */}
      <TouchableOpacity
        style={[
          styles.navButton,
          {
            backgroundColor: currentTheme.cardBackground,
            marginLeft: 8,
            opacity: translating ? 0.5 : 1,
          },
        ]}
        onPress={handleTranslate}
        disabled={translating}
      >
        <Icon
          name="translate"
          size={22}
          color={translated ? currentTheme.primaryColor : currentTheme.iconColor}
        />
      </TouchableOpacity>
    </Animated.View>
  );

  const renderCommentsButton = () => (
    <Animated.View style={{opacity: fadeAnim}} pointerEvents={barsVisible ? 'auto' : 'none'}>
      <TouchableOpacity
        style={[
          styles.floatingButton,
          { backgroundColor: currentTheme.cardBackground },
        ]}
        onPress={() => setCommentsVisible(true)}
      >
        <Icon name="comment" size={30} color={currentTheme.iconColor} />
      </TouchableOpacity>
    </Animated.View>
  );

  const renderPullIndicator = () => {
    if (!hasNextChapter || pullDistance <= 0) return null;

    const progress = Math.min(pullDistance / PULL_THRESHOLD, 1);
    const opacity = Math.min(1, pullDistance / (PULL_THRESHOLD * 0.5));

    return (
      <View style={[styles.pullContainer, { opacity }]} pointerEvents="none">
        <PullIndicator progress={progress} theme={currentTheme} />
        <Text style={[styles.pullText, { color: currentTheme.textColor }]}>
          {progress < 1
            ? t('reader_pull_up_next')
            : t('reader_release_next')}
        </Text>
      </View>
    );
  };

  return (
    <GestureHandlerRootView style={styles.root}>
      <View
        style={[
          styles.container,
          { backgroundColor: currentTheme.backgroundColor },
        ]}
      >
        <StatusBar
          barStyle={currentTheme.name === 'light' ? 'dark-content' : 'light-content'}
          backgroundColor={currentTheme.backgroundColor}
        />

        <WebView
          ref={webViewRef}
          originWhitelist={['*']}
          allowFileAccess={true}
          source={{
            // 防御：只把字符串交给 WebView。历史上曾因上层传对象进来
            // 触发 "Value for html cannot be cast from ReadableNativeMap to String"。
            html:
              typeof modifiedHtmlContent === 'string' && modifiedHtmlContent
                ? modifiedHtmlContent
                : (modifiedHtmlContent && typeof modifiedHtmlContent.html === 'string'
                    ? modifiedHtmlContent.html
                    : `<p>${t('reader_error_fallback')}</p>`),
          }}
          style={styles.webView}
          injectedJavaScript={injectedJavaScript}
          onMessage={handleMessage}
          showsVerticalScrollIndicator={false}
          bounces={false}
          overScrollMode="never"
          onOpenWindow={ (syntheticEvent) => {
            const { nativeEvent } = syntheticEvent;
            const { targetUrl } = nativeEvent
            InAppBrowser.open(targetUrl, {
              // Android
              showTitle: true,
              toolbarColor: currentTheme.backgroundColor,
              enableUrlBarHiding: true,
              enableDefaultShare: true,
              forceCloseOnRedirection: false,
              // iOS
              dismissButtonStyle: 'close',
              preferredBarTintColor: currentTheme.backgroundColor,
              preferredControlTintColor: 'white',
            });
          }}
          onShouldStartLoadWithRequest={(req) => {
            const url = req.url ?? '';
            if (url === 'about:blank' || url.startsWith('about:blank#')) return true;
            if (url.startsWith('http://') || url.startsWith('https://')) {
              InAppBrowser.open(url, {
                // Android
                showTitle: true,
                toolbarColor: currentTheme.backgroundColor,
                enableUrlBarHiding: true,
                enableDefaultShare: true,
                forceCloseOnRedirection: false,
                // iOS
                dismissButtonStyle: 'close',
                preferredBarTintColor: currentTheme.backgroundColor,
                preferredControlTintColor: 'white',
              }).catch((e) => {
                Toast.show({
                  type: "error",
                  text1: t('reader_error_opening_link'),
                  text2: e.message
                });
              });
            }
            return false;
          }}
        />
        {renderPullIndicator()}
        {renderTopBar()}
        {renderBottomBar()}
        {renderCommentsButton()}

        <Modal
          transparent={false}
          visible={commentsVisible}
          onRequestClose={() => setCommentsVisible(false)}
        >
          <CommentsScreen
            setCommentsVisible={setCommentsVisible} currentTheme={currentTheme} singleChapter={totalChapters<2}
            workOrChapterId={chapterID || workId} chapterDAO={chapterDAO} historyDAO={historyDAO} kudoHistoryDAO={kudoHistoryDAO}
            libraryDAO={libraryDAO} progressDAO={progressDAO} setScreens={setScreens} settingsDAO={settingsDAO} workDAO={workDAO}
          />
        </Modal>
      </View>
    </GestureHandlerRootView>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  webView: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: Platform.OS === 'ios' ? 50 : 20,
    paddingBottom: 10,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  titleContainer: {
    alignItems: 'center',
  },
  workTitle: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  chapterTitle: {
    fontSize: 14,
    marginTop: 2,
  },
  incognitoIndicator: {
    fontSize: 12,
    marginTop: 4,
    fontWeight: '500',
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: Platform.OS === 'ios' ? 30 : 20,
    paddingTop: 15,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0)',
  },
  navButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 3,
  },
  floatingButton: {
    position: 'absolute',
    width: 50,
    height: 50,
    bottom: 90,
    right: 20,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 3,
  },
  progressContainer: {
    flex: 1,
    height: 60,
    borderRadius: 30,
    paddingHorizontal: 20,
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 3,
  },
  progressInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  progressText: {
    fontSize: 14,
    fontWeight: '600',
  },
  chapterInfo: {
    fontSize: 12,
  },
  slider: {
    width: '100%',
    height: 20,
  },
  pullContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 120,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pullIndicatorContainer: {
    width: 60,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pullIndicatorIcon: {
    position: 'absolute',
  },
  pullText: {
    marginTop: 8,
    fontSize: 14,
    fontWeight: '500',
  },
});

export default ChapterReader;
