import express from "express";
import sharp from "sharp";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
app.use(express.json({ limit: "30mb" }));

const FRAMES_JSON_URL = "https://teongweii.github.io/Vip/frames.json";
const OUT_DIR = path.join(os.tmpdir(), "locket-out");
const FILE_TTL_MS = 30 * 60 * 1000;
const SESSION_TTL_MS = 3 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

fs.mkdirSync(OUT_DIR, { recursive: true });

let cachedFrames = null;
let cachedAt = 0;
const sessions = new Map();

function cleanup() {
  const now = Date.now();
  for (const [key, sess] of sessions.entries()) {
    if (!sess || now - sess.updatedAt > SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }
  try {
    const files = fs.readdirSync(OUT_DIR);
    for (const file of files) {
      const full = path.join(OUT_DIR, file);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > FILE_TTL_MS) {
          fs.unlinkSync(full);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

setInterval(cleanup, 60 * 1000).unref();

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function decodeImageInput(rawInput) {
  if (typeof rawInput !== "string" || !rawInput.trim()) {
    throw new Error("IMAGE_INPUT_MISSING");
  }
  const trimmed = rawInput.trim();

  if (trimmed.startsWith("data:image/")) {
    const commaIdx = trimmed.indexOf(",");
    if (commaIdx === -1) throw new Error("INVALID_DATA_URL");
    const b64 = trimmed.slice(commaIdx + 1).trim();
    const buf = Buffer.from(b64, "base64");
    if (!buf.length) throw new Error("EMPTY_BASE64_IMAGE");
    return buf;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const res = await fetchWithTimeout(trimmed, {
      headers: { "User-Agent": "Mozilla/5.0 LocketPhotoBoothWorker/1.0" }
    });
    if (!res.ok) {
      throw new Error(`INPUT_IMAGE_HTTP_${res.status}`);
    }
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (!buf.length) throw new Error("EMPTY_REMOTE_IMAGE");
    return buf;
  }

  const cleanB64 = trimmed.replace(/^data:[^;]+;base64,/, "");
  const buf = Buffer.from(cleanB64, "base64");
  if (!buf.length) throw new Error("UNSUPPORTED_IMAGE_FORMAT");
  return buf;
}

function flattenFramesList(rawJson) {
  if (Array.isArray(rawJson)) return rawJson;
  if (rawJson && typeof rawJson === "object") {
    if (Array.isArray(rawJson.frames)) return rawJson.frames;
    if (Array.isArray(rawJson.data)) return rawJson.data;
    if (Array.isArray(rawJson.items)) return rawJson.items;
    const out = [];
    for (const val of Object.values(rawJson)) {
      if (Array.isArray(val)) out.push(...val);
    }
    return out;
  }
  return [];
}

async function getFrameUrlById(filterId) {
  if (!filterId || typeof filterId !== "string") return "";
  const target = filterId.trim();
  const now = Date.now();

  if (!cachedFrames || now - cachedAt > 5 * 60 * 1000) {
    try {
      const res = await fetchWithTimeout(FRAMES_JSON_URL, {
        headers: { "User-Agent": "Mozilla/5.0 LocketPhotoBoothWorker/1.0" }
      });
      if (res.ok) {
        const parsed = await res.json();
        cachedFrames = flattenFramesList(parsed);
        cachedAt = now;
      }
    } catch (_) {
      if (!cachedFrames) cachedFrames = [];
    }
  }

  const list = Array.isArray(cachedFrames) ? cachedFrames : [];
  const found = list.find((item) => {
    if (!item || typeof item !== "object") return false;
    return (
      item.id === target ||
      item.uid === target ||
      item.key === target ||
      item.slug === target ||
      item.code === target
    );
  });

  if (!found) return "";
  const candidateUrl = found.url || found.image_url || found.frame_url || found.src || "";
  return typeof candidateUrl === "string" ? candidateUrl.trim() : "";
}

async function loadFrameOverlayBuffer(frameUrl, size = 1080) {
  if (!frameUrl || !/^https?:\/\//i.test(frameUrl)) return null;
  try {
    const res = await fetchWithTimeout(frameUrl, {
      headers: { "User-Agent": "Mozilla/5.0 LocketPhotoBoothWorker/1.0" }
    });
    if (!res.ok) return null;
    const rawBuf = Buffer.from(await res.arrayBuffer());
    if (!rawBuf.length) return null;

    return await sharp(rawBuf)
      .resize(size, size, { fit: "fill" })
      .png()
      .toBuffer();
  } catch (_) {
    return null;
  }
}

function getBaseUrl(req) {
  if (typeof process.env.PUBLIC_BASE_URL === "string" && process.env.PUBLIC_BASE_URL.trim()) {
    return process.env.PUBLIC_BASE_URL.trim().replace(/\/+$/, "");
  }
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = (
    (typeof forwardedProto === "string" && forwardedProto) ||
    req.protocol ||
    "https"
  )
    .split(",")[0]
    .trim();
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = (
    (typeof forwardedHost === "string" && forwardedHost) ||
    req.get("host") ||
    ""
  )
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function getSessionKey(req, data) {
  const uid =
    (data && (data.user_id || data.uid || data.session_id || data.sessionId)) ||
    req.headers["x-forwarded-for"] ||
    req.ip ||
    "default-user";
  const fid = (data && (data.filter_id || data.filterId || data.frame_id)) || "default-filter";
  return `${String(uid).slice(0, 80)}::${String(fid).slice(0, 80)}`;
}

function getSlotCount(filterId) {
  const id = String(filterId || "");
  if (/khung4|4[_-]?o|4grid|grid4/i.test(id)) return 4;
  if (/khung3|3[_-]?o|3grid|grid3/i.test(id)) return 3;
  if (/khung2|2[_-]?o|2grid|grid2/i.test(id)) return 2;
  return 1;
}

function getSlotRects(slotCount, size = 1080) {
  const half = Math.floor(size / 2);
  if (slotCount === 4) {
    return [
      { top: 0, left: 0, width: half, height: half },
      { top: 0, left: half, width: size - half, height: half },
      { top: half, left: 0, width: half, height: size - half },
      { top: half, left: half, width: size - half, height: size - half }
    ];
  }
  if (slotCount === 3) {
    const third = Math.floor(size / 3);
    return [
      { top: 0, left: 0, width: size, height: third },
      { top: third, left: 0, width: size, height: third },
      { top: third * 2, left: 0, width: size, height: size - third * 2 }
    ];
  }
  if (slotCount === 2) {
    return [
      { top: 0, left: 0, width: size, height: half },
      { top: half, left: 0, width: size, height: size - half }
    ];
  }
  return [{ top: 0, left: 0, width: size, height: size }];
}

async function renderFinalImage(shots, filterId, frameOverlayBuf) {
  const size = 1080;
  const slotCount = getSlotCount(filterId);
  const rects = getSlotRects(slotCount, size);

  const canvas = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  });

  const layers = [];
  const count = Math.min(shots.length, rects.length);

  for (let i = 0; i < count; i++) {
    const r = rects[i];
    const tile = await sharp(shots[i])
      .rotate()
      .resize(r.width, r.height, { fit: "cover", position: "centre" })
      .png()
      .toBuffer();
    layers.push({ input: tile, top: r.top, left: r.left });
  }

  if (frameOverlayBuf) {
    layers.push({ input: frameOverlayBuf, top: 0, left: 0 });
  }

  return await canvas
    .composite(layers)
    .jpeg({ quality: 90 })
    .toBuffer();
}

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "locket-photobooth-worker",
    status: "running"
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/out/:filename", (req, res) => {
  const safeName = path.basename(String(req.params.filename || ""));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i.test(safeName)) {
    return res.status(400).json({ error: { message: "INVALID_FILENAME" } });
  }
  const filePath = path.join(OUT_DIR, safeName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: { message: "FILE_NOT_FOUND_OR_EXPIRED" } });
  }
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=1800");
  return res.sendFile(filePath);
});

app.post("/generateFilteredImage", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const data = body.data && typeof body.data === "object" ? body.data : body;
    const rawImage = data.image_url || data.imageUrl || data.image_base64 || data.imageBase64 || "";

    const shotBuf = await decodeImageInput(rawImage);
    const filterId = String(data.filter_id || data.filterId || data.frame_id || "");
    const slotCount = getSlotCount(filterId);

    const key = getSessionKey(req, data);
    let sess = sessions.get(key);
    if (!sess || !Array.isArray(sess.shots) || sess.shots.length >= slotCount) {
      sess = { shots: [], updatedAt: Date.now() };
      sessions.set(key, sess);
    }

    sess.shots.push(shotBuf);
    sess.updatedAt = Date.now();

    const frameUrl = await getFrameUrlById(filterId);
    const frameOverlayBuf = await loadFrameOverlayBuffer(frameUrl, 1080);
    const outBuf = await renderFinalImage(sess.shots, filterId, frameOverlayBuf);

    if (sess.shots.length >= slotCount) {
      sessions.delete(key);
    }

    const fileName = `${crypto.randomUUID()}.jpg`;
    fs.writeFileSync(path.join(OUT_DIR, fileName), outBuf);

    const baseUrl = getBaseUrl(req);
    const outputUrl = `${baseUrl}/out/${fileName}`;

    return res.status(200).json({
      result: {
        data: {
          output_url: outputUrl
        }
      }
    });
  } catch (err) {
    return res.status(502).json({
      error: {
        status: "FILTER_BACKEND_ERROR",
        message: err && err.message ? String(err.message) : "PROCESS_FAILED"
      }
    });
  }
});

app.post("/generateCaption", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const data = body.data && typeof body.data === "object" ? body.data : body;
  const captionText =
    typeof data.prompt === "string" && data.prompt.trim()
      ? data.prompt.trim()
      : typeof data.caption === "string" && data.caption.trim()
      ? data.caption.trim()
      : "Chụp một tấm thật chill ✨";

  return res.status(200).json({
    result: {
      caption: captionText
    }
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: { message: "NOT_FOUND" } });
});

app.use((err, _req, res, _next) => {
  res.status(500).json({
    error: {
      status: "INTERNAL_SERVER_ERROR",
      message: err && err.message ? String(err.message) : "UNEXPECTED_ERROR"
    }
  });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Locket PhotoBooth Worker listening on port ${port}`);
});
