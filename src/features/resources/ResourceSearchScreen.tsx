import { TTResponsiveGrid } from '../../components/TTResponsiveGrid';
import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { TTButton, TTCard, TTEmptyState, TTFigmaIcon, TTIconButton, TTNoticeCard, TTScreen, TTSearchInput } from '../../components';
import { TTAppBar } from '../../navigation';
import { TTTypography } from '../../core/design/tokens';
import { useColors } from '../../core/theme/ThemeContext';
import { prepareQuery, MAX_QUERY_LENGTH, MAX_QUERY_WORDS } from '../../core/services/resources/query';
import { duckDuckGoSearchUrl } from '../../core/services/resources/duckduckgo';
import type { EducationalResource, QueryPlan, ResourceSource, SearchErrorCode, SearchOrigin } from '../../core/services/resources/types';
import { useStudySelection } from '../reader/StudySelectionContext';
import { useResourceSearch } from './useResourceSearch';
import { ResourceDetails } from './ResourceDetails';
import { ExternalBrowserAction, ExternalLinkReview } from './ExternalLinkReview';
import { SelectedPassage } from './SelectedPassage';
import { ResourceCard } from './ResourceCard';
import { useCloudLibrary } from '../library/CloudLibraryContext';

function searchError(code: SearchErrorCode, provider: string) {
  switch (code) {
    case 'invalid_query': return { title: 'Review your topic', message: 'Enter a topic with a little more context, such as a subject or concept.' };
    case 'network': return { title: 'Couldn’t load resources', message: `We could not reach ${provider}. Check your connection and try again.` };
    case 'timeout': return { title: 'Search took too long', message: `${provider} did not respond in time. Please try again.` };
    case 'rate_limit': return { title: 'Please wait before searching again', message: `${provider} has asked us to pause requests. You can retry when the waiting time ends.` };
    case 'api': return { title: `${provider} is unavailable`, message: 'Please try again shortly.' };
    case 'invalid_data': return { title: 'Couldn’t read the search response', message: `${provider} did not return usable results. Please try again.` };
    case 'cancelled': return { title: 'Search cancelled', message: 'Edit your topic or choose a source to search again.' };
  }
}
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
function backToSyllabus(router: ReturnType<typeof useRouter>) { if (router.canGoBack()) router.back(); else router.replace('/(tabs)/library'); }

export function ResourceSearchScreen({ manual = false }: { manual?: boolean }) {
  const router = useRouter();
  const { selection } = useStudySelection();
  const {state: account} = useCloudLibrary();
  // A changed document, page or exact selection creates a new lifetime before old results can render.
  return manual ? <SelectionSearch key={`manual:${account.epoch}`} selection={{kind:'manual',text:''}} />
    : selection ? <SelectionSearch key={JSON.stringify([account.epoch, selection.documentId, selection.page, selection.text])} selection={{kind:'document',...selection}} />
    : <TTScreen><TTAppBar title="Study resources" /><ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <TTNoticeCard title="Choose a topic first" message="Open a syllabus, select a passage, and tap Study to review your topic query." />
      <TTButton label="Open my syllabi" variant="secondary" onPress={() => backToSyllabus(router)} />
    </ScrollView></TTScreen>;
}

function SelectionSearch({ selection }: { selection: SearchOrigin }) {
  const router = useRouter();
  const { colors } = useColors();
  const { width, fontScale } = useWindowDimensions();
  const [draft, setDraft] = useState(() => planned(selection.text)?.query ?? '');
  const plan = useMemo(() => planned(selection.kind === 'manual' ? draft : selection.text, draft), [selection.kind, selection.text, draft]);
  const { state, search, cancel } = useResourceSearch(selection);
  const [source, setSource] = useState<ResourceSource>('duckduckgo');
  const [reviewWebSearch, setReviewWebSearch] = useState(false);
  const isWebSearch = source === 'duckduckgo';
  const provider = isWebSearch ? 'DuckDuckGo' : 'Wikipedia';
  const [details, setDetails] = useState<EducationalResource | null>(null);
  const [editing, setEditing] = useState(true);
  const wait = useRetryWait(state.status === 'error' ? state.error.retryAt : undefined);
  const result = state.status === 'success' || state.status === 'empty' ? state.result : null;
  const submitted = result?.query.query ?? (state.status === 'loading' || state.status === 'error' || state.status === 'cancelled' ? state.query?.query : undefined);
  const submit = (nextSource: ResourceSource, query = plan?.query) => {
    if (!query || (nextSource === source && wait > 0)) return;
    setDetails(null);
    setReviewWebSearch(false);
    setEditing(false);
    setSource(nextSource);
    search(query, nextSource);
  };
  const retry = () => submit(source, submitted);
  const issue = state.status === 'error' ? searchError(state.error.code, provider) : null;
  const webUrl = isWebSearch && submitted ? duckDuckGoSearchUrl(submitted) : undefined;
  const webResults = !editing && state.status !== 'empty' && webUrl && (reviewWebSearch
    ? <ExternalLinkReview key={webUrl} url={webUrl} onCancel={() => setReviewWebSearch(false)} />
    : <TTButton label="View full results on DuckDuckGo" variant="secondary" onPress={() => setReviewWebSearch(true)} />);
  const omitted = result && result.discarded > 0 && <TTNoticeCard title={`${result.discarded} result${result.discarded === 1 ? '' : 's'} omitted`}
    message="Some results had incomplete or unsupported source information." />;
  const detailsModal = details && result && <ResourceDetails resource={details} query={result.query.query} onClose={() => setDetails(null)} />;
  const topicCard = submitted && <View style={{ padding: result ? 12 : 16, gap: 4, borderRadius: 12, backgroundColor: colors.soft }}>
    {!result && <Text style={[TTTypography.caption, { color: colors.link }]}>{selection.kind === 'document' ? 'SELECTED TOPIC' : 'SEARCH TOPIC'}</Text>}
    <Text selectable style={[TTTypography.section, { color: colors.link }]}>{submitted}</Text>
    {result ? <Text style={[TTTypography.small, { color: colors.muted }]}>{isWebSearch ? 'DuckDuckGo' : `${result.resources.length} free resource${result.resources.length === 1 ? '' : 's'}`}</Text>
      : selection.kind === 'document' && <Text style={[TTTypography.small, { color: colors.muted }]}>Page / section {selection.page}</Text>}
  </View>;
  const footer = !isWebSearch && <Text style={[TTTypography.caption, { color: colors.muted }]}>Excerpts are from Wikipedia contributors under CC BY-SA 4.0.</Text>;
  if (selection.kind === 'document' && state.status === 'success' && !editing) {
    const panelWidth = width < 345 || fontScale >= 1.6 ? '100%' : Math.min(width - 40, width >= 768 ? 440 : 344);
    const close = () => backToSyllabus(router);
    return <View testID="resource-side-panel" style={{ flex: 1, flexDirection: 'row', justifyContent: 'flex-end', backgroundColor: 'rgba(11,18,32,0.36)' }}>
      <Pressable accessible={false} importantForAccessibility="no" onPress={close} style={{ flex: 1 }} />
      <SafeAreaView accessibilityViewIsModal edges={['top', 'bottom', 'right']} style={{ width: panelWidth, backgroundColor: colors.canvas }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, flexGrow: 1, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text accessibilityRole="header" style={[TTTypography.title, { flex: 1, color: colors.ink }]}>Study resources</Text>
            <TTIconButton semanticLabel="Close resource panel" icon={<TTFigmaIcon name="close" tintColor={colors.link} />} onPress={close} />
          </View>
          {topicCard}
          {omitted}
          {state.result.resources.map(resource => <ResourceCard key={resource.id} resource={resource} query={state.result.query.query} onDetails={() => setDetails(resource)} />)}
          {webResults}
          <View style={{ marginTop: 'auto', gap: 8, paddingTop: 8 }}>
            {footer}
            <TTButton label="Edit topic" variant="ghost" style={{ alignSelf: 'flex-start' }} onPress={() => setEditing(true)} />
          </View>
        </ScrollView>
      </SafeAreaView>
      {detailsModal}
    </View>;
  }
  return <TTScreen><TTAppBar title={state.status === 'loading' ? 'Finding resources' : 'Study resources'} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 16, flexGrow: 1 }}>
      {!!submitted && <View style={{gap:8}}>
        {topicCard}
        {!editing && state.status !== 'loading' && <TTButton label="Edit topic" variant="ghost" widthPolicy="responsiveAction" onPress={() => setEditing(true)} />}
      </View>}
      {editing && <>
      {selection.kind === 'document' && <SelectedPassage text={selection.text} page={selection.page} />}
      <TTCard style={{ gap: 12 }}>
        <Text accessibilityRole="header" style={[TTTypography.section, { color: colors.ink }]}>Review your topic query</Text>
        <TTSearchInput accessibilityLabel="Topic query" hintText="Enter a topic" value={draft} maxLength={500}
          autoCorrect={false} returnKeyType="done" onChangeText={setDraft} />
        {plan ? <>
          <Text style={[TTTypography.caption, { color: colors.muted }]}>TOPIC QUERY TO SEND</Text>
          <Text selectable style={[TTTypography.bodyStrong, { color: colors.link }]}>{plan.query}</Text>
          {(plan.shortened || planned(selection.text)?.shortened) && <Text style={[TTTypography.small, { color: colors.muted }]}>{selection.kind === 'document' ? 'This query is shortened. Your original passage is preserved above.' : 'This query is shortened to fit the search limit.'}</Text>}
        </> : <Text accessibilityRole="alert" style={[TTTypography.small, { color: colors.danger }]}>{draft.trim() ? 'Add a little context to your topic, such as the subject or concept.' : selection.kind === 'document' ? 'Enter a topic to search. Your original passage is preserved above.' : 'Enter a topic to search.'}</Text>}
        <Text style={[TTTypography.caption, { color: colors.muted }]}>Up to {MAX_QUERY_WORDS} words and {MAX_QUERY_LENGTH} characters.</Text>
        <Text style={[TTTypography.small, { color: colors.muted }]}>Only the topic shown above is sent to the source you choose.</Text>
        <TTButton label="Search with DuckDuckGo" onPress={() => submit('duckduckgo')} disabled={!plan || (isWebSearch && wait > 0)} />
        <TTButton label="Look up on Wikipedia" variant="secondary" onPress={() => submit('wikipedia')} disabled={!plan || (!isWebSearch && wait > 0)} />
      </TTCard></>}
      {state.status === 'loading' && <View style={{ flexGrow: 1, gap: 16 }}>
        <View style={{ flexGrow: 1, padding: 16, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <ActivityIndicator accessibilityLabel={`Searching ${provider}`} color={colors.link} size="large" />
          <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink, textAlign: 'center' }]}>Finding resources…</Text>
          <Text style={[TTTypography.body, { color: colors.muted, textAlign: 'center' }]}>{isWebSearch ? 'Checking DuckDuckGo for a cited answer.' : 'Looking for free articles on English Wikipedia.'}</Text>
        </View>
        <TTButton label="Edit topic" variant="ghost" onPress={() => setEditing(true)} />
        <TTButton label="Cancel search" variant="secondary" isExpanded onPress={cancel} />
      </View>}
      {state.status === 'cancelled' && <TTNoticeCard {...searchError('cancelled', provider)} />}
      {issue && <TTCard padding={24} style={{ gap: 16 }}>
        <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink }]}>{issue.title}</Text>
        <Text accessibilityRole="alert" style={[TTTypography.body, { color: colors.muted }]}>{issue.message}</Text>
        {wait > 0 && <Text accessibilityLiveRegion="polite" style={[TTTypography.small, { color: colors.muted }]}>Try again in {wait} second{wait === 1 ? '' : 's'}.</Text>}
        <TTButton label="Try again" onPress={retry} disabled={!submitted || wait > 0} />
      </TTCard>}
      {result && <>
        {omitted}
        {state.status === 'empty' ? webUrl
          ? !editing && <TTCard style={{ gap: 12 }}>
              <Text accessibilityRole="header" style={[TTTypography.section, { color: colors.ink }]}>
                {`DuckDuckGo has no quick answer for “${submitted}”.`}
              </Text>
              <Text style={[TTTypography.small, { color: colors.muted }]}>Full results open in your browser. Wikipedia results open here.</Text>
              <Text selectable style={[TTTypography.small, { color: colors.link }]}>{webUrl}</Text>
              <ExternalBrowserAction key={webUrl} url={webUrl} label="Open DuckDuckGo results in browser" />
              <TTButton label={`Look up “${submitted}” on Wikipedia`} variant="secondary" onPress={() => submit('wikipedia', submitted)} />
            </TTCard>
          : <TTEmptyState title="No resources found" message="Wikipedia did not find articles for this query. Try a shorter topic or add the subject." actionLabel="Try again" onAction={retry} />
          : <>
            <Text accessibilityRole="header" style={[TTTypography.title, { color: colors.ink }]}>Study resources · {result.resources.length}</Text>
            <TTResponsiveGrid items={result.resources} keyExtractor={resource => resource.id} renderItem={resource => <ResourceCard resource={resource} query={result.query.query} onDetails={() => setDetails(resource)} />} />
            {footer}
          </>}
      </>}
      {webResults}
      {selection.kind === 'document' && state.status !== 'loading' && <TTButton label="Back to syllabus" variant="secondary" onPress={() => backToSyllabus(router)} />}
    </ScrollView>
    {detailsModal}
  </TTScreen>;
}
export default ResourceSearchScreen;
