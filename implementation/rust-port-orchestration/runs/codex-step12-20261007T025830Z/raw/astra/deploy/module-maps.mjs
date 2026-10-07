/** Host-only derived point-map view for accepted import-edit stages.
 * Compose newest-to-oldest; retain original compiler artifact identity.
 * Raw source/name indices, duplicate identities and optional metadata remain
 * owned by the original map. The library sees opaque identities and no loader.
 * Arbitrary indexed/range maps and host getter/proxy objects are not certified.
 */
import remapping from "/private/tmp/canlang-rust-port-codex-step12-20261007T025830Z/installed/node_modules/@canlang/cloudflare/node_modules/@jridgewell/remapping/dist/remapping.umd.js";
import { encode } from "/private/tmp/canlang-rust-port-codex-step12-20261007T025830Z/installed/node_modules/@canlang/cloudflare/node_modules/@jridgewell/sourcemap-codec/dist/sourcemap-codec.mjs";
import { decodeMappings } from '../runtime/sourcemap.mjs';
// Encode through the library. Carrier points retain the raw decoder's large
// accumulated coordinates while keeping every field delta in its safe range.
// Equal-column carriers certify Can's last-duplicate raw lookup. Stock host
// mappers may differ on pathological large/negative coordinates; ordinary
// compiler maps require no carriers. No second VLQ parser is introduced.
function rawEncode(lines) {
    const limit = 0x3fffffff;
    const previous = [0, 0, 0, 0];
    const expanded = lines.map((line) => {
        const out = [];
        for (const segment of line) {
            if (segment.length === 1) {
                out.push(segment);
                continue;
            }
            const target = [segment[1], segment[2], segment[3], segment.length === 5 ? segment[4] : previous[3]];
            while (target.some((value, i) => Math.abs(value - previous[i]) > limit)) {
                for (let i = 0; i < 4; i++)
                    previous[i] = previous[i] + Math.max(-limit, Math.min(limit, target[i] - previous[i]));
                out.push([segment[0], previous[0], previous[1], previous[2], previous[3]]);
            }
            out.push(segment);
            for (let i = 0; i < 4; i++)
                previous[i] = target[i];
        }
        return out;
    });
    return encode(expanded);
}
// A source-order raw lookup advances only after every earlier column is <=q.
// Its exact step function has prefix-maximum thresholds; later equal-threshold
// points win. This adapts semantics rather than sorting raw input.
function effectiveLine(line) {
    const out = [[0]];
    let threshold = 0;
    for (const segment of line) {
        threshold = Math.max(threshold, segment.genCol);
        const point = segment.src === undefined ? [threshold] : segment.name === undefined
            ? [threshold, segment.src, segment.srcLine, segment.srcCol]
            : [threshold, segment.src, segment.srcLine, segment.srcCol, segment.name];
        if (out[out.length - 1][0] === threshold)
            out[out.length - 1] = point;
        else
            out.push(point);
    }
    return out;
}
/**
 * No edits pass the original map through before reading even its mappings.
 * Missing maps stay missing. Changed malformed originals remain explicitly
 * invalid: all valid raw queries already fail whole-map decode, so preserving
 * them cannot expose a usable stale authored position or newly reject staging.
 * Valid odd numeric/order maps retain the accepted raw lookup semantics.
 * Recompute this derived view for each original/edit sequence; no map cache.
 */
export function composeModuleMap(original, stagesNewestFirst, originalJs) {
    if (stagesNewestFirst.length === 0)
        return { map: original, status: original === undefined ? 'absent' : 'unchanged' };
    if (original === undefined)
        return { map: undefined, status: 'absent' };
    let decoded;
    try {
        decoded = decodeMappings(original.mappings);
    }
    catch (error) {
        return { map: original, status: 'invalid', error: error instanceof Error ? error.message : String(error) };
    }
    const sourceIds = Array.isArray(original.sources) ? original.sources.map((_, index) => `can:raw-source:${index}`) : [];
    const nameIds = Array.isArray(original.names) ? original.names.map((_, index) => `can:raw-name:${index}`) : [];
    const lineCount = originalJs.split(/\r\n|[\r\n\u2028\u2029]/).length;
    const baseLines = Array.from({ length: Math.max(decoded.length, lineCount) }, (_, index) => effectiveLine(decoded[index] ?? []).map((segment) => {
        if (segment.length === 1 || !Array.isArray(original.sources) || typeof original.sources[segment[1]] !== 'string')
            return [segment[0]];
        if (segment.length === 5 && Array.isArray(original.names) && typeof original.names[segment[4]] === 'string')
            return segment;
        return [segment[0], segment[1], segment[2], segment[3]];
    }));
    const base = { version: 3, sources: sourceIds, names: nameIds, mappings: baseLines };
    const transforms = stagesNewestFirst.map((stage) => ({ version: 3, sources: ['can:previous'], names: [], mappings: stage.mappings }));
    const composed = remapping([...transforms, base], () => null, { excludeContent: true, decodedMappings: true });
    const sources = composed.sources.map((id) => Number(id.slice('can:raw-source:'.length)));
    const names = composed.names.map((id) => Number(id.slice('can:raw-name:'.length)));
    const lines = composed.mappings.map((line) => line.map((segment) => segment.length === 1 ? segment : segment.length === 5
        ? [segment[0], sources[segment[1]], segment[2], segment[3], names[segment[4]]]
        : [segment[0], sources[segment[1]], segment[2], segment[3]]));
    return { map: { ...original, mappings: rawEncode(lines) }, status: 'composed' };
}
