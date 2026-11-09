import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { TTButton, TTCard, TTScreen, TTArtwork, TTAura, TTFigmaIcon, TTEmptyState, TTNoticeCard } from '../../components';
import { TTAppBar } from '../../navigation';
import { useColors } from '../../core/theme/ThemeContext';
import { TTTypography } from '../../core/design/tokens';
import { Document } from '../../core/models/document';
import { useDocuments } from '../library/useDocuments';
import { TTResponsiveGrid } from '../../components/TTResponsiveGrid';
import { useResponsiveLayout } from '../../core/layout/useResponsiveLayout';
import { DocumentActions } from '../library/DocumentActions';
import { ReadingProgressCard, useReadingProgressCards } from '../library/ReadingProgressCard';
import { TTContentWidths } from '../../core/layout/responsive';

export function HomeScreen() {
  const { colors } = useColors();
  const { documents: allDocuments, status, error, reload: load } = useDocuments();
  const { gutter } = useResponsiveLayout();
  const documents = useMemo(() => [...allDocuments].sort((a, b) =>
    (b.lastOpenedAt ?? b.importedAt).getTime() - (a.lastOpenedAt ?? a.importedAt).getTime()).slice(0, 3), [allDocuments]);
  const progress = useReadingProgressCards(documents);
  const [activeDocument, setActiveDocument] = useState<Document | null>(null);
  return <TTScreen bottomInset={false}>
    <TTAura style={{ right: -58, bottom: -32 }} />
    <TTAppBar automaticallyImplyLeading={false} title={<View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <TTArtwork name="mark" style={{ padding: 4 }} /><Text style={[TTTypography.title, { color: colors.onBrand }]}>TopicTrail</Text>
    </View>} />
    <ScrollView contentContainerStyle={{ padding: gutter, gap: 16 }}>
      <TTCard backgroundColor={colors.brand} borderColor={colors.brand} borderRadius={24} padding={20} style={{ overflow: 'hidden' }}>
        <TTAura kind="header" style={{ right: -10, top: 0 }} />
        <TTArtwork name="trail" style={{ position: 'absolute', right: 16, top: 32 }} />
        <Text style={[TTTypography.heading, { color: colors.onBrand, marginRight: 92, maxWidth: TTContentWidths.prose }]}>Study from your syllabus</Text>
        <Text style={[TTTypography.small, { color: colors.onBrand, opacity: 0.82, marginTop: 12, marginBottom: 12, maxWidth: TTContentWidths.prose }]}>Find free resources for a topic.</Text>
        <TTButton label="Upload syllabus" variant="study" widthPolicy="responsiveAction" onPress={() => router.push('/upload')} />
      </TTCard>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Text style={[TTTypography.section, { flex: 1, color: colors.ink }]}>Recent documents</Text>
        <TTButton label="View all" variant="ghost" onPress={() => router.navigate('/(tabs)/library')} />
      </View>
      <Text style={[TTTypography.small, { color: colors.muted }]}>Stored on this device. Cloud sync is not connected.</Text>
      {!!error && <TTNoticeCard type="error" title="Library unavailable" message={error} actionLabel="Retry" onActionPressed={load} />}
      {status === 'loading' && <Text style={[TTTypography.body, { color: colors.muted }]}>Loading documents…</Text>}
      <TTResponsiveGrid items={documents} keyExtractor={doc => doc.id} renderItem={doc =>
        <ReadingProgressCard document={doc} progress={progress.get(doc.id)} onMorePressed={() => setActiveDocument(doc)} />} />
      {status === 'ready' && !documents.length && !error && <TTEmptyState title="No syllabi yet" message="Upload a PDF or DOCX to start studying."
        actionLabel="Upload syllabus" onAction={() => router.push('/upload')} />}
      <TTCard style={{ width: '100%', maxWidth: TTContentWidths.prose }}><View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
        <TTFigmaIcon name="bookmark" /><Text style={[TTTypography.bodyStrong, { color: colors.ink, flex: 1 }]}>Saved resources</Text>
      </View><TTButton label="Open saved resources" variant="ghost" widthPolicy="responsiveAction" onPress={() => router.navigate('/(tabs)/saved')} /></TTCard>
    </ScrollView>
    <DocumentActions document={activeDocument} onClose={() => setActiveDocument(null)} onChanged={load} />
  </TTScreen>;
}
export default HomeScreen;
