import React, { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Text, View, Platform } from 'react-native';
import * as Linking from 'expo-linking';
import { TTButton, TTCard, TTIconButton, TTNoticeCard, TTScreen, TTFigmaIcon } from '../../components';
import { TTAppBar } from '../../navigation';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { evaluateUrl } from '../../core/services/link_shield';
import { savedDate, useBookmarkAction, type ResourceMetadata } from '../saved/useBookmarks';
import { LinkShieldNotice } from './LinkShieldNotice';
import { ResourceBrowser } from './ResourceBrowser';
import { ExternalLinkReview } from './ExternalLinkReview';

export function ResourceDetails({ resource, query, onClose }: { resource: ResourceMetadata; query?: string; onClose: () => void }) {
  const { colors } = useColors();
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [showAttribution, setShowAttribution] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const bookmark = useBookmarkAction(resource, query);
  const instantAnswer = resource.providerId === 'duckduckgo';
  const assessment = evaluateUrl(resource.url);
  const topic = query ?? ('topic' in resource ? resource.topic : undefined);
  const attribution = resource.attribution;
  const page = 'page' in resource ? resource.page : undefined;
  const passage = 'selectedTopic' in resource ? resource.selectedTopic : undefined;
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
    <TTScreen variant="form"><TTAppBar title="Resource details" leading={<TTIconButton icon={<TTFigmaIcon name="back" tintColor={colors.link} />}
      semanticLabel="Close resource details" onPress={onClose} />} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}>
        <Text accessibilityRole="header" style={[TTTypography.heading, { color: colors.ink }]}>{resource.title}</Text>
        <Text style={[TTTypography.body, { color: colors.muted }]}>{[resource.providerName, assessment.hostname].filter(Boolean).join(' · ')}</Text>
        <Text style={[TTTypography.caption, { color: colors.link }]}>{instantAnswer ? 'DUCKDUCKGO INSTANT ANSWER' : resource.type.toUpperCase()}{resource.providerId === 'wikipedia' ? '     FREE ACCESS' : ''}</Text>
        <Text selectable style={[TTTypography.body, { color: colors.muted }]}>{resource.description || 'Description unavailable from this source.'}</Text>
        {!!(topic || passage) && <TTCard padding={12} style={{ gap: 8 }}>
          <Text style={[TTTypography.caption, { color: colors.link }]}>{passage ? 'SYLLABUS TOPIC' : 'SEARCH TOPIC'}</Text>
          <Text selectable style={[TTTypography.bodyStrong, { color: colors.link }]}>{topic || passage}{page ? ` · Page / section ${page}` : ''}</Text>
          {!!passage && passage !== topic && <Text selectable style={[TTTypography.small, { color: colors.muted }]}>{passage}</Text>}
        </TTCard>}
        <LinkShieldNotice url={resource.url} />
        <TTButton label={attribution ? 'Source attribution' : 'Source information'} variant="ghost"
          style={{ alignSelf: 'flex-start' }} accessibilityState={{ expanded: showAttribution }} onPress={() => setShowAttribution(value => !value)} />
        {showAttribution && <TTCard padding={12} style={{ gap: 8 }}>
          <Text selectable style={[TTTypography.small, { color: colors.link }]}>{resource.url}</Text>
          {attribution && <>
            <Text style={[TTTypography.small, { color: colors.muted }]}>{attribution.author} · {attribution.licenseName}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
              <TTButton label="View source" variant="ghost" disabled={opening} onPress={() => void open(attribution.sourceUrl)} />
              <TTButton label="View license" variant="ghost" disabled={opening} onPress={() => void open(attribution.licenseUrl)} />
              {!!attribution.revisionUrl && <TTButton label="View revision" variant="ghost" disabled={opening} onPress={() => void open(attribution.revisionUrl!)} />}
            </View>
          </>}
        </TTCard>}
        {bookmark.saved && <Text style={[TTTypography.small, { color: colors.muted }]}>Saved {savedDate(bookmark.saved.savedAt)}</Text>}
        {!!bookmark.error && <TTNoticeCard type="error" title="Saved resources" message={bookmark.error} />}
        {!!error && <TTNoticeCard type="error" title="Link unavailable" message={error} />}
        {review && <ExternalLinkReview key={review} url={review} onCancel={() => setReview(null)} />}
        <View style={{ marginTop: 'auto', gap: 8, paddingTop: 8 }}>
          <TTButton label={instantAnswer ? 'Open cited source' : 'Open website'} disabled={opening || !assessment.canOpenExternal}
            onPress={() => assessment.canOpenInApp ? setBrowser(true) : void open(resource.url)} />
          <TTButton label={bookmark.alreadySaved ? 'Already saved' : bookmark.error ? (bookmark.saved ? 'Retry removal' : 'Retry save') : bookmark.saved ? 'Unsave resource' : 'Save resource'} variant="secondary"
            isLoading={bookmark.pending} disabled={bookmark.alreadySaved || !bookmark.available || bookmark.snapshot.status === 'loading'} onPress={() => void bookmark.toggle()} />
          {showAttribution && assessment.canOpenInApp && Platform.OS !== 'web' && <TTButton label="Open in external browser" variant="ghost" disabled={opening} onPress={() => void open(resource.url)} />}
        </View>
      </ScrollView>
    </TTScreen>
    {browser && <ResourceBrowser url={resource.url} title={resource.title} onClose={() => setBrowser(false)} />}
  </Modal>;
}
