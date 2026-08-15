import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Linking,
  Modal,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { debugLog } from '../utils/debugLog';
import Icon from 'react-native-vector-icons/MaterialIcons';
import Svg, { Circle } from 'react-native-svg';
import Slider from '@react-native-community/slider';
import { CommentsScreen } from '../components/Reader/commentsScreen';
import { getJsonSettings } from '../storage/jsonSettings';
import Toast from 'react-native-toast-message';
import { useTranslation } from 'react-i18next';
import { translateHtmlCached } from '../web/translate';
import { userErrorMessage } from '../utils/userError';
import TranslateMenu from '../components/common/TranslateMenu';

const PULL_THRESHOLD = 150;
const PROGRESS_SAVE_DEBOUNCE = 1000;

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
  // topBar 是 position:absolute 不在 SafeAreaView 内，硬编码 paddingTop
  // 在灵动岛机型（iPhone 14 Pro+ 状态栏 ~59px）会被遮挡，改用真实 insets。
  const insets = useSafeAreaInsets();

  const [barsVisible, setBarsVisible] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [webViewReady, setWebViewReady] = useState(false);

  useEffect(() => {
    const html = htmlContent || '';
    const imageCount = (html.match(/<img\b/gi) || []).length;
    const proxiedImageCount = (html.match(/https:\/\/i2\.wp\.com\//gi) || []).length;
    debugLog(
      'reader',
      `Opening chapter=${chapterID || workId}; images=${imageCount}; proxiedImages=${proxiedImageCount}`,
    );
  }, [chapterID, htmlContent, workId]);
  const [isIncognitoMode, setIsIncognitoMode] = useState(false);
  const [commentsVisible, setCommentsVisible] = useState(false);
  const [initialProgressLoaded, setInitialProgressLoaded] = useState(false);
  const [initialScrollAttempted, setInitialScrollAttempted] = useState(false);
  const [size, setSize] = useState(1);
  const [jsonSettings, setJsonSettings] = useState();

  // Translation state: translatedHtml holds the rendered translation, and
  // transMode selects original → translated → bilingual (via TranslateMenu).
  const [translatedHtml, setTranslatedHtml] = useState(null);
  const [transMode, setTransMode] = useState('original'); // 'original' | 'translated' | 'bilingual'
  const [translating, setTranslating] = useState(false);
  const [trProgress, setTrProgress] = useState(null); // {done, total} 翻译进度
  const [menuVisible, setMenuVisible] = useState(false);

  // Reset when the chapter changes.
  useEffect(() => {
    setTranslatedHtml(null);
    setTransMode('original');
  }, [chapterID, htmlContent]);

  const translateChapter = async (mode) => {
    if (translating) return;
    if (mode === 'original') {
      setTransMode('original');
      return;
    }
    setTranslating(true);
    setTrProgress(null);
    try {
      // 2026-08-15 RN 层翻译（用户要求：不用 WebView 内 fetch）：
      // translateHtmlCached 每批完成回调 onProgress → 显示"翻译中 x/y"
      // 进度（不干等）；完成后 WebView 显示 + 打字机逐字跳出。
      const bilingual = mode === 'bilingual';
      const out = await translateHtmlCached(
        `ch_${chapterID || workId}`,
        htmlContent,
        undefined,
        (done, total) => setTrProgress({ done, total }),
        bilingual,
        // 2026-08-15 增量显示：每批完成把部分翻译的 HTML 更新进 WebView
        (partial) => setTranslatedHtml(bilingual ? partial.bilingual : partial.single),
      );
      setTranslatedHtml(out);
      setTransMode(mode);
    } catch (e) {
      Toast.show({
        type: 'error',
        text1: t('translate_failed'),
        text2: e?.message ?? String(e),
      });
    } finally {
      setTranslating(false);
      setTrProgress(null);
    }
  };

  const handleTranslate = () => {
    if (translating) return;
    setMenuVisible(true);
  };

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const webViewRef = useRef(null);
  const progressSaveTimeoutRef = useRef(null);
  const lastSavedProgressRef = useRef(0);

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
            debugLog('reader', data.message);
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
    // Bilingual translation styles: translation on top, muted original below.
    const biStyle = document.createElement('style');
    biStyle.textContent = '.co3-tr{display:block;margin-bottom:0.15em;}' +
      '.co3-orig{display:block;color:${currentTheme.secondaryTextColor};' +
      'font-size:0.82em;line-height:1.45;margin-bottom:0.9em;opacity:0.75;}';
    document.head.appendChild(biStyle);
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

    // 打字机效果（2026-08-15 用户要求）：翻译模式（含 .co3-tr）时
    // 逐字跳出现译文，不干等。速度按总字数自适应，总时长 ~8s。
    (function(){
      if (window.__co3Typewriter) return;
      window.__co3Typewriter = true;
      if (!document.querySelector('.co3-tr')) return; // 非翻译模式跳过
      var nodes = [];
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function(n){
          var p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      while (walker.nextNode()) {
        var n = walker.currentNode;
        if (n.nodeValue && n.nodeValue.trim()) { n.__full = n.nodeValue; n.nodeValue = ''; nodes.push(n); }
      }
      if (!nodes.length) return;
      var total = 0;
      nodes.forEach(function(n){ total += n.__full.length; });
      var SPEED = Math.max(2, Math.ceil(total / 250)); // 总时长 ~7-8s
      var nodeIdx = 0, charIdx = 0;
      var timer = setInterval(function(){
        if (nodeIdx >= nodes.length) { clearInterval(timer); return; }
        var n = nodes[nodeIdx];
        charIdx = Math.min(charIdx + SPEED, n.__full.length);
        n.nodeValue = n.__full.slice(0, charIdx);
        if (charIdx >= n.__full.length) { nodeIdx++; charIdx = 0; }
      }, 30);
    })();

    // Indicate that initial JavaScript has been injected and WebView is ready for commands
    webViewLog('WebView: Injected JavaScript loaded and ready.');
    setTimeout(() => webViewLog('WebView: document images=' + document.images.length), 0);
    true;
  `;


  const renderTopBar = () => (
    <Animated.View
      style={[
        styles.topBar,
        {
          backgroundColor: `${currentTheme.backgroundColor}E6`,
          opacity: fadeAnim,
          paddingTop: Math.max(insets.top, 20),
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

      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {translating && trProgress && (
          <Text
            style={{
              color: currentTheme.primaryColor,
              fontSize: 12,
              fontWeight: '600',
              marginRight: 6,
            }}
          >
            {`${trProgress.done}/${trProgress.total}`}
          </Text>
        )}
        <TouchableOpacity
          style={[
            styles.translateButton,
            { backgroundColor: currentTheme.cardBackground },
          ]}
          onPress={handleTranslate}
          disabled={translating}
        >
          <Icon
            name={translating ? 'hourglass-empty' : 'translate'}
            size={22}
            color={
              transMode !== 'original'
                ? currentTheme.primaryColor
                : currentTheme.iconColor
            }
          />
        </TouchableOpacity>
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
            html:
              (transMode !== 'original' && translatedHtml ? translatedHtml : htmlContent) ||
              `<p>${t('reader_error_fallback')}</p>`,
          }}
          style={styles.webView}
          injectedJavaScript={injectedJavaScript}
          onMessage={handleMessage}
          onLoadStart={(event) => debugLog('reader', `WebView load start: ${event.nativeEvent.url || '(inline HTML)'}`)}
          onLoadEnd={(event) => debugLog('reader', `WebView load end: ${event.nativeEvent.url || '(inline HTML)'}`)}
          onError={(event) => debugLog('reader', `WebView error: ${event.nativeEvent.code} ${event.nativeEvent.description}`)}
          onHttpError={(event) => debugLog('reader', `WebView HTTP error: ${event.nativeEvent.statusCode} ${event.nativeEvent.description}`)}
          showsVerticalScrollIndicator={false}
          bounces={false}
          overScrollMode="never"
          onOpenWindow={ (syntheticEvent) => {
            const { nativeEvent } = syntheticEvent;
            const { targetUrl } = nativeEvent
            Linking.openURL(targetUrl);
          }}
          onShouldStartLoadWithRequest={(req) => {
            const url = req.url ?? '';
            if (url === 'about:blank' || url.startsWith('about:blank#')) return true;
            if (url.startsWith('http://') || url.startsWith('https://')) {
              Linking.openURL(url).catch((e) => {
                Toast.show({
                  type: "error",
                  text1: t('reader_error_opening_link'),
                  text2: userErrorMessage(e, t),
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

        <TranslateMenu
          visible={menuVisible}
          onClose={() => setMenuVisible(false)}
          theme={currentTheme}
          currentMode={transMode}
          onSelect={translateChapter}
          t={t}
        />
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
    flexDirection: 'row',
    alignItems: 'center',
  },
  titleContainer: {
    flex: 1,
    alignItems: 'center',
  },
  translateButton: {
    marginLeft: 10,
    padding: 8,
    borderRadius: 20,
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
