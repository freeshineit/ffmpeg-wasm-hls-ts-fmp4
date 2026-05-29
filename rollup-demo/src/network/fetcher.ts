/**
 * Fetcher — thin HTTP client wrapping the Fetch API.
 *
 * Provides timeout, abort, CORS config, and custom RequestInit merging.
 * Does NOT contain retry logic — retry is handled by each caller.
 */

import Helper from "../utils/helper";

const __$DEFAULT_FETCHER_OPTIONS$__: RequestInit = {
  mode: "cors",
  credentials: "omit",
  cache: "no-store",
};

interface FetchWithTimeoutOptions extends RequestInit {
  timeout?: number;
  // signal?: AbortSignal;
}

interface FetchTextResult {
  text: string;
  url: string;
}

export class Fetcher {
  _fetchOptions: RequestInit;
  _timeout: number;
  _abortControllers: Map<string, AbortController>;

  constructor(fetchOptions: RequestInit = {}, timeout: number = 30000) {
    this._fetchOptions = { ...__$DEFAULT_FETCHER_OPTIONS$__, ...fetchOptions };
    this._timeout = timeout;
    this._abortControllers = new Map();
  }

  /* ==================== Core Fetch ==================== */

  /**
   * Perform a single HTTP GET request. No retry.
   * Returns the raw Response (caller should consume .text() / .arrayBuffer()).
   */
  async fetch(url: string, options: FetchWithTimeoutOptions = {}): Promise<Response> {
    const baseHeaders = Helper.flattenHeaders(this._fetchOptions.headers);
    const perReqHeaders = Helper.flattenHeaders(options.headers);
    const mergedHeaders = { ...baseHeaders, ...perReqHeaders };

    const mergedOptions = {
      ...this._fetchOptions,
      ...options,
      headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
    };

    const controller = new AbortController();
    this._abortControllers.set(url, controller);

    const externalSignal = options.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const effectiveTimeout = options.timeout ?? this._timeout;
    if (effectiveTimeout > 0) {
      timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
    }

    try {
      const response = await fetch(url, {
        ...mergedOptions,
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = new Error(`HTTP ${response.status}: ${response.statusText}`) as Error & { status: number };
        err.status = response.status;
        throw err;
      }

      return response;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this._abortControllers.delete(url);
    }
  }

  /* ==================== Convenience helpers ==================== */

  async fetchText(url: string, options: FetchWithTimeoutOptions = {}): Promise<FetchTextResult> {
    const response = await this.fetch(url, options);
    const text = await response.text();
    return { text, url: response.url || url };
  }

  async fetchBytes(url: string, options: FetchWithTimeoutOptions = {}): Promise<Uint8Array> {
    const response = await this.fetch(url, options);
    const data = await response.arrayBuffer();
    return new Uint8Array(data);
  }

  /* ==================== Abort ==================== */

  cancelRequest(url: string): void {
    const controller = this._abortControllers.get(url);
    if (controller) {
      controller.abort();
      this._abortControllers.delete(url);
    }
  }

  cancelAll(): void {
    for (const [, controller] of this._abortControllers) {
      controller.abort();
    }
    this._abortControllers.clear();
  }

  /* ==================== Config ==================== */

  setFetchOptions(options: RequestInit): void {
    this._fetchOptions = { ...this._fetchOptions, ...options };
  }
}

export default Fetcher;
