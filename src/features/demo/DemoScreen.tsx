import React, { useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { TTArtwork, TTAura, TTButton, TTCard, TTFeedback, TTFigmaIcon, TTNoticeCard, TTScreen } from '../../components';
import { TTTypography } from '../../core/design/tokens';
import { useResponsiveLayout } from '../../core/layout/useResponsiveLayout';
import type { Document } from '../../core/models/document';
import type { BookmarkInput } from '../../core/services/bookmarks/types';
import { bookmarkStore } from '../../core/services/bookmarks/storage';
import type { ImportActor } from '../../core/services/document_import_contract';
import { DocumentStorage } from '../../core/services/document_storage';
import { useColors } from '../../core/theme/ThemeContext';
import { TTAppBar } from '../../navigation';
import { useAuth } from '../auth/AuthContext';
import { useBookmarks } from '../saved/useBookmarks';
import { DemoCloudStory } from './DemoCloudStory';
import { demoSamples, type DemoSampleKind } from './demoSamples';
import { importDemoSample } from './demoSampleSource';
import { ensureDemoSample, findDemoSample, type DemoSampleImportPort } from './ensureDemoSample';

const exampleBookmark: BookmarkInput = {
  url: 'https://en.wikipedia.org/wiki/Iteration',
  title: 'Iteration',
  providerId: 'wikipedia',
  providerName: 'Wikipedia',
  type: 'Article',
  topic: 'Loops and iteration',
  description: 'A reference on repeating a process. Pair it with page 2 of the practice PDF.',
};
const samplePort: DemoSampleImportPort = {
  lookup: attemptId => DocumentStorage.instance.lookupGuestImportOutcome(attemptId),
  importSample: importDemoSample,
};
type ImportedSamples = Partial<Record<DemoSampleKind, Document>>;
type Action = 'samples' | 'bookmark';
type Notice = { type: 'error' | 'success'; title: string; message: string };

export function DemoScreen() {
  const { colors } = useColors();
  const { gutter, mode } = useResponsiveLayout();
  const { gateway } = useAuth();
  const { bookmarks } = useBookmarks();
  const [documents, setDocuments] = useState<ImportedSamples>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [working, setWorking] = useState<Action | null>(null);
  const lock = useRef(false);
  const refreshGeneration = useRef(0);
  const exampleSaved = bookmarks.some(bookmark => bookmark.url === exampleBookmark.url);
  const narrow = mode === 'compact';

  useFocusEffect(useCallback(() => {
    const generation = ++refreshGeneration.current;
    void Promise.all(demoSamples.map(sample => findDemoSample(sample, samplePort.lookup))).then(([pdf, docx]) => {
      if (generation === refreshGeneration.current) setDocuments({ pdf, docx });
    }).catch(() => { /* The explicit add action reports any storage error. */ });
    return () => { refreshGeneration.current++; };
  }, []));

  async function addSamples() {
    if (lock.current) return;
    lock.current = true;
    refreshGeneration.current++;
    setWorking('samples');
    setNotice(null);
    const auth = gateway.getSnapshot();
    const actor: ImportActor = auth.status === 'account' ? { kind: 'account', uid: auth.account.uid } : { kind: 'guest' };
    try {
      const results = await Promise.allSettled(demoSamples.map(sample => ensureDemoSample(sample, actor, samplePort)));
      const ready: ImportedSamples = {};
      const errors: string[] = [];
      for (const [index, result] of results.entries()) {
        const sample = demoSamples[index];
        if (result.status === 'fulfilled') ready[sample.kind] = result.value;
        else {
          const detail = result.reason instanceof Error ? result.reason.message : 'Try adding this sample again.';
          errors.push(sample.kind.toUpperCase() + ' · ' + detail);
        }
      }
      setDocuments(ready);
      setNotice(errors.length ? { type: 'error', title: 'Some samples could not be added', message: errors.join('\n') }
        : { type: 'success', title: 'Sample files are ready', message: 'Both samples are available in My Syllabi on this device.' });
    } finally {
      lock.current = false;
      setWorking(null);
    }
  }

  async function saveBookmark() {
    if (lock.current) return;
    lock.current = true;
    setWorking('bookmark');
    setNotice(null);
    try {
      await bookmarkStore.save(exampleBookmark);
      setNotice({ type: 'success', title: 'Example bookmark is ready', message: 'Find Iteration in Saved on this device.' });
    } catch (error) {
      setNotice({ type: 'error', title: 'Could not save the example bookmark',
        message: error instanceof Error ? error.message : 'Try saving the bookmark again.' });
    } finally {
      lock.current = false;
      setWorking(null);
    }
  }

  function openDocument(document: Document) {
    router.push({ pathname: '/reader/[documentId]', params: { documentId: document.id } });
  }

  return <TTScreen>
    <TTAppBar title="Presentation demo" />
    <ScrollView contentContainerStyle={[styles.content, { padding: gutter }]}>
      <TTCard padding={narrow ? 20 : 28} borderRadius={24} backgroundColor={colors.brand} borderColor={colors.brand}
        style={styles.hero}>
        <TTAura kind="header" style={{ right: 0, top: 0 }} />
        <View style={styles.heroLabel}>
          <TTArtwork name="mark" />
          <Text style={[TTTypography.smallStrong, { color: colors.onBrand, letterSpacing: 1 }]}>TOPICTRAIL WALKTHROUGH</Text>
        </View>
        <Text accessibilityRole="header" style={[narrow ? TTTypography.heading : TTTypography.display, { color: colors.onBrand }]}>
          From syllabus to study session
        </Text>
        <Text style={[TTTypography.body, { color: colors.onBrand, maxWidth: 640 }]}>
          Try the real reader and library with two practice files, then see a separate simulation of a two-device workflow.
        </Text>
      </TTCard>

      <TTCard padding={narrow ? 16 : 24} borderRadius={20} style={styles.section}>
        <View style={styles.heading}>
          <Text style={[TTTypography.smallStrong, styles.badge, { color: colors.link, backgroundColor: colors.soft }]}>WORKING · LOCAL</Text>
          <Text accessibilityRole="header" style={[TTTypography.heading, { color: colors.ink }]}>Try the reader and library</Text>
          <Text style={[TTTypography.body, { color: colors.muted }]}>
            Add the two original practice files to My Syllabi. The PDF, DOCX, saved links, and reading positions live on this device.
          </Text>
        </View>
        <TTButton label="Add sample files" variant="study" widthPolicy="responsiveAction"
          isLoading={working === 'samples'} disabled={working === 'bookmark'} onPress={() => { void addSamples(); }} />
        <View style={[styles.cards, { flexDirection: narrow ? 'column' : 'row' }]}>
          {demoSamples.map(sample => {
            const document = documents[sample.kind];
            return <TTCard key={sample.kind} backgroundColor={colors.canvas} style={[styles.sample, !narrow && styles.column]}>
              <View style={styles.sampleLabel}>
                <TTFigmaIcon name="file" slot={32} />
                <Text accessibilityRole="header" style={[TTTypography.bodyStrong, { color: colors.ink, flex: 1 }]}>
                  {document?.title ?? sample.title}
                </Text>
              </View>
              <Text style={[TTTypography.small, { color: colors.muted }]}>{sample.detail}</Text>
              <TTButton label={sample.kind === 'pdf' ? 'Open PDF' : 'Open DOCX'} variant="secondary"
                widthPolicy="responsiveAction" disabled={!document || working === 'samples'} onPress={() => { if (document) openDocument(document); }} />
            </TTCard>;
          })}
        </View>
        <Text style={[TTTypography.small, { color: colors.muted }]}>
          Try page 2 in the PDF or move to section 2 in the DOCX. Close the reader, then reopen the file from My Syllabi to check your saved place.
        </Text>
        <View style={styles.actions}>
          <TTButton label="Open My Syllabi" variant="secondary" widthPolicy="responsiveAction" onPress={() => router.navigate('/(tabs)/library')} />
        </View>
        <View style={[styles.bookmark, { borderColor: colors.border }]}>
          <View style={styles.sampleLabel}>
            <TTFigmaIcon name="bookmark" slot={32} />
            <Text accessibilityRole="header" style={[TTTypography.section, { color: colors.ink, flex: 1 }]}>Save a study resource</Text>
          </View>
          <Text style={[TTTypography.small, { color: colors.muted }]}>
            Save a link to Wikipedia’s Iteration article and find it in the real Saved tab.
          </Text>
          <View style={styles.actions}>
            <TTButton label="Save example bookmark" variant="primary" widthPolicy="responsiveAction"
              isLoading={working === 'bookmark'} disabled={working === 'samples'} onPress={() => { void saveBookmark(); }} />
            <TTButton label="Open Saved" variant="secondary" widthPolicy="responsiveAction" onPress={() => router.navigate('/(tabs)/saved')} />
          </View>
          <TTFeedback message={exampleSaved ? 'Iteration is saved on this device.' : ''} kind="off"
            style={[TTTypography.small, { color: colors.link }]} />
        </View>
        {notice && <TTNoticeCard type={notice.type} title={notice.title} message={notice.message} />}
      </TTCard>

      <DemoCloudStory narrow={narrow} />

      <TTCard padding={narrow ? 16 : 24} borderRadius={20} style={styles.heading}>
        <Text style={[TTTypography.smallStrong, styles.badge, { color: colors.ink, backgroundColor: colors.canvas }]}>PENDING</Text>
        <Text accessibilityRole="header" style={[TTTypography.section, { color: colors.ink }]}>Live cloud library and PowerPoint</Text>
        <Text style={[TTTypography.body, { color: colors.muted }]}>
          Live cloud storage, cross-device sync, and PPTX import are still pending.
        </Text>
      </TTCard>
    </ScrollView>
  </TTScreen>;
}

const styles = StyleSheet.create({
  content: { gap: 20, width: '100%', maxWidth: 1060, alignSelf: 'center' },
  hero: { gap: 12, overflow: 'hidden' },
  heroLabel: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  section: { gap: 16 },
  heading: { gap: 8 },
  badge: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, letterSpacing: 0.6 },
  cards: { gap: 12 },
  column: { flex: 1, minWidth: 0 },
  sample: { gap: 8 },
  sampleLabel: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  bookmark: { borderTopWidth: 1, paddingTop: 16, gap: 8 },
});
