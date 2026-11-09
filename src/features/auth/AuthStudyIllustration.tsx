import React from 'react';
import { Text, View } from 'react-native';
import { TTArtwork, TTFigmaIcon } from '../../components/TTArtwork';
import { TTTypography } from '../../core/design/tokens';
import { useTheme } from '../../core/theme/ThemeContext';

// Adjacent introduction copy explains the sequence. This entire composition is decorative.
// The desktop caller supplies at least 472px; cards keep natural height and can wrap.
export function AuthStudyIllustration(): React.JSX.Element {
  const { colors, colorScheme } = useTheme();
  const borderColor = colorScheme === 'dark' ? '#34445D' : '#D8DDE5';
  return <View testID="auth-study-illustration" pointerEvents="none" accessible={false} aria-hidden
    accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ width: '100%', minWidth: 0, paddingVertical: 24 }}>
    <TTArtwork name="quiet" style={{ position: 'absolute', left: 0, top: 24, opacity: 0.65 }} />
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
      <View style={{ flexBasis: 236, flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: 288,
        padding: 20, borderRadius: 24, borderWidth: 1, borderColor, backgroundColor: colors.surface }}>
        <TTFigmaIcon name="file" slot={32} />
        <Text style={[TTTypography.section, { color: colors.ink, marginTop: 12, marginBottom: 20 }]}>Programming basics</Text>
        {['Variables', 'Loops & iteration', 'Functions'].map((topic, index) => <View key={topic}
          style={{ padding: 12, borderRadius: 8, marginBottom: index === 2 ? 0 : 8,
            backgroundColor: index === 1 ? colors.accent : colors.canvas }}>
          <Text style={[TTTypography.small, { color: index === 1 ? colors.onAccent : colors.muted }]}>{topic}</Text>
        </View>)}
        <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 8,
          marginTop: 16, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.accent }}>
          <TTFigmaIcon name="studyAccent" />
          <Text style={[TTTypography.smallStrong, { color: colors.onAccent }]}>Study</Text>
        </View>
      </View>
      <View style={{ flexBasis: 188, flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: 260, gap: 12 }}>
        <View style={{ alignSelf: 'flex-start', padding: 12, borderRadius: 24, backgroundColor: colors.brand }}>
          <TTArtwork name="trail" />
        </View>
        {[{ kind: 'Learning guide', title: 'Understand loops' }, { kind: 'Practice', title: 'Explore an example' }].map(resource => <View key={resource.kind}
          style={{ padding: 16, gap: 8, borderRadius: 16, borderWidth: 1, borderColor, backgroundColor: colors.surface }}>
          <Text style={[TTTypography.small, { color: colors.muted }]}>{resource.kind}</Text>
          <Text style={[TTTypography.bodyStrong, { color: colors.ink }]}>{resource.title}</Text>
        </View>)}
      </View>
    </View>
  </View>;
}
