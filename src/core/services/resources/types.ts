export interface SearchSelection { documentId: string; text: string; page: number }
export type ResourceSource = 'wikipedia' | 'duckduckgo';
export type SearchOrigin = ({ kind: 'document' } & SearchSelection) | { kind: 'manual'; text: string };
/** Older reader call sites supply a selection; normalize it at the search boundary. */
export function searchOrigin(value: SearchOrigin | SearchSelection): SearchOrigin {
  return 'kind' in value ? value : { kind: 'document', ...value };
}
export interface QueryPlan { query: string; originalText: string; shortened: boolean }
export interface Attribution {
  author: string; licenseName: string; licenseUrl: string; sourceUrl: string; revisionUrl?: string;
}
export interface ResourceCandidate {
  id: string; title: string; providerId: string; providerName: string; description?: string;
  url: string; type: 'Article' | 'Instant Answer'; attribution?: Attribution; providerOrder: number;
}
export interface EducationalResource extends ResourceCandidate {
  origin?: SearchOrigin;
  selectedTopic?: string; documentId?: string; page?: number;
}
export interface ProviderResult { resources: ResourceCandidate[]; discarded: number }
export interface ResourceProvider {
  readonly id: string; readonly name: string;
  search(query: string, signal: AbortSignal): Promise<ProviderResult>;
}
export interface DiscoveryResult {
  query: QueryPlan; resources: EducationalResource[]; discarded: number; fromCache: boolean;
}
export type SearchErrorCode = 'invalid_query' | 'network' | 'timeout' | 'rate_limit' | 'api' | 'invalid_data' | 'cancelled';
export class DiscoveryError extends Error {
  constructor(public readonly code: SearchErrorCode, message: string, public readonly retryAt?: number) {
    super(message); this.name = 'DiscoveryError';
  }
}
export interface DiscoveryService {
  search(selection: SearchOrigin | SearchSelection, queryOverride?: string, signal?: AbortSignal, source?: ResourceSource): Promise<DiscoveryResult>;
}
export type SearchState = { status: 'idle' }
  | { status: 'loading'; query: QueryPlan }
  | { status: 'success' | 'empty'; result: DiscoveryResult }
  | { status: 'error'; error: DiscoveryError; query?: QueryPlan }
  | { status: 'cancelled'; query?: QueryPlan };
