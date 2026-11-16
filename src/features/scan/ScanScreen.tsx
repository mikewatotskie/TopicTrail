import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { TTButton, TTFeedback, TTFigmaIcon, TTIconButton, TTNoticeCard, TTScreen } from '../../components';
import { TTAppBar } from '../../navigation';
import { TTRadius, TTSpacing, TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { DocumentImportService } from '../../core/services/document_import';
import { DocumentStorage } from '../../core/services/document_storage';
import { useCloudLibrary } from '../library/CloudLibraryContext';
import { useOcrCache } from '../reader/useOcrCache';
import { takeDockScan } from './scan_entry';
import { ScanCamera } from './ScanCamera';
import { choosePhoto, releasePhoto, rotatePhoto, photoBytes, recognizePhoto } from './photo_platform';
import { withScanPdfSource } from './pdf_source';
import { guardScanStorage, ScanDraft } from './scan_draft';

/** Each account epoch and focused route lifetime owns a fresh private draft and cache scope. */
export function ScanScreen() {
  const { state } = useCloudLibrary();
  const focused = useIsFocused();
  return focused ? <PrivateScan key={`${state.epoch}:${state.key ?? (state.phase === 'guest' ? 'guest' : 'unavailable')}`} /> : null;
}

function PrivateScan() {
  const router = useRouter();
  const { source, entry, request } = useLocalSearchParams<{ source?: string; entry?: string; request?: string }>();
  const openCamera = useRef<(() => void) | null>(null);
  const { colors } = useColors();
  const { state: account, runtime } = useCloudLibrary();
  const cache = useOcrCache();
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraLifetime, setCameraLifetime] = useState(0);
  const [draft] = useState(() => {
    const epoch = account.epoch, key = account.key;
    const available = !!account.identity || account.phase === 'guest';
    return new ScanDraft({
      isCurrent: () => available && (!runtime || (runtime.getSnapshot().epoch === epoch && runtime.getSnapshot().key === key)),
      actor: account.identity ? { kind: 'account', uid: account.identity.uid } : { kind: 'guest' },
      choosePhoto, releasePhoto, rotatePhoto, photoBytes, recognizePhoto,
      withPdfSource: withScanPdfSource,
      importFile: (uri, name, attempt, current) => new DocumentImportService(guardScanStorage(DocumentStorage.instance, current)).importFile(uri, name, attempt),
      saveTranscript: async (hash, page, transcript) => { await cache.save(hash, page, transcript); },
      copyText: text => Clipboard.setStringAsync(text),
    });
  });
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  useFocusEffect(useCallback(() => {
    draft.activate();
    const stop = runtime?.subscribe(() => { if (!draft.isCurrent()) draft.deactivate(); });
    const appState = AppState.addEventListener('change', next => {
      // Only active OCR is cancelled. External picker/camera activity keeps its private draft.
      if (next !== 'active') draft.cancelRecognition();
    });
    return () => { appState.remove(); stop?.(); draft.deactivate(); };
  }, [draft, runtime]));
  useEffect(() => {
    let focused = true;
    let cancel: (() => void) | undefined;
    // Wait for camera effects and StrictMode's mount replay before claiming the gesture.
    void Promise.resolve().then(() => {
      if (!focused) return;
      const current = draft.getSnapshot();
      const action = takeDockScan(entry, request, account.epoch,
        draft.isCurrent() && !current.photo && !current.busy && !current.saveAttempted);
      if (!action) return;
      cancel = action.cancel;
      if (action.entry === 'capture') openCamera.current?.();
      else void draft.choose(action.pick);
    });
    return () => { focused = false; cancel?.(); };
  }, [account.epoch, draft, entry, request]);
  const [cameraError, setCameraError] = useState('');
  const available = !!account.identity || account.phase === 'guest';
  const busy = !!state.busy;
  const locked = state.saveAttempted;
  const saved = state.result?.success && state.result.document;
  const cameraReview = state.source === 'camera' && !state.confirmed;
  const controlsDisabled = !available || busy || locked;
  const back = () => {
    draft.deactivate();
    if (router.canGoBack()) router.back(); else router.replace('/(tabs)/library');
  };
  const choose = () => { setCameraActive(false); setCameraError(''); void draft.choose(); };
  const camera = !locked && state.busy !== 'choosing' && <View style={{ minWidth: 0, maxWidth: '100%', width: cameraActive ? '100%' : undefined }}><ScanCamera key={cameraLifetime} openRef={openCamera}
    label={state.source === 'camera' ? 'Retake' : 'Take a photo'} disabled={controlsDisabled}
    onActiveChange={setCameraActive}
    onPhoto={photo => { setCameraActive(false); setCameraError(''); draft.acceptPhoto(photo, 'camera'); }}
    onError={message => { if (draft.isCurrent()) { setCameraActive(false); setCameraError(message); } }} /></View>;

  return <TTScreen variant="form">
    <TTAppBar title="Scan a photo" leading={<TTIconButton semanticLabel="Back from Scan"
      icon={<TTFigmaIcon name="back" tintColor={colors.link} />} disabled={state.busy === 'saving'} onPress={back} />} />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={[TTTypography.body, { color: colors.ink }]}>Recognize printed text from a photo, then save a one-page PDF when you are ready.</Text>
      <Text style={[TTTypography.small, { color: colors.muted }]}>Recognition runs on this device. The preview is private and is not added to your library until you choose Save to library.</Text>
      {!available && <TTNoticeCard title="Library unavailable" message="Wait for your account library to finish loading, then open Scan again." />}
      {!locked && <View style={styles.controls}>
        {source === 'camera' && camera}
        <TTButton label="Choose photo" variant="secondary" disabled={controlsDisabled} onPress={choose} />
        {source !== 'camera' && camera}
      </View>}
      {!!cameraError && <TTNoticeCard type="error" title="Camera unavailable" message={`${cameraError} You can still choose a photo.`} />}
      {state.photo && <View style={styles.section}>
        <Text accessibilityRole="header" style={[TTTypography.section, { color: colors.ink }]}>Photo preview</Text>
        <Image source={{ uri: state.photo.uri }} resizeMode="contain" accessibilityRole="image"
          accessibilityLabel="Private scan photo preview. Check that the text is upright and readable."
          style={[styles.photo, { backgroundColor: colors.surface, borderColor: colors.border,
            aspectRatio: state.photo.width / state.photo.height }]} />
        {!locked && <View style={styles.controls}>
          <TTButton label="Rotate 90°" semanticLabel="Rotate photo 90 degrees clockwise" variant="secondary"
            disabled={controlsDisabled || cameraActive} isLoading={state.busy === 'rotating'} onPress={() => { void draft.rotate(); }} />
          {cameraReview && <TTButton label="Use photo" disabled={controlsDisabled || cameraActive} onPress={() => draft.usePhoto()} />}
          {state.confirmed && <TTButton label="Recognize text" disabled={controlsDisabled || cameraActive}
            isLoading={state.busy === 'recognizing'} onPress={() => { void draft.recognize(); }} />}
          {state.busy === 'recognizing' && <TTButton label="Cancel recognition" variant="ghost" onPress={() => draft.cancelRecognition()} />}
        </View>}
        {cameraReview && <Text style={[TTTypography.small, { color: colors.muted }]}>Retake opens the camera only when you press it. Use photo keeps this preview for recognition.</Text>}
      </View>}
      <TTFeedback message={state.message} style={[TTTypography.small, { color: colors.muted }]} />
      <TTFeedback kind="alert" message={state.error} style={[TTTypography.small, { color: colors.danger }]} />
      {state.transcript && <View style={styles.section}>
        <Text accessibilityRole="header" style={[TTTypography.section, { color: colors.ink }]}>Recognized text · Needs review</Text>
        <Text style={[TTTypography.small, { color: colors.muted }]}>Recognition may contain errors. Compare the text with your photo before using it.</Text>
        {state.transcript.truncated && <Text style={[TTTypography.small, { color: colors.warning }]}>Only the first 50,000 characters are shown.</Text>}
        <Text testID="scan-transcript" selectable style={[TTTypography.body, styles.transcript, { color: colors.ink, borderColor: colors.border, backgroundColor: colors.surface }]}
          accessibilityLabel={state.transcript.text.trim() ? undefined : 'No readable text found'}>
          {state.transcript.text.trim() ? state.transcript.text : 'No readable text found.'}
        </Text>
        <TTButton label="Copy transcript" variant="secondary" widthPolicy="responsiveAction"
          disabled={busy || cameraActive || !state.transcript.text.trim()} isLoading={state.busy === 'copying'} onPress={() => { void draft.copyTranscript(); }} />
      </View>}
      {!!cache.warning && <TTNoticeCard title="Device-local transcript" message={cache.warning} />}
      {(state.photo || saved) && <View style={styles.section}>
        <Text style={[TTTypography.small, { color: colors.muted }]}>{account.identity
          ? 'The saved PDF follows normal account document sync. Recognition stays local; the transcript is cached only on this device and is not embedded in the PDF.'
          : 'The saved PDF stays in your guest library on this device. The transcript is cached only on this device and is not embedded in the PDF.'}</Text>
        {saved ? <TTButton label="Open PDF" isExpanded disabled={busy} onPress={() => {
          if (draft.isCurrent()) router.replace({ pathname: '/reader/[documentId]', params: { documentId: saved.id } });
        }} /> : state.result?.code === 'already_deleted' ? <TTButton label="Back to My Syllabi" isExpanded onPress={() => router.replace('/(tabs)/library')} />
          : <TTButton label={locked ? 'Retry save' : 'Save to library'} isExpanded isLoading={state.busy === 'saving'}
            disabled={!available || busy || cameraActive || !state.confirmed} onPress={() => { void draft.save(); }} />}
        <TTButton label={saved ? 'Start another scan' : 'Discard photo'} variant="ghost" isExpanded
          disabled={state.busy === 'saving'} onPress={() => { draft.discard(); setCameraError(''); setCameraActive(false); setCameraLifetime(value => value + 1); }} />
      </View>}
      {!state.photo && !saved && <Text style={[TTTypography.small, { color: colors.muted }]}>Choose a JPG or PNG, or press Take a photo to open the camera. Cancel or leave this screen to clear the private preview.</Text>}
    </ScrollView>
  </TTScreen>;
}

const styles = StyleSheet.create({
  content: { padding: TTSpacing.space16, gap: TTSpacing.space16 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: TTSpacing.space8 },
  section: { gap: TTSpacing.space12 },
  // Bound tall receipts on desktop while retaining the entire image via contain.
  photo: { width: '100%', maxHeight: 480, borderWidth: 1, borderRadius: TTRadius.radiusMd },
  transcript: { padding: TTSpacing.space12, borderWidth: 1, borderRadius: TTRadius.radiusSm },
});

export default ScanScreen;
