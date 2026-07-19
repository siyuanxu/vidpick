import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVidpickServer, StateStore } from "../server.mjs";

function createMockClient() {
  const removed = [];
  return {
    removed,
    listCalls: 0,
    requestCalls: 0,
    async list(path) {
      this.listCalls += 1;
      if (path === "/") {
        return [
          { name: "nested", is_dir: true },
          { name: "clip.mp4", is_dir: false, size: 42, modified: "2026-01-01" },
          { name: "cover.jpg", is_dir: false, size: 3, modified: "2026-01-01" },
        ];
      }
      if (path === "/nested") {
        return [
          { name: "movie.webm", is_dir: false, size: 84, modified: "2026-01-02" },
        ];
      }
      return [];
    },
    async request(endpoint, body) {
      this.requestCalls += 1;
      if (endpoint === "/api/fs/get") {
        return {
          name: body.path.split("/").at(-1),
          is_dir: false,
          raw_url: "https://media.example.com/signed-video",
        };
      }
      if (endpoint === "/api/fs/remove") {
        removed.push(body);
        return null;
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
  };
}

async function startServer({ deleteEnabled = false, smartStrm = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "vidpick-test-"));
  const smartStrmRoot = join(directory, "strm");
  if (smartStrm) {
    await mkdir(join(smartStrmRoot, "library", "nested"), { recursive: true });
    await writeFile(
      join(smartStrmRoot, "library", "first.strm"),
      "https://alist.example.com/d/115/media/clip.mp4?sign=private-one\n",
    );
    await writeFile(
      join(smartStrmRoot, "library", "nested", "second.strm"),
      "https://alist.example.com/d/115/archive/movie.webm?sign=private-two\n",
    );
    await writeFile(
      join(smartStrmRoot, "library", "untrusted.strm"),
      "https://untrusted.example/d/115/media/untrusted.mp4?sign=ignored\n",
    );
    await writeFile(
      join(smartStrmRoot, "library", "cover.jpg"),
      "not a video index\n",
    );
  }
  const client = createMockClient();
  const server = createVidpickServer({
    environment: {
      OPENLIST_ROOT: "/",
      OPENLIST_DELETE_ENABLED: String(deleteEnabled),
      PUBLIC_BASE_URL: "http://127.0.0.1",
      ...(smartStrm
        ? {
            SMARTSTRM_ROOT: smartStrmRoot,
            SMARTSTRM_OPENLIST_BASE: "/115",
            SMARTSTRM_ALLOWED_HOST: "alist.example.com",
          }
        : {}),
    },
    openListClient: client,
    stateStore: new StateStore(join(directory, "state.json")),
    distDirectory: new URL("../dist", import.meta.url).pathname,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    client,
    directory,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("stores synchronized state atomically", async () => {
  const app = await startServer();
  try {
    const initial = await fetch(`${app.base}/api/state`).then((response) =>
      response.json(),
    );
    assert.deepEqual(initial, {
      version: 1,
      decisions: {},
      likes: {},
      activeSession: null,
    });

    const state = {
      version: 1,
      decisions: { "/clip.mp4": "delete" },
      likes: { "/clip.mp4": "favorite" },
      activeSession: null,
    };
    const response = await fetch(`${app.base}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), state);
    assert.deepEqual(
      JSON.parse(await readFile(join(app.directory, "state.json"), "utf8")),
      state,
    );
  } finally {
    await app.close();
  }
});

test("recovers the state write queue after a transient filesystem failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vidpick-state-recovery-"));
  const blocker = join(directory, "data");
  const file = join(blocker, "state.json");
  const state = {
    version: 1,
    decisions: {},
    likes: {},
    activeSession: null,
  };
  try {
    await writeFile(blocker, "temporarily unavailable");
    const store = new StateStore(file);
    await assert.rejects(store.write(state));
    await rm(blocker, { force: true });
    await mkdir(blocker);
    assert.deepEqual(await store.write(state), state);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), state);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lists folders, scans recursively, filters images, and redirects media", async () => {
  const app = await startServer();
  try {
    const folders = await fetch(
      `${app.base}/api/openlist?action=folders&path=%2F`,
    ).then((response) => response.json());
    assert.deepEqual(folders.folders, [{ name: "nested", path: "/nested" }]);

    const postedFoldersResponse = await fetch(`${app.base}/api/openlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "folders", path: "/" }),
    });
    assert.equal(postedFoldersResponse.status, 200);
    const postedFolders = await postedFoldersResponse.json();
    assert.deepEqual(postedFolders.folders, [
      { name: "nested", path: "/nested" },
    ]);

    const scanResponse = await fetch(`${app.base}/api/openlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "scan", path: "/", recursive: true }),
    });
    assert.equal(scanResponse.status, 200);
    const scan = await scanResponse.json();
    assert.equal(scan.videos.length, 2);
    assert.deepEqual(
      new Set(scan.videos.map((video) => video.path)),
      new Set(["/clip.mp4", "/nested/movie.webm"]),
    );
    const callsAfterFirstScan = app.client.listCalls;
    const cachedScanResponse = await fetch(`${app.base}/api/openlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "scan", path: "/", recursive: true }),
    });
    assert.equal(cachedScanResponse.status, 200);
    assert.equal((await cachedScanResponse.json()).cached, true);
    assert.equal(app.client.listCalls, callsAfterFirstScan);

    const media = await fetch(`${app.base}/api/media?path=%2Fclip.mp4`, {
      redirect: "manual",
    });
    assert.equal(media.status, 302);
    assert.equal(
      media.headers.get("location"),
      "https://media.example.com/signed-video",
    );

    const image = await fetch(`${app.base}/api/media?path=%2Fcover.jpg`);
    assert.equal(image.status, 403);
  } finally {
    await app.close();
  }
});

test("keeps deletion disabled by default and rejects paths outside the selected root", async () => {
  const disabled = await startServer();
  try {
    const response = await fetch(`${disabled.base}/api/openlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        root: "/",
        paths: ["/clip.mp4"],
      }),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /尚未启用删除功能/);
  } finally {
    await disabled.close();
  }

  const enabled = await startServer({ deleteEnabled: true });
  try {
    const rejected = await fetch(`${enabled.base}/api/openlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        root: "/nested",
        paths: ["/clip.mp4"],
      }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(enabled.client.removed.length, 0);

    const accepted = await fetch(`${enabled.base}/api/openlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        root: "/nested",
        paths: ["/nested/movie.webm"],
      }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(enabled.client.removed, [
      { dir: "/nested", names: ["movie.webm"] },
    ]);
  } finally {
    await enabled.close();
  }
});

test("uses SmartSTRM as the folder index and playback source without scanning OpenList", async () => {
  const app = await startServer({ smartStrm: true });
  try {
    const foldersResponse = await fetch(`${app.base}/api/openlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "folders", path: "/" }),
    });
    assert.equal(foldersResponse.status, 200);
    const folders = await foldersResponse.json();
    assert.deepEqual(folders.folders, [
      { name: "library", path: "/library" },
    ]);

    const scanResponse = await fetch(`${app.base}/api/openlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "scan",
        path: "/library",
        recursive: true,
      }),
    });
    assert.equal(scanResponse.status, 200);
    const scan = await scanResponse.json();
    assert.deepEqual(
      new Set(scan.videos.map((video) => video.path)),
      new Set(["/media/clip.mp4", "/archive/movie.webm"]),
    );
    assert.equal(app.client.listCalls, 0);
    assert.equal(app.client.requestCalls, 0);

    const media = await fetch(
      `${app.base}/api/media?path=%2Fmedia%2Fclip.mp4`,
      { redirect: "manual" },
    );
    assert.equal(media.status, 302);
    assert.equal(
      media.headers.get("location"),
      "https://alist.example.com/d/115/media/clip.mp4?sign=private-one",
    );
    assert.equal(app.client.requestCalls, 0);

    const untrusted = await fetch(
      `${app.base}/api/media?path=%2Fmedia%2Funtrusted.mp4`,
      { redirect: "manual" },
    );
    assert.equal(untrusted.status, 404);
  } finally {
    await app.close();
  }
});

test("maps SmartSTRM selections back to OpenList only after confirmed deletion", async () => {
  const app = await startServer({ deleteEnabled: true, smartStrm: true });
  try {
    const response = await fetch(`${app.base}/api/openlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        root: "/library",
        paths: ["/media/clip.mp4"],
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(app.client.removed, [
      { dir: "/media", names: ["clip.mp4"] },
    ]);

    const media = await fetch(
      `${app.base}/api/media?path=%2Fmedia%2Fclip.mp4`,
      { redirect: "manual" },
    );
    assert.equal(media.status, 404);
  } finally {
    await app.close();
  }
});
