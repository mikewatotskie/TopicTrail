# TopicTrail

TopicTrail is Team JAM’s syllabus reader for Android and the web, built with React Native, TypeScript and Expo. Students can import a document, select a passage and save a study resource alongside their notes.

## Reading and study

- Import a PDF, Word document (.docx) or PowerPoint presentation (.pptx). The library lists each document with its file type and available metadata.
- Use **Scan** in the middle of the mobile navigation to choose a JPG or PNG, or take a picture of a document. Review the photo, rotate it if needed and recognize printed English or Filipino text. **Save to library** creates a one-page PDF. The transcript is cached locally.
- Highlight a passage, attach a note or bookmark your place. Tap **Study** to review and edit the topic before looking it up. You can also start a search from Home.
- DuckDuckGo returns a cited quick answer when one is available. Otherwise, open the full results in your browser or look up the same topic on Wikipedia in the app. Save a resource to keep its citation available offline.

## Run the web app

Use Node.js 24.20 with npm. From the repository root, run the following commands.

```sh
npm ci
npm run web
```

Open the address printed by Expo. Guest mode stores your library locally. On the web, use the same browser and address to return to it. Visit `/demo` to open the presentation walkthrough.

For account sign-in and synchronization, copy `.env.example` to `.env.local` and set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for your hosted Supabase project. Follow the [backend setup guide](supabase/README.md) to configure the schema and sign-in emails. Restart Expo after changing these values. The app bundles `EXPO_PUBLIC_*` values, so use only public client configuration.

## Run on Android

Use JDK 17, an Android SDK, and an emulator or USB-connected phone. The native build includes TopicTrail’s camera, OCR and document reader integrations. A fresh checkout uses the Android Gradle Plugin’s standard development signer. With the device connected, run the following command from the repository root.

```sh
npm run android -- --app-id com.teamjam.topictrail.acceptance
```

The Android 1.1.0 release represented here uses version code 17. To publish a subsequent official build, the maintainer uses PowerShell 7, Android SDK Build Tools 37.0.0, and the existing private release keystore and protected password. Run `scripts/build-secure-android.ps1` with `-Variant Release` and the next unused `-VersionCode`. The build checks the signer against the public certificate fingerprint in `android/app/release-certificate.sha256`.

## Verify changes

The tests use Java tools as well as Node. Make sure `java` and `javac` from JDK 17 are on your path.

```sh
npm run typecheck
npm run lint
npm test
npm run webview:policy:check
```

The repository includes the bundled reader and OCR assets. After changing their source, run `npm run reader:bundle` to regenerate them. Dependency installation applies the required Android WebView patch automatically.
