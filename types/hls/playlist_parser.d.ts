import type { MasterPlaylist, MasterVariant, AudioRendition, MediaPlaylist } from "../types";
/**
 * Classify a playlist as "master" (multivariant) or "media" (chunklist).
 *  - Has any #EXT-X-STREAM-INF and no #EXTINF -> master
 *  - Otherwise -> media (current default behavior)
 */
export declare function classifyPlaylist(text: string): "master" | "media";
/**
 * Parse a Master (Multivariant) Playlist. Returns:
 *   {
 *     variants: [{ bandwidth, codecs, resolution, audioGroup, uri }],
 *     audioGroups: { [groupId]: [{ groupId, name, default, language, uri }] },
 *   }
 * URIs are resolved against playlistUrl, preserving any per-URI query string.
 */
export declare function parseMasterPlaylist(text: string, playlistUrl: string): MasterPlaylist;
/**
 * Pick the default variant (highest BANDWIDTH, first-in-source-order on tie)
 * and resolve its audio rendition (DEFAULT=YES preferred, else first in group).
 * Returns { variant, audio } where either may be null.
 */
export declare function selectVariantAndAudio(master: MasterPlaylist | null | undefined): {
    variant: MasterVariant | null;
    audio: AudioRendition | null;
};
export declare function parseMediaPlaylist(text: string, playlistUrl: string): MediaPlaylist;
