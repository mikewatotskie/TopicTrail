import React from 'react';
import { Text, TouchableOpacity, StyleSheet, ActivityIndicator, TouchableOpacityProps } from 'react-native';
import { useColors } from '../core/theme/ThemeContext';
import { ButtonVariant, ButtonSize, TTRadius, TTTypography } from '../core/design/tokens';
import { TTIcon } from './TTIconButton';
import { useResponsiveLayout } from '../core/layout/useResponsiveLayout';

interface TTButtonProps extends Omit<TouchableOpacityProps, 'children' | 'role' | 'accessibilityRole'> {
  label: string;
  variant?: `${ButtonVariant}`;
  size?: `${ButtonSize}`;
  icon?: React.ReactNode;
  iconTrailing?: boolean;
  isLoading?: boolean;
  isExpanded?: boolean;
  widthPolicy?: 'legacy' | 'responsiveAction';
  actionAlign?: 'start' | 'center';
  semanticLabel?: string;
}
export function TTButton({ label, variant = 'primary', size = 'regular', icon, iconTrailing,
  isLoading = false, isExpanded, widthPolicy = 'legacy', actionAlign = 'start', semanticLabel, disabled, onPress, style, ...props }: TTButtonProps) {
  const { colors } = useColors();
  const { mode } = useResponsiveLayout();
  const inactive = !!disabled || !onPress || isLoading;
  const outlined = variant === 'secondary';
  const textOnly = outlined || variant === 'ghost';
  const foreground = inactive && !isLoading ? colors.muted : textOnly ? colors.link : variant === 'study' ? colors.onAccent
    : variant === 'danger' ? colors.onDanger : colors.onBrand;
  const background = inactive && !isLoading ? colors.soft : textOnly ? 'transparent' : variant === 'study' ? colors.accent
    : variant === 'danger' ? colors.danger : colors.brand;
  const graphic = typeof icon === 'string' ? <TTIcon name={icon} color={foreground} /> : icon;
  return <TouchableOpacity {...props} disabled={inactive} onPress={onPress}
    role={undefined} accessibilityRole="button" accessibilityLabel={semanticLabel ?? props.accessibilityLabel ?? label}
    accessibilityState={{ disabled: inactive, busy: isLoading }}
    style={[styles.button, { backgroundColor: background, minHeight: 48,
      borderWidth: outlined || (variant === 'study' && !inactive) ? 1 : 0, borderColor: variant === 'study' ? colors.brand : colors.link,
      width: isExpanded || size === 'fullWidth' ? '100%' : undefined }, style,
      widthPolicy === 'responsiveAction' && {
        width: mode === 'compact' ? '100%' : 'auto', maxWidth: '100%', minWidth: 0,
        alignSelf: actionAlign === 'center' ? 'center' : 'flex-start',
        flex: undefined, flexGrow: 0, flexShrink: 1, flexBasis: 'auto',
        height: 'auto', minHeight: 48, maxHeight: null,
      }]}>
    {isLoading ? <ActivityIndicator color={foreground} accessible={false} importantForAccessibility="no" aria-hidden /> : <>
      {!iconTrailing && graphic}
      <Text style={[TTTypography.button, { color: foreground, flexShrink: 1, textAlign: 'center' }]}>{label}</Text>
      {!!iconTrailing && graphic}
    </>}
  </TouchableOpacity>;
}
const styles = StyleSheet.create({ button: { borderRadius: TTRadius.radiusMd, paddingHorizontal: 16,
  paddingVertical: 12, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' } });
export default TTButton;
