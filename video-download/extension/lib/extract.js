(function (root) {
  const VD = root.__vd || (root.__vd = {});

  function extractBalancedObject(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function lessonDtoFromHtml(html) {
    const source = String(html);
    const marker = source.indexOf("lesson_dto");
    if (marker < 0) return null;
    const brace = source.indexOf("{", marker);
    if (brace < 0) return null;
    const json = extractBalancedObject(source, brace);
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch (error) {
      return null;
    }
  }

  function isUsefulTitle(value) {
    if (typeof value !== "string") return false;
    const title = value.trim();
    if (!title) return false;
    if (title === "Розділ" || title === "Модуль") return false;
    return true;
  }

  function findLessonTitle(root) {
    const seen = new Set();
    function visit(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return "";
      seen.add(node);
      if (node.lesson && isUsefulTitle(node.lesson.title)) return node.lesson.title.trim();
      if (isUsefulTitle(node.title) && (node.slug || node.course_id || node.section)) return node.title.trim();
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") {
          const found = visit(value);
          if (found) return found;
        }
      }
      return "";
    }
    return visit(root);
  }

  function identityOf(url, filename) {
    const match = String(url).match(/\/([^/?#]+\.(?:mp4|m3u8))(?:\.m3u8)?(?:$|[?#])/i);
    let name = match ? match[1] : filename || url;
    name = name.replace(/__TPL_/gi, "").replace(/_(?:360|480|720|1080|1440|2160)p/gi, "");
    return name.toLowerCase();
  }

  function classifyUrl(url) {
    const value = String(url);
    if (value.includes("__TPL_") || value.includes("media=hls") || /\.m3u8(\?|$)/i.test(value)) return "hls";
    if (/\.mp4(\?|$)/i.test(value)) return "mp4";
    return "";
  }

  function isVideoFile(file) {
    if (!file || file.parent_id) return false;
    const url = file.url || file.preview_path || "";
    if (typeof url !== "string" || !url) return false;
    const mime = String(file.mime_type || "");
    const extension = String(file.extension || "").toLowerCase();
    if (mime.startsWith("image/") || extension === "png" || extension === "jpg" || extension === "jpeg" || extension === "pdf") {
      return false;
    }
    return mime.startsWith("video/") || extension === "mp4" || classifyUrl(url) === "hls";
  }

  function videoFromFile(file, title, durationHint) {
    const url = file.url || file.preview_path;
    const kind = classifyUrl(url) || "mp4";
    return {
      id: String(file.uuid || file.id || url),
      title: title || file.original_name || file.name || "Відео",
      filename: file.original_name || file.name || "video.mp4",
      url,
      kind,
      width: file.width || null,
      height: file.height || null,
      duration: Number(durationHint || file.duration || 0) || null,
      size: Number(file.optimized_size || 0) || null,
    };
  }

  function score(video) {
    let value = 0;
    if (video.kind === "hls") value += 2;
    if (String(video.url).includes("__TPL_")) value += 2;
    if (video.duration) value += 1;
    return value;
  }

  function extractVideos(root, fallbackTitle) {
    const lessonTitle = findLessonTitle(root) || fallbackTitle || "Відео";
    const found = [];
    const seen = new Set();

    function visit(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      const title = isUsefulTitle(node.title) ? node.title.trim() : lessonTitle;
      if (Array.isArray(node.files)) {
        for (const file of node.files) {
          if (!isVideoFile(file)) continue;
          found.push(videoFromFile(file, title, node.duration));
        }
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") visit(value);
      }
    }

    visit(root);

    const byIdentity = new Map();
    for (const video of found) {
      const key = identityOf(video.url, video.filename);
      const current = byIdentity.get(key);
      if (!current || score(video) > score(current)) byIdentity.set(key, video);
    }
    return [...byIdentity.values()];
  }

  function videosFromHtml(html, fallbackTitle) {
    const dto = lessonDtoFromHtml(html);
    if (!dto) return [];
    return extractVideos(dto, fallbackTitle);
  }

  VD.extractBalancedObject = extractBalancedObject;
  VD.lessonDtoFromHtml = lessonDtoFromHtml;
  VD.extractVideos = extractVideos;
  VD.videosFromHtml = videosFromHtml;
  VD.classifyUrl = classifyUrl;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = VD;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
