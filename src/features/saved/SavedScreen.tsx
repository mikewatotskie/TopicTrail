import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { TTScreen, TTEmptyState, TTAura, TTSearchInput, TTNoticeCard } from '../../components';
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
export function SavedScreen() {
  const { colors } = useColors();
  const snapshot = useBookmarks();
  const { gutter } = useResponsiveLayout();
  const [query, setQuery] = useState('');
  const [details, setDetails] = useState<Bookmark | null>(null);
  const needle = query.trim().toLocaleLowerCase();
  const matches = snapshot.bookmarks.filter(bookmark => [bookmark.title, bookmark.providerName, bookmark.topic ?? ''].some(value => value.toLocaleLowerCase().includes(needle)));
  return <TTScreen bottomInset={false}>
    <TTAura kind="quiet" style={{ right: -90, bottom: -32 }} />
    <TTAppBar title="Saved resources" automaticallyImplyLeading={false} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: gutter, gap: 16 }}>
      <View style={{ width: '100%', maxWidth: TTContentWidths.prose }}><TTSearchInput accessibilityLabel="Search saved resources" hintText="Search saved resources" value={query} maxLength={140} onChangeText={setQuery} /></View>
      {(snapshot.status === 'idle' || snapshot.status === 'loading') && <ActivityIndicator accessibilityLabel="Loading saved resources" color={colors.link} />}
      {snapshot.status === 'error' && <TTNoticeCard type="error" title="Couldn’t load or update saved resources" message="Your existing saved links have not been discarded. Try again to read the saved list."
        actionLabel="Retry saved resources" onActionPressed={snapshot.retry} />}
      {snapshot.status === 'ready' && snapshot.bookmarks.length === 0 && <TTEmptyState title="No saved resources yet" message="Save a resource to find it here later. Discover resources through Study."
        actionLabel="Open My Syllabi" onAction={() => router.navigate('/(tabs)/library')} />}
      {snapshot.bookmarks.length > 0 && <>
        <Text style={[TTTypography.small, { color: colors.muted }]}>{snapshot.bookmarks.length} saved resource{snapshot.bookmarks.length === 1 ? '' : 's'}{needle ? ` · ${matches.length} match${matches.length === 1 ? '' : 'es'}` : ''}</Text>
        {matches.length === 0 && <TTEmptyState title="No matching saved resources" message="Search by title, source or topic." actionLabel="Clear saved search" onAction={() => setQuery('')} />}
        <TTResponsiveGrid items={matches} keyExtractor={bookmark => bookmark.id} renderItem={bookmark => <ResourceCard resource={bookmark} savedList onDetails={() => setDetails(bookmark)} />} />
      </>}
      <Text style={[TTTypography.small, { color: colors.muted, maxWidth: TTContentWidths.prose }]}>Saved links open online. Only link metadata is stored on this device; websites are not downloaded for offline reading.</Text>
    </ScrollView>
    {details && <ResourceDetails resource={details} onClose={() => setDetails(null)} />}
  </TTScreen>;
}
export default SavedScreen;
