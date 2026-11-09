import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { useColors } from '../core/theme/ThemeContext';
import { TTTypography } from '../core/design/tokens';
import { TTIconButton } from './TTIconButton';
import { TTFigmaIcon } from './TTArtwork';
import { TTButton } from './TTButton';
import { TTContentWidths } from '../core/layout/responsive';
import { TTFeedback, TTFeedbackRegion, type FeedbackKind } from './TTFeedback';

type Insets = number | { horizontal?: number; vertical?: number; top?: number; bottom?: number; left?: number; right?: number };
interface CardProps {
  children: React.ReactNode; onPress?: () => void; padding?: Insets; margin?: Insets;
  borderColor?: string; backgroundColor?: string; elevation?: number; borderRadius?: number;
  testID?: string; style?: StyleProp<ViewStyle>;
}
function insets(value: Insets, kind: 'padding' | 'margin'): ViewStyle {
  if (typeof value === 'number') return { [kind]: value };
  return { [kind + 'Top']: value.top ?? value.vertical ?? 0, [kind + 'Bottom']: value.bottom ?? value.vertical ?? 0,
    [kind + 'Left']: value.left ?? value.horizontal ?? 0, [kind + 'Right']: value.right ?? value.horizontal ?? 0 };
}
export function TTCard({ children, onPress, padding = 16, margin = 0, borderColor, backgroundColor,
  elevation = 0, borderRadius = 12, testID, style }: CardProps) {
  const { colors } = useColors();
  const cardStyle: StyleProp<ViewStyle> = [{ backgroundColor: backgroundColor ?? colors.surface,
    borderColor: borderColor ?? colors.border, borderWidth: 1, borderRadius, elevation },
    insets(padding, 'padding'), insets(margin, 'margin'), style];
  return onPress ? <TouchableOpacity accessibilityRole="button" onPress={onPress} style={cardStyle} testID={testID}>{children}</TouchableOpacity>
    : <View style={cardStyle} testID={testID}>{children}</View>;
}
export function TTDocumentCard({ title, subtitle, format, uploadedAt, onPress, onMorePressed, isSelected, trailing, testID }: {
  title: string; subtitle?: string; format: 'pdf' | 'docx'; onPress?: () => void;
  onMorePressed?: () => void; isSelected?: boolean; trailing?: React.ReactNode; testID?: string; uploadedAt?: Date;
}) {
  const { colors } = useColors();
  return <TTCard testID={testID} backgroundColor={isSelected ? colors.soft : colors.surface}>
    <View style={styles.row}>
      <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel={'Open ' + title}
        disabled={!onPress} style={[styles.row, { flex: 1, minWidth: 0, minHeight: 48 }]}>
        <TTFigmaIcon name="file" slot={32} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={3} style={[TTTypography.bodyStrong, { color: colors.ink, minWidth: 0,
            ...(Platform.OS === 'web' ? { overflowWrap: 'anywhere' as const } : {}) }]}>{title}</Text>
        </View>
      </TouchableOpacity>
      {trailing}
      {onMorePressed && <TTIconButton icon={<TTFigmaIcon name="more" />} style={{ flexShrink: 0 }} onPress={onMorePressed} semanticLabel={'More options for ' + title} />}
    </View>
    <Text style={[TTTypography.small, { color: colors.muted, marginTop: 8 }]}>{subtitle ?? format.toUpperCase()}</Text>
    {!!uploadedAt && <Text style={[TTTypography.caption, { color: colors.muted, marginTop: 8 }]}>Uploaded {uploadedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</Text>}
  </TTCard>;
}
export function TTNoticeCard({ type = 'info', title, message, actionLabel, onActionPressed, onDismiss, testID, announcement }: {
  type?: 'info' | 'error' | 'success'; title: string; message?: string; actionLabel?: string;
  onActionPressed?: () => void; onDismiss?: () => void; testID?: string; announcement?: FeedbackKind;
}) {
  const { colors } = useColors();
  const error = type === 'error';
  return <TTCard testID={testID} backgroundColor={error ? colors.dangerSoft : colors.soft}
    borderColor={error ? colors.danger : colors.border}>
    <View style={styles.row}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <TTFeedbackRegion kind={announcement ?? (error ? 'alert' : type === 'success' ? 'status' : 'off')}>
          <Text accessibilityRole="header" style={[TTTypography.bodyStrong, { color: error ? colors.danger : colors.ink }]}>{title}</Text>
          {!!message && <Text style={[TTTypography.small, { color: colors.ink, marginTop: 8 }]}>{message}</Text>}
        </TTFeedbackRegion>
        {!!actionLabel && <TTButton label={actionLabel} variant="ghost" onPress={onActionPressed} />}
      </View>
      {onDismiss && <TTIconButton icon="close" onPress={onDismiss} semanticLabel="Dismiss notice" />}
    </View>
  </TTCard>;
}
export function TTUploadDocumentCard({ isProcessing, errorMessage, onTap }: {
  selectedFileName?: string; selectedFileFormat?: 'pdf' | 'docx'; isProcessing?: boolean;
  errorMessage?: string | null; onTap?: () => void;
}) {
  const { colors } = useColors();
  return <TTCard padding={24}>
    <View style={{ gap: 16, alignItems: 'center' }}>
      <TTFigmaIcon name="upload" slot={48} />
      <Text style={[TTTypography.section, { color: colors.ink }]}>Choose a syllabus</Text>
      <Text style={[TTTypography.small, { color: colors.muted }]}>PDF or DOCX · 50 MB or less</Text>
      <TTButton label={isProcessing ? 'Importing…' : 'Choose file'} variant="study" size="fullWidth"
        onPress={onTap} disabled={isProcessing} />
      <TTFeedback visuallyHidden message={isProcessing ? 'Importing document…' : ''} />
      <TTFeedback kind="alert" message={errorMessage ?? ''} style={[TTTypography.small, { color: colors.danger }]} />
    </View>
  </TTCard>;
}
export function TTInfoBanner({ message }: { message: string }) {
  const { colors } = useColors();
  return <View style={{ minHeight: 88, borderRadius: 12, padding: 16, flexDirection: 'row', gap: 8, backgroundColor: colors.brand }}>
    <TTFigmaIcon name="shield" /><Text style={[TTTypography.small, { color: colors.onBrand, flex: 1 }]}>{message}</Text>
  </View>;
}
export function TTEmptyState({ title, message, actionLabel, onAction }: { title: string; message: string; actionLabel: string; onAction: () => void }) {
  const { colors } = useColors();
  return <TTCard padding={24} style={{ width: '100%', maxWidth: TTContentWidths.prose, alignSelf: 'center' }}><View style={{ alignItems: 'center', gap: 16 }}>
    <TTFigmaIcon name="book" slot={48} />
    <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink, textAlign: 'center', maxWidth: TTContentWidths.emptyCopy }]}>{title}</Text>
    <Text style={[TTTypography.body, { color: colors.muted, textAlign: 'center', maxWidth: TTContentWidths.emptyCopy }]}>{message}</Text>
    <TTButton label={actionLabel} widthPolicy="responsiveAction" actionAlign="center" onPress={onAction} />
  </View></TTCard>;
}
const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 8 } });
export default TTCard;
