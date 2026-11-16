# TopicTrail cloud setup

Guest libraries work on the device without a Supabase project. To enable signed-in cloud libraries on a fresh project, use the following SQL scripts in the Supabase SQL Editor, connected to the `postgres` database as the `postgres` role. The scripts expect the standard Supabase Auth and Storage schemas and row-level security on `storage.objects`.

1. Run [01-documents.sql](setup/01-documents.sql) to create the private `topictrail-documents` bucket, document metadata table and ownership policies.
2. Run [02-study-sync.sql](setup/02-study-sync.sql) to add study-state synchronization, including bookmarks and reading progress.
3. Run [03-annotations.sql](setup/03-annotations.sql) to add annotation storage and synchronization.
4. Run [04-powerpoint.sql](setup/04-powerpoint.sql) to extend the bucket, format constraint and ownership policies to PowerPoint. This update verifies the original policies and preserves existing document metadata.

Run each file once, in order. Each uses its own transaction and checks its prerequisites. If a script reports an existing object, a different policy or schema drift, inspect the existing deployment before continuing. Projects already running TopicTrail should compare their installed objects against these scripts. Keep the helper schemas `topictrail_sync_private` and `topictrail_annotations_v1_private` outside the exposed Data API schemas. The client uses the public Data API and Supabase Storage.

Copy `.env.example` to `.env.local` in the app folder. Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to your project's URL and public client key. Restart Expo after changing them.

### Email verification and recovery

For the app's code-entry flow, set the confirmation and password-reset email bodies in Supabase Auth to [confirmation.html](templates/confirmation.html) and [recovery.html](templates/recovery.html). Both use the Supabase `{{ .Token }}` template variable. Enable email/password sign-in and email confirmation, then verify that both emails deliver a code to a test account. Set `EXPO_PUBLIC_TOPICTRAIL_EMAIL_CODES_REF` to that project's reference after both flows work.

### Check a configured project

Sign in with a test account and import a PDF, DOCX and PPTX. Reopen the account on another device, download an original, and confirm that reading progress, a saved resource and an annotation sync. A second account should see only its own library.
