/**
 * MPD -> policy-visible catalog. The MPD object MUST originate from dash.js
 * DashParser (not an independent XML parser). Only the explicitly supported
 * single-period static SegmentTemplate/SegmentTimeline VoD profile is accepted.
 * Future-asset URL addressing is metadata-only; active-player fragment requests
 * are resolved by the patched dash.js DashHandler through SFVPlayerPool.
 */
function one(items, what) {
  if (!Array.isArray(items) || items.length !== 1)
    throw new Error(`SFV profile requires exactly one ${what}`);
  return items[0];
}
function textOf(baseURL) {
  if (typeof baseURL === 'string') return baseURL;
  return baseURL?.__text ?? baseURL?.url ?? '';
}
function formatTemplate(template, representationId, number, bandwidth, time) {
  return template.replace(
    /\$(RepresentationID|Number|Bandwidth|Time)(%0(\d+)d)?\$/g,
    (_match, symbol, _format, width) => {
      const value = {
        RepresentationID: representationId,
        Number: number,
        Bandwidth: bandwidth,
        Time: time
      }[symbol];
      if (value === undefined) throw new Error(`Unsupported MPD placeholder ${symbol}`);
      return width ? String(value).padStart(Number(width), '0') : String(value);
    }
  );
}
function frameRateFpsOf(frameRate) {
  if (frameRate == null) return undefined;
  const [numerator, denominator = 1] = String(frameRate).split('/').map(Number);
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : undefined;
}

function segmentsOf(template, durationS) {
  if (!template || !template.SegmentTimeline?.S?.length)
    throw new Error('SegmentTimeline required');
  const scale = Number(template.timescale ?? 1);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid timescale');
  const offset = Number(template.presentationTimeOffset ?? 0);
  const out = [];
  let next = 0;
  for (const entry of template.SegmentTimeline.S) {
    const d = Number(entry.d);
    const repeats = Number(entry.r ?? 0);
    if (!Number.isFinite(d) || d <= 0 || !Number.isInteger(repeats) || repeats < 0) {
      throw new Error('Unsupported SegmentTimeline duration or repetition');
    }
    const start = entry.t === undefined ? next : Number(entry.t);
    if (!Number.isFinite(start) || start < next - 1e-6)
      throw new Error('Discontinuous or invalid SegmentTimeline');
    for (let i = 0; i <= repeats; i++) {
      const t = start + i * d;
      const startS = (t - offset) / scale;
      if (startS >= durationS - 1e-6) break;
      out.push({
        index: out.length,
        startS,
        durationS: Math.min(d / scale, durationS - startS),
        number: Number(template.startNumber ?? 1) + out.length,
        time: t
      });
    }
    next = start + (repeats + 1) * d;
  }
  if (!out.length) throw new Error('Empty SegmentTimeline');
  return out;
}
function seconds(duration) {
  if (typeof duration === 'number') return duration; // dash.js DurationMatcher converts ISO 8601 to seconds
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
    duration ?? ''
  );
  if (!m) throw new Error('Unsupported presentation duration');
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}
export class SFVDashAssetResolver {
  constructor({ parseDashManifest }) {
    if (typeof parseDashManifest !== 'function')
      throw new TypeError('dash.js DashParser callback required');
    this.parseDashManifest = parseDashManifest;
  }
  parse(videoId, bytes, manifestUrl) {
    const xml = new TextDecoder().decode(
      bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
    );
    const mpd = this.parseDashManifest(xml);
    if (!mpd || mpd.type !== 'static') throw new Error('Only static DASH VoD is supported');
    const period = one(mpd.Period, 'Period');
    const durationS = seconds(mpd.mediaPresentationDuration);
    if (!(durationS > 0 && Number.isFinite(durationS))) throw new Error('Invalid VoD duration');
    const base = new URL(textOf(mpd.BaseURL?.[0]) || '.', manifestUrl);
    const representations = { video: [], audio: [] };
    for (const set of period.AdaptationSet ?? []) {
      const type = set.contentType ?? (set.mimeType?.startsWith('audio/') ? 'audio' : 'video');
      if (!['video', 'audio'].includes(type)) continue;
      const setBase = new URL(textOf(set.BaseURL?.[0]) || '.', base);
      for (const rep of set.Representation ?? []) {
        const template = rep.SegmentTemplate ?? set.SegmentTemplate ?? period.SegmentTemplate;
        if (!template?.initialization || !template?.media)
          throw new Error('SegmentTemplate init/media required');
        const bitrateKbps = Number(rep.bandwidth) / 1000;
        const timeline = segmentsOf(template, durationS);
        const root = new URL(textOf(rep.BaseURL?.[0]) || '.', setBase);
        const url = (tpl, s) =>
          new URL(formatTemplate(tpl, String(rep.id), s?.number, rep.bandwidth, s?.time), root)
            .href;
        representations[type].push({
          id: String(rep.id),
          bitrateKbps,
          width: rep.width,
          height: rep.height,
          codec: rep.codecs ?? set.codecs,
          frameRateFps: frameRateFpsOf(rep.frameRate ?? set.frameRate),
          mimeType: rep.mimeType ?? set.mimeType ?? `${type}/mp4`,
          initUrl: url(template.initialization),
          segments: timeline.map(s => ({
            index: s.index,
            startS: s.startS,
            durationS: s.durationS,
            url: url(template.media, s)
          }))
        });
      }
    }
    if (!representations.video.length) throw new Error('No video representations');
    // dash.js accepts an already parsed MPD, avoiding a second autonomously issued MPD GET.
    // ManifestLoader normally provides all three fields. When SFV fetches the
    // MPD itself, they must be restored before attaching the parsed MPD to dash.js.
    // Without baseUri, relative SegmentTemplate paths cannot be resolved by
    // BaseURLController and DashHandler.getInitRequest() returns no request.
    const absoluteManifestUrl = new URL(manifestUrl).href;
    mpd.url = absoluteManifestUrl;
    mpd.originalUrl ??= absoluteManifestUrl;
    mpd.baseUri = new URL('.', absoluteManifestUrl).href;
    mpd.loadedTime ??= new Date();
    return {
      dashManifest: mpd,
      video: {
        videoId,
        manifestUrl,
        durationS,
        segmentDurationS: representations.video[0].segments[0].durationS,
        representations
      }
    };
  }
}
