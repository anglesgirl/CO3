# HyMT 端侧翻译原生构建（RN 新架构 app 级 CMakeLists）。
#
# !! 关键 !! 必须 include react-native 的 ReactNative-application.cmake，
# 否则 RN 的 appmodules（含 autolinking 的 TurboModule，如 AsyncStorage）
# 不会被构建 → 运行时 "AsyncStorage is null" 崩溃（[runtime not ready]）。
#
# llama 推理库用「官方 Hy-MT Demo APK 里的预编译 so」（CI 提取到 jniLibs）：
# 官方 so 的 ggml 类型编号与官方 GGUF 模型严格配套
# （Q2_0C=41 / STQ_0=40），自编 llama.cpp 会因编号错位导致加载失败。
cmake_minimum_required(VERSION 3.22.1)

# 库名必须是 appmodules（RN 约定，见 react-native default-app-setup/CMakeLists.txt）
project(appmodules)

set(HYMT_SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/hymt)
set(PREBUILT_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI})

if(ANDROID_ABI MATCHES "arm64-v8a|armeabi-v7a|x86_64|x86"
   AND EXISTS ${PREBUILT_DIR}/libllama.so
   AND EXISTS ${HYMT_SRC_DIR}/hymt_jni.cpp)
  # 官方预编译 llama 库（从官方 Demo APK 提取）
  add_library(llama SHARED IMPORTED)
  set_target_properties(llama PROPERTIES
    IMPORTED_LOCATION ${PREBUILT_DIR}/libllama.so)

  add_library(hymt SHARED ${HYMT_SRC_DIR}/hymt_jni.cpp)
  target_link_libraries(hymt PRIVATE llama)
  target_include_directories(hymt PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/llama-include)
elseif(EXISTS ${HYMT_SRC_DIR}/hymt_jni.cpp)
  # 没有官方库：只出空壳 libhymt（JNI 直接返回失败，App 降级走在线/机翻）
  add_library(hymt SHARED ${HYMT_SRC_DIR}/hymt_jni.cpp)
  target_compile_definitions(hymt PRIVATE HYMT_STUB=1)
else()
  message(WARNING "hymt_jni.cpp missing, skipping hymt native library")
endif()

# RN 的 app 级配置：构建 appmodules + 链接 autolinked TurboModule 库。
# 必须放在最后（它用 CMAKE_PROJECT_NAME 建库）。
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)
