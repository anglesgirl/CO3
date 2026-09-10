# HyMT 端侧翻译原生构建（RN 新架构 app 级 CMakeLists）。
#
# !! 关键 !! 必须 include react-native 的 ReactNative-application.cmake，
# 否则 RN 的 appmodules（含 autolinking 的 TurboModule，如 AsyncStorage）
# 不会被构建 → 运行时 "AsyncStorage is null / [runtime not ready]" 崩溃。
# 依据：react-native 的 NdkConfiguratorUtils 只在 externalNativeBuild.cmake.path
# 为空时才注入默认 CMakeLists；一旦自定义必须自己 include 官方那套。
# 参见 packages/react-native/ReactAndroid/cmake-utils/default-app-setup/CMakeLists.txt
cmake_minimum_required(VERSION 3.22.1)

# 库名必须是 appmodules（RN 约定，CMAKE_PROJECT_NAME 用于命名主 so）。
project(appmodules)

set(HYMT_SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/hymt)

if(ANDROID_ABI MATCHES "arm64-v8a|x86_64" AND EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/llama-src/CMakeLists.txt)
  # 真实 llama.cpp 推理（arm64/x86_64），2bit Q2_0c 内核来自 CI 克隆的 PR 分支。
  # 目录必须叫 llama-src（不能以 .cpp 结尾，否则被上面的 *.cpp glob 误当源文件）。
  set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  add_subdirectory(llama-src)

  add_library(hymt SHARED ${HYMT_SRC_DIR}/hymt_jni.cpp)
  target_link_libraries(hymt PRIVATE llama)
  target_include_directories(hymt PRIVATE llama-src/include llama-src/common)
elseif(EXISTS ${HYMT_SRC_DIR}/hymt_jni.cpp)
  # 无 llama.cpp 或 32 位架构：只出空壳 libhymt（JNI 直接返回失败，App 降级走在线）。
  add_library(hymt SHARED ${HYMT_SRC_DIR}/hymt_jni.cpp)
  target_compile_definitions(hymt PRIVATE HYMT_STUB=1)
else()
  message(WARNING "hymt_jni.cpp missing, skipping hymt native library")
endif()

# RN 的 app 级配置（构建 appmodules + 链接所有 autolinked TurboModule 库）。
# 必须放在最后：本文件内的 *.cpp（OnLoad.cpp）会被 glob 成 appmodules 的入口。
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)
