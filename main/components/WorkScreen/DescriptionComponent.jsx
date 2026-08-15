import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import HtmlTextRenderer from '../common/HtmlTextRenderer';
import { LinearGradient } from 'react-native-linear-gradient';
import Icon from 'react-native-vector-icons/MaterialIcons';
import Toast from 'react-native-toast-message';
import { useTranslation } from 'react-i18next';
import { translateHtmlCached, translateText } from '../../web/translate';
import TranslateMenu from '../common/TranslateMenu';

const COLLAPSED_HEIGHT = 90;

export const WorkDescription = React.memo(({ work, currentTheme, jsonSettings }) => {
  const { t } = useTranslation();
  const HTML_TAG_STYLES = {
    p: {
      fontSize: 14,
      paddingBottom: 12,
    },
    span: {
      fontSize: 14,
      paddingBottom: 12,
    },
    a: {
      fontSize: 14,
      paddingBottom: 12,
      color: currentTheme.primaryColor,
      textDecorationLine: 'underline'
    },
  };

  const [isExpanded, setIsExpanded] = useState(false);
  const [fullHeight, setFullHeight] = useState(0);
  // 打字机：翻译结果逐字跳出（2026-08-15 用户要求）
  const [typedLen, setTypedLen] = useState(0);

  // Translation of the summary (on demand, cached per work).
  // mode: 'original' | 'translated' | 'bilingual'
  const [translated, setTranslated] = useState(null); // { html, text }
  const [transMode, setTransMode] = useState('original');
  const [translating, setTranslating] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);

  const onTranslate = useCallback(async (mode) => {
    if (translating) return;
    if (mode === 'original') {
      setTransMode('original');
      return;
    }
    setTranslating(true);
    try {
      const key = `desc_${work?.id ?? work?.workId ?? work?.title ?? ''}`;
      const [html, text] = await Promise.all([
        work.descriptionHTML
          ? translateHtmlCached(key + '_h', work.descriptionHTML)
          : Promise.resolve(null),
        work.description ? translateText(work.description) : Promise.resolve(null),
      ]);
      setTranslated({ html, text });
      setTransMode(mode);
    } catch (e) {
      Toast.show({
        type: 'error',
        text1: t('translate_failed'),
        text2: e?.message ?? String(e),
      });
    } finally {
      setTranslating(false);
    }
  }, [translating, work, t]);

  const openTranslateMenu = useCallback(() => {
    if (translating) return;
    setMenuVisible(true);
  }, [translating]);

  // 打字机动画：非 preferHtml（纯文本显示）且已翻译时逐字跳出。
  const isTranslatedMode = transMode !== 'original' && translated;
  const isTextMode = !jsonSettings?.preferHtml;
  useEffect(() => {
    if (!isTranslatedMode || !isTextMode) {
      setTypedLen(0);
      return;
    }
    const total = (translated?.text || '').length;
    if (total === 0) return;
    setTypedLen(0);
    const timer = setInterval(() => {
      setTypedLen(n => {
        if (n >= total) { clearInterval(timer); return n; }
        return n + 4; // 每 30ms 4 字 ≈ 130 字/s
      });
    }, 30);
    return () => clearInterval(timer);
  }, [isTranslatedMode, isTextMode, translated, transMode]);

  const animatedHeight = useSharedValue(COLLAPSED_HEIGHT);

  const toggleDescription = useCallback(() => {
    const targetState = !isExpanded;
    const targetHeight = targetState ? (fullHeight || COLLAPSED_HEIGHT) : COLLAPSED_HEIGHT;

    animatedHeight.value = withTiming(targetHeight, { duration: 200 }, (finished) => {
      if (finished) {
        runOnJS(setIsExpanded)(targetState);
      }
    });

    setIsExpanded(targetState);
  }, [isExpanded, fullHeight, animatedHeight]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: animatedHeight.value,
    overflow: 'hidden',
  }));

  const gradientStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      animatedHeight.value,
      [COLLAPSED_HEIGHT, COLLAPSED_HEIGHT + 30],
      [1, 0],
      Extrapolation.CLAMP
    );
    return {
      opacity,
      zIndex: opacity === 0 ? -1 : 2
    };
  });

  if (!work?.description) return null;

  // 双语模式:译文块在上,原文块(浅色小字)在下。
  const isBilingual = transMode === 'bilingual';
  const isTranslated = transMode !== 'original' && translated;
  const shownHtml = isTranslated ? translated.html : work.descriptionHTML;
  const shownText = isTranslated ? translated.text : work.description;

  const renderedContent = useMemo(() => {
    const main = jsonSettings?.preferHtml ? (
      <HtmlTextRenderer
        currentTheme={currentTheme}
        html={shownHtml}
        extraTagsStyles={HTML_TAG_STYLES}
      />
    ) : (
      <Text style={[styles.description, { color: currentTheme.textColor }]}>
        {/* 翻译模式打字机：逐字显示译文；原文模式全量显示 */}
        {isTranslatedMode && typedLen > 0 && typedLen < (shownText || '').length
          ? shownText.slice(0, typedLen)
          : shownText}
      </Text>
    );

    if (!isBilingual) return <View style={styles.contentPadding}>{main}</View>;

    // 双语:译文 + 原文(浅色小字)两段叠放。
    const originalBlock = jsonSettings?.preferHtml ? (
      <HtmlTextRenderer
        currentTheme={currentTheme}
        html={work.descriptionHTML}
        extraTagsStyles={{
          ...HTML_TAG_STYLES,
          p: { ...HTML_TAG_STYLES.p, color: currentTheme.secondaryTextColor },
        }}
      />
    ) : (
      <Text
        style={[
          styles.description,
          styles.originalBlock,
          { color: currentTheme.secondaryTextColor },
        ]}
      >
        {work.description}
      </Text>
    );

    return (
      <View style={styles.contentPadding}>
        {main}
        {originalBlock}
      </View>
    );
  }, [shownHtml, shownText, isBilingual, isTranslatedMode, typedLen, work, currentTheme, jsonSettings?.preferHtml]);

  const isActuallyTall = fullHeight > COLLAPSED_HEIGHT;

  return (
    <View style={styles.descriptionContainer}>
      <View
        style={styles.hiddenMeasurer}
        pointerEvents="none"
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          if (h > 0 && Math.abs(h - fullHeight) > 1) {
            setFullHeight(h);
            if (isExpanded) animatedHeight.value = h;
          }
        }}
      >
        {renderedContent}
      </View>

      <Animated.View style={[styles.descriptionWrapper, animatedStyle]}>
        {renderedContent}

        {isActuallyTall && (
          <Animated.View
            style={[styles.descriptionGradient, gradientStyle]}
            pointerEvents="none"
          >
            <LinearGradient
              colors={[`${currentTheme.backgroundColor}00`, currentTheme.backgroundColor]}
              style={{ flex: 1 }}
            />
          </Animated.View>
        )}
      </Animated.View>

      <View style={styles.actionRow}>
        <TouchableOpacity
          style={styles.translateButton}
          onPress={openTranslateMenu}
          disabled={translating}
        >
          <Icon
            name={translating ? 'hourglass-empty' : 'translate'}
            size={20}
            color={transMode !== 'original' ? currentTheme.primaryColor : currentTheme.iconColor}
          />
          <Text style={{ color: currentTheme.iconColor, fontSize: 12, marginLeft: 4 }}>
            {translating
              ? t('translate_translating')
              : transMode !== 'original'
                ? t('translate_show_original')
                : t('translate_button')}
          </Text>
        </TouchableOpacity>

        {isActuallyTall && (
          <TouchableOpacity style={styles.expandButton} onPress={toggleDescription}>
            <Icon
              name={isExpanded ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
              size={32}
              color={currentTheme.primaryColor}
            />
          </TouchableOpacity>
        )}
      </View>

      <TranslateMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        theme={currentTheme}
        currentMode={transMode}
        onSelect={onTranslate}
        t={t}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  descriptionContainer: {
    marginTop: 10,
    paddingHorizontal: 16,
    position: 'relative',
  },
  hiddenMeasurer: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    opacity: 0,
    zIndex: -10,
  },
  descriptionWrapper: {
    width: '100%',
    overflow: 'hidden',
    position: 'relative',
  },
  contentPadding: {
    paddingBottom: 10,
  },
  description: {
    fontSize: 14,
    lineHeight: 20,
  },
  originalBlock: {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 17,
    opacity: 0.8,
  },
  descriptionGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 60,
    zIndex: 2,
  },
  expandButton: {
    alignSelf: 'center',
    paddingVertical: 4,
    flex: 1,
    alignItems: 'center',
    zIndex: 10,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 10,
  },
  translateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
});