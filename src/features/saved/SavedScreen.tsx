import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { TTScreen, TTEmptyState, TTAura, TTSearchInput, TTNoticeCard, TTButton, TTCard } from '../../components';
import { TTAppBar } from '../../navigation';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import type { Bookmark } from '../../core/services/bookmarks/types';
import { TTResponsiveGrid } from '../../components/TTResponsiveGrid';
import { useResponsiveLayout } from '../../core/layout/useResponsiveLayout';
import { ResourceCard } from '../resources/ResourceCard';
import { ResourceDetails } from '../resources/ResourceDetails';
import { useBookmarks } from './useBookmarks';
import { TTContentWidths } from '../../core/layout/responsive';
import { useCloudLibrary } from '../library/CloudLibraryContext';
import { NotesPanel } from '../notes/NotesPanel';
export function SavedScreen() {
  const {state}=useCloudLibrary();
  return <SavedAccountScreen key={state.epoch} />;
}
function SavedAccountScreen() {
  const router = useRouter();
  const {state:cloud}=useCloudLibrary();
  const { colors } = useColors();
  const snapshot = useBookmarks();
  const { gutter } = useResponsiveLayout();
  const [query, setQuery] = useState('');
  const [view,setView] = useState<'resources'|'notes'|'highlights'>('resources');
  const [details, setDetails] = useState<Bookmark | null>(null);
  const needle = query.trim().toLocaleLowerCase();
  const matches = snapshot.bookmarks.filter(bookmark => [bookmark.title, bookmark.providerName, bookmark.providerId, bookmark.topic ?? ''].some(value => value.toLocaleLowerCase().includes(needle)));
  const byTopic = new Map<string, Bookmark[]>();
  for (const bookmark of matches) {
    const topic = bookmark.topic ?? '';
    const group = byTopic.get(topic);
    if (group) group.push(bookmark);
    else byTopic.set(topic, [bookmark]);
  }
  return <TTScreen bottomInset={false}>
    <TTAura kind="quiet" style={{ right: -90, bottom: -32 }} />
    <TTAppBar title={view === 'resources' ? 'Saved resources' : view === 'notes' ? 'Notes' : 'Highlights'} automaticallyImplyLeading={false} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: gutter, gap: 16 }}>
      <View style={{flexDirection:'row',flexWrap:'wrap',alignItems:'center',gap:4}}>
        {(['resources','notes','highlights'] as const).map(value=><TTButton key={value} label={value[0].toUpperCase()+value.slice(1)}
          variant="ghost" style={{ backgroundColor: view === value ? colors.soft : 'transparent', paddingHorizontal: 12 }}
          accessibilityState={{selected:view===value}} onPress={()=>{setView(value);setDetails(null);}}/>)}
      </View>
      {view==='resources'?<>
      <View style={{ width: '100%', maxWidth: TTContentWidths.prose }}><TTSearchInput accessibilityLabel="Search saved resources" hintText="Search saved resources" value={query} maxLength={140} onChangeText={setQuery} /></View>
      {(snapshot.status === 'idle' || snapshot.status === 'loading') && <ActivityIndicator accessibilityLabel="Loading saved resources" color={colors.link} />}
      {snapshot.status === 'error' && <TTNoticeCard type="error" title="Couldn’t load or update saved resources" message="Your existing saved links have not been discarded. Try again to read the saved list."
        actionLabel="Retry saved resources" onActionPressed={snapshot.retry} />}
      {snapshot.status === 'ready' && snapshot.bookmarks.length === 0 && <TTEmptyState title="No saved resources yet" message="Save a resource to find it here later. Discover resources through Study."
        actionLabel="Open My Syllabi" onAction={() => router.navigate('/(tabs)/library')} />}
      {snapshot.bookmarks.length > 0 && <>
        <Text style={[TTTypography.small, { color: colors.muted }]}>{snapshot.bookmarks.length} saved resource{snapshot.bookmarks.length === 1 ? '' : 's'}{needle ? ` · ${matches.length} match${matches.length === 1 ? '' : 'es'}` : ''}</Text>
        {matches.length === 0 && <TTEmptyState title="No matching saved resources" message="Search by title, source or topic." actionLabel="Clear saved search" onAction={() => setQuery('')} />}
        {Array.from(byTopic, ([topic, bookmarks]) => <View key={topic} style={{ gap: 12 }}>
          {!!topic && <TTCard padding={16} backgroundColor={colors.soft}>
            <Text accessibilityRole="header" style={[TTTypography.bodyStrong, { color: colors.link }]}>{topic}</Text>
          </TTCard>}
          <TTResponsiveGrid items={bookmarks} keyExtractor={bookmark => bookmark.id} renderItem={bookmark => <ResourceCard resource={bookmark} onDetails={() => setDetails(bookmark)} />} />
        </View>)}
      </>}
      <Text style={[TTTypography.small, { color: colors.muted, maxWidth: TTContentWidths.prose }]}>Saved links open online. Websites are not downloaded for offline reading. {cloud.identity ? 'Saved link metadata syncs to this account when connected.' : 'Guest bookmarks stay on this device.'}</Text>
      </>:<NotesPanel key={view} view={view}/>}
    </ScrollView>
    {details && <ResourceDetails resource={details} onClose={() => setDetails(null)} />}
  </TTScreen>;
}
export default SavedScreen;
