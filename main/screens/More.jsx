import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Animated,
  DeviceEventEmitter,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useNavigation, useFocusEffect } from '@react-navigation/native';

const MoreScreen = ({
  currentTheme,
  setScreens,
  screens,
  theme,
  setTheme,
  viewMode,
  setViewMode,
  isIncognitoMode,
  toggleIncognitoMode,
  settingsDAO,
  workDAO,
  libraryDAO,
  historyDAO,
  progressDAO,
  kudoHistoryDAO,
  databaseObj,
  chapterDAO,
  setJsonSettings,
  openTagSearch,
}) => {
  const navigation = useNavigation();

  const insets = useSafeAreaInsets();
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const { t } = useTranslation();

  // 顶部用户信息卡：登录状态（登录成功后刷新）
  const [userInfo, setUserInfo] = useState(null);
  const [checkingUser, setCheckingUser] = useState(false);

  const refreshUserInfo = useCallback(async () => {
    try {
      setCheckingUser(true);
      const { getUsername, getCredsToken } = require('../storage/Credentials');
      const { validateCookie } = require('../web/account/login');
      const u = await getUsername();
      const token = await getCredsToken();
      if (token) {
        const ok = await validateCookie(token).catch(() => false);
        setUserInfo(ok ? { username: u || 'AO3用户', logged: true } : { username: u || '', logged: false });
      } else {
        setUserInfo({ username: u || '', logged: false });
      }
    } catch (e) {
      setUserInfo(null);
    } finally {
      setCheckingUser(false);
    }
  }, []);

  useEffect(() => {
    // 登录成功事件 → 刷新顶部用户卡
    const sub = DeviceEventEmitter.addListener('LoginSuccess', () => {
      refreshUserInfo();
    });
    return () => sub.remove();
  }, [refreshUserInfo]);

  useFocusEffect(useCallback(() => { refreshUserInfo(); }, [refreshUserInfo]));

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener('doubleTap', id => {
      handlePress('Preferences');
    });

    return () => {
      subscription.remove();
    };
  }, []);

  const handlePress = screenName => {
    switch (screenName) {
      case 'Preferences':
        navigation.push('Preferences', {
          currentTheme: currentTheme,
          theme: theme,
          setTheme: setTheme,
          viewMode: viewMode,
          setViewMode: setViewMode,
          isIncognitoMode: isIncognitoMode,
          toggleIncognitoMode: toggleIncognitoMode,
          settingsDAO: settingsDAO,
          setScreens: setScreens,
          onRestartOnboarding: () => {
            setJsonSettings(prev => ({ ...prev, finishedOnboarding: false }));
          },
        });
        break;
      case 'Account':
        navigation.push('Account', {
          currentTheme: currentTheme,
          setScreens: setScreens,
        });
        break;
      case 'KudosHistory':
        navigation.push('KudosHistory', {
          currentTheme: currentTheme,
          workDAO: workDAO,
          libraryDAO: libraryDAO,
          setScreens: setScreens,
          historyDAO: historyDAO,
          settingsDAO: settingsDAO,
          progressDAO: progressDAO,
          kudoHistoryDAO: kudoHistoryDAO,
          chapterDAO: chapterDAO,
        });
        break;
      case 'Bookmarks':
        navigation.push('Bookmarks', {
          currentTheme: currentTheme,
          workDAO: workDAO,
          libraryDAO: libraryDAO,
          setScreens: setScreens,
          screens: screens,
          historyDAO: historyDAO,
          settingsDAO: settingsDAO,
          progressDAO: progressDAO,
          kudoHistoryDAO: kudoHistoryDAO,
          chapterDAO: chapterDAO,
        });
        break;
      case 'ReadLater':
        navigation.push('ReadLater', {
          currentTheme: currentTheme,
          workDAO: workDAO,
          libraryDAO: libraryDAO,
          setScreens: setScreens,
          screens: screens,
          historyDAO: historyDAO,
          settingsDAO: settingsDAO,
          progressDAO: progressDAO,
          kudoHistoryDAO: kudoHistoryDAO,
          chapterDAO: chapterDAO,
        });
        break;
      case 'Categories':
        navigation.push('Categories', {
          currentTheme: currentTheme,
          workDAO: workDAO,
          libraryDAO: libraryDAO,
          setScreens: setScreens,
          historyDAO: historyDAO,
          settingsDAO: settingsDAO,
          progressDAO: progressDAO,
          kudoHistoryDAO: kudoHistoryDAO,
        });
        break;
      case 'Statistics':
        navigation.push('Statistics', {
          currentTheme: currentTheme,
          workDAO: workDAO,
          libraryDAO: libraryDAO,
          setScreens: setScreens,
          historyDAO: historyDAO,
          settingsDAO: settingsDAO,
          progressDAO: progressDAO,
          kudoHistoryDAO: kudoHistoryDAO,
          databaseObj: databaseObj,
          openTagSearch: openTagSearch,
          chapterDAO: chapterDAO,
        });
        break;
      case 'Data and Storage':
        navigation.push('Storage', {
          currentTheme: currentTheme,
          workDAO: workDAO,
          libraryDAO: libraryDAO,
          setScreens: setScreens,
          historyDAO: historyDAO,
          settingsDAO: settingsDAO,
          progressDAO: progressDAO,
          kudoHistoryDAO: kudoHistoryDAO,
          databaseObj: databaseObj,
        });
        break;
      case 'Word Replacer':
        navigation.push('WordReplacer', {
          currentTheme: currentTheme,
          workDAO: workDAO,
          libraryDAO: libraryDAO,
          setScreens: setScreens,
          historyDAO: historyDAO,
          settingsDAO: settingsDAO,
          progressDAO: progressDAO,
          kudoHistoryDAO: kudoHistoryDAO,
          databaseObj: databaseObj,
        });
        break;
      case 'About':
        navigation.push('About', {
          currentTheme: currentTheme,
          workDAO: workDAO,
          libraryDAO: libraryDAO,
          setScreens: setScreens,
          historyDAO: historyDAO,
          settingsDAO: settingsDAO,
          progressDAO: progressDAO,
          kudoHistoryDAO: kudoHistoryDAO,
          db: databaseObj,
        });
        break;
      case 'Help':
        navigation.push('Help', {
          currentTheme: currentTheme,
          workDAO: workDAO,
          libraryDAO: libraryDAO,
          setScreens: setScreens,
          historyDAO: historyDAO,
          settingsDAO: settingsDAO,
          progressDAO: progressDAO,
          kudoHistoryDAO: kudoHistoryDAO,
        });
        break;
    }
    console.log(`${screenName} pressed`);
  };

  const menuItems = [
    {
      name: t('screen_more_nav_preference'),
      icon: 'settings',
      handler: () => handlePress('Preferences'),
    },
    {
      name: t('screen_more_nav_account'),
      icon: 'account-circle',
      handler: () => handlePress('Account'),
    },
    {
      name: t('screen_more_nav_kudos'),
      icon: 'favorite',
      handler: () => handlePress('KudosHistory'),
    },
    {
      name: t('screen_more_nav_bookmarks'),
      icon: 'bookmarks',
      handler: () => handlePress('Bookmarks'),
    },
    {
      name: t('screen_more_nav_later'),
      icon: 'watch-later',
      handler: () => handlePress('ReadLater'),
    },
    {
      name: t('screen_more_nav_categories'),
      icon: 'category',
      handler: () => handlePress('Categories'),
    },
    {
      name: t('screen_more_nav_stats'),
      icon: 'bar-chart',
      handler: () => handlePress('Statistics'),
    },
    {
      name: t('screen_more_nav_data'),
      icon: 'storage',
      handler: () => handlePress('Data and Storage'),
    },
    {
      name: t('screen_more_nav_word-replacer'),
      icon: 'find-replace',
      handler: () => handlePress('Word Replacer'),
    },
    {
      name: t('screen_more_nav_about'),
      icon: 'info',
      handler: () => handlePress('About'),
    },
    {
      name: t('screen_more_nav_help'),
      icon: 'help',
      handler: () => handlePress('Help'),
    },
  ];

  return (
    <ScrollView
      style={[
        styles.mainContent,
        { backgroundColor: currentTheme.backgroundColor },
      ]}
      contentContainerStyle={{
        paddingBottom: insets.bottom,
      }}
    >
      <View style={styles.contentContainer}>
        <Text style={[styles.title, { color: currentTheme.textColor }]}>
          {t('screen_more_title')}
        </Text>
        <Text
          style={[styles.subtitle, { color: currentTheme.placeholderColor }]}
        >
          {t('screen_more_subtitle')}
        </Text>

        {/* 用户信息卡：显示登录状态，点击进账号中心 */}
        <TouchableOpacity
          onPress={() => handlePress('Account')}
          style={[
            styles.userCard,
            { backgroundColor: currentTheme.cardBackground, borderColor: currentTheme.borderColor },
          ]}
        >
          <Icon
            name={userInfo?.logged ? 'check-circle' : 'account-circle'}
            size={34}
            color={userInfo?.logged ? 'green' : currentTheme.placeholderColor}
          />
          <View style={{ marginLeft: 12, flex: 1 }}>
            <Text style={{ color: currentTheme.textColor, fontSize: 15, fontWeight: '600' }}>
              {checkingUser ? '检查登录状态…' : userInfo?.logged ? `已登录：${userInfo.username}` : '未登录'}
            </Text>
            <Text style={{ color: currentTheme.placeholderColor, fontSize: 12, marginTop: 2 }}>
              {userInfo?.logged ? '点击进入账号中心' : '点击登录 / 注册（ECH 官方登录）'}
            </Text>
          </View>
          <Icon name="chevron-right" size={24} color={currentTheme.placeholderColor} />
        </TouchableOpacity>

        <View style={styles.menuContainer}>
          {menuItems.map((item, index) => (
            <Animated.View
              key={item.name}
              style={[
                {
                  opacity: fadeAnim,
                  transform: [
                    {
                      translateX: fadeAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [-20, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <TouchableOpacity
                style={[
                  styles.menuItem,
                  {
                    backgroundColor: currentTheme.cardBackground,
                    borderBottomColor: currentTheme.borderColor,
                  },
                  index === menuItems.length - 1 && styles.lastItem,
                ]}
                onPress={item.handler}
                activeOpacity={0.7}
              >
                <View style={styles.iconContainer}>
                  <Icon
                    name={item.icon}
                    size={24}
                    color={currentTheme.primaryColor}
                  />
                </View>
                <Text
                  style={[styles.menuText, { color: currentTheme.textColor }]}
                >
                  {item.name}
                </Text>
                <Icon
                  name="chevron-right"
                  size={24}
                  color={currentTheme.placeholderColor}
                />
              </TouchableOpacity>
            </Animated.View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  mainContent: {
    flex: 1,
    margin: 16,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 80,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 24,
  },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
    marginHorizontal: -16,
  },
  menuContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    marginHorizontal: -16,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  lastItem: {
    borderBottomWidth: 0,
  },
  iconContainer: {
    width: 40,
    alignItems: 'center',
    marginRight: 16,
  },
  menuText: {
    flex: 1,
    fontSize: 18,
    fontWeight: '500',
  },
});

export default MoreScreen;
