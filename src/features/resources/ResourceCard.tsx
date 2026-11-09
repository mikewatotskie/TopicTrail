import React from 'react';
import { Text, View } from 'react-native';
import { TTButton, TTCard, TTFigmaIcon, TTIconButton, TTNoticeCard } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { evaluateUrl } from '../../core/services/link_shield';
import { savedDate, useBookmarkAction, type ResourceMetadata } from '../saved/useBookmarks';
import { assessmentLabel } from './LinkShieldNotice';
import { ResourceSymbol } from './ResourceSymbols';

export function ResourceCard({ resource, query, onDetails, savedList = false }: {
  resource: ResourceMetadata; query?: string; onDetails: () => void; savedList?: boolean;
}) {
  const { colors } = useColors();
  const bookmark = useBookmarkAction(resource, query);
  return <TTCard style={{ gap: 8 }} testID={`resource-card-${resource.id}`}>
    <View style={{ paddingLeft: 8, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.brand }}>
      <Text style={[TTTypography.bodyStrong, { color: colors.onBrand, flex: 1 }]}>{resource.title}</Text>
      <TTIconButton semanticLabel={`${bookmark.saved ? 'Unsave' : 'Save'} ${resource.title}`} isSelected={!!bookmark.saved}
        style={{ backgroundColor: colors.soft, borderRadius: 8 }} icon={bookmark.saved ? <ResourceSymbol name="saved" /> : <TTFigmaIcon name="bookmark" />}
        disabled={bookmark.pending || !bookmark.available || bookmark.snapshot.status === 'loading'} onPress={() => void bookmark.toggle()} />
    </View>
    <Text style={[TTTypography.small, { color: colors.muted }]}>{resource.providerName} · {resource.type}</Text>
    <Text numberOfLines={3} style={[TTTypography.small, { color: colors.muted }]}>{resource.description || 'Description unavailable from this source.'}</Text>
    {savedList && 'topic' in resource && !!resource.topic && <Text style={[TTTypography.small, { color: colors.link }]}>Topic: {resource.topic}</Text>}
    {bookmark.saved && <Text accessibilityLiveRegion="polite" style={[TTTypography.caption, { color: colors.muted }]}>Saved {savedDate(bookmark.saved.savedAt)}</Text>}
    <Text style={[TTTypography.caption, { color: colors.muted }]}>Reputation not checked</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.warningSoft }}>
        <ResourceSymbol name="shield" /><Text style={[TTTypography.caption, { color: colors.warning }]}>{assessmentLabel(evaluateUrl(resource.url))}</Text>
      </View>
      <TTButton label="View details" semanticLabel={`View details for ${resource.title}`} variant="study" onPress={onDetails} />
    </View>
    {!!bookmark.error && <TTNoticeCard type="error" title="Saved resources" message={bookmark.error} actionLabel={bookmark.saved ? 'Retry removal' : 'Retry save'} onActionPressed={() => void bookmark.toggle()} />}
  </TTCard>;
}
