import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '../core/theme/ThemeContext';
import { TTIconButton } from '../components/TTIconButton';
import { TTFigmaIcon } from '../components/TTArtwork';
import { TTTypography } from '../core/design/tokens';
import { useResponsiveLayout } from '../core/layout/useResponsiveLayout';
export { NavDestination } from '../core/design/tokens';

export const destinations = [
  { key: 'home', label: 'Home', path: '/(tabs)/home', icon: 'home', muted: 'homeMuted' },
  { key: 'mySyllabi', label: 'My Syllabi', path: '/(tabs)/library', icon: 'book', muted: 'bookMuted' },
  { key: 'saved', label: 'Saved', path: '/(tabs)/saved', icon: 'bookmark', muted: 'bookmarkMuted' },
  { key: 'settings', label: 'Settings', path: '/(tabs)/settings', icon: 'settings', muted: 'settingsMuted' },
] as const;
export function TTBottomNavigationBar({ currentDestination, onDestinationSelected, testID }: {
  currentDestination: string; onDestinationSelected: (dest: string) => void; testID?: string;
}) {
  const { colors } = useColors();
  const inset = useSafeAreaInsets();
  const { contentMaxWidth } = useResponsiveLayout();
  return <View style={{ backgroundColor: colors.surface, paddingBottom: inset.bottom, borderTopWidth: 1, borderColor: colors.border }}>
    <View testID={testID} style={{ flexDirection: 'row', maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center', padding: 8 }}>
      {destinations.map(dest => <TouchableOpacity key={dest.key} accessibilityRole="tab"
        accessibilityState={{ selected: currentDestination === dest.key }} aria-selected={currentDestination === dest.key} accessibilityLabel={dest.label}
        onPress={() => onDestinationSelected(dest.key)} style={{ flex: 1, minHeight: 64, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        <TTFigmaIcon name={currentDestination === dest.key ? dest.icon : dest.muted} />
        <Text style={[TTTypography.caption, { textAlign: 'center', color: currentDestination === dest.key ? colors.link : colors.muted }]}>{dest.label}</Text>
      </TouchableOpacity>)}
    </View>
  </View>;
}
export function TopicTrailTabBar({ routeName }: { routeName: string }) {
  const current = destinations.find(dest => dest.path.endsWith('/' + routeName))?.key ?? 'home';
  return <TTBottomNavigationBar currentDestination={current} onDestinationSelected={key => {
    const destination = destinations.find(dest => dest.key === key);
    if (destination) router.navigate(destination.path);
  }} />;
}
export function TTAppBar({ title, leading, actions, automaticallyImplyLeading = true, backgroundColor, foregroundColor }: {
  title?: React.ReactNode; leading?: React.ReactNode; actions?: React.ReactNode[]; automaticallyImplyLeading?: boolean;
  backgroundColor?: string; foregroundColor?: string; centerTitle?: boolean; elevation?: number; testID?: string;
}) {
  const { colors } = useColors();
  return <View style={{ minHeight: 64, paddingHorizontal: 16, backgroundColor: backgroundColor ?? colors.brand,
    flexDirection: 'row', alignItems: 'center', gap: 8 }}>
    {leading ?? (automaticallyImplyLeading && <TTIconButton icon={<TTFigmaIcon name="back" />} color={foregroundColor ?? colors.onBrand}
      semanticLabel="Go back" onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/home')} />)}
    <View style={{ flex: 1, paddingVertical: 8 }}>{typeof title === 'string' ? <Text style={[TTTypography.title, { color: foregroundColor ?? colors.onBrand }]} numberOfLines={2}>{title}</Text> : title}</View>
    {actions}
  </View>;
}
