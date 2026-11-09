import React from 'react';
import { Text } from 'react-native';
import { TTButton, TTCard, TTNoticeCard } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { evaluateUrl } from '../../core/services/link_shield';
import { LinkShieldNotice } from './LinkShieldNotice';

function approvedDestination(url: string): string | undefined {
  const assessment = evaluateUrl(url);
  return assessment.canOpenExternal && assessment.normalizedUrl?.startsWith('https://') ? assessment.normalizedUrl : undefined;
}
export function ExternalLinkReview({ url, onCancel }: { url: string; onCancel(): void }) {
  const { colors } = useColors();
  const destination = approvedDestination(url);
  return <TTCard testID="external-review" style={{ gap: 12 }}>
    <Text accessibilityRole="header" style={[TTTypography.section, { color: colors.ink }]}>Review external destination</Text>
    <Text selectable style={[TTTypography.small, { color: colors.link }]}>{destination ?? 'Unsupported destination'}</Text>
    <LinkShieldNotice url={url} />
    <Text style={[TTTypography.small, { color: colors.muted }]}>This opens a separate browser tab. TopicTrail keeps your current topic and results. The browser controls the website navigation and downloads; TopicTrail cannot enforce the custom Android download policy here.</Text>
    {destination ? <a href={destination} target="_blank" rel="noopener noreferrer"
      onClick={event => { if (approvedDestination(url) !== destination) event.preventDefault(); }}
      style={{ display: 'block', padding: 16, minHeight: 48, boxSizing: 'border-box', textAlign: 'center', borderRadius: 12,
        background: colors.accent, color: colors.onAccent, fontFamily: 'Inter', fontSize: 16, overflowWrap: 'anywhere' }}>
      Continue in external browser
    </a> : <TTNoticeCard type="error" title="Link unavailable" message="Choose a supported, public HTTPS destination." />}
    <TTButton label="Cancel external opening" variant="secondary" onPress={onCancel} />
  </TTCard>;
}
