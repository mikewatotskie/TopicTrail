import React from 'react';
import { Platform, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { Image } from 'expo-image';
import { TTIconButton, TTFigmaIcon } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import type { Document } from '../../core/models/document';
import { useTheme } from '../../core/theme/ThemeContext';
import { formatDocumentSize } from './libraryView';

const formatArtwork = {
  pdf: require('../../assets/figma/498bc.svg'),
  docx: require('../../assets/figma/0f409.svg'),
  pptx: require('../../assets/figma/86e91.svg'),
} as const;

const categories = {
  Report: ['#FCEBEE', '#A93149'],
  Guide: ['#EAF1FB', '#285A9A'],
  Slides: ['#FCEDDF', '#8D491D'],
  Handbook: ['#F0ECFA', '#65439F'],
  Notes: ['#E7F3EA', '#326749'],
} as const;
type Category = keyof typeof categories;

function documentCategory(document: Document): Category | undefined {
  const words = document.title.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u);
  for (const name of Object.keys(categories) as Category[]) {
    const singular = name.toLowerCase().replace(/s$/, '');
    if (words.includes(singular) || words.includes(singular + 's')) return name;
  }
  return document.format === 'pptx' ? 'Slides' : undefined;
}

function importDate(date: Date): string {
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() && { year: 'numeric' }),
  });
}

type Props = {
  document: Document;
  position?: { page: number; totalPages: number };
  readingStatus: string;
  attention: string;
  onOpen(): void;
  onMorePressed(): void;
};

export function CompactDocumentRow({ document, position, readingStatus, attention, onOpen, onMorePressed }: Props) {
  const { colors, colorScheme } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stackedChip = width < 340 || fontScale > 1.15;
  const category = documentCategory(document);
  const format = document.format;
  const title = document.title.toLowerCase().endsWith('.' + format) ? document.title : document.title + '.' + format;
  const count = document.pageCount;
  const unit = format === 'pptx' ? 'slide' : format === 'docx' ? 'section' : 'page';
  const extent = position ? unit[0].toUpperCase() + unit.slice(1) + ' ' + position.page + ' of ' + position.totalPages
    : count ? count + ' ' + unit + (count === 1 ? '' : 's') : format === 'docx' ? 'Text view' : '';
  const metadata = [extent, formatDocumentSize(document.fileSize), importDate(document.importedAt)].filter(Boolean).join(' · ');
  const chip = category && <View style={{
    alignSelf: stackedChip ? 'flex-start' : 'center', paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 7, backgroundColor: colorScheme === 'dark' ? colors.soft : categories[category][0],
  }}><Text style={[TTTypography.caption, { fontFamily: 'InterSemiBold', fontWeight: '600',
    color: colorScheme === 'dark' ? colors.ink : categories[category][1] }]}>{category}</Text></View>;

  return <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingRight: 4 }}>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={'Open ' + document.title}
      accessibilityHint={[format.toUpperCase(), metadata, category, readingStatus].filter(Boolean).join('. ')}
      onPress={onOpen} style={{ flex: 1, minWidth: 0, minHeight: 64, flexDirection: 'row', alignItems: 'center',
        paddingLeft: 12, paddingRight: 4, paddingVertical: 8, gap: 9 }}>
      <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ width: 35, height: 40, flexShrink: 0 }}>
        <Image source={formatArtwork[format]} contentFit="contain" style={{ width: 35, height: 40 }} />
        <Text allowFontScaling={false} style={{ position: 'absolute', top: 24, left: 4, width: 27,
          textAlign: 'center', color: colors.white, fontFamily: 'InterBold', fontWeight: '700',
          fontSize: 7.4, lineHeight: 10, includeFontPadding: false }}>{format.toUpperCase()}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text numberOfLines={fontScale > 1.15 ? undefined : 2} style={[TTTypography.smallStrong, { color: colors.ink,
          minWidth: 0, ...(Platform.OS === 'web' ? { overflowWrap: 'anywhere' as const } : {}) }]}>{title}</Text>
        <Text style={[TTTypography.caption, { color: colors.muted }]}>{metadata}</Text>
        {!!attention && <Text style={[TTTypography.caption, { color: colors.muted }]}>{attention}</Text>}
        {stackedChip && chip}
      </View>
      {!stackedChip && chip}
    </TouchableOpacity>
    <TTIconButton icon={<TTFigmaIcon name="more" tintColor={colors.link} />}
      semanticLabel={'More options for ' + document.title} onPress={onMorePressed} style={{ flexShrink: 0 }} />
  </View>;
}
