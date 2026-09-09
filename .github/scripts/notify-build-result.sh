#!/usr/bin/env bash
# 构建结果回传 Telegram（成功/失败都通知，旧包永不发送）。
# 需要 secrets： TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
# 调用方传入： GH_TOKEN / BUILD_STATUS / HEAD_SHA / RUN_ID（见 android-build.yml）
set -u
REPO="${GITHUB_REPOSITORY:?}"
RUN_ID="${RUN_ID:?}"
SHA="${HEAD_SHA:?}"
STATUS="${BUILD_STATUS:-unknown}"
SHORT_SHA="${SHA:0:8}"
RUN_URL="https://github.com/${REPO}/actions/runs/${RUN_ID}"

send_msg() {
  curl -s --max-time 30 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=$1" | head -c 200
  echo
}

if [ "$STATUS" = "success" ]; then
  APK=$(ls -t CO3-Android-arm64-v8a.apk CO3-Android-*.apk 2>/dev/null | head -n 1)
  if [ -n "$APK" ] && [ -f "$APK" ]; then
    SIZE=$(stat -c%s "$APK")
    MSG="✅ CO3 构建成功 ${SHORT_SHA}%0A运行：${RUN_URL}%0AAPK：${APK}（${SIZE} 字节）"
    if [ "$SIZE" -lt 50000000 ]; then
      curl -s --max-time 300 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument" \
        -F "chat_id=${TELEGRAM_CHAT_ID}" \
        -F "document=@${APK}" \
        -F "caption=CO3 ${SHORT_SHA} ${APK}" | head -c 200
      echo
    else
      send_msg "✅ CO3 构建成功 ${SHORT_SHA}%0A运行：${RUN_URL}%0A${APK}（${SIZE} 字节，超 50MB 请到 Actions 下载）"
    fi
  else
    send_msg "✅ CO3 构建成功 ${SHORT_SHA}%0A运行：${RUN_URL}%0A（未找到 APK 文件）"
  fi
else
  ERR=$(grep -rh -m 3 -E "^e: file://|FAILED|error:" "${GITHUB_WORKSPACE:-.}/android/app/build/outputs/logs" 2>/dev/null | head -n 5)
  if [ -z "$ERR" ]; then
    ERR="(详见 Actions 日志)"
  fi
  send_msg "❌ CO3 构建失败 ${SHORT_SHA}%0A运行：${RUN_URL}%0A状态：${STATUS}%0A${ERR}"
fi
