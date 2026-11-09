import React, { useId, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Platform } from 'react-native';
import { useTheme } from '../../core/theme/ThemeContext';
import { TTTypography } from '../../core/design/tokens';
import { TTFeedback } from '../../components/TTFeedback';

export function AuthField({ label, value, onChange, placeholder, password = false, email = false, error, disabled = false, newPassword = false, oneTimeCode = false }: {
  label: string; value: string; onChange: (value: string) => void; placeholder: string;
  password?: boolean; email?: boolean; error?: string; disabled?: boolean; newPassword?: boolean; oneTimeCode?: boolean;
}) {
  const { colors } = useTheme();
  const [shown, setShown] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visibilityFocused, setVisibilityFocused] = useState(false);
  const errorId = useId();
  return <View style={{ gap: 8, minWidth: 0 }}>
    <Text style={[TTTypography.smallStrong, { color: colors.ink }]}>{label}</Text>
    <View style={{ minHeight: 48, minWidth: 0, flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: focused ? 2 : 1,
      borderColor: error ? colors.danger : focused ? colors.link : colors.border, backgroundColor: disabled ? colors.soft : colors.surface }}>
      <TextInput accessibilityLabel={label} accessibilityHint={Platform.OS === 'android' ? error : undefined}
        aria-invalid={Platform.OS === 'web' ? !!error : undefined} aria-describedby={Platform.OS === 'web' && error ? errorId : undefined}
        accessibilityState={{ disabled }} editable={!disabled} value={value} onChangeText={onChange} placeholder={placeholder}
        placeholderTextColor={colors.muted} secureTextEntry={password && !shown} autoCapitalize={email || password ? 'none' : 'words'}
        autoCorrect={!email && !password && !oneTimeCode} keyboardType={oneTimeCode ? 'number-pad' : email ? 'email-address' : 'default'}
        maxLength={oneTimeCode ? 10 : undefined}
        autoComplete={oneTimeCode ? 'one-time-code' : email ? 'email' : password ? newPassword ? 'new-password' : 'current-password' : 'name'}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={[TTTypography.body, { minWidth: 0, flex: 1, minHeight: 46, paddingHorizontal: 16, paddingVertical: 10, color: colors.ink }]} />
      {password && <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
        accessibilityState={{ disabled }} disabled={disabled} onPress={() => setShown(!shown)}
        onFocus={() => setVisibilityFocused(true)} onBlur={() => setVisibilityFocused(false)}
        style={{ width: 48, minHeight: 48, flexShrink: 0, justifyContent: 'center', alignItems: 'center', borderRadius: 8,
          outlineStyle: 'solid', outlineColor: colors.link, outlineWidth: visibilityFocused ? 2 : 0, outlineOffset: 2 }}>
        <Text style={[TTTypography.smallStrong, { color: disabled ? colors.muted : colors.link }]}>{shown ? 'Hide' : 'Show'}</Text>
      </TouchableOpacity>}
    </View>
    <TTFeedback nativeID={errorId} message={error ?? ''} style={[TTTypography.small, { color: colors.danger, minWidth: 0,
      ...(Platform.OS === 'web' ? { overflowWrap: 'anywhere' as const } : {}) }]} />
  </View>;
}
