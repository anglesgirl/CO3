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
import DebugScreen from './DebugScreen';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function AboutScreen({ route }) {
  const {setScreens, currentTheme, db} = route.params;
  const navigation = useNavigation();

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
            onPress={() =>
              navigation.push("Debug", {
                setScreens: setScreens,
                db: db
              })
            }
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
          <LinkButton
            url="https://github.com/tbvns/CO3"
            label={t('screen_about_source')}
            theme={currentTheme}
          />
          <Text style={[styles.sectionTitle, { color: currentTheme.textColor }]}>
            {t('screen_about_assisted_development')}
          </Text>
          <LinkButton
            url="https://anglesya.win/"
            label={t('screen_about_idea_contributor')}
            theme={currentTheme}
          />
          <LinkButton
            url="https://www.ao3.xyz"
            label="www.ao3.xyz"
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
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 24,
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
