import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { TTButton, TTScreen, TTCard, TTFigmaIcon, TTAura } from '../../components';
import { TTAppBar } from '../../navigation';
import { useColors } from '../../core/theme/ThemeContext';
import { TTTypography } from '../../core/design/tokens';
export function WelcomeScreen() {
  const { colors } = useColors();
  return <TTScreen>
    <TTAura style={{ right: -50, bottom: 44 }} />
    <TTAppBar title="TopicTrail" automaticallyImplyLeading={false} />
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <View accessible accessibilityLabel="Illustration: highlight a syllabus topic to explore study resources"
        style={{ height: 264, borderRadius: 24, overflow: 'hidden', backgroundColor: colors.soft }}>
        <TTCard style={{ position: 'absolute', left: 24, top: 24, width: 190 }}>
          <TTFigmaIcon name="file" slot={32} />
          <Text style={[TTTypography.bodyStrong, { color: colors.ink, marginVertical: 8 }]}>Your syllabus</Text>
          {['Variables', 'Loops & iteration', 'Functions'].map((label, i) => <View key={label}
            style={{ padding: 8, borderRadius: 8, backgroundColor: i === 1 ? colors.highlight : colors.canvas, marginBottom: i === 2 ? 0 : 8 }}>
            <Text style={[TTTypography.small, { color: i === 1 ? colors.link : colors.muted }]}>{label}</Text>
          </View>)}
        </TTCard>
        <TTCard style={{ position: 'absolute', right: 16, top: 124, width: 174 }}>
          <TTFigmaIcon name="study" />
          <Text style={[TTTypography.small, { color: colors.link, marginVertical: 8 }]}>Study resources</Text>
          <Text style={[TTTypography.caption, { color: colors.muted }]}>Free resources{'\n'}Source checks</Text>
        </TTCard>
      </View>
      <Text style={[TTTypography.display, { color: colors.ink }]}>Study your syllabus</Text>
      <Text style={[TTTypography.body, { color: colors.muted }]}>Upload a PDF or DOCX. Highlight a topic, then tap Study to choose what to learn.</Text>
    </ScrollView>
    <View style={{ padding: 16, gap: 8, backgroundColor: colors.surface }}>
      <TTButton label="Get started" variant="study" isExpanded onPress={() => router.replace('/(tabs)/home')} />
      <TTButton label="Log in" variant="secondary" isExpanded onPress={() => router.replace({ pathname: '/auth/login', params: { origin: 'welcome' } })} />
      <TTButton label="Presentation demo" variant="ghost" isExpanded onPress={() => router.push('/demo')} />
      <Text style={[TTTypography.caption, { color: colors.muted, textAlign: 'center' }]}>No account required.</Text>
    </View>
  </TTScreen>;
}
export default WelcomeScreen;
