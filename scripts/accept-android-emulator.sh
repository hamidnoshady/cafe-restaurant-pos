#!/usr/bin/env bash
set -Eeuo pipefail

# Runs inside reactivecircus/android-emulator-runner after the API 30 emulator
# has completed its initial boot. This is emulator-only trust validation; real
# Android onboarding remains a separately evidenced release gate.

on_error() {
  local code=$?
  local line=${BASH_LINENO[0]:-unknown}
  local command=${BASH_COMMAND:-unknown}
  command=${command//'%'/'%25'}
  command=${command//$'\r'/'%0D'}
  command=${command//$'\n'/'%0A'}
  printf '::error file=scripts/accept-android-emulator.sh,line=%s,title=Android trust fixture::Command failed with exit code %s: %s\n' "$line" "$code" "$command"
  exit "$code"
}
trap on_error ERR

wait_for_android_boot() {
  local phase=$1
  local attempt=0

  if ! timeout 180 adb wait-for-device; then
    printf '::error file=scripts/accept-android-emulator.sh,title=Android trust fixture::%s: adb device did not return within 180 seconds\n' "$phase"
    return 1
  fi

  while (( attempt < 120 )); do
    if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
      return 0
    fi
    ((attempt += 1))
    sleep 2
  done

  printf '::error file=scripts/accept-android-emulator.sh,title=Android trust fixture::%s: Android did not finish booting within 240 seconds\n' "$phase"
  adb shell getprop || true
  adb logcat -d | tail -n 300 || true
  return 1
}

ensure_adb_root() {
  local phase=$1
  local attempt output uid

  # android-emulator-runner reports boot completion before adbd has always
  # settled. `adb root` can therefore race a short offline/restarting window
  # even on the same API 30 userdebug image that supports root. Retry only that
  # transport transition and prove the resulting daemon identity; never mask a
  # production image that consistently refuses root.
  for attempt in $(seq 1 12); do
    timeout 30 adb wait-for-device >/dev/null 2>&1 || true
    output=$(timeout 30 adb root 2>&1) || true
    timeout 30 adb wait-for-device >/dev/null 2>&1 || true
    uid=$(adb shell id -u 2>/dev/null | tr -d '\r' || true)
    if [[ "$uid" == "0" ]]; then
      printf 'adb root ready during %s (attempt %s): %s\n' "$phase" "$attempt" "$output"
      return 0
    fi
    printf '::notice file=scripts/accept-android-emulator.sh,title=Android trust fixture::%s: adb root attempt %s/12 not ready (%s; uid=%s)\n' "$phase" "$attempt" "$output" "${uid:-unavailable}"
    sleep 5
  done

  printf '::error file=scripts/accept-android-emulator.sh,title=Android trust fixture::%s: adb did not become root after bounded retries\n' "$phase"
  return 1
}

CA_CERT="$RUNNER_TEMP/mobile-android/gateway-certificates/business-suite-local-ca.crt"
RESULT="$RUNNER_TEMP/mobile-android/browser-result.json"
SERVER_LOG="$RUNNER_TEMP/mobile-android/server.log"

ensure_adb_root "initial emulator boot"
# API 29/30 writable-system images can boot-loop when adb disable-verity is
# used alone. Disable Android Verified Boot verification before rebooting, then
# let adb remount create the writable overlay.
adb shell avbctl disable-verification
adb reboot
wait_for_android_boot "post-AVB reboot"
ensure_adb_root "post-AVB reboot"
adb remount

HASH=$(openssl x509 -in "$CA_CERT" -subject_hash_old -noout)
adb push "$CA_CERT" "/system/etc/security/cacerts/${HASH}.0"
adb shell chmod 644 "/system/etc/security/cacerts/${HASH}.0"
adb reboot
wait_for_android_boot "post-CA reboot"
adb shell test -r "/system/etc/security/cacerts/${HASH}.0"

ACCEPTANCE_URL='https://10.0.2.2:9443/acceptance?platform=android-emulator'
if adb shell pm path com.android.chrome >/dev/null 2>&1; then
  # A clean emulator otherwise stops at Chrome's first-run UI instead of
  # navigating to the acceptance URL. Keep this scoped to the disposable test
  # emulator; no browser security control is disabled.
  adb shell pm clear com.android.chrome >/dev/null
  adb shell am set-debug-app --persistent com.android.chrome
  adb shell 'printf "%s\n" "chrome --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
  adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main -a android.intent.action.VIEW -d "$ACCEPTANCE_URL"
else
  printf '::notice file=scripts/accept-android-emulator.sh,title=Android trust fixture::Chrome package is absent; using the image default HTTPS handler\n'
  adb shell am start -a android.intent.action.VIEW -d "$ACCEPTANCE_URL"
fi

for _ in $(seq 1 45); do
  if grep -q '"completed": true' "$RESULT"; then
    cat "$RESULT"
    exit 0
  fi
  sleep 2
done

printf '::error file=scripts/accept-android-emulator.sh,title=Android trust fixture::Chrome did not complete trusted HTTPS and WSS acceptance within 90 seconds\n'
adb logcat -d | tail -n 300 || true
cat "$SERVER_LOG"
cat "$RESULT"
exit 1
