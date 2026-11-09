export interface SearchSelection { documentId: string; text: string; page: number }
export interface QueryPlan { query: string; originalText: string; shortened: boolean }
export interface Attribution {
  author: string; licenseName: string; licenseUrl: string; sourceUrl: string; revisionUrl?: string;
}
export interface ResourceCandidate {
  id: string; title: string; providerId: string; providerName: string; description?: string;
  url: string; type: 'Article'; attribution: Attribution; providerOrder: number;
}
export interface EducationalResource extends ResourceCandidate {
  selectedTopic: string; documentId: string; page: number;
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
  search(selection: SearchSelection, queryOverride?: string, signal?: AbortSignal): Promise<DiscoveryResult>;
}
export type SearchState = { status: 'idle' }
  | { status: 'loading'; query: QueryPlan }
  | { status: 'success' | 'empty'; result: DiscoveryResult }
  | { status: 'error'; error: DiscoveryError; query?: QueryPlan }
  | { status: 'cancelled'; query?: QueryPlan };
