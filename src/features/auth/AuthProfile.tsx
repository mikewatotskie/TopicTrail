import React from 'react';
import { Platform, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { TTCard, TTFigmaIcon, TTScreen } from '../../components';
import type { AccountIdentity } from '../../core/auth/types';
import { TTRadius, TTSpacing, TTTypography } from '../../core/design/tokens';
import { useTheme } from '../../core/theme/ThemeContext';
import { AuthAccessButton } from './AuthAccessLayout';

function useCompactProfile() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return width - insets.left - insets.right < 768;
}

const wrappingText = Platform.OS === 'web' ? { overflowWrap: 'anywhere' as const } : {};
const decorative = { accessible: false, accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants' as const, ...(Platform.OS === 'web' ? { 'aria-hidden': true } : {}) };

/** Profile-only composition. The shared form cap and other auth screens keep their own layouts. */
export function AuthProfileFrame({ busy, onBack, children }: {
  busy: boolean; onBack: () => void; children: React.ReactNode;
}) {
  const { colors, colorScheme } = useTheme();
  const compact = useCompactProfile();
  return <TTScreen variant="form">
    <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1, minWidth: 0 }}
      contentContainerStyle={{ paddingHorizontal: compact ? TTSpacing.space16 : TTSpacing.space32,
        paddingTop: TTSpacing.space24, paddingBottom: TTSpacing.space32, gap: TTSpacing.space24 }}>
      <View testID="profile-top-row" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
        justifyContent: 'space-between', gap: TTSpacing.space12, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: TTSpacing.space12 }}>
          <Image source={colorScheme === 'dark' ? require('../../assets/figma/726ad.svg') : require('../../assets/figma/4117e.svg')}
            {...decorative} style={{ width: 40, height: 40 }} contentFit="contain" />
          <Text style={[TTTypography.title, { color: colors.ink }]}>TopicTrail</Text>
        </View>
        <AuthAccessButton label="Back to Settings" variant="ghost"
          icon={<View {...decorative}><Text style={{ color: colors.link, fontSize: 20, lineHeight: 24 }}>←</Text></View>}
          disabled={busy} onPress={onBack} style={{ width: 'auto', alignSelf: 'flex-start' }} />
      </View>
      <View style={{ gap: TTSpacing.space8, marginTop: TTSpacing.space8 }}>
        <Text accessibilityRole="header" style={[TTTypography.heading, { fontSize: compact ? 28 : 32,
          lineHeight: compact ? 36 : 40, color: colors.ink }]}>Account</Text>
        <Text style={[TTTypography.body, { color: colors.muted }]}>Your profile and sign-in options.</Text>
      </View>
      {children}
    </ScrollView>
  </TTScreen>;
}

/** Presentation only: ProfileScreen continues to own every account action and pending state. */
export function AuthProfileDetails({ account, initials, busy, onResetPassword, onLogout }: {
  account: AccountIdentity; initials: string; busy: boolean; onResetPassword: () => void; onLogout: () => void;
}) {
  const { colors, colorScheme } = useTheme();
  const compact = useCompactProfile();
  const border = colorScheme === 'dark' ? '#34445D' : '#D8DDE5';
  const padding = compact ? TTSpacing.space20 : TTSpacing.space24;
  return <View style={{ gap: TTSpacing.space20, minWidth: 0 }}>
    <TTCard testID="profile-identity-card" padding={padding} borderRadius={TTRadius.radiusLg} borderColor={border}
      style={{ gap: TTSpacing.space24, minWidth: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: TTSpacing.space16, minWidth: 0 }}>
        <View {...decorative} style={{ width: compact ? 56 : 72, height: compact ? 56 : 72, flexShrink: 0,
          borderRadius: TTRadius.radiusFull, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={[TTTypography.heading, { color: colors.onAccent }]}>{initials}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: TTSpacing.space8 }}>
          <Text testID="profile-name" selectable style={[TTTypography.heading, { color: colors.ink, ...wrappingText }]}>
            {account.displayName || account.email || 'TopicTrail account'}
          </Text>
          {!!account.email && <Text testID="profile-email" selectable style={[TTTypography.small, { color: colors.muted, ...wrappingText }]}>{account.email}</Text>}
          <View testID="profile-status" style={{ flexDirection: 'row', alignItems: 'center', gap: TTSpacing.space8,
            alignSelf: 'flex-start', maxWidth: '100%', paddingHorizontal: TTSpacing.space12, paddingVertical: TTSpacing.space6,
            borderRadius: TTRadius.radiusFull, backgroundColor: colors.soft }}>
            <View {...decorative} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.link }} />
            <Text style={[TTTypography.smallStrong, { color: colors.link, flexShrink: 1 }]}>Signed in</Text>
          </View>
        </View>
      </View>
      <View testID="profile-library-note" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: TTSpacing.space12,
        padding: TTSpacing.space16, borderRadius: TTRadius.radiusMd, backgroundColor: colors.soft }}>
        <View {...decorative}><TTFigmaIcon name="book" /></View>
        <View style={{ flex: 1, minWidth: 0, gap: TTSpacing.space6 }}>
          <Text accessibilityRole="header" style={[TTTypography.bodyStrong, { color: colors.ink }]}>Your local library</Text>
          <Text style={[TTTypography.small, { color: colors.ink }]}>Your syllabi and saved links stay on this device. Signing in or out does not change them.</Text>
        </View>
      </View>
    </TTCard>
    <TTCard testID="profile-actions-card" padding={padding} borderRadius={TTRadius.radiusLg} borderColor={border}
      style={{ gap: TTSpacing.space20, minWidth: 0 }}>
      <Text accessibilityRole="header" style={[TTTypography.section, { color: colors.ink }]}>Session &amp; security</Text>
      <View testID="profile-password-row" style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center',
        gap: TTSpacing.space16, minWidth: 0 }}>
        <View style={{ flex: compact ? undefined : 1, minWidth: 0, gap: TTSpacing.space6 }}>
          <Text style={[TTTypography.bodyStrong, { color: colors.ink }]}>Password recovery</Text>
          <Text style={[TTTypography.small, { color: colors.muted }]}>Request a reset link by email.</Text>
        </View>
        <AuthAccessButton label="Reset password" disabled={busy} onPress={onResetPassword}
          style={{ width: compact ? '100%' : 172, flexShrink: 0 }} />
      </View>
      <View style={{ height: 1, backgroundColor: border }} />
      <View testID="profile-session-row" style={{ flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center',
        gap: TTSpacing.space16, minWidth: 0 }}>
        <View style={{ flex: compact ? undefined : 1, minWidth: 0, gap: TTSpacing.space6 }}>
          <Text style={[TTTypography.bodyStrong, { color: colors.ink }]}>Current session</Text>
          <Text style={[TTTypography.small, { color: colors.muted }]}>{Platform.OS === 'web'
            ? 'Your sign-in is remembered in this browser. Use Log out to end your session.'
            : 'Your sign-in is stored securely on this device. Use Log out to end your local session.'}</Text>
        </View>
        <AuthAccessButton label="Log out" variant="secondary" disabled={busy} onPress={onLogout}
          style={{ width: compact ? '100%' : 172, flexShrink: 0 }} />
      </View>
    </TTCard>
  </View>;
}
