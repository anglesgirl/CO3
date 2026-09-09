# HyMT 端侧翻译原生构建。llama.cpp 由 CI 克隆到本目录（PR #19357 分支，
# 2bit Q2_0c 内核），本地没有该目录时跳过（不断正常构建）。
cmake_minimum_required(VERSION 3.22.1)

project(hymt_jni)

if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/CMakeLists.txt)
  set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  add_subdirectory(llama.cpp)

  add_library(hymt SHARED hymt_jni.cpp)
  target_link_libraries(hymt PRIVATE llama)
  target_include_directories(hymt PRIVATE llama.cpp/include llama.cpp/common)
else()
  message(WARNING "llama.cpp not found, skipping hymt native library")
endif()
