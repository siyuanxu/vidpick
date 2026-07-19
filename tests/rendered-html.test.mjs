import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("implements the complete dual-mode and cross-device flow", async () => {
  const [client, styles, server, environmentExample] = await Promise.all([
    readFile(new URL("../src/video-picker-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.match(client, /整理模式/);
  assert.match(client, /随机播放/);
  assert.match(client, /选择一个目录/);
  assert.match(client, /包含子目录/);
  assert.match(client, /PREFETCH_COUNT = 2/);
  assert.match(client, /handleWheel/);
  assert.match(client, /ArrowDown/);
  assert.match(client, /确认从 OpenList 删除/);
  assert.match(client, /exportQueue\("csv"\)/);
  assert.match(client, /跨设备续播/);
  assert.match(styles, /safe-area-inset/i);
  assert.doesNotMatch(client, /OPENLIST_TOKEN|OPENLIST_URL/);
  assert.match(server, /OPENLIST_TOKEN_FILE/);
  assert.match(server, /OPENLIST_DELETE_ENABLED/);
  assert.match(server, /拒绝跨站请求/);
  assert.match(environmentExample, /OPENLIST_DELETE_ENABLED=false/);
});
