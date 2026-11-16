import React from 'react';
import { Text, View } from 'react-native';
import { TTButton, TTFigmaIcon, TTIconButton } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';

type Props = {
  title: string;
  format?: 'pdf' | 'docx' | 'pptx';
  page: number;
  pages: number;
  selection: boolean;
  focus: boolean;
  toolsOpen: boolean;
  disabled: boolean;
  onBack: () => void;
  onClear: () => void;
  onNotes: () => void;
  onTools: () => void;
  onFocus: () => void;
  onDocumentNote: () => void;
  onLocationNote: () => void;
  onMark: () => void;
  onCorners: () => void;
};

export function ReaderToolbar(props: Props) {
  const { colors } = useColors();
  const { title, format, page, pages, selection, focus, toolsOpen, disabled } = props;
  if (focus) {
    return <View style={{ alignItems: 'flex-end', backgroundColor: colors.canvas, paddingHorizontal: 16 }}>
      <TTButton label="Exit focus mode" variant="ghost" onPress={props.onFocus} />
    </View>;
  }
  return <>
    <View style={{ minHeight: 56, paddingHorizontal: 16, paddingVertical: 4, backgroundColor: colors.canvas,
      flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <TTIconButton semanticLabel="Go back" icon={<TTFigmaIcon name="back" tintColor={colors.link} />} onPress={props.onBack} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text accessibilityRole="header" numberOfLines={2} style={[TTTypography.title, { color: colors.ink }]}>{title}</Text>
        {format === 'docx' && <Text style={[TTTypography.caption, { color: colors.muted }]}>Word text view · section {page} of {pages}</Text>}
        {format === 'pptx' && <Text style={[TTTypography.caption, { color: colors.muted }]}>PowerPoint study view · slide {page} of {pages}</Text>}
      </View>
      {selection
        ? <TTIconButton semanticLabel="Clear selection" icon={<TTFigmaIcon name="close" tintColor={colors.link} />} onPress={props.onClear} />
        : <>
          <TTIconButton semanticLabel="Notes" icon="document-text-outline" onPress={props.onNotes}/>
          <TTIconButton semanticLabel="Tools" accessibilityState={{ expanded: toolsOpen }} isSelected={toolsOpen}
            icon={<TTFigmaIcon name="more" tintColor={colors.link} />} onPress={props.onTools}/>
        </>}
    </View>
    {toolsOpen && !selection && <View style={{ backgroundColor: colors.surface, paddingHorizontal: 16, paddingVertical: 8, gap: 8,
      borderBottomWidth: 1, borderColor: colors.border }}>
      <Text style={[TTTypography.small, { color: colors.muted }]}>Select document text to copy it, study it or add a note.</Text>
      {format === 'pptx' && <Text style={[TTTypography.small, { color: colors.muted }]}>Slides show extracted study content. Original layouts, animations and charts are unavailable.</Text>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <TTButton label="Focus" variant="ghost" onPress={props.onFocus}/>
        <TTButton label="Document note" variant="secondary" disabled={disabled} onPress={props.onDocumentNote}/>
        <TTButton label="Note at this location" variant="secondary" disabled={disabled} onPress={props.onLocationNote}/>
        {format === 'pdf' && <>
          <TTButton label="Mark area" variant="secondary" disabled={disabled} onPress={props.onMark}/>
          <TTButton label="Tap corners" variant="secondary" disabled={disabled} onPress={props.onCorners}/>
        </>}
      </View>
    </View>}
  </>;
}
