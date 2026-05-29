/**
 * Lightweight TimeRanges polyfill matching the HTMLMediaElement.buffered shape.
 * Stores [start, end] seconds pairs.
 * @example
 * new TimeRangesLite([[0, 10], [20, 30]])
 *  .start(0) // 0
 *  .end(0)   // 10
 *
 */
class TimeRangesLite {
  _ranges: Array<[number, number]>;
  declare length: number;

  constructor(ranges?: Array<[number, number]>) {
    this._ranges = ranges || [];
    Object.defineProperty(this, "length", {
      get: () => this._ranges.length,
    });
  }
  start(i: number): number {
    if (i < 0 || i >= this._ranges.length) {
      throw new Error("TimeRanges index out of range");
    }
    return this._ranges[i][0];
  }
  end(i: number): number {
    if (i < 0 || i >= this._ranges.length) {
      throw new Error("TimeRanges index out of range");
    }
    return this._ranges[i][1];
  }
}

export default TimeRangesLite;
