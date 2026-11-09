import { TTResponsiveGrid } from '../../components/TTResponsiveGrid';
import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, ScrollView, Text } from 'react-native';
import { router } from 'expo-router';
import { TTButton, TTCard, TTEmptyState, TTNoticeCard, TTScreen, TTSearchInput } from '../../components';
import { TTAppBar } from '../../navigation';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { prepareQuery, MAX_QUERY_LENGTH, MAX_QUERY_WORDS } from '../../core/services/resources/query';
import type { EducationalResource, QueryPlan, SearchErrorCode, SearchSelection } from '../../core/services/resources/types';
import { useStudySelection } from '../reader/StudySelectionContext';
import { useResourceSearch } from './useResourceSearch';
import { ResourceDetails } from './ResourceDetails';
import { SelectedPassage } from './SelectedPassage';
import { ResourceCard } from './ResourceCard';

const errorCopy: Record<SearchErrorCode, { title: string; message: string }> = {
  invalid_query: { title: 'Review your topic', message: 'Enter a topic with a little more context, such as a subject or concept.' },
  network: { title: 'Couldn’t load resources', message: 'We could not reach Wikipedia. Check your connection and try again. Search needs an internet connection; your syllabus remains available on this device.' },
  timeout: { title: 'Search took too long', message: 'Wikipedia did not respond in time. Please try again.' },
  rate_limit: { title: 'Please wait before searching again', message: 'Wikipedia has asked us to pause requests. You can retry when the waiting time ends.' },
  api: { title: 'Wikipedia is unavailable', message: 'Wikipedia could not complete the search. Please try again shortly.' },
  invalid_data: { title: 'Couldn’t read the search response', message: 'Wikipedia did not return usable results. Please try again.' },
  cancelled: { title: 'Search cancelled', message: 'Your selected passage is still here. Review the query and search when you are ready.' },
};
function planned(text: string, override?: string): QueryPlan | null {
  try { return prepareQuery(text, override); } catch { return null; }
}
function useRetryWait(retryAt?: number) {
  // Read the clock for each deadline snapshot, including deadlines already elapsed when received.
  const getSnapshot = useCallback(() => retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0, [retryAt]);
  const subscribe = useCallback((onChange: () => void) => {
    if (!retryAt || retryAt <= Date.now()) return () => {};
    const timer = setInterval(() => { onChange(); if (retryAt <= Date.now()) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
function backToSyllabus() { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/library'); }

export function ResourceSearchScreen() {
  const { selection } = useStudySelection();
  // A changed document, page or exact selection creates a new lifetime before old results can render.
  return selection ? <SelectionSearch key={JSON.stringify([selection.documentId, selection.page, selection.text])} selection={selection} />
    : <TTScreen><TTAppBar title="Study resources" /><ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <TTNoticeCard title="Choose a topic first" message="Open a syllabus, select a passage, and tap Study to review your topic query." />
      <TTButton label="Open my syllabi" variant="secondary" onPress={backToSyllabus} />
    </ScrollView></TTScreen>;
}

function SelectionSearch({ selection }: { selection: SearchSelection }) {
  const { colors } = useColors();
  const [draft, setDraft] = useState(() => planned(selection.text)?.query ?? '');
  const plan = useMemo(() => planned(selection.text, draft), [selection.text, draft]);
  const { state, search, cancel } = useResourceSearch(selection);
  const [details, setDetails] = useState<EducationalResource | null>(null);
  const wait = useRetryWait(state.status === 'error' ? state.error.retryAt : undefined);
  const result = state.status === 'success' || state.status === 'empty' ? state.result : null;
  const submitted = result?.query.query ?? (state.status === 'loading' || state.status === 'error' || state.status === 'cancelled' ? state.query?.query : undefined);
  const submit = () => {
    if (!plan || wait > 0) return;
    setDetails(null); search(plan.query);
  };
  const issue = state.status === 'error' ? errorCopy[state.error.code] : null;
  return <TTScreen><TTAppBar title={state.status === 'loading' ? 'Finding resources' : 'Study resources'} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 16 }}>
      <SelectedPassage text={selection.text} page={selection.page} />
      <TTCard style={{ gap: 12 }}>
        <Text accessibilityRole="header" style={[TTTypography.section, { color: colors.ink }]}>Review your topic query</Text>
        <TTSearchInput accessibilityLabel="Wikipedia topic query" hintText="Enter a topic" value={draft} maxLength={500}
          autoCorrect={false} returnKeyType="search" onChangeText={setDraft} onSubmitEditing={submit} />
        {plan ? <>
          <Text style={[TTTypography.caption, { color: colors.muted }]}>TOPIC QUERY TO SEND</Text>
          <Text selectable style={[TTTypography.bodyStrong, { color: colors.link }]}>{plan.query}</Text>
          {(plan.shortened || planned(selection.text)?.shortened) && <Text style={[TTTypography.small, { color: colors.muted }]}>This query is shortened. Your original passage is preserved above.</Text>}
        </> : <Text accessibilityRole="alert" style={[TTTypography.small, { color: colors.danger }]}>{draft.trim() ? 'Add a little context to your topic, such as the subject or concept.' : 'Enter a topic to search. Your original passage is preserved above.'}</Text>}
        <Text style={[TTTypography.caption, { color: colors.muted }]}>Up to {MAX_QUERY_WORDS} words and {MAX_QUERY_LENGTH} characters.</Text>
        <Text style={[TTTypography.small, { color: colors.muted }]}>Only the shown topic query goes to Wikipedia when you tap Search. Your document file stays on this device.</Text>
        <TTButton label="Search Wikipedia" variant="study" onPress={submit} disabled={!plan || wait > 0} />
      </TTCard>
      {!!submitted && <Text selectable style={[TTTypography.small, { color: colors.muted }]}>Search topic: {submitted}</Text>}
      {state.status === 'loading' && <TTCard padding={24} style={{ gap: 24, alignItems: 'center' }}>
        <ActivityIndicator accessibilityLabel="Searching Wikipedia" color={colors.link} size="large" />
        <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink, textAlign: 'center' }]}>Finding resources…</Text>
        <Text style={[TTTypography.body, { color: colors.muted, textAlign: 'center' }]}>Searching English Wikipedia for articles on your reviewed topic.</Text>
        <TTButton label="Cancel search" variant="secondary" isExpanded onPress={cancel} />
      </TTCard>}
      {state.status === 'cancelled' && <TTNoticeCard title={errorCopy.cancelled.title} message={errorCopy.cancelled.message} />}
      {issue && <TTCard padding={24} style={{ gap: 16 }}>
        <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink }]}>{issue.title}</Text>
        <Text accessibilityRole="alert" style={[TTTypography.body, { color: colors.muted }]}>{issue.message}</Text>
        {wait > 0 && <Text accessibilityLiveRegion="polite" style={[TTTypography.small, { color: colors.muted }]}>Try again in {wait} second{wait === 1 ? '' : 's'}.</Text>}
        <TTButton label="Try again" onPress={submit} disabled={!plan || wait > 0} />
      </TTCard>}
      {result && <>
        {result.discarded > 0 && <TTNoticeCard title={`${result.discarded} result${result.discarded === 1 ? '' : 's'} omitted`}
          message="Some provider results had incomplete or unsupported source information and were left out." />}
        {state.status === 'empty' ? <TTEmptyState title="No resources found" message="Wikipedia did not find articles for this query. Try a shorter topic or add the subject." actionLabel="Try again" onAction={submit} />
          : <>
            <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink }]}>Study resources · {result.resources.length}</Text>
            <TTResponsiveGrid items={result.resources} keyExtractor={resource => resource.id} renderItem={resource => <ResourceCard resource={resource} query={result.query.query} onDetails={() => setDetails(resource)} />} />
            <Text style={[TTTypography.small, { color: colors.muted }]}>Check the source before opening. Excerpts are from Wikipedia contributors under CC BY-SA 4.0.</Text>
          </>}
      </>}
      <TTButton label="Back to syllabus" variant="secondary" onPress={backToSyllabus} />
    </ScrollView>
    {details && result && <ResourceDetails resource={details} query={result.query.query} onClose={() => setDetails(null)} />}
  </TTScreen>;
}
export default ResourceSearchScreen;
