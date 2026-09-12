import React, { useEffect, useState } from 'react';
import { Linking, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 首次启动提示：只说两件事 —— 这 App 是免费的，以及作者的博客在哪。
 * 用 AsyncStorage 記住"看过了"，只弹一次（换版本号也不用重弹，除非改 KEY）。
 */
const SEEN_KEY = 'co3_first_run_notice_v1';
const BLOG_URL = 'https://anglesya.win/';

export default function FirstRunNotice({ currentTheme }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const seen = await AsyncStorage.getItem(SEEN_KEY);
        if (alive && !seen) setVisible(true);
      } catch {
        // 读不到就当作已看过，避免每次启动都弹
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const dismiss = async () => {
    setVisible(false);
    try {
      await AsyncStorage.setItem(SEEN_KEY, '1');
    } catch {}
  };

  const openBlog = () => {
    Linking.openURL(BLOG_URL).catch(() => {});
  };

  const bg = (currentTheme && currentTheme.cardBackground) || '#ffffff';
  const fg = (currentTheme && currentTheme.textColor) || '#111111';
  const sub = (currentTheme && currentTheme.textSecondary) || '#666666';
  const accent = (currentTheme && currentTheme.primaryColor) || '#b23b3b';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={dismiss}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: bg }]}>
          <Text style={[styles.title, { color: fg }]}>这个 App 是免费的</Text>
          <Text style={[styles.body, { color: sub }]}>
            如果你是从别人那里花钱买到的，请给对方打差评。
          </Text>
          <TouchableOpacity onPress={openBlog}>
            <Text style={[styles.link, { color: accent }]}>作者博客：anglesya.win</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, { backgroundColor: accent }]} onPress={dismiss}>
            <Text style={styles.buttonText}>我知道了</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  card: {
    width: '100%',
    borderRadius: 14,
    padding: 20,
  },
  title: { fontSize: 17, fontWeight: 'bold', marginBottom: 10 },
  body: { fontSize: 14, lineHeight: 21, marginBottom: 12 },
  link: { fontSize: 14, marginBottom: 18, textDecorationLine: 'underline' },
  button: {
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  buttonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
});
