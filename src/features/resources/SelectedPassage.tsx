import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { TTButton, TTCard } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';

export function SelectedPassage({ text, page }: { text: string; page: number }) {
  const { colors } = useColors();
  const [expanded, setExpanded] = useState(false);
  return <TTCard testID="topic-preview" backgroundColor={colors.soft} style={{ gap: 8 }}>
    <Text style={[TTTypography.caption, { color: colors.link }]}>SELECTED PASSAGE</Text>
    <Text testID="selected-passage" selectable numberOfLines={expanded ? undefined : 4}
      style={[TTTypography.section, { color: colors.ink }]}>{text}</Text>
    <Text style={[TTTypography.small, { color: colors.muted }]}>From page / section {page}</Text>
    <View style={{ alignItems: 'flex-start' }}><TTButton label={expanded ? 'Collapse passage' : 'Show full passage'} variant="ghost"
      accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} /></View>
  </TTCard>;
}
