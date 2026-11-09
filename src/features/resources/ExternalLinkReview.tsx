import React, { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import * as Linking from 'expo-linking';
import { TTButton, TTCard, TTNoticeCard } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { evaluateUrl } from '../../core/services/link_shield';
import { LinkShieldNotice } from './LinkShieldNotice';

export function ExternalLinkReview({ url, onCancel }: { url: string; onCancel: () => void }) {
  const { colors } = useColors();
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const lock = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const assessment = evaluateUrl(url);
  async function open() {
    if (lock.current) return;
    const checked = evaluateUrl(url);
    if (!checked.canOpenExternal || !checked.normalizedUrl) { setError('This link is unavailable.'); return; }
    lock.current = true; setOpening(true); setError('');
    try { await Linking.openURL(checked.normalizedUrl); }
    catch { if (active.current) setError('Could not open this link. Please try again or check your browser settings.'); }
    finally { lock.current = false; if (active.current) setOpening(false); }
  }
  return <TTCard testID="external-review" style={{ gap: 12 }}>
    <Text accessibilityRole="header" style={[TTTypography.section, { color: colors.ink }]}>Review external destination</Text>
    <Text selectable style={[TTTypography.small, { color: colors.link }]}>{assessment.normalizedUrl ?? 'Unsupported destination'}</Text>
    <LinkShieldNotice url={url} />
    <Text style={[TTTypography.small, { color: colors.muted }]}>Opening this link leaves TopicTrail and uses your browser or another app. Review the destination before continuing.</Text>
    {!!error && <TTNoticeCard type="error" title="Link unavailable" message={error} />}
    <TTButton label="Continue in external browser" disabled={opening || !assessment.canOpenExternal} onPress={() => void open()} />
    <TTButton label="Cancel external opening" variant="secondary" onPress={onCancel} />
  </TTCard>;
}
