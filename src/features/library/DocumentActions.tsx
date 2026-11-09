import React, { useState } from 'react';
import { Modal, View, Text, TextInput, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Document } from '../../core/models/document';
import { DocumentStorage } from '../../core/services/document_storage';
import { useColors } from '../../core/theme/ThemeContext';
import { TTTypography } from '../../core/design/tokens';
import { TTButton, TTCard, TTNoticeCard, TTScreen, TTIconButton, TTFigmaIcon } from '../../components';
import { TTAppBar } from '../../navigation';

export function documentSubtitle(doc: Document): string {
  const size = doc.fileSize === undefined ? '' : doc.fileSize < 1024 * 1024 ? Math.ceil(doc.fileSize / 1024) + ' KB' : (doc.fileSize / (1024 * 1024)).toFixed(1) + ' MB';
  return [doc.format.toUpperCase(), doc.format === 'docx' ? 'Text view' : doc.pageCount ? doc.pageCount + (doc.pageCount === 1 ? ' page' : ' pages') : '', size].filter(Boolean).join(' · ');
}
export function DocumentActions({ document, onClose, onChanged }: {
  document: Document | null; onClose: () => void; onChanged: () => Promise<void>;
}) {
  return document ? <DocumentActionContent key={document.id} document={document} onClose={onClose} onChanged={onChanged} /> : null;
}
function DocumentActionContent({ document, onClose, onChanged }: {
  document: Document; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const { colors } = useColors();
  const [mode, setMode] = useState<'options' | 'rename' | 'delete'>('options');
  const [title, setTitle] = useState(document.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    if (!document || busy || (mode === 'rename' && !title.trim())) return;
    setBusy(true); setError('');
    try {
      if (mode === 'rename') await DocumentStorage.instance.updateDocument(document.copyWith({ title: title.trim() }));
      else await DocumentStorage.instance.deleteDocument(document.id);
      await onChanged(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to save changes. Please try again.'); }
    finally { setBusy(false); }
  }
  return <Modal visible={!!document} animationType="slide" onRequestClose={() => { if (!busy) onClose(); }}>
    <TTScreen variant="form"><TTAppBar title={mode === 'rename' ? 'Rename syllabus' : mode === 'delete' ? 'Delete syllabus' : 'Document options'}
      leading={<TTIconButton icon={<TTFigmaIcon name="back" />} semanticLabel="Close document options" disabled={busy} onPress={onClose} />} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 16 }}>
          {!!error && <TTNoticeCard type="error" title="Changes not saved" message={error} />}
          {mode === 'options' ? <>
            <Text selectable style={[TTTypography.section, { color: colors.ink, minWidth: 0,
              ...(Platform.OS === 'web' ? { overflowWrap: 'anywhere' as const } : {}) }]}>{document?.title}</Text>
            <TTButton label="Rename document" onPress={() => setMode('rename')} />
            <TTButton label="Delete document" variant="danger" onPress={() => setMode('delete')} />
            <TTButton label="Cancel" variant="ghost" onPress={onClose} />
          </> : mode === 'rename' ? <>
            <Text style={[TTTypography.section, { color: colors.ink }]}>Document name</Text>
            <TextInput accessibilityLabel="Document name" value={title} onChangeText={setTitle} maxLength={200} autoFocus
              editable={!busy} style={[TTTypography.body, { minHeight: 56, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.border, color: colors.ink, backgroundColor: colors.surface }]} />
            <Text style={[TTTypography.small, { color: colors.muted }]}>Enter a name for this document.</Text>
            <TTButton label="Save name" onPress={save} isLoading={busy} disabled={!title.trim()} />
            <TTButton label="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
          </> : <TTCard padding={24} borderRadius={24}><View style={{ gap: 16 }}>
            <Text style={[TTTypography.title, { color: colors.ink }]}>Delete this syllabus?</Text>
            <Text style={[TTTypography.body, { color: colors.muted }]}>This removes “{document?.title}” from this device.</Text>
            <TTButton label="Delete syllabus" variant="danger" isLoading={busy} onPress={save} />
            <TTButton label="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
          </View></TTCard>}
        </ScrollView>
      </KeyboardAvoidingView>
    </TTScreen>
  </Modal>;
}
