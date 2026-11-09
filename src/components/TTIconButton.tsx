import React from 'react';
import { TouchableOpacity, type TouchableOpacityProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../core/theme/ThemeContext';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
const aliases: Record<string, IconName> = { 'more-vert': 'ellipsis-vertical', 'zoom-in': 'add',
  'zoom-out': 'remove', 'chevron-left': 'chevron-back', 'chevron-right': 'chevron-forward',
  'first-page': 'play-skip-back', 'last-page': 'play-skip-forward', 'text-decrease': 'remove',
  'text-increase': 'add', 'content-copy': 'copy-outline' };
export function TTIcon({ name, size = 24, color }: { name: string; size?: number; color?: string }) {
  const candidate = aliases[name] ?? name.replace(/^ios-/, '');
  const icon = candidate in Ionicons.glyphMap ? candidate as IconName : 'help-circle-outline';
  return <Ionicons name={icon} size={size} color={color} />;
}
interface Props extends Omit<TouchableOpacityProps, 'children' | 'role' | 'accessibilityRole'> {
  icon: React.ReactNode; size?: number; iconSize?: number; isSelected?: boolean;
  semanticLabel?: string; color?: string;
}
export function TTIconButton({ icon, size = 48, iconSize = 24, isSelected, semanticLabel,
  disabled, onPress, style, color, ...props }: Props) {
  const { colors } = useColors();
  const inactive = !!disabled || !onPress;
  return <TouchableOpacity {...props} onPress={onPress} disabled={inactive}
    role={undefined} accessibilityRole="button" accessibilityLabel={semanticLabel ?? props.accessibilityLabel ?? (typeof icon === 'string' ? icon : undefined)}
    accessibilityState={{ disabled: inactive, selected: !!isSelected }}
    style={[{ minWidth: Math.max(48, size), minHeight: Math.max(48, size), borderRadius: 999,
      alignItems: 'center', justifyContent: 'center', opacity: inactive ? 0.45 : 1,
      backgroundColor: isSelected ? colors.soft : 'transparent' }, style]}>
    {typeof icon === 'string' ? <TTIcon name={icon} size={iconSize} color={color ?? colors.link} /> : icon}
  </TouchableOpacity>;
}
export default TTIconButton;
