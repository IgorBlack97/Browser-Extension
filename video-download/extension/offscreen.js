const VD = globalThis.__vd;

let controller = null;

class OpfsSink {
  constructor(writable) {
    this.writable = writable;
    this.position = 0;
    this.parts = [];
    this.buffered = 0;
  }

  async write(data) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    this.parts.push(copy);
    this.buffered += copy.byteLength;
    this.position += copy.byteLength;
    if (this.buffered >= 2 * 1024 * 1024) await this.flush();
  }

  async flush() {
    if (!this.buffered) return;
    const merged = new Uint8Array(this.buffered);
    let offset = 0;
    for (const part of this.parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    const at = this.position - this.buffered;
    await this.writable.write({ type: "write", position: at, data: merged });
    this.parts = [];
    this.buffered = 0;
  }

  async writeAt(position, data) {
    await this.flush();
    await this.writable.write({ type: "write", position, data });
  }
}

function report(job) {
  chrome.runtime.sendMessage({ type: "job-progress", job }).catch(() => {});
}

async function fetchBytes(url, signal, attempt) {
  const response = await fetch(VD.normalizeUrl(url), { signal, credentials: "omit", cache: "no-store" });
  if (!response.ok) {
    if (attempt < 2 && response.status >= 500) return fetchBytes(url, signal, attempt + 1);
    throw new Error("Сервер відео відповів " + response.status);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchText(url, signal) {
  const response = await fetch(VD.normalizeUrl(url), { signal, credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new Error("Не вдалося отримати плейлист (" + response.status + ")");
  return response.text();
}

async function resolveMedia(video, signal) {
  if (video.mediaUrl) {
    const text = await fetchText(video.mediaUrl, signal);
    const parsed = VD.parsePlaylist(text, video.mediaUrl);
    if (parsed.encrypted) throw new Error("Відео захищене шифруванням");
    if (!parsed.segments.length) throw new Error("Плейлист не містить фрагментів");
    return parsed;
  }

  const text = await fetchText(video.url, signal);
  const parsed = VD.parsePlaylist(text, video.url);
  if (parsed.encrypted) throw new Error("Відео захищене шифруванням");
  if (parsed.isMaster) {
    const best = VD.bestVariant(parsed.variants);
    if (!best) throw new Error("У плейлисті немає варіантів якості");
    if (!VD.supportsCodecs(best.codecs)) {
      throw new Error("Цей кодек не збирається в MP4. Потрібні H.264 і AAC");
    }
    const mediaText = await fetchText(best.url, signal);
    const media = VD.parsePlaylist(mediaText, best.url);
    if (media.encrypted) throw new Error("Відео захищене шифруванням");
    if (!media.segments.length) throw new Error("Плейлист не містить фрагментів");
    return media;
  }
  if (!parsed.segments.length) throw new Error("Плейлист не містить фрагментів");
  return parsed;
}

function resolutionFromLabel(label) {
  const height = Number(String(label || "").replace("p", ""));
  if (!height) return { width: 0, height: 0 };
  const map = { 360: [640, 360], 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] };
  const known = map[height];
  return known ? { width: known[0], height: known[1] } : { width: 0, height };
}

async function downloadHls(video, signal) {
  const baseJob = {
    id: video.id,
    title: video.title,
    phase: "playlist",
    loaded: 0,
    total: 0,
    bytes: 0,
    done: false,
    error: null,
  };
  report(baseJob);
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle("vd-" + Date.now() + ".mp4", { create: true });
  let writable = null;
  try {
    const playlist = await resolveMedia(video, signal);
    const total = playlist.segments.length;
    const size = resolutionFromLabel(video.quality);
    writable = await handle.createWritable();
    const sink = new OpfsSink(writable);
    const remuxer = new VD.TsToMp4(sink, {
      width: video.width || size.width,
      height: video.height || size.height,
    });
    await remuxer.start();

    const pending = new Map();
    let nextFetch = 0;
    let nextWrite = 0;
    let fetched = 0;
    let bytes = 0;
    let failure = null;

    async function fetchWorker() {
      while (!failure && !signal.aborted) {
        const index = nextFetch++;
        if (index >= total) return;
        try {
          const data = await fetchBytes(playlist.segments[index].url, signal, 0);
          pending.set(index, data);
          fetched += 1;
          bytes += data.byteLength;
          report({ ...baseJob, phase: "download", loaded: fetched, total, bytes });
        } catch (error) {
          failure = error.name === "AbortError" ? new Error("Скасовано") : error;
          return;
        }
      }
    }

    async function writeWorker() {
      while (nextWrite < total) {
        if (failure) throw failure;
        if (signal.aborted) throw new Error("Скасовано");
        if (!pending.has(nextWrite)) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          continue;
        }
        const data = pending.get(nextWrite);
        pending.delete(nextWrite);
        await remuxer.pushSegment(data);
        nextWrite += 1;
      }
    }

    await Promise.all([fetchWorker(), fetchWorker(), fetchWorker(), fetchWorker(), writeWorker()]);
    if (failure) throw failure;

    report({ ...baseJob, phase: "save", loaded: total, total, bytes });
    await remuxer.finish();
    await writable.close();
    writable = null;

    const file = await handle.getFile();
    const objectUrl = URL.createObjectURL(file);
    try {
      await askBackgroundToSave(objectUrl, video.filename);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    report({ ...baseJob, phase: "done", loaded: total, total, bytes, done: true });
  } finally {
    if (writable) {
      try { await writable.close(); } catch (error) {}
    }
    try { await handle.remove(); } catch (error) {}
  }
}

function askBackgroundToSave(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "save-blob", url, filename }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error((response && response.error) || "Не вдалося зберегти файл"));
        return;
      }
      resolve();
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "offscreen-ping") {
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "offscreen-cancel") {
    if (controller) controller.abort();
    return;
  }
  if (message.type !== "offscreen-download") return;

  if (controller) controller.abort();
  const current = new AbortController();
  controller = current;
  sendResponse({ ok: true });
  downloadHls(message.video, current.signal).catch((error) => {
    if (controller !== current) return;
    report({
      id: message.video.id,
      title: message.video.title,
      phase: "error",
      done: true,
      error: current.signal.aborted ? "Скасовано" : (error.message || "Не вдалося зібрати MP4"),
    });
  }).finally(() => {
    if (controller === current) controller = null;
  });
});
