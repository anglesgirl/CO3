import {
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { co3Version } from '../../constant';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRef } from 'react';
import { debugLog, setDebugEnabled } from '../../utils/debugLog';

export default function AboutScreen({ route }) {
  const {setScreens, currentTheme, db} = route.params;
  const navigation = useNavigation();
  const logoTapCount = useRef(0);
  const logoTapTimer = useRef(null);

  async function onLogoPress() {
    logoTapCount.current += 1;
    clearTimeout(logoTapTimer.current);
    logoTapTimer.current = setTimeout(() => { logoTapCount.current = 0; }, 900);
    if (logoTapCount.current !== 3) return;
    logoTapCount.current = 0;
    await setDebugEnabled(true);
    await debugLog('debug', 'Debug logging enabled from About screen');
    navigation.push('Debug', { setScreens, db });
  }

  function onBack() {
    navigation.goBack();
  }

  const { t } = useTranslation();

  return (
    <SafeAreaView style={[{backgroundColor: currentTheme.backgroundColor}, styles.container]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack}>
          <Icon name="arrow-back" size={24} color={currentTheme.textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: currentTheme.textColor }]}>
          {t('screen_about_title')}
        </Text>
      </View>
      <ScrollView style={{ height: '100%' }}>
        <View style={styles.mainContent}>
          <TouchableOpacity
            onPress={onLogoPress}
          >
            <Image style={styles.image} source={require('../../res/CO3.png')} />
          </TouchableOpacity>
          <View
            style={[
              styles.separator,
              { backgroundColor: currentTheme.borderColor },
            ]}
          />
          <Text style={[styles.title, { color: currentTheme.textColor }]}>
            {t('general_app_name')}
          </Text>
          <Text style={[{ paddingTop: 20, color: currentTheme.textColor }]}>
            {t('screen_about_sub')}
          </Text>
        </View>
        <View style={[{ margin: 16 }]}>
          <Text style={[{ color: currentTheme.textColor }]}>
            {t('screen_about_text_1')}
          </Text>
          <Text style={[{ paddingTop: 5, color: currentTheme.textColor }]}>
            {t('screen_about_text_2')}
          </Text>
          <View style={[{ paddingTop: 16, paddingBottom: 8 }]}>
            <Text style={[{ fontWeight: '700', color: currentTheme.textColor }]}>
              本版本修改：雅💓涵
            </Text>
          </View>
          <LinkButton
            url="https://anglesya.win/"
            label="作者博客：anglesya.win"
            theme={currentTheme}
          />
          <LinkButton
            url="https://github.com/tbvns/CO3"
            label={t('screen_about_source') + '（原仓库）'}
            theme={currentTheme}
          />
        </View>
        <Text
          style={[
            {
              color: currentTheme.secondaryTextColor,
              width: '100%',
              textAlign: 'center',
            },
          ]}
        >
          {t('screen_about_version', { co3Version: co3Version })}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function LinkButton({ url, label, theme }) {
  return (
    <TouchableOpacity
      style={[
        {
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          paddingTop: 16,
        },
      ]}
      onPress={() => Linking.openURL(url)}
    >
      <Icon name={"link"} size={20} color={theme.textColor} />
      <Text style={[styles.buttonText, { color: theme.textColor}]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}


const styles = StyleSheet.create({
  container: {
    flex: 1,
    height: '100%',
  },
  mainContent: {
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 20,
    paddingBottom: 10,
    paddingTop: 10,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginLeft: 16,
  },
  buttonText: {
    fontSize: 20,
    fontWeight: 'ultralight',
    textDecorationLine: 'underline',
    marginLeft: 16,
  },
  image: {
    width: 100,
    height: 100,
    margin: 35,
  },
  separator: {
    height: 1,
    width: '100%',
    marginBottom: 20,
  }
});
