const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Point the server at a throwaway data directory before it loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wheel-test-"));
process.env.DATA_DIR = dataDir;
delete process.env.DATA_FILE;
const { createServer, dataFile } = require("../server.js");

let server;
let baseUrl;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function request(pathname, { method = "GET", body, rawBody } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: rawBody ?? (body ? JSON.stringify(body) : undefined)
  });
}

async function json(pathname, options) {
  const response = await request(pathname, options);
  return { status: response.status, body: await response.json() };
}

function readDataFile() {
  return JSON.parse(fs.readFileSync(dataFile, "utf8"));
}

describe("static files", () => {
  test("serves the public app files", async () => {
    for (const pathname of ["/", "/app.js", "/wheel-core.js", "/styles.css", "/assets/fx-logo.svg"]) {
      const response = await request(pathname);
      assert.equal(response.status, 200, pathname);
    }
  });

  test("serves JavaScript modules with a JavaScript MIME type", async () => {
    const response = await request("/wheel-core.js");
    assert.match(response.headers.get("content-type"), /^text\/javascript/);
  });

  test("refuses source, git metadata, and stored data", async () => {
    for (const pathname of ["/server.js", "/package.json", "/.git/config", "/data/wheels.json", "/test/server.test.js", "/../secret"]) {
      const response = await request(pathname);
      assert.equal(response.status, 403, pathname);
    }
  });

  test("rejects malformed URLs", async () => {
    const response = await request("/%E0%A4%A");
    assert.equal(response.status, 400);
  });
});

describe("wheel API", () => {
  test("viewing a new wheel returns defaults without writing to disk", async () => {
    const { status, body } = await json("/api/wheels/readonly1");
    assert.equal(status, 200);
    assert.deepEqual(body, {
      title: "Wheel of Names",
      centerImage: "",
      names: [],
      lastWinner: "",
      lastWinnerId: "",
      lastWinnerAt: 0
    });
    assert.equal(fs.existsSync(dataFile), false);
  });

  test("rejects invalid wheel IDs and unknown routes", async () => {
    assert.equal((await request("/api/wheels/abc")).status, 400);
    assert.equal((await request("/api/wheels/valid123/nope")).status, 404);
    assert.equal((await request("/api/other")).status, 404);
  });

  test("adds names, normalizing and persisting them", async () => {
    const { status, body } = await json("/api/wheels/names123/names", {
      method: "POST",
      body: { text: `  Ada   ${"x".repeat(100)}` }
    });
    assert.equal(status, 201);
    assert.equal(body.names.length, 1);
    assert.equal(body.names[0].text.length, 80);
    assert.match(body.names[0].text, /^Ada x/);

    const saved = readDataFile().wheels.names123;
    assert.equal(saved.names[0].text, body.names[0].text);
    assert.equal(fs.existsSync(`${dataFile}.tmp`), false, "temp file should be renamed into place");
  });

  test("rejects empty names, bad JSON, and oversized bodies", async () => {
    assert.equal((await request("/api/wheels/names123/names", { method: "POST", body: { text: "   " } })).status, 400);
    assert.equal((await request("/api/wheels/names123/names", { method: "POST", rawBody: "{bad" })).status, 400);
    const huge = await request("/api/wheels/names123/names", {
      method: "POST",
      rawBody: JSON.stringify({ text: "z".repeat(800000) })
    }).catch(() => null);
    // The server may reset the socket after replying 413; either outcome means it refused.
    assert.ok(!huge || huge.status === 413, `unexpected status ${huge?.status}`);
  });

  test("removes names by ID", async () => {
    const added = await json("/api/wheels/remove12/names", { method: "POST", body: { text: "Grace" } });
    const nameId = added.body.names[0].id;
    const { status, body } = await json(`/api/wheels/remove12/names/${nameId}`, { method: "DELETE" });
    assert.equal(status, 200);
    assert.deepEqual(body.names, []);
  });

  test("records the last winner, linking the ID only if the name exists", async () => {
    const added = await json("/api/wheels/winner12/names", { method: "POST", body: { text: "Linus" } });
    const nameId = added.body.names[0].id;

    const known = await json("/api/wheels/winner12/last-winner", { method: "PUT", body: { text: "Linus", nameId } });
    assert.equal(known.body.lastWinner, "Linus");
    assert.equal(known.body.lastWinnerId, nameId);
    assert.ok(known.body.lastWinnerAt > 0);

    const unknown = await json("/api/wheels/winner12/last-winner", { method: "PUT", body: { text: "Ghost", nameId: "missing" } });
    assert.equal(unknown.body.lastWinnerId, "");
  });

  test("updates the title, falling back to the default when blank", async () => {
    const renamed = await json("/api/wheels/title123/title", { method: "PUT", body: { title: "  Friday   lunch " } });
    assert.equal(renamed.body.title, "Friday lunch");
    const blank = await json("/api/wheels/title123/title", { method: "PUT", body: { title: "   " } });
    assert.equal(blank.body.title, "Wheel of Names");
  });

  test("accepts palette colours and images, and drops anything else", async () => {
    const colour = await json("/api/wheels/centre12/center-image", { method: "PUT", body: { centerImage: "color:#7a4fb3" } });
    assert.equal(colour.body.centerImage, "color:#7a4fb3");

    const image = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    const uploaded = await json("/api/wheels/centre12/center-image", { method: "PUT", body: { centerImage: image } });
    assert.equal(uploaded.body.centerImage, image);

    const bad = await json("/api/wheels/centre12/center-image", { method: "PUT", body: { centerImage: "javascript:alert(1)" } });
    assert.equal(bad.body.centerImage, "");
  });
});

describe("live updates", () => {
  test("streams the current wheel, then pushes changes to subscribers", async () => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/wheels/stream12/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Reads Server-Sent Events until one matches, so heartbeats and chunking don't matter.
    async function nextEvent(predicate) {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (raw.startsWith("data: ")) {
            const state = JSON.parse(raw.slice(6));
            if (predicate(state)) return state;
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended early");
        buffer += decoder.decode(value, { stream: true });
      }
    }

    try {
      const initial = await nextEvent(() => true);
      assert.deepEqual(initial.names, []);

      await request("/api/wheels/stream12/names", { method: "POST", body: { text: "Margaret" } });
      const updated = await nextEvent((state) => state.names.length === 1);
      assert.equal(updated.names[0].text, "Margaret");
    } finally {
      controller.abort();
    }
  });
});
