import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { TTScanChooser, type ScanEntryHandler } from './TTScanChooser';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '../core/theme/ThemeContext';
import { TTIconButton } from '../components/TTIconButton';
import { TTFigmaIcon } from '../components/TTArtwork';
import { TTRadius, TTTypography } from '../core/design/tokens';
import { useResponsiveLayout } from '../core/layout/useResponsiveLayout';
export { NavDestination } from '../core/design/tokens';

export const destinations = [
  { key: 'home', label: 'Home', path: '/(tabs)/home', icon: 'dockHome' },
  { key: 'mySyllabi', label: 'My Syllabi', path: '/(tabs)/library', icon: 'dockLibrary' },
  { key: 'saved', label: 'Saved', path: '/(tabs)/saved', icon: 'dockSaved' },
  { key: 'settings', label: 'Settings', path: '/(tabs)/settings', icon: 'dockSettings' },
] as const;
export const navigationItems = [destinations[0], destinations[1], { key: 'scan' }, destinations[2], destinations[3]] as const;

export function TTBottomNavigationBar({ currentDestination, onDestinationSelected, onScanEntry, testID }: {
  currentDestination: string; onDestinationSelected: (dest: string) => void; onScanEntry?: ScanEntryHandler; testID?: string;
}) {
  const { colors } = useColors();
  const inset = useSafeAreaInsets();
  const { contentMaxWidth } = useResponsiveLayout();
  // Reserve the bar's full height so scroll content stays reachable at larger font scales.
  return <View style={{ backgroundColor: colors.canvas, paddingLeft: inset.left + 16, paddingRight: inset.right + 16,
    paddingTop: 8, paddingBottom: Math.max(8, inset.bottom + 4) }}>
    <View testID={testID} style={{ flexDirection: 'row', maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center',
      padding: 7, borderWidth: 1, borderRadius: TTRadius.radiusLg, borderColor: colors.border, backgroundColor: colors.surface }}>
      {navigationItems.map(dest => dest.key === 'scan'
        ? onScanEntry && <TTScanChooser key="scan" onChoose={onScanEntry} />
        : <TouchableOpacity key={dest.key} accessibilityRole="tab"
        accessibilityState={{ selected: currentDestination === dest.key }} aria-selected={currentDestination === dest.key} accessibilityLabel={dest.label}
        onPress={() => onDestinationSelected(dest.key)} style={{ flex: 1, minWidth: 0, minHeight: 56, paddingHorizontal: 1, paddingVertical: 4,
          alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: TTRadius.radiusMd,
          backgroundColor: currentDestination === dest.key ? colors.brand : 'transparent' }}>
        <TTFigmaIcon name={dest.icon} tintColor={currentDestination === dest.key ? colors.onBrand : colors.muted} />
        <Text style={[TTTypography.caption, { alignSelf: 'stretch', textAlign: 'center', color: currentDestination === dest.key ? colors.onBrand : colors.muted }]}>{dest.label}</Text>
      </TouchableOpacity>)}
    </View>
  </View>;
}
export function TopicTrailTabBar({ routeName, onScanEntry }: { routeName: string; onScanEntry: ScanEntryHandler }) {
  const router = useRouter();
  const current = destinations.find(dest => dest.path.endsWith('/' + routeName))?.key ?? 'home';
  return <TTBottomNavigationBar currentDestination={current} onScanEntry={onScanEntry} onDestinationSelected={key => {
    const destination = destinations.find(dest => dest.key === key);
    if (destination) router.navigate(destination.path);
  }} />;
}
export function TTAppBar({ title, leading, actions, automaticallyImplyLeading = true, backgroundColor, foregroundColor, appearance = 'core' }: {
  title?: React.ReactNode; leading?: React.ReactNode; actions?: React.ReactNode[]; automaticallyImplyLeading?: boolean;
  backgroundColor?: string; foregroundColor?: string; appearance?: 'core' | 'auth'; centerTitle?: boolean; elevation?: number; testID?: string;
}) {
  const router = useRouter();
  const { colors } = useColors();
  const ink = foregroundColor ?? (appearance === 'auth' ? colors.onBrand : colors.ink);
  return <View style={{ minHeight: appearance === 'auth' ? 64 : 56, paddingHorizontal: 16,
    backgroundColor: backgroundColor ?? (appearance === 'auth' ? colors.brand : colors.canvas),
    flexDirection: 'row', alignItems: 'center', gap: 8 }}>
    {leading ?? (automaticallyImplyLeading && <TTIconButton icon={<TTFigmaIcon name="back" tintColor={ink} />} color={ink}
      semanticLabel="Go back" onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/home')} />)}
    <View style={{ flex: 1, minWidth: 0, paddingVertical: appearance === 'auth' ? 8 : 4 }}>{typeof title === 'string' ? <Text accessibilityRole="header" style={[TTTypography.title, { color: ink }]}>{title}</Text> : title}</View>
    {actions}
  </View>;
}
