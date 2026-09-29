cmake_minimum_required(VERSION 3.22)
project(co3ech LANGUAGES C CXX)

# CO3 的 ech_http 原生引擎（Android）。
#
# 产物: libco3ech.so —— 去 Dart 化后的 ech_http C++ 引擎 + CO3 的 JNI 桥。
# 由 CI 交叉编译后落到 android/app/src/main/jniLibs/<abi>/，与现有 Hy-MT
# 预编译 so 的投放方式一致（本工程刻意不声明 externalNativeBuild）。
#
# 用法:
#   cmake -S android/app/src/main/cpp -B build/<abi> -G Ninja \
#     -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake \
#     -DANDROID_ABI=<abi> -DANDROID_PLATFORM=android-24 -DANDROID_STL=c++_static \
#     -DCMAKE_BUILD_TYPE=Release -DEH_DEPS_ROOT=<预编译 SDK 目录>
#
# 依赖 SDK 提供 include/{curl,openssl} 与 lib/{libcurl,libssl,libcrypto,libzlib}.a

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

if(NOT DEFINED EH_DEPS_ROOT)
  message(FATAL_ERROR "必须提供 -DEH_DEPS_ROOT=<含 cmake/EchHttpDeps.cmake 的预编译 SDK 目录>")
endif()
include("${EH_DEPS_ROOT}/cmake/EchHttpDeps.cmake")

# CA 包编译进二进制，运行时不需要外部证书文件
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/ech_http/cacert.pem" EH_CA_PEM)
configure_file("${CMAKE_CURRENT_SOURCE_DIR}/ech_http/ca_bundle.h.in"
               "${CMAKE_CURRENT_BINARY_DIR}/ca_bundle.h" @ONLY)

add_library(co3ech SHARED
  ech_http_jni.cpp
  ech_http/ech_http.cpp)

# imported 目标默认走 -isystem，可能被宿主 OpenSSL 头抢占，强制用本 SDK 的头
set_target_properties(co3ech PROPERTIES NO_SYSTEM_FROM_IMPORTED ON)
target_include_directories(co3ech PRIVATE
  "${CMAKE_CURRENT_BINARY_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}/ech_http")
target_link_libraries(co3ech PRIVATE EchHttp::curl)
find_package(Threads REQUIRED)
target_link_libraries(co3ech PRIVATE Threads::Threads)

if(ANDROID)
  # __android_log_print
  target_link_libraries(co3ech PRIVATE log)
  # 16 KiB 页对齐（Android 15 强制要求）；静态库符号本地化避免与应用符号冲突
  target_link_options(co3ech PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,--exclude-libs,ALL"
    "-Wl,--strip-debug")
endif()

set_target_properties(co3ech PROPERTIES
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out")
