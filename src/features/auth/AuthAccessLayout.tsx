import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { TTButton, TTFigmaIcon, TTScreen } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useTheme } from '../../core/theme/ThemeContext';
import { AuthStudyIllustration } from './AuthStudyIllustration';

/** Access-only focus/boundary styling; shared button width and loading policies stay intact. */
export function AuthAccessButton({ style, onFocus, onBlur, ...props }: React.ComponentProps<typeof TTButton>) {
  const { colors, colorScheme } = useTheme();
  const [focused, setFocused] = useState(false);
  const primary = !props.variant || props.variant === 'primary';
  return <TTButton {...props} aria-busy={props.isLoading || undefined} onFocus={event => { setFocused(true); onFocus?.(event); }}
    onBlur={event => { setFocused(false); onBlur?.(event); }}
    style={[{ width: '100%', maxWidth: '100%', minWidth: 0, minHeight: 48,
      ...(primary ? { borderWidth: 1, borderColor: colorScheme === 'dark' ? colors.link : colors.brand } : {}),
      outlineStyle: 'solid', outlineColor: colors.link, outlineWidth: focused ? 2 : 0, outlineOffset: 3 }, style]} />;
}

export function AuthAccessLayout({ title, description, backLabel, onBack, busy = false, children }: {
  title: string; description: string; backLabel: string; onBack: () => void; busy?: boolean; children: React.ReactNode;
}) {
  const { colors, colorScheme } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const availableWidth = Math.max(0, width - insets.left - insets.right);
  const wide = availableWidth >= 1024;
  const compact = availableWidth < 768;
  const gutter = compact ? 16 : 32;
  // TTScreen already owns safe areas. Its scoped cap is the USABLE composition;
  // don't subtract the app rail or add a second set of horizontal gutters inside it.
  const maxWidth = Math.min(1140, Math.max(0, availableWidth - 2 * gutter));
  const gap = wide ? Math.min(96, 48 + (availableWidth - 1024) * 48 / 416) : 24;
  const logoSize = wide ? 44 : 32;
  return <TTScreen variant="form" style={{ maxWidth }}>
    <KeyboardAvoidingView style={{ flex: 1, minHeight: 0, minWidth: 0 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1, minWidth: 0 }}
        contentContainerStyle={{ paddingTop: wide ? 32 : 24, paddingBottom: 32, minWidth: 0 }}>
        <View testID="auth-access-top-row" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <Image source={colorScheme === 'dark' ? require('../../assets/figma/726ad.svg') : require('../../assets/figma/4117e.svg')}
              accessible={false} style={{ width: logoSize, height: logoSize }} contentFit="contain" />
            <Text style={[TTTypography.title, { fontSize: wide ? 24 : 20, lineHeight: wide ? 32 : 28, color: colors.ink }]}>TopicTrail</Text>
          </View>
          <AuthAccessButton label={backLabel} variant="ghost" icon={<TTFigmaIcon name="back" />} disabled={busy} onPress={onBack}
            style={{ width: 'auto', flexShrink: 0, alignSelf: 'flex-start' }} />
        </View>
        <View testID="auth-access-composition" style={{ flexDirection: wide ? 'row' : 'column', alignItems: 'stretch',
          width: '100%', maxWidth: wide ? '100%' : 440, minWidth: 0, alignSelf: 'center', gap, marginTop: wide ? 48 : 24 }}>
          <View testID="auth-access-intro" style={{ flex: wide ? 1 : undefined, minWidth: 0, gap: 16 }}>
            <View style={{ maxWidth: 440, minWidth: 0, gap: 16 }}>
              <Text style={[TTTypography.display, { fontSize: wide ? 44 : 26, lineHeight: wide ? 50 : 32, color: colors.ink }]}>Your syllabus.<Text>{'\n'}Your next discovery.</Text></Text>
              <Text style={[TTTypography.body, { color: colors.muted }]}>Open your syllabus, highlight a topic, and find resources to help you understand it.</Text>
            </View>
            {wide && <AuthStudyIllustration />}
          </View>
          <View testID="auth-access-card" style={{ width: wide ? 440 : '100%', maxWidth: '100%', minWidth: 0, flexShrink: 0,
            alignSelf: wide ? 'flex-start' : 'stretch', padding: compact ? 20 : 32, borderRadius: 24, borderWidth: 1,
            borderColor: colorScheme === 'dark' ? '#34445D' : '#D8DDE5', backgroundColor: colors.surface, gap: 20 }}>
            <View style={{ gap: 8, minWidth: 0, marginBottom: 4 }}>
              <Text accessibilityRole="header" style={[TTTypography.heading, { fontSize: wide ? 28 : 24, lineHeight: wide ? 36 : 32, color: colors.ink }]}>{title}</Text>
              <Text style={[TTTypography.body, { color: colors.muted }]}>{description}</Text>
            </View>
            {children}
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </TTScreen>;
}
