import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Asset } from 'expo-asset';
import { readDocumentBytes } from '../../core/services/document_content';
import { ReaderFrame } from './ReaderFrame.web';
import type { ReaderConnection } from './reader_channel';
import type { ReaderInput } from './reader_protocol';
import { copyText } from '../../core/services/clipboard.web';
import { useTheme } from '../../core/theme/ThemeContext';
import { Document } from '../../core/models/document';
import { DocumentStorage } from '../../core/services/document_storage';
import { DocxTextExtraction } from '../../core/services/docx_text_extraction';
import { TTIconButton, TTNoticeCard, TTScreen, TTTextSelectionMenu, TTFigmaIcon } from '../../components';
import { TTReaderControls } from '../../components/TTReaderControls';
import { TTAppBar } from '../../navigation';
import type { ReaderMessage } from './selection';
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
  const viewer = useRef<ReaderConnection | null>(null);
  const payload = useRef<ReaderInput | null>(null);
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
      const asset = Asset.fromModule(require('../../../assets/reader/viewer.html'));
      const response = await fetch(asset.uri);
      if (!response.ok) throw new Error('The offline reader could not be loaded. Please retry.');
      const readerHtml = await response.text();
      const bytes = doc.format === 'pdf' ? await readDocumentBytes(doc.filePath) : undefined;
      const input: ReaderInput = doc.format === 'pdf'
        ? { format: 'pdf', bytes: bytes!.slice().buffer as ArrayBuffer, dark: colorScheme === 'dark' }
        : { format: 'docx', paragraphs: await DocxTextExtraction.instance.extractParagraphs(doc), dark: colorScheme === 'dark' };
      if (!active) return;
      payload.current = input; setDocument(doc); setHtml(readerHtml);
      await DocumentStorage.instance.updateLastOpened(doc.id).catch(() => {
        if (active) setStorageWarning('Recent activity could not be saved. You can still read this syllabus.');
      });
    })().catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : 'Unable to open syllabus'); setBusy(false); } });
    return () => { active = false; payload.current = null; viewer.current?.dispose(); viewer.current = null; selected.current = ''; };
  // A theme change updates the live reader; it must not reload document bytes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, hydrateProgress]);
  useEffect(() => { viewer.current?.theme(colorScheme === 'dark'); }, [colorScheme]);
  function failReader(message: string) {
    selected.current = ''; setText(''); setSelectionWarning(''); setError(message); setBusy(false);
  }
  function changePage(value: number) { setBusy(true); setText(''); setSelectionWarning(''); selected.current = ''; viewer.current?.page(value); }
  function changeZoom(value: number) { const next = Math.max(0.5, Math.min(3, value)); setText(''); selected.current = ''; setZoom(next); setBusy(true); viewer.current?.zoom(next); }
  async function copy() {
    const passage = selected.current;
    if (!passage.trim()) return;
    try { await copyText(passage); if (selected.current === passage) setSelectionWarning('Selected text copied.'); }
    catch { if (selected.current === passage) setSelectionWarning('Clipboard access was denied. Use your browser copy command or try again.'); }
  }
  function study() {
    if (!selected.current.trim() || !document) return;
    setSelection({ documentId: document.id, text: selected.current, page });
    router.push('/topic-preview');
  }
  return <TTScreen variant="reader">
    <TTAppBar title={document?.title ?? 'Syllabus'} leading={<TTIconButton
      icon={<TTFigmaIcon name="back" />} semanticLabel="Go back"
      onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/library')} />}
      actions={text ? [<TTIconButton key="clear" icon={<TTFigmaIcon name="close" />} semanticLabel="Clear selection"
        onPress={() => { selected.current = ''; setText(''); viewer.current?.clearSelection(); }} />] : undefined} />
    <View style={{ padding: 16, backgroundColor: colors.canvas }}>
      <Text style={{ color: colors.muted }}>Select a topic in the document, then choose Study.</Text>
      {document?.format === 'docx' && <Text style={{ fontFamily: 'Inter', fontSize: 12, lineHeight: 16, color: colors.muted, marginTop: 8 }}>Word text view · section {page} of {pages}</Text>}
    </View>
    <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        {!!html && <ReaderFrame html={html} onConnect={connection => { viewer.current = connection; }}
          onFailure={() => failReader('The isolated reader could not load. Please retry.')}
          onMessage={(message: ReaderMessage) => {
            if (message.type === 'ready' && payload.current) {
              viewer.current?.load({ ...payload.current, dark: colorScheme === 'dark' }); payload.current = null;
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
            onCopy={copy} onSelectAll={() => viewer.current?.selectAll()} onStudy={study} />
        </View>}
      </View>
    {!!error && <TTNoticeCard type="error" title="Unable to read this document" message={error}
      actionLabel="Retry" onActionPressed={onRetry} />}
    {!busy && !error && !hasText && <TTNoticeCard title="No selectable text on this page"
      message="Try another page or a text-based document. Scanned pages need OCR, which is not available yet."
      actionLabel="Choose another file" onActionPressed={() => router.push('/upload')} />}
    {!!selectionWarning && <TTNoticeCard title="Selection" message={selectionWarning} />}
    {!!(storageWarning || progressWarning) && <TTNoticeCard title="Reading is still available"
      message={[storageWarning, progressWarning].filter(Boolean).join(' ')} />}
    <TTReaderControls page={page} pages={pages} zoom={zoom} busy={busy || !!error} section={document?.format === 'docx'} onPage={changePage} onZoom={changeZoom} />
  </TTScreen>;
}
export default ReaderScreen;
