import { prepareQuery } from './query';
import { DiscoveryError, type DiscoveryResult, type DiscoveryService, type QueryPlan, type SearchSelection, type SearchState } from './types';
export class SearchSession {
  private state: SearchState = { status: 'idle' };
  private readonly listeners = new Set<() => void>();
  private controller?: AbortController;
  private generation = 0;
  private active?: { key: string; promise: Promise<void> };
  private disposed = false;
  constructor(private readonly service: DiscoveryService) {}
  getSnapshot = (): SearchState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: SearchState) { if (!this.disposed) { this.state = state; this.listeners.forEach(listener => listener()); } }
  search(selection: SearchSelection, queryOverride?: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    let query: QueryPlan;
    try { query = prepareQuery(selection.text, queryOverride); }
    catch (error) {
      this.controller?.abort(); this.generation++; this.active = undefined;
      this.publish({ status: 'error', error: error instanceof DiscoveryError ? error : new DiscoveryError('invalid_query', 'Choose a topic first.') });
      return Promise.resolve();
    }
    const key = JSON.stringify([selection.documentId, selection.page, selection.text, query.query.toLocaleLowerCase('en-US')]);
    if (this.active?.key === key) return this.active.promise;
    this.controller?.abort(); this.controller = new AbortController();
    const signal = this.controller.signal, generation = ++this.generation;
    this.publish({ status: 'loading', query });
    let request: Promise<DiscoveryResult>;
    try { request = this.service.search(selection, queryOverride, signal); }
    catch (error) { request = Promise.reject(error); }
    const promise = request.then(result => {
      if (generation === this.generation && !signal.aborted) this.publish({ status: result.resources.length ? 'success' : 'empty', result });
    }).catch(error => {
      if (generation !== this.generation || signal.aborted) return;
      const failure = error instanceof DiscoveryError ? error : new DiscoveryError('api', 'The search could not finish. Please try again.');
      this.publish(failure.code === 'cancelled' ? { status: 'cancelled', query } : { status: 'error', error: failure, query });
    }).finally(() => { if (generation === this.generation) this.active = undefined; });
    this.active = { key, promise }; return promise;
  }
  cancel() {
    const previous = this.state;
    this.controller?.abort(); this.generation++; this.active = undefined;
    this.publish({ status: 'cancelled', query: previous.status === 'loading' ? previous.query : undefined });
  }
  dispose() { this.disposed = true; this.controller?.abort(); this.generation++; this.active = undefined; this.listeners.clear(); }
}
