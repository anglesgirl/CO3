import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import HtmlTextRenderer from '../common/HtmlTextRenderer';
import { LinearGradient } from 'react-native-linear-gradient';
import Icon from 'react-native-vector-icons/MaterialIcons';
import Toast from 'react-native-toast-message';
import { useTranslation } from 'react-i18next';
import { translateHtmlCached, translateText } from '../../web/translate';

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

  // Translation of the summary (on demand, cached per work).
  const [translated, setTranslated] = useState(null); // { html, text }
  const [showTranslated, setShowTranslated] = useState(false);
  const [translating, setTranslating] = useState(false);

  const onTranslate = useCallback(async () => {
    if (translating) return;
    if (translated) {
      setShowTranslated(v => !v);
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
      setShowTranslated(true);
    } catch (e) {
      Toast.show({
        type: 'error',
        text1: t('translate_failed'),
        text2: e?.message ?? String(e),
      });
    } finally {
      setTranslating(false);
    }
  }, [translating, translated, work, t]);

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

  const shownHtml = showTranslated && translated?.html ? translated.html : work.descriptionHTML;
  const shownText = showTranslated && translated?.text ? translated.text : work.description;

  const renderedContent = useMemo(() => {
    return (
      <View style={styles.contentPadding}>
        {jsonSettings?.preferHtml ? (
          <HtmlTextRenderer
            currentTheme={currentTheme}
            html={shownHtml}
            extraTagsStyles={HTML_TAG_STYLES}
          />
        ) : (
          <Text style={[styles.description, { color: currentTheme.textColor }]}>
            {shownText}
          </Text>
        )}
      </View>
    );
  }, [shownHtml, shownText, currentTheme, jsonSettings?.preferHtml]);

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
          onPress={onTranslate}
          disabled={translating}
        >
          <Icon
            name={translating ? 'hourglass-empty' : 'translate'}
            size={20}
            color={showTranslated ? currentTheme.primaryColor : currentTheme.iconColor}
          />
          <Text style={{ color: currentTheme.iconColor, fontSize: 12, marginLeft: 4 }}>
            {translating
              ? t('translate_translating')
              : showTranslated
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