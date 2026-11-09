import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TTButton, TTCard, TTFeedback, TTFigmaIcon } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';

const story = [
  {
    title: 'Start with two fictional devices',
    summary: 'Imagine the same learner opening TopicTrail on a laptop and a phone.',
    first: 'Library ready',
    second: 'Waiting for a cloud copy',
    action: 'Simulate upload',
  },
  {
    title: 'Device A adds a syllabus',
    summary: 'The fictional laptop adds Intro to Programming to its library.',
    first: 'Intro to Programming · Page 1 of 3',
    second: 'Waiting for a cloud copy',
    action: 'Simulate reading and saving',
  },
  {
    title: 'Device A reads and saves a link',
    summary: 'The learner reaches page 2 and saves the Iteration article.',
    first: 'Page 2 of 3 · Iteration bookmarked',
    second: 'Waiting for a cloud copy',
    action: 'Simulate sync',
  },
  {
    title: 'Device B receives the fictional changes',
    summary: 'The fictional phone receives the sample syllabus, bookmark, and reading position.',
    first: 'Page 2 of 3 · Iteration bookmarked',
    second: 'Page 2 of 3 · Iteration bookmarked',
    action: 'Continue on Device B',
  },
  {
    title: 'Device B continues reading',
    summary: 'The phone opens at page 2 and advances to page 3. The laptop last read page 2.',
    first: 'Page 2 of 3 · Iteration bookmarked',
    second: 'Page 3 of 3 · Iteration bookmarked',
    action: undefined,
  },
] as const;

export function DemoCloudStory({ narrow }: { narrow: boolean }) {
  const { colors } = useColors();
  const [step, setStep] = useState(0);
  const scene = story[step];

  return <TTCard padding={narrow ? 16 : 24} borderRadius={20} backgroundColor={colors.warningSoft} style={styles.section}>
    <Text style={[TTTypography.smallStrong, styles.badge, { color: colors.warning, backgroundColor: colors.surface }]}>SIMULATION ONLY</Text>
    <Text accessibilityRole="header" style={[TTTypography.heading, { color: colors.ink }]}>Imagine studying across devices</Text>
    <Text style={[TTTypography.body, { color: colors.ink }]}>
      This walkthrough uses fictional devices and sample activity. Your real library and bookmarks stay separate.
    </Text>
    <TTFeedback message={'Step ' + step + ' of ' + (story.length - 1) + '. ' + scene.title}
      style={[TTTypography.bodyStrong, { color: colors.ink }]} />
    <Text style={[TTTypography.small, { color: colors.ink }]}>{scene.summary}</Text>
    <View style={[styles.devices, { flexDirection: narrow ? 'column' : 'row' }]}>
      {[
        { title: 'Device A · Laptop', state: scene.first },
        { title: 'Device B · Phone', state: scene.second },
      ].map(device => <TTCard key={device.title} style={[styles.device, !narrow && styles.column]}>
        <View style={styles.deviceLabel}>
          <TTFigmaIcon name="book" />
          <Text accessibilityRole="header" style={[TTTypography.bodyStrong, { color: colors.ink, flex: 1 }]}>{device.title}</Text>
        </View>
        <Text style={[TTTypography.small, { color: colors.muted }]}>{device.state}</Text>
      </TTCard>)}
    </View>
    <View style={styles.actions}>
      {scene.action && <TTButton label={scene.action} variant="primary" widthPolicy="responsiveAction"
        onPress={() => setStep(Math.min(step + 1, story.length - 1))} />}
      <TTButton label="Reset simulation" variant="secondary" widthPolicy="responsiveAction" disabled={step === 0} onPress={() => setStep(0)} />
    </View>
  </TTCard>;
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  badge: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, letterSpacing: 0.6 },
  devices: { gap: 12 },
  device: { gap: 8 },
  column: { flex: 1, minWidth: 0 },
  deviceLabel: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
});
