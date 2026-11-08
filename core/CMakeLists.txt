# TemenCAD core: lamassu-js + Manifold + the modelling API, as one static library.
#
#   cmake -S core -B build/native && cmake --build build/native        # libtemencore.a + the temencore CLI
#   emcmake cmake -S core -B build/wasm && cmake --build build/wasm    # temencore.mjs + temencore.wasm
#
# Both builds compile the same C; the Emscripten one adds wasm/glue.c as the
# JavaScript-facing surface. Clipper2 (Manifold's 2D backend) is fetched by
# Manifold's own CMake at configure time, so the first configure needs network.
cmake_minimum_required(VERSION 3.24)
project(temencore C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(TEMEN_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/..)
set(LAMASSU_DIR ${TEMEN_ROOT}/third_party/lamassu-js)
set(MANIFOLD_DIR ${TEMEN_ROOT}/third_party/manifold)

# ---- Manifold -------------------------------------------------------------
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(MANIFOLD_CBIND ON CACHE BOOL "" FORCE)
set(MANIFOLD_CROSS_SECTION ON CACHE BOOL "" FORCE)
set(MANIFOLD_PAR OFF CACHE BOOL "" FORCE)
set(MANIFOLD_TEST OFF CACHE BOOL "" FORCE)
set(MANIFOLD_PYBIND OFF CACHE BOOL "" FORCE)
set(MANIFOLD_JSBIND OFF CACHE BOOL "" FORCE)
set(MANIFOLD_USE_BUILTIN_CLIPPER2 ON CACHE BOOL "" FORCE)
add_subdirectory(${MANIFOLD_DIR} manifold EXCLUDE_FROM_ALL)
# Manifold sets its version variables inside its own directory scope, so read them from the file.
set(TEMEN_MANIFOLD_VERSION "")
foreach(part MAJOR MINOR PATCH)
  file(STRINGS ${MANIFOLD_DIR}/CMakeLists.txt line REGEX "set\\(MANIFOLD_VERSION_${part} [0-9]+\\)")
  string(REGEX MATCH "[0-9]+" num "${line}")
  list(APPEND TEMEN_MANIFOLD_VERSION_PARTS "${num}")
endforeach()
list(JOIN TEMEN_MANIFOLD_VERSION_PARTS "." TEMEN_MANIFOLD_VERSION)

# ---- lamassu-js (same file lists as its Makefile) -------------------------
set(LAMASSU_RUNTIME
  js_vm.c js_gc.c js_string.c js_map.c js_object.c js_number.c js_interp.c
  js_builtins.c js_promise.c js_case.c js_module.c js_regexp.c js_bytecode_read.c js_date.c
  js_mapobj.c js_setobj.c js_error.c)
list(TRANSFORM LAMASSU_RUNTIME PREPEND ${LAMASSU_DIR}/src/runtime/)
# the fdlibm-derived math kernel (same bits as Node; see lamassu's Makefile)
set(LAMASSU_FDLIBM scalbn.c rem_pio2_large.c rem_pio2.c k_sin.c k_cos.c k_tan.c sin.c cos.c tan.c
  atan.c atan2.c asin.c acos.c exp.c log.c pow.c log2.c log10.c cbrt.c)
list(TRANSFORM LAMASSU_FDLIBM PREPEND ${LAMASSU_DIR}/src/runtime/fdlibm/)
list(APPEND LAMASSU_RUNTIME ${LAMASSU_FDLIBM})
set(LAMASSU_FRONTEND
  js_lexer.c js_parser.c js_compiler.c js_arena.c js_bytecode_write.c js_compile_api.c js_module_compile.c)
list(TRANSFORM LAMASSU_FRONTEND PREPEND ${LAMASSU_DIR}/src/frontend/)
set(BARU_RE re_lexer.c re_parser.c re_compiler.c re_vm.c)
list(TRANSFORM BARU_RE PREPEND ${LAMASSU_DIR}/third_party/baru-re/src/)

add_library(lamassu STATIC ${LAMASSU_RUNTIME} ${LAMASSU_FRONTEND} ${BARU_RE})
target_include_directories(lamassu
  PUBLIC ${LAMASSU_DIR}/include
  # The host reaches a few internals (js_native_new, js_error_new, js_source_line_col) until they are public.
  PUBLIC ${LAMASSU_DIR}/src ${LAMASSU_DIR}/src/runtime ${LAMASSU_DIR}/src/frontend
  PRIVATE ${LAMASSU_DIR}/third_party/baru-re/include)
target_compile_definitions(lamassu PUBLIC LAMASSU_HAS_REGEX PRIVATE _POSIX_C_SOURCE=200809L)
target_compile_options(lamassu PRIVATE -Wall -Wextra -Wshadow -ffp-contract=off)
if(NOT EMSCRIPTEN)
  target_link_libraries(lamassu PUBLIC m)
endif()

# ---- the prelude, embedded as bytes ----------------------------------------
set(PRELUDE_SRC ${CMAKE_CURRENT_SOURCE_DIR}/src/prelude.js)
set(PRELUDE_HDR ${CMAKE_CURRENT_BINARY_DIR}/generated/prelude_js.h)
add_custom_command(
  OUTPUT ${PRELUDE_HDR}
  COMMAND ${CMAKE_COMMAND} -DIN=${PRELUDE_SRC} -DOUT=${PRELUDE_HDR} -DNAME=temen_prelude_js
          -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed.cmake
  DEPENDS ${PRELUDE_SRC} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed.cmake
  COMMENT "Embedding prelude.js")

# ---- the core library -------------------------------------------------------
add_library(temencore STATIC src/host.c src/natives.c ${PRELUDE_HDR})
target_include_directories(temencore
  PUBLIC include
  PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/generated ${MANIFOLD_DIR}/bindings/c/include)
target_compile_definitions(temencore PRIVATE TEMEN_MANIFOLD_VERSION="${TEMEN_MANIFOLD_VERSION}" _POSIX_C_SOURCE=200809L _DARWIN_C_SOURCE)
target_compile_options(temencore PRIVATE -Wall -Wextra)
target_link_libraries(temencore PUBLIC lamassu manifoldc manifold)

# ---- native command line tool ------------------------------------------------
if(NOT EMSCRIPTEN)
  add_executable(temencore-cli tools/temencore.c)
  set_target_properties(temencore-cli PROPERTIES OUTPUT_NAME temencore)
  target_link_libraries(temencore-cli PRIVATE temencore)
endif()

# ---- WebAssembly module -------------------------------------------------------
if(EMSCRIPTEN)
  add_executable(temencore-wasm wasm/glue.c)
  # emitted next to wasm/index.js, which imports ./dist/temencore.mjs
  set_target_properties(temencore-wasm PROPERTIES OUTPUT_NAME temencore SUFFIX .mjs
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/wasm/dist)
  target_link_libraries(temencore-wasm PRIVATE temencore)
  target_link_options(temencore-wasm PRIVATE
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createTemenCore
    -sENVIRONMENT=web,worker,node
    # lamassu's parser recurses; its own builds use an 8 MB stack
    -sSTACK_SIZE=8388608
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432
    -sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8,HEAPF32,HEAPU32
    -sEXPORTED_FUNCTIONS=_malloc,_free
    -sDISABLE_EXCEPTION_CATCHING=0)
  target_compile_options(temencore PUBLIC -fexceptions)
  target_compile_options(manifold PRIVATE -fexceptions)
  target_compile_options(manifoldc PRIVATE -fexceptions)
endif()
