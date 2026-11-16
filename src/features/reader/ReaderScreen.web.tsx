import { usePageOcr } from './usePageOcr';
import { sha256 } from '../../core/services/cloud/sha256';
import { parsePptx } from '../../core/services/pptx_parser';
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, AppState } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
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
import { TTNoticeCard, TTScreen, TTTextSelectionMenu } from '../../components';
import { useReaderNotes } from '../notes/useReaderNotes';
import { TTReaderControls } from '../../components/TTReaderControls';
import { ReaderToolbar } from './ReaderToolbar';
import type { ReaderMessage } from './selection';
import { useStudySelection } from './StudySelectionContext';
import { useReadingProgress } from './useReadingProgress';
import { useCloudLibrary } from '../library/CloudLibraryContext';
import { CloudStudyConflicts } from '../library/CloudStudyConflicts';

export function ReaderScreen() {
  const {state}=useCloudLibrary();
  const { documentId } = useLocalSearchParams<{ documentId: string }>();
  return <DocumentReader key={`${state.epoch}:${documentId}`} documentId={documentId} />;
}
function DocumentReader({ documentId }: { documentId: string }) {
  const [attempt, setAttempt] = useState(0);
  return <ReaderAttempt key={attempt} documentId={documentId} onRetry={() => setAttempt(value => value + 1)} />;
}
function ReaderAttempt({ documentId, onRetry }: { documentId: string; onRetry: () => void }) {
  const router = useRouter();
  const { colors, colorScheme } = useTheme();
  const { hydrateProgress, acceptRenderedPage, progressWarning } = useReadingProgress();
  const { setSelection } = useStudySelection();
  const viewer = useRef<ReaderConnection | null>(null);
  const payload = useRef<ReaderInput | null>(null);
  const selected = useRef('');
  const ocr = usePageOcr(viewer);
  const [contentHash,setContentHash] = useState('');
  const visiblePage = useRef(1);
  const viewRevision=useRef(0);
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
  const [toolsOpen,setToolsOpen]=useState(false),[focus,setFocus]=useState(false);
  const notes=useReaderNotes(document,contentHash,page,viewer,changePage);
  useEffect(()=>{const listener=AppState.addEventListener('change',state=>{if(state!=='active')viewer.current?.cancelArea();});return()=>listener.remove();},[]);
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
      const bytes = await readDocumentBytes(doc.filePath);
      const hash = sha256(bytes);
      const input: ReaderInput = doc.format === 'pdf'
        ? { format: 'pdf', bytes: bytes!.slice().buffer as ArrayBuffer, dark: colorScheme === 'dark' }
        : doc.format === 'pptx' ? { format: 'pptx', slides: parsePptx(bytes), dark: colorScheme === 'dark' }
        : { format: 'docx', paragraphs: await DocxTextExtraction.instance.extractParagraphs(doc), dark: colorScheme === 'dark' };
      if (!active) return;
      payload.current = input; setContentHash(hash); setDocument(doc); setHtml(readerHtml);
      await DocumentStorage.instance.updateLastOpened(doc.id).catch(() => {
        if (active) setStorageWarning('Recent activity could not be saved. You can still read this syllabus.');
      });
    })().catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : 'Unable to open syllabus'); setBusy(false); } });
    return () => { active = false; payload.current = null;selected.current = ''; };
  // A theme change updates the live reader; it must not reload document bytes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, hydrateProgress]);
  useEffect(() => { viewer.current?.theme(colorScheme === 'dark'); }, [colorScheme]);
  function failReader(message: string) {
    ocr.reset();
    viewRevision.current++;notes.receive({type:'error',message});viewer.current?.cancelArea();viewer.current?.dispose();
    selected.current = ''; setText(''); setSelectionWarning(''); setError(message); setBusy(false);
  }
  function changePage(value: number) {ocr.reset();viewRevision.current++;notes.beforeNavigation();visiblePage.current=value;setBusy(true); setText(''); setSelectionWarning(''); selected.current = ''; viewer.current?.page(value); }
  function changeZoom(value: number) {ocr.reset();viewRevision.current++;notes.beforeNavigation(true);const next = Math.max(0.5, Math.min(3, value)); setText(''); selected.current = ''; setZoom(next); setBusy(true); viewer.current?.zoom(next); }
  async function copy() {
    const passage = selected.current;
    if (!passage.trim()) return;
    try { await copyText(passage); if (selected.current === passage) setSelectionWarning('Selected text copied.'); }
    catch { if (selected.current === passage) setSelectionWarning('Clipboard access was denied. Use your browser copy command or try again.'); }
  }
  function clearReaderSelection() {
    selected.current = '';
    setText('');
    setSelectionWarning('');
    notes.clear();
    viewer.current?.clearSelection();
  }
  function study() {
    if (!selected.current.trim() || !document) return;
    setSelection({ documentId: document.id, text: selected.current, page });
    clearReaderSelection();
    router.push('/topic-preview');
  }
  return <TTScreen variant="reader">
    <ReaderToolbar title={document?.title ?? 'Syllabus'} format={document?.format} page={page} pages={pages}
      selection={!!text.trim()} focus={focus} toolsOpen={toolsOpen} disabled={busy || !!error}
      onBack={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/library')}
      onClear={clearReaderSelection}
      onNotes={notes.openPanel} onTools={() => setToolsOpen(value => !value)} onFocus={() => setFocus(value => !value)}
      onDocumentNote={notes.newDocumentNote} onLocationNote={notes.newLocationNote}
      onMark={() => notes.mark('drag')} onCorners={() => notes.mark('corners')} />
    <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        {!!html && <ReaderFrame html={html} onConnect={connection => { viewer.current = connection; }}
          onFailure={() => failReader('The isolated reader could not load. Please retry.')}
          onMessage={(message: ReaderMessage) => {
            if(message.type==='page'&&!acceptRenderedPage(message,changePage))return;
            notes.receive(message);
            if(message.type==='render-start'||message.type==='surface-change'||message.type==='selection-reset'){viewRevision.current++;selected.current='';setText('');if(message.type==='render-start'){ocr.reset();setBusy(true);}return;}
            if (message.type === 'ready' && payload.current) {
              viewer.current?.load({ ...payload.current, dark: colorScheme === 'dark' }); payload.current = null;
            } else if (message.type === 'page') {
              visiblePage.current=message.page;
              if(document?.format==='pdf'&&contentHash)ocr.onPage(contentHash,message.page);
              setPage(message.page); setPages(message.totalPages); setHasText(message.hasText); setBusy(false); setError('');
            } else if (message.type === 'ocr-status' || message.type === 'ocr-result') {
              ocr.receive(message);
            } else if (message.type === 'selection' && message.page === visiblePage.current && message.text) {
              selected.current = message.text; setText(message.text); setSelectionWarning('');
            } else if (message.type === 'selection-limit') {
              selected.current = ''; setText(''); setSelectionWarning('Select a passage of 50,000 characters or less.');
            } else if (message.type === 'error') { failReader(message.message); }
          }} />}
        {busy && <View pointerEvents="none" style={{ position: 'absolute', inset: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.canvas }}>
          <ActivityIndicator color={colors.link} /><Text style={{ color: colors.ink, marginTop: 8 }}>Loading syllabus…</Text>
        </View>}

      </View>
    <CloudStudyConflicts documentId={documentId} onResolved={onRetry} />
    {!!error && <TTNoticeCard type="error" title="Unable to read this document" message={error}
      actionLabel="Retry" onActionPressed={onRetry} />}
    {!busy && !error && (!focus||!hasText||ocr.running) && (toolsOpen||!hasText||ocr.running) && document?.format === 'pdf' && <TTNoticeCard title="Read scanned text"
      message={ocr.status || 'Recognize printed English and Filipino locally. Results may contain errors. Your page and transcript are not sent to an OCR service.'}
      actionLabel={ocr.running ? 'Cancel recognition' : 'Recognize page'} onActionPressed={() => { if(ocr.running)ocr.cancel();else void ocr.recognize(); }} />}
    {!!ocr.warning && <TTNoticeCard title="OCR storage" message={ocr.warning} />}
    {!busy && !error && !hasText && document?.format !== 'pdf' && <TTNoticeCard title="No selectable text" message="This view has no readable text. Image-only PowerPoint and Word content is not supported by PDF page OCR." />}
    {!!selectionWarning && <TTNoticeCard title="Selection" message={selectionWarning} />}
    {!!(storageWarning || progressWarning) && <TTNoticeCard title="Reading is still available"
      message={[storageWarning, progressWarning].filter(Boolean).join(' ')} />}
    {!!text.trim() && <View style={{ paddingVertical: 8 }}>
      <TTTextSelectionMenu selectedText={text} canStudy={!busy && !error}
        onCopy={copy} onSelectAll={() => viewer.current?.selectAll()} onStudy={study} onNote={notes.openNote} onNotePressIn={notes.captureNote} canNote={notes.canNote&&!busy&&!error}/>
    </View>}
    <TTReaderControls page={page} pages={pages} zoom={zoom} busy={busy || !!error} section={document?.format === 'docx'} slide={document?.format === 'pptx'} onPage={changePage} onZoom={changeZoom} />
    {notes.content}
  </TTScreen>;
}
export default ReaderScreen;
