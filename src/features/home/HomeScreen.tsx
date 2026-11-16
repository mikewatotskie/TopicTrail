import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { TTButton, TTScreen, TTArtwork, TTAura, TTFigmaIcon, TTNoticeCard } from '../../components';
import { TTAppBar } from '../../navigation';
import { useColors } from '../../core/theme/ThemeContext';
import { TTTypography } from '../../core/design/tokens';
import { Document } from '../../core/models/document';
import { useDocuments } from '../library/useDocuments';
import { TTResponsiveGrid } from '../../components/TTResponsiveGrid';
import { useResponsiveLayout } from '../../core/layout/useResponsiveLayout';
import { DocumentActions } from '../library/DocumentActions';
import { ReadingProgressCard, useReadingProgressCards, useDocumentAvailability } from '../library/ReadingProgressCard';
import { TTContentWidths } from '../../core/layout/responsive';
import { CloudLibraryNotice } from '../library/CloudLibraryNotice';
import { continueReadingDocuments, filterLibraryDocuments } from '../library/libraryView';

export function HomeScreen() {
  const router = useRouter();
  const { colors } = useColors();
  const { documents: allDocuments, status, error, reload: load } = useDocuments();
  const { gutter } = useResponsiveLayout();
  const progress = useReadingProgressCards(allDocuments);
  const availability = useDocumentAvailability(allDocuments);
  const continuing = useMemo(() => continueReadingDocuments(allDocuments, progress), [allDocuments, progress]);
  const documents = useMemo(() => filterLibraryDocuments(allDocuments, '', 'all', 'recent-added').filter(doc => !continuing.some(item => item.id === doc.id)).slice(0, 3), [allDocuments, continuing]);
  const [activeDocument, setActiveDocument] = useState<Document | null>(null);
  return <TTScreen bottomInset={false}>
    <TTAura style={{ right: -58, bottom: -32 }} />
    <TTAppBar automaticallyImplyLeading={false} title={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <TTArtwork name="mark" style={{ padding: 4 }} /><Text style={[TTTypography.title, { color: colors.link }]}>TopicTrail</Text>
    </View>} />
    <ScrollView contentContainerStyle={{ padding: gutter, gap: 16 }}>
      <View style={{ gap: 8, maxWidth: TTContentWidths.prose }}>
        <Text accessibilityRole="header" style={[TTTypography.heading, { color: colors.ink }]}>Your study space</Text>
        <Text style={[TTTypography.small, { color: colors.muted }]}>Pick up a syllabus or import a new one.</Text>
        <TTButton label="Import syllabus" widthPolicy="responsiveAction" onPress={() => router.push('/upload')} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, maxWidth: TTContentWidths.prose }}>
        {([
          ['My Syllabi', 'book', '/(tabs)/library'],
          ['Saved resources', 'bookmark', '/(tabs)/saved'],
        ] as const).map(([label, icon, route]) =>
          <Pressable key={route} accessibilityRole="button" accessibilityLabel={label} onPress={() => router.navigate(route)}
            style={({pressed}) => ({ flexGrow: 1, flexBasis: 128, minHeight: 88, justifyContent: 'center', gap: 8,
              padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.soft : colors.surface })}>
            <TTFigmaIcon name={icon} /><Text style={[TTTypography.smallStrong, { color: colors.ink }]}>{label}</Text>
          </Pressable>)}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Text accessibilityRole="header" style={[TTTypography.section, { flex: 1, color: colors.ink }]}>Continue reading</Text>
        <TTButton label="View all" variant="ghost" onPress={() => router.navigate('/(tabs)/library')} />
      </View>
      {!!error && <TTNoticeCard type="error" title="Library unavailable" message={error} actionLabel="Retry" onActionPressed={load} />}
      {status === 'loading' && <Text style={[TTTypography.body, { color: colors.muted }]}>Loading documents…</Text>}
      <TTResponsiveGrid items={continuing} keyExtractor={doc => doc.id} renderItem={doc =>
        <ReadingProgressCard document={doc} progress={progress.get(doc.id)} availability={availability.get(doc.id)} onMorePressed={() => setActiveDocument(doc)} />} />
      {status === 'ready' && allDocuments.length > 0 && !continuing.length && <Text style={[TTTypography.body, {color:colors.muted}]}>Open a syllabus to start reading. Your last viewed page, section or slide will appear here.</Text>}
      {status === 'ready' && !allDocuments.length && !error && <Text style={[TTTypography.body, { color: colors.muted }]}>No syllabi yet</Text>}
      <CloudLibraryNotice />
      {!!documents.length && <Text accessibilityRole="header" style={[TTTypography.section, {color:colors.ink}]}>Recently added</Text>}
      <TTResponsiveGrid items={documents} keyExtractor={doc => doc.id} renderItem={doc =>
        <ReadingProgressCard document={doc} progress={progress.get(doc.id)} availability={availability.get(doc.id)} onMorePressed={() => setActiveDocument(doc)} />} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <TTButton label="Search a topic" variant="secondary" widthPolicy="responsiveAction" onPress={() => router.push('/topic-search')} />
        <TTButton label="New note" variant="secondary" widthPolicy="responsiveAction" onPress={() => router.push('/notes')} />
      </View>
    </ScrollView>
    <DocumentActions document={allDocuments.some(doc=>doc.id===activeDocument?.id)?activeDocument:null} onClose={() => setActiveDocument(null)} onChanged={load} />
  </TTScreen>;
}
export default HomeScreen;
