/**
 * Lightweight TimeRanges polyfill matching the HTMLMediaElement.buffered shape.
 * Stores [start, end] seconds pairs.
 * @example
 * new TimeRangesLite([[0, 10], [20, 30]])
 *  .start(0) // 0
 *  .end(0)   // 10
 *
 */
declare class TimeRangesLite {
    _ranges: Array<[number, number]>;
    length: number;
    constructor(ranges?: Array<[number, number]>);
    start(i: number): number;
    end(i: number): number;
}
export default TimeRangesLite;
