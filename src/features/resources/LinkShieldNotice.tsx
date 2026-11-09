import React from 'react';
import { Text, View } from 'react-native';
import { TTCard } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { evaluateUrl, type LinkAssessment } from '../../core/services/link_shield';
import { ResourceSymbol } from './ResourceSymbols';

export function assessmentLabel(assessment: LinkAssessment) {
  return assessment.status === 'recognized' ? 'Recognized source' : assessment.status === 'unrecognized' ? 'Unrecognized source'
    : assessment.status === 'blocked' ? 'Link blocked' : 'Unable to verify';
}

export function LinkShieldNotice({ url }: { url: string }) {
  const { colors } = useColors();
  const assessment = evaluateUrl(url);
  return <TTCard testID="link-shield" style={{ gap: 8 }}>
    <Text accessibilityRole="header" style={[TTTypography.section, { color: colors.ink }]}>Source checks · Link Shield</Text>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.warningSoft }}>
      <ResourceSymbol name="shield" /><Text style={[TTTypography.caption, { color: colors.warning, flexShrink: 1 }]}>{assessmentLabel(assessment)}</Text>
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Text style={[TTTypography.small, { color: colors.muted }]}>Connection</Text>
      <Text style={[TTTypography.small, { color: colors.ink }]}>{assessment.connection === 'https' ? 'HTTPS URL' : 'Unsupported or unknown'}</Text>
    </View>
    <Text style={[TTTypography.small, { color: colors.ink }]}>Source: {assessment.sourceName ?? assessment.hostname ?? 'Unknown'}</Text>
    {[...assessment.reasons, ...assessment.warnings].map((reason, index) => <Text key={index} style={[TTTypography.small, { color: colors.muted }]}>{reason}</Text>)}
    <Text style={[TTTypography.small, { color: colors.warning }]}>Reputation not checked</Text>
    <Text style={[TTTypography.caption, { color: colors.muted }]}>URL and configured-source checks do not guarantee safety or accuracy. Website content, DNS changes and third-party requests are not inspected.</Text>
  </TTCard>;
}
