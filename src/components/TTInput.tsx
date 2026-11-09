import React, { useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, type TextInputProps } from 'react-native';
import { useColors } from '../core/theme/ThemeContext';
import { TTTypography } from '../core/design/tokens';
import { TTIconButton } from './TTIconButton';
import { TTFigmaIcon } from './TTArtwork';

interface Props extends Omit<TextInputProps, 'onSubmitEditing' | 'role' | 'accessibilityRole'> {
  hintText?: string; onChanged?: (text: string) => void; onSubmitEditing?: (text: string) => void;
}
export function TTSearchInput({ hintText, placeholder, value, onChangeText, onChanged, onSubmitEditing,
  onFocus, onBlur, style, ...props }: Props) {
  const { colors } = useColors();
  const [focused, setFocused] = useState(false);
  const change = (text: string) => { onChangeText?.(text); onChanged?.(text); };
  return <View style={{ flexDirection: 'row', alignItems: 'center' }}>
    <TextInput {...props} value={value} onChangeText={change} placeholder={placeholder ?? hintText ?? 'Search…'}
      role={undefined} accessibilityRole={undefined}
      accessibilityLabel={props.accessibilityLabel ?? hintText ?? 'Search'}
      onSubmitEditing={event => onSubmitEditing?.(event.nativeEvent.text)}
      onFocus={event => { setFocused(true); onFocus?.(event); }}
      onBlur={event => { setFocused(false); onBlur?.(event); }}
      placeholderTextColor={colors.muted} selectionColor={colors.link}
      style={[TTTypography.body, { flex: 1, minWidth: 0, minHeight: 48, color: colors.ink, backgroundColor: colors.surface,
        borderWidth: focused ? 2 : 1, borderColor: focused ? colors.link : colors.border, borderRadius: 12,
        paddingLeft: 48, paddingRight: 48, paddingVertical: 12 }, style]} />
    <View pointerEvents="none" style={{ position: 'absolute', left: 16 }}><TTFigmaIcon name="search" /></View>
    {!!value && <TTIconButton icon="close" semanticLabel="Clear search" onPress={() => change('')} style={{ position: 'absolute', right: 0 }} />}
  </View>;
}
export function TTTextSelectionMenu({ onCopy, onSelectAll, onStudy, canStudy = true, testID }: {
  onCopy: () => void; onSelectAll: () => void; onStudy: () => void; selectedText?: string; canStudy?: boolean; testID?: string;
}) {
  const { colors } = useColors();
  return <View testID={testID} accessibilityLabel="Text selection actions" style={{ flexDirection: 'row', flexWrap: 'wrap',
    padding: 8, gap: 4, marginHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
    {([{ label: 'Copy', action: onCopy, icon: 'copy' }, { label: 'Select All', action: onSelectAll }, { label: 'Study', action: onStudy, icon: 'studyAccent' }] as const).map(item =>
      <TouchableOpacity key={item.label} accessibilityRole="button" accessibilityLabel={item.label}
        accessibilityState={{ disabled: item.label === 'Study' && !canStudy }} disabled={item.label === 'Study' && !canStudy} onPress={item.action}
        style={{ flexGrow: 1, minHeight: 48, padding: 8, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 12,
          backgroundColor: item.label === 'Study' ? colors.accent : 'transparent', opacity: item.label === 'Study' && !canStudy ? 0.55 : 1 }}>
        {'icon' in item && <TTFigmaIcon name={item.icon} />}
        <Text style={[TTTypography.small, { color: item.label === 'Study' ? colors.onAccent : colors.ink }]}>{item.label}</Text>
      </TouchableOpacity>)}
  </View>;
}
