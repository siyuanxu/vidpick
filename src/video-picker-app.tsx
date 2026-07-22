"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent,
} from "react";

type Mode = "organize" | "shuffle";
type Screen = "setup" | "loading" | "player" | "review" | "complete";
type Decision = "keep" | "delete" | "favorite";

type Folder = {
  name: string;
  path: string;
};

type Video = {
  id: string;
  name: string;
  path: string;
  size: number;
  modified: string;
};

type DeleteResult = {
  path: string;
  ok: boolean;
  message?: string;
};

type ActiveSession = {
  mode: Mode;
  folder: string;
  recursive: boolean;
  videos: Video[];
  index: number;
  screen: "player" | "review";
  updatedAt: string;
};

type SyncedState = {
  version: 1;
  decisions: Record<string, Decision>;
  likes: Record<string, "favorite">;
  activeSession: ActiveSession | null;
};

type ScreenWakeLockSentinel = EventTarget & {
  released: boolean;
  release: () => Promise<void>;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<ScreenWakeLockSentinel>;
  };
};

const ROOT_PATH = "/";
const PREFETCH_COUNT = 2;

function basename(path: string) {
  return path.split("/").filter(Boolean).at(-1) || "根目录";
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(value: string) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatPlaybackTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function mediaUrl(path: string) {
  return `/api/media?path=${encodeURIComponent(path)}`;
}

function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob(["\ufeff", content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

type ApiOptions = {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
};

function apiJson<T>(path: string, options: ApiOptions = {}) {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const method = options.method || "GET";
    try {
      request.open(method, path, true);
    } catch {
      reject(new Error("浏览器无法创建接口请求，请刷新页面后重试"));
      return;
    }
    request.withCredentials = true;
    request.timeout = 30_000;
    request.setRequestHeader("Accept", "application/json");
    if (options.body !== undefined) {
      request.setRequestHeader("Content-Type", "application/json");
    }
    request.onload = () => {
      let payload: unknown;
      try {
        payload = JSON.parse(request.responseText || "{}");
      } catch {
        reject(new Error(`服务器返回了无法识别的内容（HTTP ${request.status}）`));
        return;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(payload as T);
        return;
      }
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? String(payload.error)
          : `请求失败（HTTP ${request.status}）`;
      reject(new Error(message));
    };
    request.onerror = () => reject(new Error("网络连接失败，请稍后重试"));
    request.ontimeout = () => reject(new Error("请求超时，请稍后重试"));
    request.send(
      options.body === undefined ? null : JSON.stringify(options.body),
    );
  });
}

export function VideoPickerApp() {
  const [screen, setScreen] = useState<Screen>("setup");
  const [mode, setMode] = useState<Mode>("organize");
  const [recursive, setRecursive] = useState(false);
  const [currentFolder, setCurrentFolder] = useState(ROOT_PATH);
  const [selectedFolder, setSelectedFolder] = useState(ROOT_PATH);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderLoading, setFolderLoading] = useState(true);
  const [folderError, setFolderError] = useState("");
  const [videos, setVideos] = useState<Video[]>([]);
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [likes, setLikes] = useState<Record<string, "favorite">>({});
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [contain, setContain] = useState(false);
  const [playerError, setPlayerError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleteResults, setDeleteResults] = useState<DeleteResult[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [stateReady, setStateReady] = useState(false);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const touchStartY = useRef<number | null>(null);
  const pointerStartY = useRef<number | null>(null);
  const wheelLockedUntil = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bufferedVideoRefs = useRef(new Map<string, HTMLVideoElement>());
  const seekRef = useRef<HTMLInputElement | null>(null);
  const timeLabelRef = useRef<HTMLSpanElement | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncFailureShown = useRef(false);
  const wakeLockRef = useRef<ScreenWakeLockSentinel | null>(null);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 2200);
  }, []);

  useEffect(() => {
    let disposed = false;

    const releaseWakeLock = async () => {
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      if (sentinel && !sentinel.released) {
        await sentinel.release().catch(() => undefined);
      }
    };

    const syncWakeLock = async () => {
      const shouldStayAwake =
        screen === "player" &&
        playing &&
        document.visibilityState === "visible";

      if (!shouldStayAwake) {
        await releaseWakeLock();
        return;
      }

      if (wakeLockRef.current && !wakeLockRef.current.released) return;
      const wakeLock = (navigator as WakeLockNavigator).wakeLock;
      if (!wakeLock) return;

      try {
        const sentinel = await wakeLock.request("screen");
        if (disposed || document.visibilityState !== "visible") {
          await sentinel.release().catch(() => undefined);
          return;
        }
        wakeLockRef.current = sentinel;
        sentinel.addEventListener(
          "release",
          () => {
            if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
          },
          { once: true },
        );
      } catch {
        // Unsupported or denied wake locks must never interrupt playback.
      }
    };

    const handleVisibilityChange = () => void syncWakeLock();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void syncWakeLock();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void releaseWakeLock();
    };
  }, [playing, screen]);

  const loadFolders = useCallback(async (path: string) => {
    setFolderLoading(true);
    setFolderError("");
    try {
      const payload = await apiJson<{ folders: Folder[]; path: string }>(
        "/api/openlist",
        {
          method: "POST",
          body: { action: "folders", path },
        },
      );
      setFolders(payload.folders);
      setCurrentFolder(payload.path);
    } catch (error) {
      setFolders([]);
      setFolderError(
        error instanceof Error ? error.message : "无法读取视频索引",
      );
    } finally {
      setFolderLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFolders(ROOT_PATH);
    void apiJson<SyncedState>("/api/state")
      .then((payload) => {
        setDecisions(payload.decisions || {});
        setLikes(payload.likes || {});
        setActiveSession(payload.activeSession || null);
      })
      .catch((error) => {
        showNotice(error instanceof Error ? error.message : "同步状态暂不可用");
      })
      .finally(() => setStateReady(true));
  }, [loadFolders, showNotice]);

  useEffect(() => {
    if (!stateReady) return;
    const timer = setTimeout(() => {
      void apiJson<SyncedState>("/api/state", {
        method: "PUT",
        body: {
          version: 1,
          decisions,
          likes,
          activeSession,
        } satisfies SyncedState,
      })
        .then(() => {
          syncFailureShown.current = false;
        })
        .catch(() => {
          if (!syncFailureShown.current) {
            syncFailureShown.current = true;
            showNotice("同步暂时失败，稍后会再次保存");
          }
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [activeSession, decisions, likes, showNotice, stateReady]);

  useEffect(() => {
    if (
      !stateReady ||
      !videos.length ||
      (screen !== "player" && screen !== "review")
    ) {
      return;
    }
    setActiveSession({
      mode,
      folder: selectedFolder,
      recursive,
      videos,
      index,
      screen,
      updatedAt: new Date().toISOString(),
    });
  }, [
    index,
    mode,
    recursive,
    screen,
    selectedFolder,
    stateReady,
    videos,
  ]);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const currentVideo = videos[index];

  useEffect(() => {
    setPlaying(false);
    if (seekRef.current) {
      seekRef.current.value = "0";
      seekRef.current.max = "0.1";
      seekRef.current.style.setProperty("--seek-progress", "0%");
    }
    if (timeLabelRef.current) timeLabelRef.current.textContent = "0:00 / 0:00";
  }, [currentVideo?.path]);
  const nextVideos = useMemo(
    () => {
      const seen = new Set<string>();
      return Array.from({ length: PREFETCH_COUNT }, (_, offset) => {
        if (!videos.length) return undefined;
        const candidateIndex =
          mode === "shuffle"
            ? (index + offset + 1) % videos.length
            : index + offset + 1;
        return videos[candidateIndex];
      }).filter((video): video is Video => {
        if (
          !video ||
          video.path === currentVideo?.path ||
          seen.has(video.path)
        ) {
          return false;
        }
        seen.add(video.path);
        return true;
      });
    },
    [currentVideo?.path, index, mode, videos],
  );
  const bufferedVideos = useMemo(
    () => (currentVideo ? [currentVideo, ...nextVideos] : nextVideos),
    [currentVideo, nextVideos],
  );

  useEffect(() => {
    if (screen !== "player" || !currentVideo) return;
    const player = bufferedVideoRefs.current.get(currentVideo.path);
    if (!player) return;
    videoRef.current = player;
    void player.play().catch(() => undefined);
  }, [currentVideo, screen]);

  useEffect(() => {
    for (const video of nextVideos) {
      const player = bufferedVideoRefs.current.get(video.path);
      if (player && player.readyState === HTMLMediaElement.HAVE_NOTHING) {
        player.load();
      }
    }
  }, [nextVideos]);

  const deleteQueue = useMemo(
    () => videos.filter((video) => decisions[video.path] === "delete"),
    [decisions, videos],
  );
  const favoriteCount = useMemo(
    () =>
      videos.filter(
        (video) =>
          decisions[video.path] === "favorite" || likes[video.path] === "favorite",
      ).length,
    [decisions, likes, videos],
  );
  const decidedCount = useMemo(
    () => videos.filter((video) => Boolean(decisions[video.path])).length,
    [decisions, videos],
  );
  const deleteBytes = useMemo(
    () => deleteQueue.reduce((sum, video) => sum + video.size, 0),
    [deleteQueue],
  );

  async function start() {
    setScreen("loading");
    setPlayerError("");
    setDeleteResults([]);
    try {
      const payload = await apiJson<{ videos: Video[] }>("/api/openlist", {
        method: "POST",
        body: {
          action: "scan",
          path: selectedFolder,
          recursive,
        },
      });
      if (!payload.videos.length) {
        throw new Error("这个目录里没有找到浏览器可尝试播放的视频文件");
      }
      setVideos(payload.videos);
      setIndex(0);
      setScreen("player");
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : "扫描视频失败");
      setScreen("setup");
    }
  }

  function resumeSession() {
    if (!activeSession?.videos.length) return;
    setMode(activeSession.mode);
    setSelectedFolder(activeSession.folder);
    setCurrentFolder(activeSession.folder);
    setRecursive(activeSession.recursive);
    setVideos(activeSession.videos);
    setIndex(
      Math.min(activeSession.index, Math.max(activeSession.videos.length - 1, 0)),
    );
    setScreen(activeSession.screen);
  }

  const goNext = useCallback(() => {
    setPlayerError("");
    if (!videos.length) return;
    if (index < videos.length - 1) {
      setIndex((value) => value + 1);
      return;
    }
    if (mode === "organize") {
      setScreen("review");
      return;
    }
    setVideos((items) => [...items].sort(() => Math.random() - 0.5));
    setIndex(0);
    showNotice("已重新随机排序");
  }, [index, mode, showNotice, videos.length]);

  const goPrevious = useCallback(() => {
    setPlayerError("");
    if (!videos.length) return;
    setIndex((value) =>
      value > 0 ? value - 1 : mode === "shuffle" ? videos.length - 1 : 0,
    );
  }, [mode, videos.length]);

  const choose = useCallback((decision: Decision) => {
    if (!currentVideo) return;
    setDecisions((current) => ({
      ...current,
      [currentVideo.path]: decision,
    }));
    if (decision === "favorite") {
      setLikes((current) => ({
        ...current,
        [currentVideo.path]: "favorite",
      }));
    }
    showNotice(
      decision === "delete"
        ? "已加入待删除"
        : decision === "favorite"
          ? "已加入喜欢"
          : "已保留",
    );
    goNext();
  }, [currentVideo, goNext, showNotice]);

  const toggleLike = useCallback(() => {
    if (!currentVideo) return;
    setLikes((current) => {
      const next = { ...current };
      if (next[currentVideo.path]) {
        delete next[currentVideo.path];
        showNotice("已取消喜欢");
      } else {
        next[currentVideo.path] = "favorite";
        showNotice("已加入喜欢");
      }
      return next;
    });
  }, [currentVideo, showNotice]);

  const togglePlayback = useCallback(() => {
    const player = videoRef.current;
    if (!player) return;
    if (player.paused) void player.play();
    else player.pause();
  }, []);

  const updatePlaybackProgress = useCallback((player: HTMLVideoElement) => {
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    const currentTime = Number.isFinite(player.currentTime)
      ? player.currentTime
      : 0;
    if (seekRef.current) {
      seekRef.current.max = String(duration > 0 ? duration : 0.1);
      seekRef.current.value = String(Math.min(currentTime, duration || 0));
      seekRef.current.style.setProperty(
        "--seek-progress",
        `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
      );
    }
    if (timeLabelRef.current) {
      timeLabelRef.current.textContent = `${formatPlaybackTime(currentTime)} / ${formatPlaybackTime(duration)}`;
    }
  }, []);

  function handleTouchStart(event: TouchEvent) {
    if ((event.target as HTMLElement).closest("button, input")) return;
    touchStartY.current = event.touches[0]?.clientY ?? null;
  }

  function handleTouchEnd(event: TouchEvent) {
    if (touchStartY.current === null) return;
    const endY = event.changedTouches[0]?.clientY ?? touchStartY.current;
    const distance = touchStartY.current - endY;
    touchStartY.current = null;
    if (Math.abs(distance) < 54) return;
    if (distance > 0) goNext();
    else goPrevious();
  }

  function handlePointerDown(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType !== "mouse") return;
    if ((event.target as HTMLElement).closest("button, input")) return;
    pointerStartY.current = event.clientY;
  }

  function handlePointerUp(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType !== "mouse" || pointerStartY.current === null) return;
    const distance = pointerStartY.current - event.clientY;
    pointerStartY.current = null;
    if (Math.abs(distance) < 70) return;
    if (distance > 0) goNext();
    else goPrevious();
  }

  function handleWheel(event: React.WheelEvent<HTMLElement>) {
    if (Math.abs(event.deltaY) < 24 || Date.now() < wheelLockedUntil.current) {
      return;
    }
    wheelLockedUntil.current = Date.now() + 520;
    if (event.deltaY > 0) goNext();
    else goPrevious();
  }

  useEffect(() => {
    if (screen !== "player") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        goNext();
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        goPrevious();
      } else if (event.key === " ") {
        event.preventDefault();
        const player = videoRef.current;
        if (!player) return;
        if (player.paused) void player.play();
        else player.pause();
      } else if (event.key.toLowerCase() === "m") {
        setMuted((value) => !value);
      } else if (event.key.toLowerCase() === "f") {
        if (mode === "organize") choose("favorite");
        else toggleLike();
      } else if (mode === "organize" && event.key.toLowerCase() === "k") {
        choose("keep");
      } else if (mode === "organize" && event.key.toLowerCase() === "d") {
        choose("delete");
      } else if (mode === "organize" && event.key.toLowerCase() === "r") {
        setScreen("review");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [choose, goNext, goPrevious, mode, screen, toggleLike]);

  function exportQueue(format: "csv" | "txt" | "json") {
    const date = new Date().toISOString().slice(0, 10);
    const base = `待删除视频-${basename(selectedFolder)}-${date}`;
    if (format === "json") {
      downloadText(
        `${base}.json`,
        JSON.stringify(
          {
            folder: selectedFolder,
            recursive,
            exportedAt: new Date().toISOString(),
            totalBytes: deleteBytes,
            videos: deleteQueue,
          },
          null,
          2,
        ),
        "application/json;charset=utf-8",
      );
      return;
    }
    if (format === "txt") {
      downloadText(
        `${base}.txt`,
        deleteQueue.map((video) => video.path).join("\n"),
        "text/plain;charset=utf-8",
      );
      return;
    }
    const rows = [
      ["文件名", "完整路径", "大小（字节）", "修改时间"],
      ...deleteQueue.map((video) => [
        video.name,
        video.path,
        video.size,
        video.modified,
      ]),
    ];
    downloadText(
      `${base}.csv`,
      rows.map((row) => row.map(csvCell).join(",")).join("\n"),
      "text/csv;charset=utf-8",
    );
  }

  async function confirmDelete() {
    if (!deleteQueue.length) return;
    setDeleting(true);
    try {
      const payload = await apiJson<{ results: DeleteResult[] }>(
        "/api/openlist",
        {
          method: "POST",
          body: {
            action: "delete",
            root: selectedFolder,
            paths: deleteQueue.map((video) => video.path),
          },
        },
      );
      const results: DeleteResult[] = payload.results || [];
      setDeleteResults(results);
      const deleted = new Set(
        results.filter((result) => result.ok).map((result) => result.path),
      );
      setVideos((items) => items.filter((video) => !deleted.has(video.path)));
      setDecisions((current) => {
        const next = { ...current };
        for (const path of deleted) delete next[path];
        return next;
      });
      setConfirmingDelete(false);
      if (results.every((result) => result.ok)) {
        setActiveSession(null);
        setScreen("complete");
      }
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }

  if (screen === "setup" || screen === "loading") {
    const pathParts = currentFolder.split("/").filter(Boolean);
    return (
      <main className="setup-page">
        <div className="ambient ambient-one" />
        <div className="ambient ambient-two" />
        <section className="setup-shell">
          <header className="brand-row">
            <div className="brand-mark">▶</div>
            <div>
              <p className="eyebrow">OPENLIST VIDEO FLOW</p>
              <h1>视频快刷</h1>
            </div>
          </header>

          <div className="mode-grid" aria-label="选择使用模式">
            <button
              className={`mode-card ${mode === "organize" ? "selected" : ""}`}
              onClick={() => setMode("organize")}
            >
              <span className="mode-icon coral">✓</span>
              <span>
                <strong>整理模式</strong>
                <small>刷完复核，确认后删除</small>
              </span>
              <span className="radio-dot" />
            </button>
            <button
              className={`mode-card ${mode === "shuffle" ? "selected" : ""}`}
              onClick={() => setMode("shuffle")}
            >
              <span className="mode-icon violet">∞</span>
              <span>
                <strong>随机播放</strong>
                <small>只看视频，持续随机播放</small>
              </span>
              <span className="radio-dot" />
            </button>
          </div>

          {activeSession?.videos.length ? (
            <button className="resume-card" onClick={resumeSession}>
              <span>
                <small>跨设备续播</small>
                <strong>{basename(activeSession.folder)}</strong>
                <em>
                  {activeSession.mode === "organize" ? "整理模式" : "随机播放"} ·{" "}
                  {activeSession.index + 1}/{activeSession.videos.length}
                </em>
              </span>
              <b>继续 ›</b>
            </button>
          ) : null}

          <section className="folder-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">视频来源</p>
                <h2>选择一个目录</h2>
              </div>
              <button
                className="select-current"
                onClick={() => setSelectedFolder(currentFolder)}
                disabled={selectedFolder === currentFolder}
              >
                {selectedFolder === currentFolder ? "已选择" : "选择这里"}
              </button>
            </div>

            <nav className="breadcrumbs" aria-label="目录路径">
              <button onClick={() => loadFolders("/")}>根目录</button>
              {pathParts.map((part, partIndex) => {
                const path = `/${pathParts.slice(0, partIndex + 1).join("/")}`;
                return (
                  <span key={path}>
                    <i>/</i>
                    <button onClick={() => loadFolders(path)}>{part}</button>
                  </span>
                );
              })}
            </nav>

            <div className="folder-list">
              {folderLoading ? (
                <div className="folder-state">正在读取目录…</div>
              ) : folderError ? (
                <div className="folder-state error">
                  <strong>暂时无法读取视频索引</strong>
                  <span>{folderError}</span>
                  <button onClick={() => loadFolders(currentFolder)}>
                    重新连接
                  </button>
                </div>
              ) : folders.length ? (
                folders.map((folder) => (
                  <button
                    className="folder-row"
                    key={folder.path}
                    onClick={() => loadFolders(folder.path)}
                  >
                    <span className="folder-glyph">⌑</span>
                    <span>{folder.name}</span>
                    <span className="chevron">›</span>
                  </button>
                ))
              ) : (
                <div className="folder-state">这里没有子目录</div>
              )}
            </div>

            <div className="selected-path">
              <span>已选目录</span>
              <strong>{selectedFolder}</strong>
            </div>

            <label className="toggle-row">
              <span>
                <strong>包含子目录</strong>
                <small>递归寻找所有视频文件</small>
              </span>
              <input
                type="checkbox"
                checked={recursive}
                onChange={(event) => setRecursive(event.target.checked)}
              />
              <i aria-hidden="true" />
            </label>
          </section>

          <button
            className="start-button"
            onClick={start}
            disabled={screen === "loading" || Boolean(folderError)}
          >
            {screen === "loading" ? (
              "正在生成随机播放列表…"
            ) : (
              <>
                <span>随机生成播放列表</span>
                <b>开始刷</b>
              </>
            )}
          </button>
          <p className="privacy-note">
            视频直接从 OpenList 播放 · 不转码 · 提前预加载后两条
          </p>
        </section>
      </main>
    );
  }

  if (screen === "review" || screen === "complete") {
    const failedResults = deleteResults.filter((result) => !result.ok);
    return (
      <main className="review-page">
        <header className="review-header">
          <button
            className="icon-button"
            onClick={() => {
              setScreen("player");
              setIndex(Math.min(index, Math.max(videos.length - 1, 0)));
            }}
            aria-label="返回播放"
          >
            ‹
          </button>
          <div>
            <p className="eyebrow">本次整理</p>
            <h1>{screen === "complete" ? "删除完成" : "确认整理结果"}</h1>
          </div>
          <span className="review-progress">
            {decidedCount}/{videos.length}
          </span>
        </header>

        <section className="summary-grid">
          <article className="summary-card danger">
            <span>待删除</span>
            <strong>{deleteQueue.length}</strong>
            <small>{formatBytes(deleteBytes)}</small>
          </article>
          <article className="summary-card">
            <span>已保留</span>
            <strong>
              {
                videos.filter((video) => decisions[video.path] === "keep")
                  .length
              }
            </strong>
            <small>不会更改源文件</small>
          </article>
          <article className="summary-card favorite">
            <span>喜欢</span>
            <strong>{favoriteCount}</strong>
            <small>保存在喜欢列表</small>
          </article>
        </section>

        {failedResults.length > 0 && (
          <div className="result-alert">
            有 {failedResults.length} 个文件未能删除，已保留在清单中。
          </div>
        )}

        <section className="review-list-section">
          <div className="section-title">
            <div>
              <p className="eyebrow">DELETE QUEUE</p>
              <h2>待删除视频</h2>
            </div>
            <div className="export-menu">
              <button onClick={() => exportQueue("csv")}>导出 CSV</button>
              <button onClick={() => exportQueue("txt")}>TXT</button>
              <button onClick={() => exportQueue("json")}>JSON</button>
            </div>
          </div>

          <div className="review-list">
            {deleteQueue.length ? (
              deleteQueue.map((video) => (
                <article className="review-item" key={video.path}>
                  <video
                    src={mediaUrl(video.path)}
                    preload="metadata"
                    muted
                    playsInline
                  />
                  <div>
                    <strong>{video.name}</strong>
                    <span>{video.path}</span>
                    <small>
                      {formatBytes(video.size)} · {formatDate(video.modified)}
                    </small>
                  </div>
                  <button
                    onClick={() =>
                      setDecisions((current) => ({
                        ...current,
                        [video.path]: "keep",
                      }))
                    }
                  >
                    撤销
                  </button>
                </article>
              ))
            ) : (
              <div className="empty-review">
                <span>✓</span>
                <strong>没有待删除的视频</strong>
                <p>可以继续筛选，或者直接结束本次整理。</p>
              </div>
            )}
          </div>
        </section>

        <footer className="review-actions">
          <button className="secondary-button" onClick={() => setScreen("player")}>
            继续筛选
          </button>
          <button
            className="delete-button"
            disabled={!deleteQueue.length || screen === "complete"}
            onClick={() => setConfirmingDelete(true)}
          >
            确认删除 {deleteQueue.length ? `${deleteQueue.length} 条` : ""}
          </button>
        </footer>

        {confirmingDelete && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="confirm-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
            >
              <div className="warning-mark">!</div>
              <h2 id="confirm-title">确认从 OpenList 删除？</h2>
              <p>
                即将删除 <strong>{deleteQueue.length}</strong> 个视频，共{" "}
                <strong>{formatBytes(deleteBytes)}</strong>。该操作会直接作用于
                OpenList 后端存储。
              </p>
              <div className="confirm-path">{selectedFolder}</div>
              <button
                className="delete-button"
                onClick={confirmDelete}
                disabled={deleting}
              >
                {deleting ? "正在逐项核对并删除…" : "我已核对，确认删除"}
              </button>
              <button
                className="text-button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
              >
                取消，返回检查
              </button>
            </section>
          </div>
        )}
      </main>
    );
  }

  if (!currentVideo) return null;

  const currentDecision = decisions[currentVideo.path];
  const isLiked = likes[currentVideo.path] === "favorite";
  return (
    <main
      className="player-page"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
    >
      <header className="player-topbar">
        <button
          className="glass-button"
          onClick={() =>
            mode === "organize" ? setScreen("review") : setScreen("setup")
          }
        >
          {mode === "organize" ? "暂停整理" : "退出播放"}
        </button>
        <div className="mode-pill">
          <span className={mode === "organize" ? "live coral-dot" : "live"} />
          {mode === "organize" ? "整理模式" : "随机播放"}
        </div>
        <button
          className="round-glass"
          onClick={() => setContain((value) => !value)}
          aria-label="切换画面比例"
        >
          {contain ? "填" : "全"}
        </button>
      </header>

      {bufferedVideos.map((video) => {
        const isCurrent = video.path === currentVideo.path;
        return (
          <video
            className={
              isCurrent
                ? `main-video ${contain ? "contain" : ""}`
                : "preload-video"
            }
            ref={(element) => {
              if (element) {
                bufferedVideoRefs.current.set(video.path, element);
                if (isCurrent) videoRef.current = element;
              } else {
                bufferedVideoRefs.current.delete(video.path);
              }
            }}
            key={video.path}
            src={mediaUrl(video.path)}
            preload="auto"
            autoPlay={isCurrent}
            muted={isCurrent ? muted : true}
            playsInline
            loop={isCurrent}
            aria-hidden={isCurrent ? undefined : true}
            onClick={isCurrent ? togglePlayback : undefined}
            onCanPlay={isCurrent ? () => setPlayerError("") : undefined}
            onLoadedMetadata={
              isCurrent
                ? (event) => updatePlaybackProgress(event.currentTarget)
                : undefined
            }
            onDurationChange={
              isCurrent
                ? (event) => updatePlaybackProgress(event.currentTarget)
                : undefined
            }
            onTimeUpdate={
              isCurrent
                ? (event) => updatePlaybackProgress(event.currentTarget)
                : undefined
            }
            onPlay={isCurrent ? () => setPlaying(true) : undefined}
            onPause={isCurrent ? () => setPlaying(false) : undefined}
            onError={
              isCurrent
                ? () =>
                    setPlayerError(
                      "当前格式或编码可能不受这个浏览器支持",
                    )
                : undefined
            }
          />
        );
      })}

      <div className="video-shade top" />
      <div className="video-shade bottom" />

      {playerError && (
        <div className="player-error">
          <strong>无法播放</strong>
          <span>{playerError}</span>
          <button onClick={goNext}>跳到下一条</button>
        </div>
      )}

      <aside className="side-actions">
        <button
          className={isLiked ? "active favorite-action" : ""}
          onClick={mode === "organize" ? () => choose("favorite") : toggleLike}
          aria-label="喜欢"
        >
          <span>♥</span>
          <small>{isLiked ? "已喜欢" : "喜欢"}</small>
        </button>
        <button onClick={() => setMuted((value) => !value)} aria-label="声音">
          <span>{muted ? "♩" : "♫"}</span>
          <small>{muted ? "静音" : "有声"}</small>
        </button>
        <button onClick={togglePlayback} aria-label={playing ? "暂停" : "播放"}>
          <span>{playing ? "Ⅱ" : "▶"}</span>
          <small>{playing ? "暂停" : "播放"}</small>
        </button>
        <button onClick={goNext} aria-label="下一条">
          <span>↑</span>
          <small>下一条</small>
        </button>
      </aside>

      <section className="video-meta">
        <div className="seek-control">
          <input
            ref={seekRef}
            type="range"
            min="0"
            max="0.1"
            step="0.1"
            defaultValue="0"
            aria-label="视频播放进度"
            style={{ "--seek-progress": "0%" } as React.CSSProperties}
            onChange={(event) => {
              const nextTime = Number(event.currentTarget.value);
              if (videoRef.current) videoRef.current.currentTime = nextTime;
              if (videoRef.current) updatePlaybackProgress(videoRef.current);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            onTouchEnd={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          />
          <span ref={timeLabelRef}>0:00 / 0:00</span>
        </div>
        <p>
          {index + 1} / {videos.length}
          {mode === "organize" && ` · 已决定 ${decidedCount}`}
        </p>
        <h1>{currentVideo.name}</h1>
        <span className="video-path">{currentVideo.path}</span>
        <small>
          {formatBytes(currentVideo.size)} · {formatDate(currentVideo.modified)}
          {currentDecision && ` · 已标记${currentDecision === "delete" ? "待删除" : currentDecision === "favorite" ? "喜欢" : "保留"}`}
        </small>
      </section>

      {mode === "organize" ? (
        <nav className="decision-dock" aria-label="整理操作">
          <button className="keep" onClick={() => choose("keep")}>
            <span>✓</span>
            保留
          </button>
          <button className="delete" onClick={() => choose("delete")}>
            <span>×</span>
            待删除
          </button>
        </nav>
      ) : (
        <div className="shuffle-hint">上滑切换 · 已预加载后两条</div>
      )}

      <div className="desktop-shortcuts" aria-label="电脑端快捷键">
        <span>
          <kbd>↑</kbd><kbd>↓</kbd> 切换
        </span>
        <span>
          <kbd>Space</kbd> 播放/暂停
        </span>
        <span>
          <kbd>F</kbd> 喜欢
        </span>
        {mode === "organize" && (
          <>
            <span>
              <kbd>K</kbd> 保留
            </span>
            <span>
              <kbd>D</kbd> 待删除
            </span>
            <span>
              <kbd>R</kbd> 整理页
            </span>
          </>
        )}
      </div>

      {notice && <div className="toast">{notice}</div>}
    </main>
  );
}
