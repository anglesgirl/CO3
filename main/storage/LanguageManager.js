import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import en from '../../languages/en.json';
import fr from '../../languages/fr.json';
import zh from '../../languages/zh.json';

export const availableLanguages = [
  {
    code: 'en',
    label: 'English',
    flag: 'GB',
    translation: en,
  },
  {
    code: 'fr',
    label: 'Français',
    flag: 'FR',
    translation: fr,
  },
  {
    code: 'zh',
    label: '中文',
    flag: 'CN',
    translation: zh,
  },
];

const resources = {};
availableLanguages.forEach(lang => {
  resources[lang.code] = { translation: lang.translation };
});

export const getSavedLanguage = async () => {
  try {
    const savedLang = await AsyncStorage.getItem('app_language');
    return savedLang || 'en';
  } catch (e) {
    return 'en';
  }
};

i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

getSavedLanguage().then(savedLang => {
  if (savedLang !== i18n.language) {
    i18n.changeLanguage(savedLang);
  }
});

export const changeLanguage = async lng => {
  await AsyncStorage.setItem('app_language', lng);
  await i18n.changeLanguage(lng);
};

export default i18n;