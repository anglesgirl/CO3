# HyMT 端侧翻译原生构建。llama.cpp 由 CI 克隆到本目录（PR #19357 分支，
# 2bit Q2_0c 内核），本地没有该目录时跳过（不断正常构建）。
# 32 位架构（v7a/x86）编 llama 会挂（缺 NEON FP16 指令），这些架构只出
# 空壳 libhymt（JNI 直接返回失败），App 内自动降级走在线引擎。
cmake_minimum_required(VERSION 3.22.1)

project(hymt_jni)

if(ANDROID_ABI MATCHES "arm64-v8a|x86_64" AND EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/CMakeLists.txt)
  set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  add_subdirectory(llama.cpp)

  add_library(hymt SHARED hymt_jni.cpp)
  target_link_libraries(hymt PRIVATE llama)
  target_include_directories(hymt PRIVATE llama.cpp/include llama.cpp/common)
elseif(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/hymt_jni.cpp)
  add_library(hymt SHARED hymt_jni.cpp)
  target_compile_definitions(hymt PRIVATE HYMT_STUB=1)
else()
  message(WARNING "hymt_jni.cpp missing, skipping hymt native library")
endif()
