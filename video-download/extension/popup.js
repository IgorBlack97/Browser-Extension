const VD = globalThis.__vd;
const list = document.querySelector("#list");
const refreshButton = document.querySelector("#refresh");

let tabId = null;
let videos = [];
let job = null;
const details = new Map();

function formatDuration(seconds) {
  if (!seconds) return "";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes + ":" + String(rest).padStart(2, "0");
}

function formatSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1).replace(".", ",") + " ГБ";
  return Math.round(mb) + " МБ";
}

function formatProgressBytes(bytes) {
  return formatSize(bytes) || "0 МБ";
}

function fileName(video) {
  const quality = video.qualityLabel ? " " + video.qualityLabel : "";
  const base = String(video.title || "video")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "video";
  return base + quality + ".mp4";
}

function metaLine(video) {
  const parts = [];
  if (video.qualityLabel) parts.push(video.qualityLabel);
  else if (video.kind === "hls") parts.push("шукаю якість…");
  const duration = formatDuration(video.duration);
  if (duration) parts.push(duration);
  const size = formatSize(video.size);
  if (size) parts.push(size);
  return parts.join(" · ") || "Можна зберегти як MP4";
}

function render() {
  if (!videos.length) {
    list.innerHTML = '<p class="empty">На цій сторінці немає відео, яке можна скачати. Відкрийте урок і зачекайте, поки сторінка завантажиться.</p>';
    return;
  }

  list.innerHTML = "";
  videos.forEach((video) => {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("h2");
    title.className = "title";
    title.textContent = video.title || "Відео";
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = metaLine(video);
    card.append(title, meta);

    const active = job && job.id === video.id && !job.done && !job.error;
    const button = document.createElement("button");
    button.className = "download";
    button.type = "button";
    button.textContent = video.qualityLabel ? "Скачати " + video.qualityLabel : "Скачати MP4";
    button.disabled = Boolean(active || (job && !job.done && !job.error));
    button.addEventListener("click", () => startDownload(video, button));
    card.append(button);

    if (job && job.id === video.id) {
      const status = document.createElement("p");
      status.className = "status" + (job.error ? " error" : "");
      status.textContent = statusText(job);
      card.append(status);
      if (active && job.total) {
        const progress = document.createElement("div");
        progress.className = "progress";
        const bar = document.createElement("span");
        bar.style.width = Math.min(100, Math.round((job.loaded / job.total) * 100)) + "%";
        progress.append(bar);
        card.append(progress);
      }
      if (active) {
        const cancel = document.createElement("button");
        cancel.className = "cancel";
        cancel.type = "button";
        cancel.textContent = "Скасувати";
        cancel.addEventListener("click", () => chrome.runtime.sendMessage({ type: "cancel-download" }));
        card.append(cancel);
      }
    }
    list.append(card);
  });
}

function statusText(current) {
  if (current.error) return current.error;
  if (current.done || current.phase === "done") return "Файл збережено в Завантаження";
  if (current.phase === "playlist" || current.phase === "start") return "Готую найвищу якість…";
  if (current.phase === "save") return "Зберігаю MP4…";
  if (current.phase === "download") {
    const percent = current.total ? Math.round((current.loaded / current.total) * 100) : 0;
    return "Завантаження " + percent + "% · " + formatProgressBytes(current.bytes);
  }
  return "Завантаження…";
}

async function probe(video) {
  if (video.kind !== "hls" || details.has(video.id)) return;
  details.set(video.id, { ...video, pending: true });
  try {
    const response = await fetch(VD.normalizeUrl(video.url), { credentials: "omit" });
    if (!response.ok) throw new Error(String(response.status));
    const parsed = VD.parsePlaylist(await response.text(), video.url);
    const best = parsed.isMaster ? VD.bestVariant(parsed.variants) : null;
    const resolution = best ? best.resolution : "";
    const [width, height] = resolution.split("x").map(Number);
    const duration = video.duration || parsed.duration || 0;
    const rate = best ? (best.averageBandwidth || best.bandwidth) : 0;
    const estimated = rate && duration ? Math.round(rate * duration / 8) : video.size;
    const next = {
      ...video,
      mediaUrl: best ? best.url : video.url,
      qualityLabel: VD.qualityLabel(resolution),
      width: width || video.width,
      height: height || video.height,
      duration: duration || video.duration,
      size: estimated || video.size,
      codecs: best ? best.codecs : "",
    };
    details.set(video.id, next);
    videos = videos.map((item) => item.id === video.id ? { ...item, ...next } : item);
    render();
  } catch (error) {
    details.set(video.id, { ...video, pending: false });
  }
}

async function startDownload(video, button) {
  const known = details.get(video.id) || video;
  button.disabled = true;
  const response = await chrome.runtime.sendMessage({
    type: "download",
    video: {
      id: known.id,
      title: known.title,
      url: known.url,
      mediaUrl: known.mediaUrl || "",
      kind: known.kind,
      filename: fileName(known),
      width: known.width || null,
      height: known.height || null,
      quality: known.qualityLabel || "",
      codecs: known.codecs || "",
    },
  });
  if (response && response.ok === false) {
    job = { id: known.id, done: true, error: response.error || "Не вдалося почати" };
    render();
  }
}

async function loadVideos() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    videos = [];
    render();
    return;
  }
  tabId = tab.id;
  try {
    videos = await askTab(tab.id);
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["lib/extract.js", "injected.js"],
        world: "MAIN",
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      videos = await askTab(tab.id);
    } catch (injectError) {
      videos = [];
    }
  }
  render();
  videos.forEach(probe);
}

function askTab(id) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(id, { type: "get-videos" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve((response && response.videos) || []);
    });
  });
}

refreshButton.addEventListener("click", () => {
  details.clear();
  loadVideos();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "videos-updated" && sender.tab && sender.tab.id === tabId) {
    const incoming = message.videos || [];
    if (!incoming.length && videos.length) return;
    videos = incoming.map((video) => {
      const known = details.get(video.id);
      return known && !known.pending ? { ...video, ...known, url: video.url } : video;
    });
    render();
    videos.forEach(probe);
  }
  if (message.type === "job-updated") {
    job = message.job;
    render();
  }
});

chrome.runtime.sendMessage({ type: "get-job" }, (response) => {
  if (response && response.job) job = response.job;
  loadVideos();
});
