/**
 * Fetcher — thin HTTP client wrapping the Fetch API.
 *
 * Provides timeout, abort, CORS config, and custom RequestInit merging.
 * Does NOT contain retry logic — retry is handled by each caller.
 *
 * Ported from the TypeScript reference (fetcher.ts) to plain JS for the
 * rollup-demo project (no external deps).
 */

import Helper from "../utils/helper";

const __$DEFAULT_FETCHER_OPTIONS$__: RequestInit = {
  mode: "cors",
  credentials: "omit",
  cache: "no-store",
};

type FetchWithTimeoutOptions = RequestInit & { timeout?: number; signal?: AbortSignal };

export class Fetcher {
  _fetchOptions: RequestInit;
  _timeout: number;
  _abortControllers: Map<string, AbortController>;

  /**
   * @param {RequestInit} [fetchOptions] Base RequestInit merged into every request.
   * @param {number} [timeout=30000] Request timeout in ms (0 = no timeout).
   */
  constructor(fetchOptions: RequestInit = {}, timeout = 30000) {
    this._fetchOptions = { ...__$DEFAULT_FETCHER_OPTIONS$__, ...fetchOptions };
    this._timeout = timeout;
    /** @type {Map<string, AbortController>} */
    this._abortControllers = new Map();
  }

  /* ==================== Core Fetch ==================== */

  /**
   * Perform a single HTTP GET request. No retry.
   *
   * @param {string} url
   * @param {RequestInit & { timeout?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<{ data: ArrayBuffer, url: string, contentType?: string, contentLength?: number }>}
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

    // AbortController: use caller-provided signal OR create one for timeout.
    const controller = new AbortController();
    this._abortControllers.set(url, controller);

    // If the caller already has a signal (e.g. from track.abort), chain it.
    const externalSignal = options.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    let timeoutId = null;
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
        const err = new Error(`HTTP ${response.status}: ${response.statusText}`) as Error & { status?: number };
        err.status = response.status;
        throw err;
      }

      //   const data = await response.arrayBuffer();

      return response;
      //   return {
      //     data,
      //     url: response.url || url,
      //     contentType: response.headers.get("content-type") || undefined,
      //     contentLength: parseInt(response.headers.get("content-length") || "0", 10) || undefined,
      //   };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this._abortControllers.delete(url);
    }
  }

  /* ==================== Convenience helpers ==================== */

  /**
   * Fetch and return response text.
   * @param {string} url
   * @param {{ signal?: AbortSignal, timeout?: number }} [options]
   * @returns {Promise<{ text: string, url: string }>}
   */
  async fetchText(url: string, options: FetchWithTimeoutOptions = {}): Promise<{ text: string; url: string }> {
    // try {
    const response = await this.fetch(url, options);
    const text = await response.text();
    return { text, url: response.url || url };
    // } catch (error) {
    //   const err = {
    //     type: "NETWORK",
    //     subType: "M3U8",
    //     message: `Failed to load playlist: ${error.message}`,
    //     originalError: error,
    //     playlistUrl: this._playlistUrl,
    //   };
    //   this._callbacks.onError(err);
    // }
  }

  /**
   * Fetch and return bytes as Uint8Array.
   * @param {string} url
   * @param {{ signal?: AbortSignal, timeout?: number }} [options]
   * @returns {Promise<Uint8Array>}
   */
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

  /** Update the base fetch options at runtime. */
  updateFetchOptions(options: RequestInit): void {
    this._fetchOptions = { ...this._fetchOptions, ...options };
  }

  /** Replace the base fetch options entirely. */
  setFetchOptions(options: RequestInit): void {
    this._fetchOptions = { ...__$DEFAULT_FETCHER_OPTIONS$__, ...options };
  }
}

export default Fetcher;
