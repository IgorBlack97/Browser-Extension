let job = null;

function broadcast(next) {
  job = next;
  chrome.runtime.sendMessage({ type: "job-updated", job }).catch(() => {});
}

async function ensureOffscreen() {
  const hasDocument = await chrome.offscreen.hasDocument();
  if (hasDocument) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Збирає фрагменти відео в один MP4 і передає файл у завантаження",
  });
}

function waitForOffscreen() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const ping = () => {
      if (Date.now() - started > 5000) {
        reject(new Error("Не вдалося відкрити фонову сторінку завантаження"));
        return;
      }
      chrome.runtime.sendMessage({ type: "offscreen-ping" }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          setTimeout(ping, 40);
          return;
        }
        resolve();
      });
    };
    ping();
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "videos-updated" && sender.tab) {
    const text = message.count ? String(message.count) : "";
    chrome.action.setBadgeText({ text, tabId: sender.tab.id });
    chrome.action.setBadgeBackgroundColor({ color: "#0f766e", tabId: sender.tab.id });
    return;
  }

  if (message.type === "get-job") {
    sendResponse({ job });
    return;
  }

  if (message.type === "job-progress") {
    broadcast(message.job);
    return;
  }

  if (message.type === "cancel-download") {
    chrome.runtime.sendMessage({ type: "offscreen-cancel" }).catch(() => {});
    return;
  }

  if (message.type === "save-blob") {
    saveBlob(message.url, message.filename).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || "Не вдалося зберегти файл" });
    });
    return true;
  }

  if (message.type === "download") {
    startDownload(message.video).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message || "Не вдалося почати завантаження" });
    });
    return true;
  }
});

function saveBlob(url, filename) {
  if (!chrome.downloads) {
    return Promise.reject(new Error("Браузер не дав доступу до завантажень. Перезавантажте розширення."));
  }
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename: filename || "video.mp4",
      conflictAction: "uniquify",
      saveAs: false,
    }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error || !downloadId) {
        reject(new Error(error ? error.message : "Не вдалося зберегти файл"));
        return;
      }
      waitUntilSaved(downloadId).then(resolve, reject);
    });
  });
}

function waitUntilSaved(downloadId) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      chrome.downloads.search({ id: downloadId }, (items) => {
        const item = items && items[0];
        if (!item) return;
        if (item.state === "complete") {
          clearInterval(timer);
          resolve();
        } else if (item.state === "interrupted") {
          clearInterval(timer);
          reject(new Error("Браузер перервав збереження файлу"));
        } else if (Date.now() - started > 30 * 60 * 1000) {
          clearInterval(timer);
          reject(new Error("Збереження файлу триває надто довго"));
        }
      });
    }, 400);
  });
}

async function startDownload(video) {
  if (job && !job.done && !job.error) {
    return { ok: false, error: "Вже завантажується інше відео" };
  }
  broadcast({
    id: video.id,
    title: video.title,
    phase: "start",
    loaded: 0,
    total: 0,
    bytes: 0,
    done: false,
    error: null,
  });

  if (video.kind === "mp4") {
    try {
      await chrome.downloads.download({
        url: video.url,
        filename: video.filename,
        conflictAction: "uniquify",
        saveAs: false,
      });
      broadcast({ ...job, phase: "done", done: true });
      return { ok: true };
    } catch (error) {
      broadcast({ ...job, phase: "error", done: true, error: error.message });
      return { ok: false, error: error.message };
    }
  }

  try {
    await ensureOffscreen();
    await waitForOffscreen();
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "offscreen-download", video }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          reject(new Error("Не вдалося запустити завантаження"));
          return;
        }
        resolve();
      });
    });
    return { ok: true };
  } catch (error) {
    broadcast({ ...job, phase: "error", done: true, error: error.message || "Не вдалося почати завантаження" });
    return { ok: false, error: error.message || "Не вдалося почати завантаження" };
  }
}
