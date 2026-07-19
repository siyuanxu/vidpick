import { createServer } from "node:http";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".flv",
  ".ts",
  ".m2ts",
  ".mts",
  ".mpeg",
  ".mpg",
  ".3gp",
  ".ogv",
]);
const MAX_DIRECTORIES = 800;
const MAX_VIDEOS = 20_000;
const MAX_DELETE_BATCH = 500;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const projectDirectory = dirname(fileURLToPath(import.meta.url));

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function emptyState() {
  return {
    version: 1,
    decisions: {},
    likes: {},
    activeSession: null,
  };
}

function apiError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function normalizePath(value) {
  const source = String(value || "/").normalize("NFC");
  if (source.includes("\0")) throw apiError("路径不合法", 400);
  const parts = source.split("/");
  if (parts.some((part) => part === "..")) throw apiError("路径不合法", 400);
  return `/${parts.filter((part) => part && part !== ".").join("/")}`;
}

export function isInside(root, path) {
  return path === root || path.startsWith(`${root === "/" ? "" : root}/`);
}

function extension(path) {
  const name = path.split("/").at(-1) || "";
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index).toLowerCase();
}

export function isVideo(path) {
  return VIDEO_EXTENSIONS.has(extension(path));
}

function joinOpenListPath(base, name) {
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

function safeRemoteUrl(value) {
  const url = new URL(String(value));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw apiError("OpenList 返回了不安全的地址");
  }
  return url.href;
}

function cleanString(value, maximum = 4096) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function sanitizeVideo(value) {
  if (!value || typeof value !== "object") return null;
  const path = normalizePath(value.path);
  if (!isVideo(path)) return null;
  return {
    id: cleanString(value.id || path),
    name: cleanString(value.name || path.split("/").at(-1) || "video"),
    path,
    size: Math.max(0, Number(value.size) || 0),
    modified: cleanString(value.modified, 128),
  };
}

function sanitizeState(value) {
  if (!value || typeof value !== "object") throw apiError("同步数据不合法", 400);
  const decisions = {};
  for (const [rawPath, decision] of Object.entries(value.decisions || {}).slice(
    0,
    MAX_VIDEOS,
  )) {
    const path = normalizePath(rawPath);
    if (isVideo(path) && ["keep", "delete", "favorite"].includes(decision)) {
      decisions[path] = decision;
    }
  }
  const likes = {};
  for (const [rawPath, like] of Object.entries(value.likes || {}).slice(
    0,
    MAX_VIDEOS,
  )) {
    const path = normalizePath(rawPath);
    if (isVideo(path) && like === "favorite") likes[path] = "favorite";
  }

  let activeSession = null;
  if (value.activeSession && typeof value.activeSession === "object") {
    const videos = Array.isArray(value.activeSession.videos)
      ? value.activeSession.videos
          .slice(0, MAX_VIDEOS)
          .map(sanitizeVideo)
          .filter(Boolean)
      : [];
    if (videos.length) {
      activeSession = {
        mode: value.activeSession.mode === "shuffle" ? "shuffle" : "organize",
        folder: normalizePath(value.activeSession.folder),
        recursive: Boolean(value.activeSession.recursive),
        videos,
        index: Math.min(
          Math.max(0, Number(value.activeSession.index) || 0),
          videos.length - 1,
        ),
        screen: value.activeSession.screen === "review" ? "review" : "player",
        updatedAt: cleanString(value.activeSession.updatedAt, 128),
      };
    }
  }
  return { version: 1, decisions, likes, activeSession };
}

export class StateStore {
  constructor(file) {
    this.file = resolve(file);
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      return sanitizeState(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      if (error?.status) throw error;
      throw apiError("同步状态文件损坏，请检查服务器数据目录", 500);
    }
  }

  async write(value) {
    const state = sanitizeState(value);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.file);
    });
    await this.writeQueue;
    return state;
  }
}

async function readToken(environment) {
  if (environment.OPENLIST_TOKEN?.trim()) return environment.OPENLIST_TOKEN.trim();
  if (!environment.OPENLIST_TOKEN_FILE?.trim()) return "";
  const value = (await readFile(environment.OPENLIST_TOKEN_FILE.trim(), "utf8")).trim();
  const match = value.match(/^(?:OPENLIST_TOKEN=)?(.+)$/m);
  return match?.[1]?.trim() || "";
}

class OpenListClient {
  constructor(environment) {
    this.environment = environment;
    this.baseUrl = String(environment.OPENLIST_URL || "").trim().replace(/\/+$/, "");
  }

  async request(endpoint, body, userAgent = "") {
    const token = await readToken(this.environment);
    if (!this.baseUrl || !token) {
      throw apiError(
        "网站尚未连接 OpenList，请先配置专用的最小权限账号",
        503,
      );
    }
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        ...(userAgent ? { "User-Agent": userAgent.slice(0, 400) } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 200) {
      throw apiError(
        payload?.message || `OpenList 请求失败（HTTP ${response.status}）`,
        response.status === 401 || response.status === 403 ? 502 : response.status,
      );
    }
    return payload.data;
  }

  async list(path, userAgent) {
    const data = await this.request(
      "/api/fs/list",
      { path, password: "", page: 1, per_page: 0, refresh: false },
      userAgent,
    );
    return Array.isArray(data?.content) ? data.content : [];
  }
}

async function scanVideos(client, root, recursive, userAgent) {
  const queue = [root];
  const videos = [];
  let visitedDirectories = 0;
  while (queue.length) {
    if (++visitedDirectories > MAX_DIRECTORIES) {
      throw apiError(`目录过多，单次最多扫描 ${MAX_DIRECTORIES} 个目录`, 413);
    }
    const current = queue.shift();
    const objects = await client.list(current, userAgent);
    for (const object of objects) {
      const path = joinOpenListPath(current, object.name);
      if (object.is_dir) {
        if (recursive) queue.push(path);
      } else if (isVideo(path)) {
        videos.push({
          id: path,
          name: object.name,
          path,
          size: Number(object.size) || 0,
          modified: object.modified || "",
        });
        if (videos.length >= MAX_VIDEOS) {
          throw apiError(`视频过多，单次最多生成 ${MAX_VIDEOS} 条`, 413);
        }
      }
    }
  }
  for (let index = videos.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [videos[index], videos[randomIndex]] = [videos[randomIndex], videos[index]];
  }
  return videos;
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw apiError("请求内容过大", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw apiError("请求内容不是有效 JSON", 400);
  }
}

function assertSameOrigin(request, environment) {
  const origin = request.headers.origin;
  if (!origin) return;
  const expected = environment.PUBLIC_BASE_URL?.trim()
    ? new URL(environment.PUBLIC_BASE_URL).origin
    : `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`;
  if (origin !== expected) throw apiError("拒绝跨站请求", 403);
}

function sendError(response, error) {
  json(response, error?.status || 500, {
    error: error?.message || "服务器处理失败",
  });
}

function configuredRoot(environment) {
  return normalizePath(environment.OPENLIST_ROOT || "/");
}

async function handleOpenList(request, response, url, client, environment) {
  const root = configuredRoot(environment);
  const userAgent = request.headers["user-agent"] || "";
  if (request.method === "GET") {
    if (url.searchParams.get("action") !== "folders") {
      throw apiError("不支持的操作", 400);
    }
    const path = normalizePath(url.searchParams.get("path") || root);
    if (!isInside(root, path)) throw apiError("目录超出允许范围", 403);
    const objects = await client.list(path, userAgent);
    const folders = objects
      .filter((object) => object.is_dir)
      .map((object) => ({
        name: object.name,
        path: joinOpenListPath(path, object.name),
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name, "zh-CN", { numeric: true }),
      );
    return json(response, 200, { path, root, folders });
  }
  if (request.method !== "POST") throw apiError("不支持的请求方法", 405);
  assertSameOrigin(request, environment);
  const body = await readJson(request);

  if (body.action === "scan") {
    const path = normalizePath(body.path || root);
    if (!isInside(root, path)) throw apiError("目录超出允许范围", 403);
    const videos = await scanVideos(client, path, Boolean(body.recursive), userAgent);
    return json(response, 200, {
      path,
      recursive: Boolean(body.recursive),
      videos,
    });
  }

  if (body.action !== "delete") throw apiError("不支持的操作", 400);
  if (String(environment.OPENLIST_DELETE_ENABLED) !== "true") {
    throw apiError("服务器尚未启用删除功能", 403);
  }
  const selectedRoot = normalizePath(body.root || "");
  if (!isInside(root, selectedRoot)) throw apiError("删除目录超出允许范围", 403);
  const paths = [...new Set(Array.isArray(body.paths) ? body.paths : [])].map(
    normalizePath,
  );
  if (!paths.length || paths.length > MAX_DELETE_BATCH) {
    throw apiError(`每次只能删除 1–${MAX_DELETE_BATCH} 个视频`, 400);
  }
  if (
    paths.some(
      (path) =>
        !isInside(selectedRoot, path) || path === selectedRoot || !isVideo(path),
    )
  ) {
    throw apiError("删除清单包含越界目录或非视频文件", 400);
  }

  const verified = [];
  const results = [];
  for (const path of paths) {
    try {
      const item = await client.request(
        "/api/fs/get",
        { path, password: "" },
        userAgent,
      );
      if (item?.is_dir || !isVideo(item?.name || path)) {
        throw apiError("目标不是视频文件", 400);
      }
      verified.push(path);
    } catch (error) {
      results.push({ path, ok: false, message: error.message || "核对失败" });
    }
  }

  const grouped = new Map();
  for (const path of verified) {
    const slash = path.lastIndexOf("/");
    const directory = slash > 0 ? path.slice(0, slash) : "/";
    const name = path.slice(slash + 1);
    grouped.set(directory, [...(grouped.get(directory) || []), name]);
  }
  for (const [directory, names] of grouped) {
    try {
      await client.request("/api/fs/remove", { dir: directory, names }, userAgent);
      results.push(
        ...names.map((name) => ({
          path: joinOpenListPath(directory, name),
          ok: true,
        })),
      );
    } catch (error) {
      results.push(
        ...names.map((name) => ({
          path: joinOpenListPath(directory, name),
          ok: false,
          message: error.message || "删除失败",
        })),
      );
    }
  }
  return json(response, 200, { results });
}

async function handleMedia(request, response, url, client, environment) {
  const path = normalizePath(url.searchParams.get("path"));
  const root = configuredRoot(environment);
  if (!isInside(root, path) || !isVideo(path)) {
    throw apiError("视频路径不在允许范围内", 403);
  }
  const item = await client.request(
    "/api/fs/get",
    { path, password: "" },
    request.headers["user-agent"] || "",
  );
  if (item?.is_dir || !item?.raw_url) {
    throw apiError("OpenList 没有返回可播放地址", 404);
  }
  response.writeHead(302, {
    Location: safeRemoteUrl(item.raw_url),
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  });
  response.end();
}

async function serveStatic(response, pathname, distDirectory) {
  let file = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let candidate = resolve(distDirectory, file);
  if (!isInside(resolve(distDirectory), candidate)) return false;
  try {
    if (!(await stat(candidate)).isFile()) return false;
  } catch {
    file = "index.html";
    candidate = join(distDirectory, file);
  }
  const content = await readFile(candidate);
  const isAsset = pathname.startsWith("/assets/");
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(candidate).toLowerCase()] || "application/octet-stream",
    "Content-Length": content.length,
    "Cache-Control": isAsset
      ? "public, max-age=31536000, immutable"
      : "no-cache, no-store, must-revalidate",
  });
  response.end(content);
  return true;
}

function applySecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' https: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

export function createVidpickServer(options = {}) {
  const environment = options.environment || process.env;
  const distDirectory = resolve(
    options.distDirectory || join(projectDirectory, "dist"),
  );
  const stateStore =
    options.stateStore ||
    new StateStore(environment.DATA_FILE || join(projectDirectory, "data/state.json"));
  const client = options.openListClient || new OpenListClient(environment);

  return createServer(async (request, response) => {
    applySecurityHeaders(response);
    try {
      const url = new URL(
        request.url || "/",
        `http://${request.headers.host || "localhost"}`,
      );
      if (url.pathname === "/healthz") {
        return json(response, 200, { status: "ok" });
      }
      if (url.pathname === "/api/state") {
        if (request.method === "GET") return json(response, 200, await stateStore.read());
        if (request.method !== "PUT") throw apiError("不支持的请求方法", 405);
        assertSameOrigin(request, environment);
        return json(response, 200, await stateStore.write(await readJson(request)));
      }
      if (url.pathname === "/api/openlist") {
        return await handleOpenList(
          request,
          response,
          url,
          client,
          environment,
        );
      }
      if (url.pathname === "/api/media" && request.method === "GET") {
        return await handleMedia(request, response, url, client, environment);
      }
      if (url.pathname.startsWith("/api/")) throw apiError("接口不存在", 404);
      if (!["GET", "HEAD"].includes(request.method || "")) {
        throw apiError("不支持的请求方法", 405);
      }
      if (!(await serveStatic(response, url.pathname, distDirectory))) {
        throw apiError("页面不存在", 404);
      }
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.end();
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT) || 3000;
  createVidpickServer().listen(port, host, () => {
    console.log(`Vidpick listening on http://${host}:${port}`);
  });
}
