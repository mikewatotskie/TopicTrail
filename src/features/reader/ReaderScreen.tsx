import { usePageOcr } from './usePageOcr';
import { runNativeOcr } from '../scan/native_ocr';
import { sha256 } from '../../core/services/cloud/sha256';
import { parsePptx } from '../../core/services/pptx_parser';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, Alert, NativeModules, Platform, AppState } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { encodeBase64 } from '../../core/services/cloud/base64';
import { readDocumentBytes } from '../../core/services/document_content';
import * as Clipboard from 'expo-clipboard';
import WebView from 'react-native-webview';
import { useTheme } from '../../core/theme/ThemeContext';
import { Document } from '../../core/models/document';
import { DocumentStorage } from '../../core/services/document_storage';
import { DocxTextExtraction } from '../../core/services/docx_text_extraction';
import { TTNoticeCard, TTScreen, TTTextSelectionMenu } from '../../components';
import { TTReaderControls } from '../../components/TTReaderControls';
import { ReaderToolbar } from './ReaderToolbar';
import { connectNativeReader, type ReaderConnection } from './reader_channel';
import type { ReaderInput } from './reader_protocol';
import { nativeReaderSource, packagedReaderSource } from './native_reader_source';
import type { ReaderMessage } from './selection';
import { useReaderNotes } from '../notes/useReaderNotes';
import { useStudySelection } from './StudySelectionContext';
import { useReadingProgress } from './useReadingProgress';
import { useCloudLibrary } from '../library/CloudLibraryContext';
import { CloudStudyConflicts } from '../library/CloudStudyConflicts';

async function loadReaderSource(format: Document['format']) {
  if (Platform.OS === 'android' && NativeModules.TopicTrailTransfer?.readerStreamVersion === 1) {
    return packagedReaderSource(format);
  }
  const viewerAsset = format === 'pdf'
    ? require('../../../assets/reader/viewer.html')
    : require('../../../assets/reader/office-viewer.html');
  const asset = await Asset.fromModule(viewerAsset).downloadAsync();
  if (!asset.localUri) throw new Error('The offline reader could not be loaded.');
  const readerHtml = await new File(asset.localUri).text();
  if (!readerHtml.startsWith('<!doctype html>') || !readerHtml.endsWith('</body></html>')) {
    throw new Error('The offline viewer could not be read completely. Please retry.');
  }
  return nativeReaderSource(readerHtml, Platform.OS);
}

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
  const nativeView = useRef<WebView<object>>(null);
  const receive=useRef<(message:ReaderMessage)=>void>(()=>{});
  const nativeConnection=useRef<ReturnType<typeof connectNativeReader>|null>(null);
  const pendingReady=useRef(false);
  const pendingLoad=useRef<boolean | null>(null);
  const viewer=useRef<ReaderConnection|null>(null);
  const payload = useRef<ReaderInput | null>(null);
  const selected = useRef('');
  const ocr = usePageOcr(viewer);
  const [contentHash,setContentHash] = useState('');
  const visiblePage = useRef(1);
  const viewRevision=useRef(0);
  const [document, setDocument] = useState<Document | null>(null);
  const [source, setSource] = useState<Awaited<ReturnType<typeof loadReaderSource>>>();
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
      // The active Guest/account storage adapter owns path and size checks.
      const readerSource = await loadReaderSource(doc.format);
      const bytes = await readDocumentBytes(doc.filePath);
      const hash = sha256(bytes);
      const input:ReaderInput = doc.format === 'pdf' ? { format: doc.format, base64: encodeBase64(bytes),dark:colorScheme==='dark' }
        : doc.format === 'pptx' ? { format: doc.format, slides: parsePptx(bytes),dark:colorScheme==='dark' }
        : { format: doc.format, paragraphs: await DocxTextExtraction.instance.extractParagraphs(doc),dark:colorScheme==='dark' };
      if (!active) return;
      payload.current = input; setContentHash(hash); setDocument(doc); setSource(readerSource);
      await DocumentStorage.instance.updateLastOpened(doc.id).catch(() => {
        if (active) setStorageWarning('Recent activity could not be saved. You can still read this syllabus.');
      });
    })().catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : 'Unable to open syllabus'); setBusy(false); } });
    return () => { active = false; payload.current = null; };
  // Theme changes update the existing reader without rereading original bytes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, hydrateProgress]);
  useEffect(()=>{
    if(!source)return;
    const connection=connectNativeReader(script=>nativeView.current?.injectJavaScript(script),message=>receive.current(message));
    nativeConnection.current=connection;viewer.current=connection;
    if (pendingLoad.current !== null) {
      connection.documentLoaded(pendingLoad.current);
      pendingLoad.current = null;
    }
    if(pendingReady.current){pendingReady.current=false;connection.receive('{"type":"ready"}');}
    return()=>{connection.dispose();if(nativeConnection.current===connection)nativeConnection.current=null;if(viewer.current===connection)viewer.current=null;};
  },[source]);
  useEffect(() => { viewer.current?.theme(colorScheme === 'dark'); }, [colorScheme]);
  function failReader(message: string) {
    ocr.reset();
    viewRevision.current++;notes.receive({type:'error',message});viewer.current?.cancelArea();viewer.current?.dispose();
    selected.current = ''; setText(''); setSelectionWarning(''); setError(message); setBusy(false);
  }
  function changePage(value: number) {ocr.reset();viewRevision.current++;notes.beforeNavigation();visiblePage.current=value;setBusy(true); setText(''); setSelectionWarning(''); selected.current = ''; viewer.current?.page(value); }
  function changeZoom(value: number) {ocr.reset();viewRevision.current++;notes.beforeNavigation(true);const next = Math.max(0.5, Math.min(3, value)); setText(''); selected.current = ''; setZoom(next); setBusy(true); viewer.current?.zoom(next); }
  async function copy() {
    try { await Clipboard.setStringAsync(selected.current); Alert.alert('Copied', 'Selected text copied to clipboard.'); }
    catch { Alert.alert('Unable to copy', 'Please try again.'); }
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
  function handleMessage(message:ReaderMessage) {
    if(message.type==='page'&&!acceptRenderedPage(message,changePage))return;
    notes.receive(message);
    if(message.type==='render-start'||message.type==='surface-change'||message.type==='selection-reset'){viewRevision.current++;selected.current='';setText('');if(message.type==='render-start'){ocr.reset();setBusy(true);}return;}
            if (message.type === 'ready' && payload.current) {
              viewer.current?.load({ ...payload.current, dark: colorScheme === 'dark' });
              payload.current = null;
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

  }
  useLayoutEffect(()=>{receive.current=handleMessage;});
  return <TTScreen variant="reader">
    <ReaderToolbar title={document?.title ?? 'Syllabus'} format={document?.format} page={page} pages={pages}
      selection={!!text.trim()} focus={focus} toolsOpen={toolsOpen} disabled={busy || !!error}
      onBack={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/library')}
      onClear={clearReaderSelection}
      onNotes={notes.openPanel} onTools={() => setToolsOpen(value => !value)} onFocus={() => setFocus(value => !value)}
      onDocumentNote={notes.newDocumentNote} onLocationNote={notes.newLocationNote}
      onMark={() => notes.mark('drag')} onCorners={() => notes.mark('corners')} />
    {Platform.OS === 'web' ? <TTNoticeCard title="Use the mobile app" message="The interactive document reader is available in the Android app." />
      : <View style={{ flex: 1 }}>
        {!!source && <WebView<object> ref={nativeView} source={source} originWhitelist={['*']}
          onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
          allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
          javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false}
          mixedContentMode="never" cacheEnabled={false} domStorageEnabled={false}
          style={{ backgroundColor: colors.canvas }}
          onLoad={event => {
            const title = event.nativeEvent.title;
            if (title === 'TopicTrail reader script unavailable') {
              failReader('The offline viewer opened, but its script could not start. Please retry.');
              return;
            }
            const viewerStarted = title === 'TopicTrail reader ready';
            if (nativeConnection.current) nativeConnection.current.documentLoaded(viewerStarted);
            else pendingLoad.current = viewerStarted;
          }}
          onError={() => failReader('The document reader could not load. Please retry.')}
          onRenderProcessGone={() => failReader('Android stopped the document reader. Tap Retry to reopen it.')}
          onMessage={event => {if(nativeConnection.current)nativeConnection.current.receive(event.nativeEvent.data);else {try{if(JSON.parse(event.nativeEvent.data)?.type==='ready')pendingReady.current=true;}catch{/* malformed startup message */}}}} />}
        {busy && <View pointerEvents="none" style={{ position: 'absolute', inset: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.canvas }}>
          <ActivityIndicator color={colors.link} /><Text style={{ color: colors.ink, marginTop: 8 }}>Loading syllabus…</Text>
        </View>}

      </View>}
    <CloudStudyConflicts documentId={documentId} onResolved={onRetry} />
    {!!error && <TTNoticeCard type="error" title="Unable to read this document" message={error}
      actionLabel="Retry" onActionPressed={onRetry} />}
    {!busy && !error && (!focus||!hasText||ocr.running) && (toolsOpen||!hasText||ocr.running) && document?.format === 'pdf' && <TTNoticeCard title="Read scanned text"
      message={ocr.status || 'Recognize printed English and Filipino on this device. Results may contain errors. Google ML Kit may send SDK usage metrics, but not your page or transcript.'}
      actionLabel={ocr.running ? 'Cancel recognition' : 'Recognize page'} onActionPressed={() => {
        if(ocr.running)ocr.cancel();
        else void ocr.recognize(signal => runNativeOcr(signal, (module,id) => module.recognizePdf(document.filePath,contentHash,page,id)));
      }} />}
    {!!ocr.warning && <TTNoticeCard title="OCR storage" message={ocr.warning} />}
    {!busy && !error && !hasText && document?.format !== 'pdf' && <TTNoticeCard title="No selectable text" message="This view has no readable text. Image-only PowerPoint and Word content is not supported by PDF page OCR." />}
    {!!selectionWarning && <TTNoticeCard title="Choose a shorter passage" message={selectionWarning} />}
    {!!(storageWarning || progressWarning) && <TTNoticeCard title="Reading is still available"
      message={[storageWarning, progressWarning].filter(Boolean).join(' ')} />}
    {!!text.trim() && <View style={{ paddingVertical: 8 }}>
      <TTTextSelectionMenu selectedText={text} canStudy={!busy && !error}
        onCopy={copy} onSelectAll={() => viewer.current?.selectAll()} onStudy={study} onNote={notes.openNote} onNotePressIn={notes.captureNote} canNote={notes.canNote&&!busy&&!error} />
    </View>}
    <TTReaderControls page={page} pages={pages} zoom={zoom} busy={busy || !!error || Platform.OS === 'web'} section={document?.format === 'docx'} slide={document?.format === 'pptx'} onPage={changePage} onZoom={changeZoom} />
    {notes.content}
  </TTScreen>;
}
export default ReaderScreen;
