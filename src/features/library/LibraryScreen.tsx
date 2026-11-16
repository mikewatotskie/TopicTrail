import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '../../core/theme/ThemeContext';
import { TTTypography } from '../../core/design/tokens';
import { TTButton, TTSearchInput, TTScreen, TTNoticeCard, TTInfoBanner, TTEmptyState, TTAura } from '../../components';
import { TTAppBar } from '../../navigation';
import { Document } from '../../core/models/document';
import { useDocuments } from './useDocuments';
import { useResponsiveLayout } from '../../core/layout/useResponsiveLayout';
import { DocumentActions } from './DocumentActions';
import { ReadingProgressCard, useReadingProgressCards, useDocumentAvailability } from './ReadingProgressCard';
import { TTContentWidths } from '../../core/layout/responsive';
import { CloudLibraryNotice } from './CloudLibraryNotice';
import { filterLibraryDocuments, type LibraryFormat, type LibrarySort } from './libraryView';
export function LibraryScreen() {
  const router = useRouter();
  const { colors } = useColors();
  const { documents, status, error, reload: load } = useDocuments();
  const progress = useReadingProgressCards(documents);
  const availability = useDocumentAvailability(documents);
  const { gutter } = useResponsiveLayout();
  const [searchQuery, setSearch] = useState('');
  const [format, setFormat] = useState<LibraryFormat>('all');
  const [sort, setSort] = useState<LibrarySort>('recent-opened');
  const [showFilters, setShowFilters] = useState(false);
  const [selection, setSelection] = useState<{ document: Document; status?: string } | null>(null);
  const filtered = useMemo(() => filterLibraryDocuments(documents, searchQuery, format, sort), [documents,searchQuery,format,sort]);
  const filtering = !!searchQuery.trim() || format !== 'all';
  const choice = (label: string, selected: boolean, action: () => void) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{selected}} aria-selected={selected} onPress={action}
    style={({pressed}) => ({minHeight:48,paddingHorizontal:16,paddingVertical:12,borderRadius:12,justifyContent:'center',borderWidth:1,borderColor:selected?colors.link:colors.border,backgroundColor:selected?colors.soft:colors.surface,opacity:pressed?0.75:1})}>
    <Text style={[TTTypography.small,{color:selected?colors.link:colors.ink}]}>{label}</Text></Pressable>;
  return <TTScreen bottomInset={false}>
    <TTAura kind="quiet" style={{ right: -90, bottom: -32 }} />
    <TTAppBar title="My Syllabi" automaticallyImplyLeading={false} />
    <ScrollView contentContainerStyle={{ padding: gutter, gap: 16 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 16 }}>
        <View style={{ width: '100%', maxWidth: TTContentWidths.prose }}><TTSearchInput hintText="Search documents" value={searchQuery} onChangeText={setSearch} /></View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <Text style={[TTTypography.section, { color: colors.ink, flexGrow: 1 }]}>{status === 'ready' ? `${filtered.length} document${filtered.length === 1 ? '' : 's'}` : ''}</Text>
          <TTButton label="Filter and sort" variant="ghost" accessibilityState={{ expanded: showFilters }} onPress={() => setShowFilters(value => !value)} />
          <TTButton label="Upload syllabus" variant="secondary" onPress={() => router.push('/upload')} />
        </View>
        {showFilters && <><View style={{gap:8}}><Text style={[TTTypography.small,{color:colors.muted}]}>Format</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
          {(['all','pdf','docx','pptx'] as const).map(value => choice(value === 'all' ? 'All formats' : value.toUpperCase(), format === value, () => setFormat(value)))}
        </View></View>
        <View style={{gap:8}}><Text style={[TTTypography.small,{color:colors.muted}]}>Sort by</Text><View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
          {([['recent-opened','Recently opened'],['recent-added','Recently added'],['title','Title']] as const).map(([value,label]) => choice(label, sort === value, () => setSort(value)))}
        </View>{sort === 'recent-opened' && <Text style={[TTTypography.caption,{color:colors.muted}]}>Recently opened on this device.</Text>}</View></>}
        <CloudLibraryNotice />
        {!!error && <TTNoticeCard type="error" title="Library unavailable" message={error} actionLabel="Retry" onActionPressed={load} />}
      </View>
      {status === 'loading' && <ActivityIndicator accessibilityLabel="Loading documents" color={colors.link} />}
      {status === 'ready' && !filtered.length && <TTEmptyState title={filtering ? 'No matching documents' : 'No syllabi yet'}
        message={filtering ? 'Try a different title or format.' : 'Upload a PDF, DOCX or PPTX to start studying.'}
        actionLabel={filtering ? 'Clear filters' : 'Upload syllabus'} onAction={() => {if(filtering){setSearch('');setFormat('all');}else router.push('/upload');}} />}
      {!!filtered.length && <View style={{ width: '100%', maxWidth: TTContentWidths.prose, borderRadius: 16,
        borderWidth: 1, borderColor: colors.border + '3B', backgroundColor: colors.surface, overflow: 'hidden' }}>
        {filtered.map((doc, index) => <View key={doc.id} style={index ? {
          borderTopWidth: 1, borderTopColor: colors.border + '3B',
        } : undefined}>
          <ReadingProgressCard compact document={doc} progress={progress.get(doc.id)} availability={availability.get(doc.id)}
            onMorePressed={readingStatus => setSelection({ document: doc, status: readingStatus })} />
        </View>)}
      </View>}
      {!!filtered.length && <View style={{ width: '100%', maxWidth: TTContentWidths.prose }}><TTInfoBanner message="Open a syllabus to study a topic." /></View>}
    </ScrollView>
    <DocumentActions document={documents.find(doc => doc.id === selection?.document.id) ?? null}
      readingStatus={selection?.status} onClose={() => setSelection(null)} onChanged={load} />
  </TTScreen>;
}
export default LibraryScreen;

