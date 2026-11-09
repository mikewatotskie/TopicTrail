import React, { useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { useColors } from '../../core/theme/ThemeContext';
import { TTTypography } from '../../core/design/tokens';
import { TTButton, TTSearchInput, TTScreen, TTNoticeCard, TTInfoBanner, TTEmptyState, TTAura } from '../../components';
import { TTAppBar } from '../../navigation';
import { Document } from '../../core/models/document';
import { useDocuments } from './useDocuments';
import { TTResponsiveGrid } from '../../components/TTResponsiveGrid';
import { useResponsiveLayout } from '../../core/layout/useResponsiveLayout';
import { DocumentActions } from './DocumentActions';
import { ReadingProgressCard, useReadingProgressCards } from './ReadingProgressCard';
import { TTContentWidths } from '../../core/layout/responsive';
export function LibraryScreen() {
  const { colors } = useColors();
  const { documents, status, error, reload: load } = useDocuments();
  const progress = useReadingProgressCards(documents);
  const { gutter } = useResponsiveLayout();
  const [searchQuery, setSearch] = useState('');
  const [activeDocument, setActiveDocument] = useState<Document | null>(null);
  const filtered = documents.filter(doc => doc.title.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()));
  return <TTScreen bottomInset={false}>
    <TTAura kind="quiet" style={{ right: -90, bottom: -32 }} />
    <TTAppBar title="My Syllabi" automaticallyImplyLeading={false} />
    <ScrollView contentContainerStyle={{ padding: gutter, gap: 16 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 16 }}>
        <View style={{ width: '100%', maxWidth: TTContentWidths.prose }}><TTSearchInput hintText="Search documents" value={searchQuery} onChangeText={setSearch} /></View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Text style={[TTTypography.section, { color: colors.ink, flex: 1 }]}>{status === 'ready' ? `${filtered.length} document${filtered.length === 1 ? '' : 's'}` : ''}</Text>
          <TTButton label="Upload syllabus" variant="ghost" onPress={() => router.push('/upload')} />
        </View>
        <Text style={[TTTypography.small, { color: colors.muted }]}>Stored on this device. Cloud sync is not connected.</Text>
        {!!error && <TTNoticeCard type="error" title="Library unavailable" message={error} actionLabel="Retry" onActionPressed={load} />}
      </View>
      {status === 'loading' && <ActivityIndicator accessibilityLabel="Loading documents" color={colors.link} />}
      {status === 'ready' && !filtered.length && <TTEmptyState title={searchQuery.trim() ? 'No matching documents' : 'No syllabi yet'}
        message={searchQuery.trim() ? 'Try a different search term.' : 'Upload a PDF or DOCX to start studying.'}
        actionLabel={searchQuery.trim() ? 'Clear search' : 'Upload syllabus'} onAction={() => searchQuery.trim() ? setSearch('') : router.push('/upload')} />}
      <TTResponsiveGrid items={filtered} keyExtractor={doc => doc.id} renderItem={doc =>
        <ReadingProgressCard document={doc} progress={progress.get(doc.id)} onMorePressed={() => setActiveDocument(doc)} />} />
      {!!filtered.length && <View style={{ width: '100%', maxWidth: TTContentWidths.prose }}><TTInfoBanner message="Open a syllabus to study a topic." /></View>}
    </ScrollView>
    <DocumentActions document={activeDocument} onClose={() => setActiveDocument(null)} onChanged={load} />
  </TTScreen>;
}
export default LibraryScreen;

