(function () {
  if (globalThis.__vdContentInstalled) return;
  globalThis.__vdContentInstalled = true;

  let videos = [];
  let notifyTimer = 0;

  function notify() {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      chrome.runtime.sendMessage({
        type: "videos-updated",
        count: videos.length,
        videos,
      }).catch(() => {});
    }, 80);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "vd-page") return;
    if (event.data.type !== "videos" || !Array.isArray(event.data.videos)) return;
    videos = event.data.videos;
    notify();
  });

  function requestScan() {
    window.postMessage({ source: "vd-content", type: "rescan" }, "*");
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "get-videos") return;
    requestScan();
    const started = Date.now();
    const wait = () => {
      if (videos.length || Date.now() - started > 700) {
        sendResponse({ videos });
        return;
      }
      setTimeout(wait, 40);
    };
    wait();
    return true;
  });

  requestScan();
})();
