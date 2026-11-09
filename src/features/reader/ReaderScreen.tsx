import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, Alert, Platform } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import * as Clipboard from 'expo-clipboard';
import WebView from 'react-native-webview';
import { useTheme } from '../../core/theme/ThemeContext';
import { Document } from '../../core/models/document';
import { DocumentStorage } from '../../core/services/document_storage';
import { DocxTextExtraction } from '../../core/services/docx_text_extraction';
import { MAX_FILE_SIZE_BYTES } from '../../core/services/document_validation';
import { TTIconButton, TTNoticeCard, TTScreen, TTTextSelectionMenu, TTFigmaIcon, TTInfoBanner } from '../../components';
import { TTReaderControls } from '../../components/TTReaderControls';
import { TTAppBar } from '../../navigation';
import { parseReaderMessage } from './selection';
import { useStudySelection } from './StudySelectionContext';
import { useReadingProgress } from './useReadingProgress';

export function ReaderScreen() {
  const { documentId } = useLocalSearchParams<{ documentId: string }>();
  return <DocumentReader key={documentId} documentId={documentId} />;
}
function DocumentReader({ documentId }: { documentId: string }) {
  const [attempt, setAttempt] = useState(0);
  return <ReaderAttempt key={attempt} documentId={documentId} onRetry={() => setAttempt(value => value + 1)} />;
}
function ReaderAttempt({ documentId, onRetry }: { documentId: string; onRetry: () => void }) {
  const { colors, colorScheme } = useTheme();
  const { hydrateProgress, acceptRenderedPage, progressWarning } = useReadingProgress();
  const { setSelection } = useStudySelection();
  const viewer = useRef<WebView<object>>(null);
  const payload = useRef<object | null>(null);
  const selected = useRef('');
  const [document, setDocument] = useState<Document | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [text, setText] = useState('');
  const [selectionWarning, setSelectionWarning] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const [hasText, setHasText] = useState(true);
  useEffect(() => {
    let active = true;
    (async () => {
      const doc = await DocumentStorage.instance.getDocument(documentId);
      if (!active) return;
      if (!doc) throw new Error('This syllabus is no longer in your library.');
      await hydrateProgress(doc, () => active);
      if (!active) return;
      const file = new File(doc.filePath);
      if (!file.exists) throw new Error('The stored file is missing. Please import it again.');
      if ((file.size ?? 0) > MAX_FILE_SIZE_BYTES) throw new Error('This document exceeds the 50 MB limit.');
      const asset = await Asset.fromModule(require('../../../assets/reader/viewer.html')).downloadAsync();
      if (!asset.localUri) throw new Error('The offline reader could not be loaded.');
      const readerHtml = await new File(asset.localUri).text();
      const input = doc.format === 'pdf' ? { format: doc.format, base64: await file.base64() }
        : { format: doc.format, paragraphs: await DocxTextExtraction.instance.extractParagraphs(doc) };
      if (!active) return;
      payload.current = input; setDocument(doc); setHtml(readerHtml);
      await DocumentStorage.instance.updateLastOpened(doc.id).catch(() => {
        if (active) setStorageWarning('Recent activity could not be saved. You can still read this syllabus.');
      });
    })().catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : 'Unable to open syllabus'); setBusy(false); } });
    return () => { active = false; payload.current = null; };
  }, [documentId, hydrateProgress]);
  const source = useMemo(() => html ? { html } : undefined, [html]);
  useEffect(() => { viewer.current?.injectJavaScript('window.TopicTrailReader?.theme(' + (colorScheme === 'dark') + '); true;'); }, [colorScheme]);
  function command(value: string) { viewer.current?.injectJavaScript('window.TopicTrailReader.' + value + '; true;'); }
  function failReader(message: string) {
    selected.current = ''; setText(''); setSelectionWarning(''); setError(message); setBusy(false);
  }
  function changePage(value: number) { setBusy(true); setText(''); setSelectionWarning(''); selected.current = ''; command('page(' + value + ')'); }
  function changeZoom(value: number) { const next = Math.max(0.5, Math.min(3, value)); setText(''); selected.current = ''; setZoom(next); setBusy(true); command('zoom(' + next + ')'); }
  async function copy() {
    try { await Clipboard.setStringAsync(selected.current); Alert.alert('Copied', 'Selected text copied to clipboard.'); }
    catch { Alert.alert('Unable to copy', 'Please try again.'); }
  }
  function study() {
    if (!selected.current.trim() || !document) return;
    setSelection({ documentId: document.id, text: selected.current, page });
    router.push('/topic-preview');
  }
  return <TTScreen>
    <TTAppBar title={document?.title ?? 'Syllabus'} leading={<TTIconButton
      icon={<TTFigmaIcon name="back" />} semanticLabel="Go back"
      onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/library')} />}
      actions={text ? [<TTIconButton key="clear" icon={<TTFigmaIcon name="close" />} semanticLabel="Clear selection"
        onPress={() => { selected.current = ''; setText(''); command('clearSelection()'); }} />] : undefined} />
    <View style={{ padding: 16, backgroundColor: colors.canvas }}>
      <TTInfoBanner message={text ? 'Tap Study to review your selected topic.' : 'Touch and hold a topic, then tap Study.'} />
      {document?.format === 'docx' && <Text style={{ fontFamily: 'Inter', fontSize: 12, lineHeight: 16, color: colors.muted, marginTop: 8 }}>Word text view · section {page} of {pages}</Text>}
    </View>
    {Platform.OS === 'web' ? <TTNoticeCard title="Use the mobile app" message="The interactive document reader is available in the Android app." />
      : <View style={{ flex: 1 }}>
        {!!source && <WebView<object> ref={viewer} source={source} originWhitelist={['*']}
          onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
          allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
          javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false}
          mixedContentMode="never" cacheEnabled={false} domStorageEnabled={false}
          style={{ backgroundColor: colors.canvas }}
          onError={() => failReader('The document reader could not load. Please retry.')}
          onMessage={event => {
            const message = parseReaderMessage(event.nativeEvent.data);
            if (!message) return;
            if (message.type === 'ready' && payload.current) {
              command('load(' + JSON.stringify({ ...payload.current, dark: colorScheme === 'dark' }) + ')');
              payload.current = null;
            } else if (message.type === 'page') {
              if (!acceptRenderedPage(message, changePage)) return;
              setPage(message.page); setPages(message.totalPages); setHasText(message.hasText); setBusy(false); setError('');
            } else if (message.type === 'selection' && message.page === page) {
              selected.current = message.text; setText(message.text); setSelectionWarning('');
            } else if (message.type === 'selection-limit') {
              selected.current = ''; setText(''); setSelectionWarning('Select a passage of 50,000 characters or less.');
            } else if (message.type === 'error') { failReader(message.message); }
          }} />}
        {busy && <View pointerEvents="none" style={{ position: 'absolute', inset: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.canvas }}>
          <ActivityIndicator color={colors.link} /><Text style={{ color: colors.ink, marginTop: 8 }}>Loading syllabus…</Text>
        </View>}
        {!!text.trim() && <View style={{ position: 'absolute', left: 0, right: 0, bottom: 16 }}>
          <TTTextSelectionMenu selectedText={text} canStudy={!busy && !error}
            onCopy={copy} onSelectAll={() => command('selectAll()')} onStudy={study} />
        </View>}
      </View>}
    {!!error && <TTNoticeCard type="error" title="Unable to read this document" message={error}
      actionLabel="Retry" onActionPressed={onRetry} />}
    {!busy && !error && !hasText && <TTNoticeCard title="No selectable text on this page"
      message="Try another page or a text-based document. Scanned pages need OCR, which is not available yet."
      actionLabel="Choose another file" onActionPressed={() => router.push('/upload')} />}
    {!!selectionWarning && <TTNoticeCard title="Choose a shorter passage" message={selectionWarning} />}
    {!!(storageWarning || progressWarning) && <TTNoticeCard title="Reading is still available"
      message={[storageWarning, progressWarning].filter(Boolean).join(' ')} />}
    <TTReaderControls page={page} pages={pages} zoom={zoom} busy={busy || !!error || Platform.OS === 'web'} section={document?.format === 'docx'} onPage={changePage} onZoom={changeZoom} />
  </TTScreen>;
}
export default ReaderScreen;
