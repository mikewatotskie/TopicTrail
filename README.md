# TopicTrail

Team JAM's syllabus reader, built with React Native, TypeScript and Expo for Android and web.

## Current implementation

- PDF/DOCX import, local library and selectable-text reading.
- Educational-resource discovery and bookmarks.
- Local reading progress and a presentation walkthrough.
- Supabase authentication.

**Real cloud document synchronization is not implemented in this upload.** Signing in on another device does not currently retrieve local files. The presentation's cross-device cards are explicitly simulated. PPTX and OCR remain pending. The browser presentation was exercised; the latest Android presentation APK was built and signature-checked but has not been qualified on a phone.

## Run from source

Use Node.js and install the locked dependencies:

```sh
npm ci
npm run web
```

Open the address printed by Expo. `/demo` opens the presentation guide. Browser libraries belong to their browser and address; keep the same address to retain your library.

For account functionality, create a local `.env.local` using `.env.example` and supply your Supabase project's public URL and publishable key. Never add service-role keys, passwords or personal access tokens to the app. Firebase configuration/modules remain available for rollback.

```sh
npm run typecheck
npm test
npm run webview:policy:check
```

## Android

Native source and the Gradle wrapper are included. Use an Android SDK and compatible JDK. Signing keys and local SDK paths are intentionally excluded; configure a local development keystore before building. The guarded WebView patch applied by `npm ci` is required. Expo Go does not establish native download-policy enforcement.

## Repository contents

Source, assets, tests and build scripts are versioned. Local credentials, personal libraries, dependency folders, generated builds, APKs and internal work records remain on the development computer. `START-PRESENTATION.cmd` expects a prebuilt `dist-presentation` export; use `npm run web` for a fresh checkout.

The earlier project planning documents remain for historical context; their Flutter/planned-feature descriptions predate this React Native implementation.
