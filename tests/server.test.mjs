import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVidpickServer, StateStore } from "../server.mjs";

function createMockClient() {
  const removed = [];
  return {
    removed,
    listCalls: 0,
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

async function startServer({ deleteEnabled = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "vidpick-test-"));
  const client = createMockClient();
  const server = createVidpickServer({
    environment: {
      OPENLIST_ROOT: "/",
      OPENLIST_DELETE_ENABLED: String(deleteEnabled),
      PUBLIC_BASE_URL: "http://127.0.0.1",
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
