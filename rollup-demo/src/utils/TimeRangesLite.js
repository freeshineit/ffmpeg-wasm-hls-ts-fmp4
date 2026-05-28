/**
 * Lightweight TimeRanges polyfill matching the HTMLMediaElement.buffered shape.
 * Stores [start, end] seconds pairs.
 */
class TimeRangesLite {
  constructor(ranges) {
    this._ranges = ranges || [];
    Object.defineProperty(this, "length", {
      get: () => this._ranges.length,
    });
  }
  start(i) {
    if (i < 0 || i >= this._ranges.length) {
      throw new Error("TimeRanges index out of range");
    }
    return this._ranges[i][0];
  }
  end(i) {
    if (i < 0 || i >= this._ranges.length) {
      throw new Error("TimeRanges index out of range");
    }
    return this._ranges[i][1];
  }
}

export default TimeRangesLite;
