#!/usr/bin/env bash
set -euo pipefail

apk=${1:-}
if [[ -z "$apk" || ! -f "$apk" ]]; then
  echo "Usage: $0 <debug-apk>" >&2
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

permissions=$("$aapt2" dump permissions "$apk")
for required in android.permission.INTERNET android.permission.CAMERA android.permission.RECORD_AUDIO android.permission.POST_NOTIFICATIONS; do
  grep -Fq "uses-permission: name='$required'" <<<"$permissions"
done
for forbidden in \
  android.permission.WRITE_EXTERNAL_STORAGE \
  android.permission.READ_EXTERNAL_STORAGE \
  android.permission.DOWNLOAD_WITHOUT_NOTIFICATION \
  android.permission.ACCESS_WIFI_STATE \
  android.permission.ACCESS_NETWORK_STATE \
  android.permission.WAKE_LOCK; do
  if grep -Fq "uses-permission: name='$forbidden'" <<<"$permissions"; then
    echo "Forbidden Android permission in Debug APK: $forbidden" >&2
    exit 1
  fi
done

manifest=$("$aapt2" dump xmltree "$apk" --file AndroidManifest.xml)
grep -Fq 'android:allowBackup' <<<"$manifest"
grep -F 'android:allowBackup' <<<"$manifest" | grep -Fq '=false'
awk '
  /android:name.*com.cetameshmobile.camera.CetaQrActivity/ { scanner=1; next }
  scanner && /android:exported.*=false/ { safe=1; exit }
  scanner && /E: activity/ { exit }
  END { exit safe ? 0 : 1 }
' <<<"$manifest"

abis=$(unzip -Z1 "$apk" | sed -n 's#^lib/\([^/]*\)/.*\.so$#\1#p' | sort -u | paste -sd, -)
if [[ "$abis" != 'arm64-v8a,armeabi-v7a,x86,x86_64' ]]; then
  echo "Unexpected Android ABI set: $abis" >&2
  exit 1
fi

dex_strings=$(unzip -p "$apk" 'classes*.dex' | strings)
for module in CetaDeviceIdentity CetaQrScanner CetaPairingTransport CetaCameraCapture CetaMicrophoneRecord CetaNotificationSend; do
  grep -Fq "$module" <<<"$dex_strings"
done

if unzip -Z1 "$apk" | grep -Eiq '(\.keystore$|\.jks$|private[_-]?key|pairing[_-]?secret|\.pem$|\.p12$|\.env$)'; then
  echo 'Forbidden key or secret-like file name in Debug APK' >&2
  exit 1
fi

echo "Android Debug APK verification: PASS ($abis)"
