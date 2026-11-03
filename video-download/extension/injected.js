(function () {
  const VD = globalThis.__vd || (globalThis.__vd = {});
  if (globalThis.__vdPageInstalled) {
    if (typeof VD.scanPage === "function") VD.scanPage();
    return;
  }
  globalThis.__vdPageInstalled = true;

  let lastPayload = null;

  function domVideos() {
    const found = [];
    const nodes = document.querySelectorAll("video, video source");
    nodes.forEach((node) => {
      const url = node.currentSrc || node.src || "";
      if (!url || url.startsWith("blob:") || url.startsWith("data:")) return;
      const kind = VD.classifyUrl ? VD.classifyUrl(url) : "";
      if (!kind) return;
      found.push({
        id: url,
        title: document.title || "Відео",
        filename: "video.mp4",
        url,
        kind,
        width: node.videoWidth || null,
        height: node.videoHeight || null,
        duration: Number.isFinite(node.duration) ? Math.round(node.duration) : null,
        size: null,
      });
    });
    return found;
  }

  function scriptVideos() {
    if (!VD.videosFromHtml || !document.scripts) return [];
    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (!text.includes("lesson_dto") && !text.includes("__TPL_")) continue;
      const videos = VD.videosFromHtml(text, document.title);
      if (videos.length) return videos;
    }
    return [];
  }

  function resourceVideos() {
    if (!performance || !performance.getEntriesByType) return [];
    const found = [];
    for (const entry of performance.getEntriesByType("resource")) {
      const url = entry.name || "";
      if (!url.includes(".m3u8") && !url.includes("__TPL_") && !url.includes("media=hls")) continue;
      found.push({
        id: url,
        title: document.title || "Відео",
        filename: "video.mp4",
        url,
        kind: "hls",
        width: null,
        height: null,
        duration: null,
        size: null,
      });
    }
    return found;
  }

  function storageKey(video) {
    const match = String(video.url || "").match(/\/([^/?#]+)$/);
    let name = match ? match[1] : (video.filename || video.id || "");
    return name
      .replace(/__TPL_/gi, "Q")
      .replace(/_(?:360|480|720|1080|1440|2160)p/gi, "Q")
      .replace(/\.m3u8$/i, "")
      .toLowerCase();
  }

  function prefer(current, next) {
    const score = (video) => (String(video.url).includes("__TPL_") ? 4 : 0) + (video.duration ? 2 : 0) + (video.size ? 1 : 0);
    return score(next) >= score(current) ? next : current;
  }

  function publish(videos) {
    window.postMessage({ source: "vd-page", type: "videos", videos }, "*");
  }

  function scan() {
    const byName = new Map();
    for (const video of [...scriptVideos(), ...domVideos(), ...resourceVideos(), ...(lastPayload || [])]) {
      const key = storageKey(video);
      const current = byName.get(key);
      byName.set(key, current ? prefer(current, video) : video);
    }
    publish([...byName.values()]);
  }

  VD.scanPage = scan;

  function absorbText(text) {
    if (!text || text.length > 8_000_000) return;
    if (!text.includes("__TPL_") && !text.includes("video/mp4") && !text.includes(".m3u8")) return;
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (error) {
      if (!VD.videosFromHtml) return;
      const fromHtml = VD.videosFromHtml(text, document.title);
      if (fromHtml.length) {
        lastPayload = fromHtml;
        scan();
      }
      return;
    }
    if (!VD.extractVideos) return;
    const videos = VD.extractVideos(data, document.title);
    if (!videos.length) return;
    lastPayload = videos;
    scan();
  }

  const host = location.hostname || "";
  const watchNetwork = host === "kwiga.com" || host.endsWith(".kwiga.com");

  if (watchNetwork && typeof window.fetch === "function") {
    const originalFetch = window.fetch;
    window.fetch = function () {
      const result = originalFetch.apply(this, arguments);
      Promise.resolve(result).then((response) => {
        if (!response || typeof response.clone !== "function") return;
        const type = (response.headers.get("content-type") || "").toLowerCase();
        if (!type.includes("json") && !type.includes("text")) return;
        const length = Number(response.headers.get("content-length") || 0);
        if (length > 4000000) return;
        response.clone().text().then(absorbText).catch(() => {});
      }).catch(() => {});
      return result;
    };
  }

  if (watchNetwork) {
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener("load", () => {
        try {
          const type = String(this.getResponseHeader("content-type") || "").toLowerCase();
          if (!type.includes("json") && !type.includes("text")) return;
          if (typeof this.responseText === "string") absorbText(this.responseText);
        } catch (error) {}
      });
      return originalSend.apply(this, arguments);
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "vd-content") return;
    if (event.data.type === "rescan") scan();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan, { once: true });
  } else {
    scan();
  }
  window.addEventListener("load", () => setTimeout(scan, 400));

  if (watchNetwork) {
    const pushState = history.pushState;
    history.pushState = function () {
      const result = pushState.apply(this, arguments);
      setTimeout(scan, 600);
      return result;
    };
    window.addEventListener("popstate", () => setTimeout(scan, 600));
  }
})();
