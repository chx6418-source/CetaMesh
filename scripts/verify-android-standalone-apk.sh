#!/usr/bin/env bash
set -euo pipefail

apk=${1:-}
if [[ -z "$apk" || ! -f "$apk" ]]; then
  echo "Usage: $0 <release-apk>" >&2
  exit 2
fi

build_tools=${ANDROID_BUILD_TOOLS_DIR:-${ANDROID_HOME:-}/build-tools/${ANDROID_BUILD_TOOLS:-}}
apksigner="$build_tools/apksigner"
aapt2="$build_tools/aapt2"

for tool in "$apksigner" "$aapt2"; do
  if [[ ! -x "$tool" ]]; then
    echo "Required Android build tool is unavailable: $tool" >&2
    exit 2
  fi
done

"$apksigner" verify --verbose "$apk"

badging=$("$aapt2" dump badging "$apk")
grep -Fq "package: name='com.cetameshmobile'" <<<"$badging"
grep -Fq "compileSdkVersion='37'" <<<"$badging"
grep -Fq "minSdkVersion:'24'" <<<"$badging"
grep -Fq "targetSdkVersion:'36'" <<<"$badging"

manifest=$("$aapt2" dump xmltree "$apk" --file AndroidManifest.xml)
if grep -Fq "android:debuggable" <<<"$manifest" && grep -F "android:debuggable" <<<"$manifest" | grep -Fq "=true"; then
  echo "Standalone APK must not be debuggable" >&2
  exit 1
fi

if ! unzip -Z1 "$apk" | grep -Fxq "assets/index.android.bundle"; then
  echo "React Native JS bundle missing: assets/index.android.bundle" >&2
  exit 1
fi

bundle_size=$(unzip -p "$apk" assets/index.android.bundle | wc -c | tr -d " ")
if [[ "$bundle_size" -lt 1024 ]]; then
  echo "React Native JS bundle is unexpectedly small: $bundle_size bytes" >&2
  exit 1
fi

permissions=$("$aapt2" dump permissions "$apk")
for required in android.permission.INTERNET android.permission.CAMERA android.permission.RECORD_AUDIO android.permission.POST_NOTIFICATIONS; do
  grep -Fq "uses-permission: name='$required'" <<<"$permissions"
done

for forbidden in android.permission.WRITE_EXTERNAL_STORAGE android.permission.READ_EXTERNAL_STORAGE android.permission.DOWNLOAD_WITHOUT_NOTIFICATION android.permission.ACCESS_WIFI_STATE android.permission.ACCESS_NETWORK_STATE android.permission.WAKE_LOCK; do
  if grep -Fq "uses-permission: name='$forbidden'" <<<"$permissions"; then
    echo "Forbidden Android permission in standalone APK: $forbidden" >&2
    exit 1
  fi
done

abis=$(unzip -Z1 "$apk" | sed -n 's#^lib/\([^/]*\)/.*\.so$#\1#p' | sort -u | paste -sd, -)
if [[ "$abis" != "arm64-v8a,armeabi-v7a,x86,x86_64" ]]; then
  echo "Unexpected Android ABI set: $abis" >&2
  exit 1
fi

if unzip -Z1 "$apk" | grep -Eiq "(\.keystore$|\.jks$|private[_-]?key|pairing[_-]?secret|\.pem$|\.p12$|\.env$)"; then
  echo "Forbidden key or secret-like file name in standalone APK" >&2
  exit 1
fi

echo "Android standalone APK verification: PASS (bundle=$bundle_size bytes; abis=$abis)"
