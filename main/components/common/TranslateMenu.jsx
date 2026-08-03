import React from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';

// 翻译选项底部弹窗:显示原文 / 中文(纯译文) / 双语(对照)。
// 章节阅读器、作品介绍、书库详情共用。
const TranslateMenu = ({
  visible,
  onClose,
  theme,
  currentMode, // 'original' | 'translated' | 'bilingual'
  onSelect, // (mode) => void
  t,
}) => {
  const options = [
    { mode: 'original', label: t('translate_option_original'), icon: 'visibility', hint: null },
    { mode: 'translated', label: t('translate_option_chinese'), icon: 'translate', hint: null },
    { mode: 'bilingual', label: t('translate_option_bilingual'), icon: 'compare', hint: t('translate_option_bilingual_hint') },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: theme.cardBackground }]}
          onPress={(e) => e.stopPropagation()}
        >
          <Text style={[styles.title, { color: theme.textColor }]}>
            {t('translate_title')}
          </Text>

          {options.map((opt) => {
            const active = currentMode === opt.mode;
            return (
              <TouchableOpacity
                key={opt.mode}
                style={[
                  styles.option,
                  active && { backgroundColor: theme.primaryColor + '22' },
                ]}
                onPress={() => {
                  onClose();
                  onSelect(opt.mode);
                }}
              >
                <Icon
                  name={opt.icon}
                  size={22}
                  color={active ? theme.primaryColor : theme.iconColor}
                />
                <View style={styles.optionTextWrap}>
                  <Text
                    style={[
                      styles.optionLabel,
                      { color: active ? theme.primaryColor : theme.textColor },
                    ]}
                  >
                    {opt.label}
                  </Text>
                  {opt.hint ? (
                    <Text style={[styles.optionHint, { color: theme.secondaryTextColor }]}>
                      {opt.hint}
                    </Text>
                  ) : null}
                </View>
                {active && (
                  <Icon name="check" size={20} color={theme.primaryColor} />
                )}
              </TouchableOpacity>
            );
          })}

          <TouchableOpacity
            style={styles.cancel}
            onPress={onClose}
          >
            <Text style={[styles.cancelText, { color: theme.secondaryTextColor }]}>
              {t('update_later_button')}
            </Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 28,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 6,
  },
  optionTextWrap: {
    flex: 1,
    marginLeft: 14,
  },
  optionLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  optionHint: {
    fontSize: 12,
    marginTop: 2,
  },
  cancel: {
    alignItems: 'center',
    paddingTop: 14,
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.3)',
  },
  cancelText: {
    fontSize: 14,
  },
});

export default TranslateMenu;
