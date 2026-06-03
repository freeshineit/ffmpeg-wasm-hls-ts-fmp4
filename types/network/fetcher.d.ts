/**
 * Fetcher — thin HTTP client wrapping the Fetch API.
 *
 * Provides timeout, abort, CORS config, and custom RequestInit merging.
 * Does NOT contain retry logic — retry is handled by each caller.
 */
interface FetchWithTimeoutOptions extends RequestInit {
    timeout?: number;
}
interface FetchTextResult {
    text: string;
    url: string;
}
export declare class Fetcher {
    _fetchOptions: RequestInit;
    _timeout: number;
    _abortControllers: Map<string, Set<AbortController>>;
    constructor(fetchOptions?: RequestInit, timeout?: number);
    /**
     * Perform a single HTTP GET request. No retry.
     * Returns the raw Response (caller should consume .text() / .arrayBuffer()).
     */
    fetch(url: string, options?: FetchWithTimeoutOptions): Promise<Response>;
    fetchText(url: string, options?: FetchWithTimeoutOptions): Promise<FetchTextResult>;
    fetchBytes(url: string, options?: FetchWithTimeoutOptions): Promise<Uint8Array>;
    cancelRequest(url: string): void;
    cancelAll(): void;
    setFetchOptions(options: RequestInit): void;
}
export default Fetcher;
