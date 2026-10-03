# CetaMesh Mobile

Independent React Native/TypeScript mobile node. M0–M4 foundations and the M5–M8
Device Mesh track are implemented: Task/Approval, trusted transport and durable
sync contracts, local-only inbox/voice foundations, Action Center, and safe
declarative extensions. Mobile remains usable without Desktop, DSH or QQ; a
peer is an optional future mesh participant. See [PROJECT_STATE.md](PROJECT_STATE.md),
[M5–M8 implementation acceptance](docs/acceptance/M5_M8_IMPLEMENTATION.md),
and [current architecture](docs/architecture/MOBILE_ARCHITECTURE.md).

The repository/Node/JavaScript gate passes locally. Android Debug Build/APK
static evidence is retained from CI, but the current Linux workspace has not
run a fresh APK install/start, iOS native compilation, physical capability
behavior, Push delivery, or real Desktop/Server interoperability. Those items
are explicitly not claimed as PASS.

Memory works offline without Provider setup: open Memory to create/search/edit/
pin/delete local records. In Chat, “提取记忆候选” previews explicit “记住/Remember”
requests; each needs confirmation. Scope is local-only and memories are never
automatically uploaded or sent to a model.
See [M2 architecture](docs/architecture/M2_LOCAL_MEMORY.md) and
[M2 acceptance](docs/acceptance/M2_ACCEPTANCE.md).

Open Devices to view the hardware-backed public device identity and scan a
compatible peer's short-lived pairing QR. Confirm the HTTPS destination before
key exchange, then compare the device ID/public key and explicitly confirm trust.
Trusted devices can be removed. Chat and Memory work without a paired device.
Pairing does not start sync or upload Memory. Android requires a hardware-backed
Keystore; iOS requires Secure Enclave, so pairing may be unavailable on simulators.
The Desktop repository has not been changed; real peer interoperability is still
pending. See [M3 architecture](docs/architecture/M3_IDENTITY_PAIRING.md),
[wire contract](docs/protocol/M3_PAIRING_V1.md) and
[acceptance](docs/acceptance/M3_ACCEPTANCE.md).

Configure a trusted HTTPS Chat Completions provider, save its key in system
secure storage, then enter/discover a Model ID and create a chat. Model,
reasoning and mode are saved per session. Smart currently uses the model only.
Text documents and JPEG/PNG/WebP images can be selected through permissioned
pickers; no content is uploaded until Send. Desktop/DSH/QQ are not required.

M5–M8 additions are intentionally contract-first. Tasks are CetaMesh-owned and
reference replaceable Provider/Session executions. Memory synchronization is
limited to an explicitly authorized `my-devices` scope; Task synchronization
contains state and artifact metadata, not transcripts. Remote capabilities are
finally authorized by the local device. Extensions are declarative or
remote-transport data only: no downloaded JavaScript, executable payload,
unrestricted shell or unrestricted native bridge.

Run `npm ci`, then `npm run check` for local automated checks. Android uses the
committed Gradle wrapper and SDK/NDK versions in android/build.gradle
(SDK 37, Build Tools 37.0.0, NDK 27.1.12297006, minimum Android API 24).
The published SDK Manager platform package is `platforms;android-37.0`, not
`platforms;android-37`; CI installs that explicit package without lowering API level.
CI verifies the Debug APK signature, manifest/permissions, configured ABIs and M3
native module presence with `scripts/verify-android-debug-apk.sh` before upload.
Install those using Android Studio, configure ANDROID_HOME, and use
`npm run android:debug` to build or `npm run android` to install.
iOS native build requires macOS/Xcode and Pods. Commands below are the standard
React Native setup reference; Android CI is verified above, while local native
startup and iOS build have not been verified in this environment.

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.

## Debug signing

Signing keys are not committed. CI generates a disposable Debug key per run.
For local Android builds, first generate `android/app/debug.keystore` using the
`Generate disposable Debug signing key` command in `.github/workflows/android-ci.yml`.
CI APKs from different runs use different keys; Android may require uninstalling
the earlier APK (which clears its data). For upgrade/persistence acceptance, build
both versions locally with the same locally retained Debug key.
