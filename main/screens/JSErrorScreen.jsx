import React, { useContext } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Button,
  TouchableOpacity,
  Linking,
  BackHandler,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { AppContext, navigationRef } from '../app';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { links } from '../constant';

function ErrButton({ currentTheme, onClick, title }) {
  return (
    <TouchableOpacity activeOpacity={0.5} onPress={onClick} style={{ flex: 1 }}>
      <View
        style={[
          styles.errButton,
          {
            backgroundColor: currentTheme.backgroundColor,
            borderColor: currentTheme.borderColor,
          },
        ]}
      >
        <Text style={[styles.errButtonText, { color: currentTheme.textColor }]}>
          {title}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

class JSErrorScreenInner extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  render() {
    const { currentTheme, t } = this.props;

    console.log(this.state);

    if (this.state.hasError) {
      return (
        <SafeAreaView
          style={[
            styles.background,
            { backgroundColor: currentTheme.backgroundColor },
          ]}
        >
          <View
            style={[
              styles.header,
              { backgroundColor: currentTheme.warningBackground },
            ]}
          >
            <Text style={[styles.header1, { color: currentTheme.textColor }]}>
              {t('screen_js_error_h1')}
            </Text>
            <Text style={[styles.header2, { color: currentTheme.textColor }]}>
              {t('screen_js_error_h2')}
            </Text>
          </View>
          <View style={[styles.container]}>
            <View
              style={[
                styles.errorMsg,
                { backgroundColor: currentTheme.inputBackground },
              ]}
            >
              <Text style={{ color: currentTheme.textColor }}>
                {this.state.error?.message || t('screen_js_error_unknown')}
              </Text>
            </View>
            <ScrollView
              style={[
                styles.traceContainer,
                {
                  backgroundColor: currentTheme.inputBackground,
                  borderColor: currentTheme.borderColor,
                },
              ]}
            >
              <Text style={{ color: currentTheme.textColor }}>
                {this.state.error?.stack}
              </Text>
            </ScrollView>
            <View style={styles.errBtnRow}>
              <ErrButton
                currentTheme={currentTheme}
                title={t('screen_js_error_github')}
                onClick={() => {
                  Linking.openURL(links.githubUrl);
                }}
              />
              <ErrButton
                currentTheme={currentTheme}
                title={t('screen_js_error_discord')}
                onClick={() => {
                  Linking.openURL(links.discordUrl);
                }}
              />
              <ErrButton
                currentTheme={currentTheme}
                title={t('screen_js_error_copy')}
                onClick={() => {
                  Clipboard.setString(
                    this.state.error?.stack ||
                      this.state.error?.message ||
                      t('screen_js_error_unknown'),
                  );
                }}
              />
            </View>
            <View style={styles.errBtnRow}>
              <ErrButton
                currentTheme={currentTheme}
                title={t('screen_js_error_close')}
                onClick={() => {
                  BackHandler.exitApp();
                }}
              />
              <ErrButton
                currentTheme={currentTheme}
                title={t('screen_js_error_recover')}
                onClick={() => {
                  this.setState({ hasError: false, error: null }, () => {
                    if (
                      navigationRef?.isReady() &&
                      navigationRef?.canGoBack()
                    ) {
                      navigationRef.goBack();
                    }
                  });
                }}
              />
            </View>
          </View>
        </SafeAreaView>
      );
    }

    return this.props.children;
  }
}

export function JSErrorScreen({ children }) {
  const { currentTheme } = useContext(AppContext);
  const { t } = useTranslation();

  return (
    <JSErrorScreenInner currentTheme={currentTheme} t={t}>
      {children}
    </JSErrorScreenInner>
  );
}

const styles = StyleSheet.create({
  background: {
    alignItems: 'center',
    alignContent: 'center',
    flexDirection: 'column',
    flex: 1,
  },
  container: {
    padding: 16,
    gap: 10,
    flex: 1
  },
  header: {
    borderBottomRightRadius: 16,
    borderBottomLeftRadius: 16,
  },
  header1: {
    textAlign: 'center',
    fontSize: 40,
    paddingTop: 10,
  },
  header2: {
    textAlign: 'center',
    fontSize: 20,
    paddingTop: 10,
    paddingBottom: 10,
  },
  errorMsg: {
    borderRadius: 16,
    padding: 8,
  },
  traceContainer: {
    borderRadius: 16,
    padding: 8,
    borderWidth: 1,
    flex: 1
  },
  errBtnRow: {
    flex: 0,
    flexDirection: 'row',
    gap: 8,
  },
  errButton: {
    borderWidth: 1,
    borderRadius: 64,
    padding: 8,
  },
  errButtonText: {
    textAlign: 'center',
    fontSize: 16,
  }
});
