import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { Redirect } from 'expo-router';
import { TTScreen, TTArtwork } from '../../components';
import { useTheme } from '../../core/theme/ThemeContext';
import { TTTypography } from '../../core/design/tokens';
export function SplashScreen() {
  const { colors, colorScheme } = useTheme();
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setFinished(true), 2300);
    return () => clearTimeout(timer);
  }, []);
  if (finished) return <Redirect href="/welcome" />;
  return <TTScreen>
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <TTArtwork name="splashUpper" style={{ position: 'absolute', left: '50%', top: '50%', marginLeft: -71, marginTop: -272 }} />
      <TTArtwork name="splashLower" style={{ position: 'absolute', left: '50%', top: '50%', marginLeft: -399, marginTop: -18 }} />
      <View style={{ alignItems: 'center', width: '100%', maxWidth: 326, gap: 12 }}>
        <TTArtwork name="logo" />
        <View style={{ gap: 16, alignItems: 'center' }}>
          <Text style={[TTTypography.display, { color: colorScheme === 'dark' ? colors.ink : colors.brand }]}>TopicTrail</Text>
          <Text style={[TTTypography.body, { color: colors.muted, textAlign: 'center' }]}>Highlight. Explore. Learn.</Text>
        </View>
      </View>
    </View>
  </TTScreen>;
}
export default SplashScreen;
