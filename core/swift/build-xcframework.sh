#!/bin/sh
# Builds the TemenCAD core as TemenCore.xcframework (macOS arm64+x86_64, iOS arm64, iOS simulator arm64+x86_64)
# with CMake and Xcode, then the Swift package in this folder links it.
#
#   core/swift/build-xcframework.sh            all three slices
#   core/swift/build-xcframework.sh macos      one slice (macos | ios | simulator), e.g. for `swift test`
#
# Each slice compiles the core, lamassu, Manifold, Clipper2 and miniz into static libraries and merges them
# into one libTemenCAD.a (a distinct name: the file system is case-insensitive, so libTemenCore.a would clobber libtemencore.a); the framework carries include/temencad.h with a module map so Swift can
# `import CTemenCore`. Needs the Xcode command line tools and CMake 3.24+.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
CORE=$(dirname "$HERE")
OUT="$HERE/TemenCore.xcframework"
BUILD="$CORE/../build/xcframework"
SLICES=${*:-macos ios simulator}

build_slice() {
  name=$1; shift
  dir="$BUILD/$name"
  cmake -S "$CORE" -B "$dir" -DCMAKE_BUILD_TYPE=Release "$@" > "$dir.configure.log" 2>&1 || { cat "$dir.configure.log"; exit 1; }
  cmake --build "$dir" --target temencore -j8 > "$dir.build.log" 2>&1 || { tail -40 "$dir.build.log"; exit 1; }
  # one archive from the six static libraries CMake produced
  rm -f "$dir/libTemenCAD.a"
  libs=$(find "$dir" \( -name 'libtemencore.a' -o -name 'liblamassu.a' -o -name 'libmanifoldc.a' -o -name 'libmanifold.a' -o -name 'libClipper2.a' -o -name 'libminiz.a' \) -print)
  [ "$(echo "$libs" | wc -l | tr -d ' ')" = 6 ] || { echo "expected 6 libraries, found:"; echo "$libs"; exit 1; }
  libtool -static -o "$dir/libTemenCAD.a" $libs
  [ -f "$dir/libTemenCAD.a" ] || exit 1
  echo "built $name: $(du -h "$dir/libTemenCAD.a" | cut -f1)"
}

mkdir -p "$BUILD"
HEADERS="$BUILD/include"
rm -rf "$HEADERS" && mkdir -p "$HEADERS"
cp "$CORE/include/temencad.h" "$HEADERS/"
cat > "$HEADERS/module.modulemap" <<EOF
module CTemenCore {
    header "temencad.h"
    export *
}
EOF

ARGS=""
for s in $SLICES; do
  case $s in
    macos)     build_slice macos "-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64" -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 ;;
    ios)       build_slice ios -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_DEPLOYMENT_TARGET=16.0 ;;
    simulator) build_slice simulator -DCMAKE_SYSTEM_NAME=iOS "-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64" -DCMAKE_OSX_SYSROOT=iphonesimulator -DCMAKE_OSX_DEPLOYMENT_TARGET=16.0 ;;
    *) echo "unknown slice $s (macos | ios | simulator)"; exit 2 ;;
  esac
  ARGS="$ARGS -library $BUILD/$s/libTemenCAD.a -headers $HEADERS"
done

rm -rf "$OUT"
xcodebuild -create-xcframework $ARGS -output "$OUT" > "$BUILD/xcframework.log" 2>&1 || { cat "$BUILD/xcframework.log"; exit 1; }
echo "wrote $OUT ($(echo $SLICES | wc -w | tr -d ' ') slice(s))"
