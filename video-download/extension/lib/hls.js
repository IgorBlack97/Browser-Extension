(function (root) {
  const VD = root.__vd || (root.__vd = {});

  function normalizeUrl(url) {
    return String(url).replace(/\+/g, "%2B");
  }

  function resolveUrl(base, ref) {
    try {
      return normalizeUrl(new URL(ref, base).toString());
    } catch (error) {
      return normalizeUrl(ref);
    }
  }

  function parsePlaylist(text, baseUrl) {
    const lines = String(text).split(/\r?\n/);
    const variants = [];
    const segments = [];
    let pendingStream = null;
    let pendingDuration = 0;
    let duration = 0;
    let encrypted = false;
    let isMaster = false;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        isMaster = true;
        const bandwidth = /(?<![-A-Z])BANDWIDTH=(\d+)/.exec(line);
        const average = /AVERAGE-BANDWIDTH=(\d+)/.exec(line);
        const resolution = /RESOLUTION=(\d+x\d+)/.exec(line);
        const codecs = /CODECS="([^"]+)"/.exec(line);
        pendingStream = {
          bandwidth: bandwidth ? Number(bandwidth[1]) : (average ? Number(average[1]) : 0),
          averageBandwidth: average ? Number(average[1]) : 0,
          resolution: resolution ? resolution[1] : "",
          codecs: codecs ? codecs[1] : "",
        };
        continue;
      }
      if (line.startsWith("#EXTINF")) {
        const value = parseFloat(line.slice(line.indexOf(":") + 1));
        pendingDuration = Number.isFinite(value) ? value : 0;
        continue;
      }
      if (line.startsWith("#EXT-X-KEY") && !/METHOD=NONE/.test(line)) {
        encrypted = true;
        continue;
      }
      if (line.startsWith("#")) continue;

      const url = resolveUrl(baseUrl, line);
      if (pendingStream) {
        variants.push({ ...pendingStream, url });
        pendingStream = null;
      } else {
        duration += pendingDuration;
        segments.push({ url, duration: pendingDuration });
        pendingDuration = 0;
      }
    }

    return { isMaster, variants, segments, duration, encrypted };
  }

  function bestVariant(variants) {
    if (!variants || !variants.length) return null;
    return variants.reduce((best, item) => (item.bandwidth > best.bandwidth ? item : best));
  }

  function qualityLabel(resolution) {
    if (!resolution) return "";
    const height = Number(String(resolution).split("x")[1]);
    if (!height) return String(resolution);
    return height + "p";
  }

  function supportsCodecs(codecs) {
    if (!codecs) return true;
    const lower = codecs.toLowerCase();
    const videoOk = lower.includes("avc1");
    const audioOk = !lower.includes("mp4a") || lower.includes("mp4a.40.2") || lower.includes("mp4a.40");
    return videoOk && audioOk;
  }

  VD.normalizeUrl = normalizeUrl;
  VD.parsePlaylist = parsePlaylist;
  VD.bestVariant = bestVariant;
  VD.qualityLabel = qualityLabel;
  VD.supportsCodecs = supportsCodecs;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = VD;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
