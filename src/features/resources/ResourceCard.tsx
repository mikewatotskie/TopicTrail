import React from 'react';
import { Text, View } from 'react-native';
import { TTButton, TTCard, TTFigmaIcon, TTIconButton, TTNoticeCard } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { evaluateUrl } from '../../core/services/link_shield';
import { savedDate, useBookmarkAction, type ResourceMetadata } from '../saved/useBookmarks';
import { assessmentLabel } from './LinkShieldNotice';
import { ResourceSymbol } from './ResourceSymbols';

export function ResourceCard({ resource, query, onDetails }: {
  resource: ResourceMetadata; query?: string; onDetails: () => void;
}) {
  const { colors } = useColors();
  const bookmark = useBookmarkAction(resource, query);
  const instantAnswer = resource.providerId === 'duckduckgo';
  return <TTCard padding={12} style={{ gap: 4 }} testID={`resource-card-${resource.id}`}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text accessibilityRole="header" style={[TTTypography.bodyStrong, { color: colors.ink, flex: 1 }]}>{resource.title}</Text>
      <TTIconButton semanticLabel={`${bookmark.alreadySaved ? 'Already saved' : bookmark.saved ? 'Unsave' : 'Save'} ${resource.title}`} isSelected={!!bookmark.saved}
        style={{ backgroundColor: bookmark.saved ? colors.soft : 'transparent', borderRadius: 8 }}
        icon={bookmark.saved ? <ResourceSymbol name="saved" /> : <TTFigmaIcon name="bookmark" />}
        disabled={bookmark.alreadySaved || bookmark.pending || !bookmark.available || bookmark.snapshot.status === 'loading'} onPress={() => void bookmark.toggle()} />
    </View>
    <Text style={[TTTypography.small, { color: colors.muted }]}>{instantAnswer ? 'DuckDuckGo Instant Answer' : resource.providerName} · {instantAnswer ? resource.providerName : resource.type}</Text>
    <Text numberOfLines={2} style={[TTTypography.small, { color: colors.muted }]}>{resource.description || 'Description unavailable from this source.'}</Text>
    {bookmark.saved && <Text accessibilityLiveRegion="polite" style={[TTTypography.caption, { color: colors.muted }]}>{bookmark.alreadySaved ? 'Already saved' : `Saved ${savedDate(bookmark.saved.savedAt)}`}</Text>}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.warningSoft }}>
        <ResourceSymbol name="shield" /><Text style={[TTTypography.caption, { color: colors.warning, flexShrink: 1 }]}>{assessmentLabel(evaluateUrl(resource.url))}</Text>
      </View>
      <TTButton label="Open" semanticLabel={`View details for ${resource.title}`} style={{ minWidth: 96 }} onPress={onDetails} />
    </View>
    {!!bookmark.error && <TTNoticeCard type="error" title="Saved resources" message={bookmark.error} actionLabel={bookmark.saved ? 'Retry removal' : 'Retry save'} onActionPressed={() => void bookmark.toggle()} />}
  </TTCard>;
}
