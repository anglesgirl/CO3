import React, { Component, useMemo } from 'react';
import { Text, useWindowDimensions } from 'react-native';
import RenderHtml from 'react-native-render-html';

// react-native-render-html 在 iOS 新架构(Fabric)下渲染部分 HTML 会抛原生
// 异常导致整个 App 闪退（评论点击/展开时最常见）。错误边界捕获后降级为
// 纯文本，宁可样式丢失也不让 App 崩。
class HtmlErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.warn('[HtmlTextRenderer] render-html crashed, falling back to text:', error?.message ?? error);
  }

  render() {
    if (this.state.failed) {
      // 剥离标签的纯文本兜底（不翻译不渲染 HTML，只保证内容可见）。
      const plain = String(this.props.html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      return (
        <Text style={this.props.fallbackStyle || { color: this.props.currentTheme?.textColor, fontSize: 14 }}>
          {plain || ' '}
        </Text>
      );
    }
    return this.props.children;
  }
}

export default function HtmlTextRenderer({
  html,
  currentTheme,
  extraTagsStyles = {},
}) {
  const { width } = useWindowDimensions();

  const tagsStyles = useMemo(
    () => ({
      blockquote: {
        backgroundColor: currentTheme.inputBackground,
        padding: 12,
        borderLeftWidth: 4,
        borderLeftColor: currentTheme.primaryColor,
        marginVertical: 10,
        borderRadius: 4,
      },
      a: {
        color: currentTheme.primaryColor,
        textDecorationLine: 'underline',
      },
      h1: { color: currentTheme.textColor, fontSize: 20, marginBottom: 10 },
      h2: { color: currentTheme.textColor, fontSize: 18, marginBottom: 8 },
      h3: { color: currentTheme.textColor, fontSize: 16, marginBottom: 6 },
      p: {
        color: currentTheme.textColor,
        marginBottom: 10,
        lineHeight: 22,
      },
      li: {
        color: currentTheme.textColor,
      },
      ...extraTagsStyles,
    }),
    [currentTheme, extraTagsStyles],
  );

  if (!html) return null;

  return (
    <HtmlErrorBoundary html={html} currentTheme={currentTheme}>
      <RenderHtml
        contentWidth={width - 40}
        source={{ html: typeof html === 'string' ? html : html.toString() }}
        baseStyle={{
          color: currentTheme.textColor,
          fontSize: 16,
        }}
        tagsStyles={tagsStyles}
      />
    </HtmlErrorBoundary>
  );
}
