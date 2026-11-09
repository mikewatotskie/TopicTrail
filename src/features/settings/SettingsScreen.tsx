import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Modal } from 'react-native';
import { useTheme } from '../../core/theme/ThemeContext';
import { ThemeMode, TTTypography } from '../../core/design/tokens';
import { TTButton, TTCard, TTScreen, TTArtwork, TTAura, TTNoticeCard, TTIconButton, TTFigmaIcon } from '../../components';
import { TTAppBar } from '../../navigation';
import { router } from 'expo-router';
import { useAuth } from '../auth/AuthContext';

export function SettingsScreen() {
  const { colors, colorScheme, themeMode, setThemeMode } = useTheme();
  const { state: auth } = useAuth();
  const [detail, setDetail] = useState<'privacy' | 'checks'>('privacy');
  const [detailVisible, setDetailVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function showDetail(next: 'privacy' | 'checks') {
    setDetail(next);
    setDetailVisible(true);
  }
  async function changeTheme(mode: ThemeMode) {
    if (busy) return;
    setBusy(true); setError('');
    try { await setThemeMode(mode); } catch { setError('Your preference could not be saved. Please try again.'); }
    finally { setBusy(false); }
  }
  return <TTScreen variant="form" bottomInset={false}>
    <TTAura kind="quiet" style={{ left: -126, top: 96 }} />
    <TTAppBar title="Settings" automaticallyImplyLeading={false} />
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      {!!error && <TTNoticeCard type="error" title="Preference not saved" message={error} />}
      <TTCard borderRadius={16} style={{ gap: 8 }}><Text style={[TTTypography.section, { color: colors.ink }]}>Account</Text>
        {auth.status === 'account' ? <>
          <Text style={[TTTypography.bodyStrong, { color: colors.ink }]}>{auth.account.displayName || auth.account.email || 'TopicTrail account'}</Text>
          {!!auth.account.email && <Text style={[TTTypography.small, { color: colors.muted }]}>{auth.account.email}</Text>}
          <TTButton label="View account" variant="secondary" onPress={() => router.replace('/auth/profile')} />
        </> : <>
          <Text style={[TTTypography.bodyStrong, { color: colors.ink }]}>Guest</Text>
          <Text style={[TTTypography.small, { color: colors.muted }]}>{auth.status === 'loading' ? 'Checking account session…' : auth.status === 'unavailable' ? 'Authentication is unavailable. Guest features remain available.' : 'Log in or create your TopicTrail account.'}</Text>
          <TTButton label="Log in" variant="secondary" onPress={() => router.replace({ pathname: '/auth/login', params: { origin: 'settings' } })} />
          <TTButton label="Create account" variant="ghost" onPress={() => router.replace({ pathname: '/auth/register', params: { origin: 'settings' } })} />
        </>}
      </TTCard>
      <TTCard borderRadius={16} style={{ gap: 8 }}>
        <Text style={[TTTypography.section, { color: colors.ink }]}>Presentation guide</Text>
        <Text style={[TTTypography.small, { color: colors.muted }]}>Try sample documents and the working local library. The cross-device preview uses synthetic data; cloud synchronization is not connected.</Text>
        <TTButton label="Open presentation guide" variant="secondary" onPress={() => router.push('/demo')} />
      </TTCard>
      <TTCard borderRadius={16}><Text style={[TTTypography.section, { color: colors.ink, marginBottom: 16 }]}>Appearance</Text>
        <TouchableOpacity accessibilityRole="switch" accessibilityLabel="Dark mode" accessibilityState={{ checked: colorScheme === 'dark', disabled: busy }} aria-checked={colorScheme === 'dark'}
          disabled={busy} onPress={() => changeTheme(colorScheme === 'dark' ? ThemeMode.LIGHT : ThemeMode.DARK)}
          style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <Text style={[TTTypography.smallStrong, { color: colors.ink, flex: 1 }]}>Dark mode</Text>
          <TTArtwork name={colorScheme === 'dark' ? 'switchOn' : 'switchOff'} style={{ width: 64, height: 48, justifyContent: 'center' }} />
        </TouchableOpacity>
        <TTButton label={themeMode === ThemeMode.SYSTEM ? 'Using device appearance' : 'Use device appearance'} variant="ghost"
          disabled={busy || themeMode === ThemeMode.SYSTEM} onPress={() => changeTheme(ThemeMode.SYSTEM)} />
      </TTCard>
      <TTCard backgroundColor={colors.brand}><View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', minHeight: 40, marginBottom: 8 }}>
        <TTArtwork name="mark" style={{ padding: 4 }} /><Text style={[TTTypography.title, { color: colors.onBrand }]}>TopicTrail</Text>
      </View><Text style={[TTTypography.small, { color: colors.onBrand }]}>Highlight. Explore. Learn.</Text></TTCard>
      <TTCard><Text style={[TTTypography.section, { color: colors.ink }]}>Privacy and data</Text>
        <Text style={[TTTypography.small, { color: colors.muted, marginVertical: 8 }]}>Your document files stay on this device. Search sends only the topic query you review to Wikipedia.</Text>
        <TTButton label="Privacy details" variant="ghost" onPress={() => showDetail('privacy')} />
      </TTCard>
      <TTCard><Text style={[TTTypography.section, { color: colors.ink }]}>Source checks</Text>
        <Text style={[TTTypography.small, { color: colors.muted, marginVertical: 8 }]}>Wikipedia results include source and attribution details. Link reputation checks are not available yet.</Text>
        <TTButton label="About source checks" variant="ghost" onPress={() => showDetail('checks')} />
      </TTCard>
    </ScrollView>
    <Modal visible={detailVisible} animationType="slide" onRequestClose={() => setDetailVisible(false)}>
      <TTScreen variant="form"><TTAppBar title={detail === 'privacy' ? 'Privacy and data' : 'About source checks'}
        leading={<TTIconButton icon={<TTFigmaIcon name="back" />} semanticLabel="Back to Settings" onPress={() => setDetailVisible(false)} />} />
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          <Text style={[TTTypography.heading, { color: colors.ink }]}>{detail === 'privacy' ? 'Your documents and selections' : 'About source checks'}</Text>
          {detail === 'privacy' ? <>
            <Text style={[TTTypography.body, { color: colors.muted }]}>Your syllabi are stored on this device. Reading and selecting text do not upload your file. After Study, review or edit the topic query; only that query is sent to Wikipedia when you tap Search. Wikipedia also receives normal connection information such as your IP address.</Text>
            <Text style={[TTTypography.body, { color: colors.muted }]}>You can rename or remove a document from My Syllabi. Copy places your selection on the device clipboard.</Text>
          </> : <>
            <TTNoticeCard title="Reputation checks are unavailable" message="URL and configured-source checks are available. Link reputation checks do not run in this version." />
            {[['Topic match', 'How closely a resource matches your selected topic.'], ['Connection', 'HTTPS encrypts the connection. It does not prove a website is safe.'],
              ['Source information', 'Information about the publisher, including official documentation and educational sources.'],
              ['Free access', 'Whether a resource can be used without payment.'], ['Link reputation', 'Available reports about harmful or suspicious links. Unavailable checks will be marked.']].map(([title, text]) =>
              <TTCard key={title}><Text style={[TTTypography.section, { color: colors.ink }]}>{title}</Text><Text style={[TTTypography.body, { color: colors.muted, marginTop: 8 }]}>{text}</Text></TTCard>)}
            <Text style={[TTTypography.small, { color: colors.muted }]}>Checks do not guarantee safety or accuracy.</Text>
          </>}
          <TTButton label="Back to Settings" variant="secondary" onPress={() => setDetailVisible(false)} />
        </ScrollView>
      </TTScreen>
    </Modal>
  </TTScreen>;
}
export default SettingsScreen;
