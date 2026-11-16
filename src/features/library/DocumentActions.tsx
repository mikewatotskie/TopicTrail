import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Document } from '../../core/models/document';
import { DocumentStorage } from '../../core/services/document_storage';
import { relinkGuestFile } from '../../core/services/relink_document';
import { useColors } from '../../core/theme/ThemeContext';
import { TTTypography } from '../../core/design/tokens';
import { TTButton, TTCard, TTNoticeCard, TTScreen, TTIconButton, TTFigmaIcon } from '../../components';
import { TTAppBar } from '../../navigation';
import { useCloudLibrary } from './CloudLibraryContext';
import { formatDocumentSize } from './libraryView';

export function documentSubtitle(doc: Document): string {
  const size = formatDocumentSize(doc.fileSize);
  return [doc.format.toUpperCase(), doc.format === 'docx' ? 'Text view' : doc.format === 'pptx' ? 'PowerPoint study view' : doc.pageCount ? doc.pageCount + (doc.pageCount === 1 ? ' page' : ' pages') : '', size].filter(Boolean).join(' · ');
}
export function DocumentActions({ document, readingStatus, onClose, onChanged }: {
  document: Document | null; readingStatus?: string; onClose: () => void; onChanged: () => Promise<void>;
}) {
  return document ? <DocumentActionContent key={document.id} document={document} readingStatus={readingStatus} onClose={onClose} onChanged={onChanged} /> : null;
}
function DocumentActionContent({ document, readingStatus, onClose, onChanged }: {
  document: Document; readingStatus?: string; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const { colors } = useColors();
  const {runtime,state:cloud}=useCloudLibrary();
  const [mode, setMode] = useState<'options' | 'rename' | 'delete'>('options');
  const [title, setTitle] = useState(document.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [missingEpoch, setMissingEpoch] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    if (Platform.OS === 'android' && runtime && cloud.phase === 'guest') {
      void runtime.documents.documentFileExists(document.id).then(exists => {
        if (active) setMissingEpoch(exists ? null : cloud.epoch);
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [runtime, cloud.phase, cloud.epoch, document.id]);
  async function relink() {
    if (!runtime || busy) return;
    const checkActive = () => {
      const current = runtime.getSnapshot();
      if (current.phase !== 'guest' || current.epoch !== cloud.epoch) throw new Error('Your active library changed. Reopen the document options.');
    };
    setBusy(true); setError('');
    try {
      if (await relinkGuestFile(document, checkActive)) { checkActive(); await onChanged(); onClose(); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The original file could not be linked.'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!document || busy || (mode === 'rename' && !title.trim())) return;
    setBusy(true); setError('');
    try {
      if (mode === 'rename') await DocumentStorage.instance.updateDocument(document.copyWith({ title: title.trim() }));
      else if(cloud.identity&&runtime)await runtime.trashDocument(document.id);
      else await DocumentStorage.instance.deleteDocument(document.id);
      await onChanged(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save changes. Please try again.'); }
    finally { setBusy(false); }
  }
  return <Modal visible={!!document} animationType="slide" onRequestClose={() => { if (!busy) onClose(); }}>
    <TTScreen variant="form"><TTAppBar title={mode === 'rename' ? 'Rename syllabus' : mode === 'delete' ? cloud.identity ? 'Move to Trash' : 'Remove from this device' : 'Document options'}
      leading={<TTIconButton icon={<TTFigmaIcon name="back" tintColor={colors.link} />} semanticLabel="Close document options" disabled={busy} onPress={onClose} />} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 16 }}>
          {!!error && <TTNoticeCard type="error" title="Changes not saved" message={error} />}
          {mode === 'options' ? <>
            <Text selectable style={[TTTypography.section, { color: colors.ink, minWidth: 0,
              ...(Platform.OS === 'web' ? { overflowWrap: 'anywhere' as const } : {}) }]}>{document?.title}</Text>
            {!!readingStatus && <Text style={[TTTypography.small, { color: colors.muted }]}>{readingStatus}</Text>}
            {missingEpoch === cloud.epoch && cloud.phase === 'guest' && <>
              <Text style={[TTTypography.body, { color: colors.ink }]}>Choose the original file to keep this library entry and its study history.</Text>
              <TTButton label="Relink original file" isLoading={busy} onPress={relink} />
            </>}
            <TTButton label={cloud.identity?'Rename across devices':'Rename document'} disabled={busy} onPress={() => setMode('rename')} />
            <TTButton label={cloud.identity?'Move to Trash':'Remove from this device'} variant="danger" disabled={busy} onPress={() => setMode('delete')} />
            <TTButton label="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
          </> : mode === 'rename' ? <>
            <Text style={[TTTypography.section, { color: colors.ink }]}>Document name</Text>
            <TextInput accessibilityLabel="Document name" value={title} onChangeText={setTitle} maxLength={200} autoFocus
              editable={!busy} style={[TTTypography.body, { minHeight: 56, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.border, color: colors.ink, backgroundColor: colors.surface }]} />
            <Text style={[TTTypography.small, { color: colors.muted }]}>Enter a name for this document.</Text>
            <TTButton label="Save name" onPress={save} isLoading={busy} disabled={!title.trim()} />
            <TTButton label="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
          </> : <TTCard padding={24} borderRadius={24}><View style={{ gap: 16 }}>
            <Text style={[TTTypography.title, { color: colors.ink }]}>{cloud.identity?'Move this syllabus to Trash?':'Remove this syllabus from this device?'}</Text>
            <Text style={[TTTypography.body, { color: colors.muted }]}>{cloud.identity?`“${document.title}” moves to Trash across your account when connected. Its original file is kept, and you can Restore it from Library details.`:`This removes “${document.title}” from this device. Device files do not have a Trash restore option; you can import the original file again.`}</Text>
            <TTButton label={cloud.identity?'Move to Trash':'Remove from this device'} variant="danger" isLoading={busy} onPress={save} />
            <TTButton label="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
          </View></TTCard>}
        </ScrollView>
      </KeyboardAvoidingView>
    </TTScreen>
  </Modal>;
}
