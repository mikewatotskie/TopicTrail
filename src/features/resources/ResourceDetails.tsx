import React, { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Text, View, Platform } from 'react-native';
import * as Linking from 'expo-linking';
import { TTButton, TTCard, TTIconButton, TTNoticeCard, TTScreen, TTFigmaIcon } from '../../components';
import { TTAppBar } from '../../navigation';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { evaluateUrl } from '../../core/services/link_shield';
import { savedDate, useBookmarkAction, type ResourceMetadata } from '../saved/useBookmarks';
import { SelectedPassage } from './SelectedPassage';
import { LinkShieldNotice } from './LinkShieldNotice';
import { ResourceBrowser } from './ResourceBrowser';
import { ExternalLinkReview } from './ExternalLinkReview';

export function ResourceDetails({ resource, query, onClose }: { resource: ResourceMetadata; query?: string; onClose: () => void }) {
  const { colors } = useColors();
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const bookmark = useBookmarkAction(resource, query);
  const assessment = evaluateUrl(resource.url);
  const topic = query ?? ('topic' in resource ? resource.topic : undefined);
  const attribution = resource.attribution;
  const openingLock = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function open(value: string) {
    if (openingLock.current) return;
    // Revalidate at the platform boundary. Provider URLs are untrusted input.
    const checked = evaluateUrl(value);
    if (!checked.canOpenExternal || !checked.normalizedUrl) { setError('This link is unavailable. Close details and search again for an updated source.'); return; }
    if (Platform.OS === 'web') { setError(''); setReview(value); return; }
    if (checked.status !== 'recognized') { setError('This link is unavailable in TopicTrail. Review the external destination before choosing whether to continue.'); setReview(value); return; }
    setError(''); setOpening(true); openingLock.current = true;
    try { await Linking.openURL(checked.normalizedUrl); }
    catch { if (active.current) setError('Could not open this link. Please try again or check your browser settings.'); }
    finally { openingLock.current = false; if (active.current) setOpening(false); }
  }
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <TTScreen variant="form"><TTAppBar title="Resource details" leading={<TTIconButton icon={<TTFigmaIcon name="back" />}
      semanticLabel="Close resource details" onPress={onClose} />} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Text accessibilityRole="header" style={[TTTypography.heading, { color: colors.ink }]}>{resource.title}</Text>
        <Text style={[TTTypography.body, { color: colors.muted }]}>{resource.providerName} · {resource.type}</Text>
        <Text selectable style={[TTTypography.small, { color: colors.link }]}>{resource.url}</Text>
        <LinkShieldNotice url={resource.url} />
        {!!bookmark.error && <TTNoticeCard type="error" title="Saved resources" message={bookmark.error} />}
        <TTCard style={{ gap: 8 }}>
          <Text style={[TTTypography.section, { color: colors.ink }]}>Source excerpt</Text>
          <Text selectable style={[TTTypography.body, { color: colors.ink }]}>{resource.description || 'Description unavailable from this source.'}</Text>
          <Text style={[TTTypography.caption, { color: colors.muted }]}>Shortened excerpt supplied by {resource.providerName}; it has not been rewritten by TopicTrail.</Text>
        </TTCard>
        {!!topic && <Text style={[TTTypography.small, { color: colors.muted }]}>Found for topic query: {topic}</Text>}
        {'selectedTopic' in resource && <SelectedPassage text={resource.selectedTopic} page={resource.page} />}
        {bookmark.saved && <Text style={[TTTypography.small, { color: colors.muted }]}>Saved {savedDate(bookmark.saved.savedAt)}</Text>}
        <Text style={[TTTypography.caption, { color: colors.muted }]}>Saved resources keep link metadata on this device, not an offline copy of the website.</Text>
        {attribution && <TTCard style={{ gap: 8 }}>
          <Text style={[TTTypography.section, { color: colors.ink }]}>Source attribution</Text>
          <Text style={[TTTypography.body, { color: colors.ink }]}>{attribution.author}</Text>
          <Text style={[TTTypography.small, { color: colors.muted }]}>{attribution.licenseName}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <TTButton label="View source" variant="ghost" disabled={opening} onPress={() => void open(attribution.sourceUrl)} />
            <TTButton label="View license" variant="ghost" disabled={opening} onPress={() => void open(attribution.licenseUrl)} />
            {!!attribution.revisionUrl && <TTButton label="View revision" variant="ghost" disabled={opening} onPress={() => void open(attribution.revisionUrl!)} />}
          </View>
        </TTCard>}
        <TTButton label={Platform.OS === 'web' ? 'Review website' : 'Open in TopicTrail'} variant="study" disabled={!assessment.canOpenInApp} onPress={() => setBrowser(true)} />
        <TTButton label={bookmark.error ? (bookmark.saved ? 'Retry removal' : 'Retry save') : bookmark.saved ? 'Unsave resource' : 'Save resource'} variant="secondary"
          isLoading={bookmark.pending} disabled={!bookmark.available || bookmark.snapshot.status === 'loading'} onPress={() => void bookmark.toggle()} />
        <Text style={[TTTypography.small, { color: colors.muted }]}>Open website asks your device to open the link externally. Your browser or an associated app may handle it. Review the source before using it in your studies.</Text>
        {!!error && <TTNoticeCard type="error" title="Link unavailable" message={error} />}
        {review && <ExternalLinkReview key={review} url={review} onCancel={() => setReview(null)} />}
        <TTButton label="Open website" variant="secondary" disabled={opening} onPress={() => void open(resource.url)} />
        <TTButton label="Back to results" variant="secondary" onPress={onClose} />
      </ScrollView>
    </TTScreen>
    {browser && <ResourceBrowser url={resource.url} title={resource.title} onClose={() => setBrowser(false)} />}
  </Modal>;
}
