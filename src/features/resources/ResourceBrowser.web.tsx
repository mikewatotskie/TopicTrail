import React from 'react';
import { Modal, ScrollView } from 'react-native';
import { TTScreen, TTIconButton, TTFigmaIcon } from '../../components';
import { TTAppBar } from '../../navigation';
import { ExternalLinkReview } from './ExternalLinkReview';
import { useColors } from '../../core/theme/ThemeContext';

export function ResourceBrowser({ url, title, onClose }: { url: string; title: string; onClose(): void }) {
  const { colors } = useColors();
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <TTScreen variant="form"><TTAppBar title={title} leading={<TTIconButton semanticLabel="Close resource browser"
      icon={<TTFigmaIcon name="back" tintColor={colors.link} />} onPress={onClose} />} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <ExternalLinkReview url={url} onCancel={onClose} />
      </ScrollView>
    </TTScreen>
  </Modal>;
}
