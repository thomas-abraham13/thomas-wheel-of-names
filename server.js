const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const dataFile = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(dataDir, "wheels.json");
const basePort = Number(process.env.PORT || 4173);
const clients = new Map();

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

let database = loadDatabase();

function createServer() {
  return http.createServer(async (request, response) => {
    try {
      if (request.url.startsWith("/api/")) {
        await handleApi(request, response);
        return;
      }

      serveStatic(request, response);
    } catch (error) {
      console.error(error);
      sendJson(response, 500, { error: "Server error" });
    }
  });
}

async function handleApi(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const parts = requestUrl.pathname.split("/").filter(Boolean);

  if (parts[0] !== "api" || parts[1] !== "wheels") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const wheelId = parts[2] || "";
  if (!isValidWheelId(wheelId)) {
    sendJson(response, 400, { error: "Invalid wheel ID" });
    return;
  }

  if (request.method === "GET" && parts.length === 3) {
    sendJson(response, 200, getWheel(wheelId));
    return;
  }

  if (request.method === "GET" && parts.length === 4 && parts[3] === "events") {
    handleEvents(request, response, wheelId);
    return;
  }

  if (request.method === "POST" && parts.length === 4 && parts[3] === "names") {
    const body = await readJsonBody(request);
    const text = normalizeName(body.text);
    if (!text) {
      sendJson(response, 400, { error: "Name is required" });
      return;
    }

    const wheel = getWheel(wheelId);
    wheel.names.push({
      id: createRecordId(),
      text,
      createdAt: Date.now()
    });
    saveAndBroadcast(wheelId, wheel);
    sendJson(response, 201, wheel);
    return;
  }

  if (request.method === "DELETE" && parts.length === 5 && parts[3] === "names") {
    const nameId = parts[4];
    const wheel = getWheel(wheelId);
    wheel.names = wheel.names.filter((name) => name.id !== nameId);
    saveAndBroadcast(wheelId, wheel);
    sendJson(response, 200, wheel);
    return;
  }

  if (request.method === "PUT" && parts.length === 4 && parts[3] === "last-winner") {
    const body = await readJsonBody(request);
    const text = normalizeName(body.text);
    const nameId = normalizeId(body.nameId);
    const wheel = getWheel(wheelId);
    wheel.lastWinner = text;
    wheel.lastWinnerId = wheel.names.some((name) => name.id === nameId) ? nameId : "";
    wheel.lastWinnerAt = Date.now();
    saveAndBroadcast(wheelId, wheel);
    sendJson(response, 200, wheel);
    return;
  }

  if (request.method === "PUT" && parts.length === 4 && parts[3] === "title") {
    const body = await readJsonBody(request);
    const title = normalizeTitle(body.title);
    const wheel = getWheel(wheelId);
    wheel.title = title || "Wheel of Names";
    saveAndBroadcast(wheelId, wheel);
    sendJson(response, 200, wheel);
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function handleEvents(request, response, wheelId) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  response.write(`data: ${JSON.stringify(getWheel(wheelId))}\n\n`);

  const wheelClients = clients.get(wheelId) || new Set();
  wheelClients.add(response);
  clients.set(wheelId, wheelClients);

  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, 25000);

  request.on("close", () => {
    clearInterval(heartbeat);
    wheelClients.delete(response);
    if (!wheelClients.size) {
      clients.delete(wheelId);
    }
  });
}

function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(root, relativePath);

  if (!isInside(root, filePath) || isInside(dataDir, filePath)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(data);
  });
}

function getWheel(wheelId) {
  if (!database.wheels[wheelId]) {
    database.wheels[wheelId] = {
      title: "Wheel of Names",
      names: [],
      lastWinner: "",
      lastWinnerId: "",
      lastWinnerAt: 0,
      createdAt: Date.now()
    };
    persistDatabase();
  }

  const wheel = database.wheels[wheelId];
  wheel.title = normalizeTitle(wheel.title) || "Wheel of Names";
  wheel.names = Array.isArray(wheel.names) ? wheel.names : [];
  wheel.lastWinner = typeof wheel.lastWinner === "string" ? wheel.lastWinner : "";
  wheel.lastWinnerId = normalizeId(wheel.lastWinnerId);
  wheel.lastWinnerAt = Number(wheel.lastWinnerAt || 0);

  return {
    title: wheel.title,
    names: wheel.names
      .map((name) => ({
        id: String(name.id),
        text: String(name.text),
        createdAt: Number(name.createdAt || 0)
      }))
      .filter((name) => name.id && name.text)
      .sort((a, b) => a.createdAt - b.createdAt),
    lastWinner: wheel.lastWinner,
    lastWinnerId: wheel.lastWinnerId,
    lastWinnerAt: wheel.lastWinnerAt
  };
}

function saveAndBroadcast(wheelId, wheel) {
  database.wheels[wheelId] = {
    ...database.wheels[wheelId],
    title: normalizeTitle(wheel.title) || "Wheel of Names",
    names: wheel.names,
    lastWinner: wheel.lastWinner,
    lastWinnerId: normalizeId(wheel.lastWinnerId),
    lastWinnerAt: Number(wheel.lastWinnerAt || 0),
    updatedAt: Date.now()
  };
  persistDatabase();
  broadcast(wheelId, getWheel(wheelId));
}

function broadcast(wheelId, state) {
  const wheelClients = clients.get(wheelId);
  if (!wheelClients) {
    return;
  }

  const payload = `data: ${JSON.stringify(state)}\n\n`;
  wheelClients.forEach((client) => client.write(payload));
}

function loadDatabase() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    return parsed && typeof parsed === "object" && parsed.wheels ? parsed : { wheels: {} };
  } catch {
    return { wheels: {} };
  }
}

function persistDatabase() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(database, null, 2));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });

    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function createRecordId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function normalizeTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

function normalizeId(value) {
  const text = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{1,120}$/.test(text) ? text : "";
}

function isValidWheelId(value) {
  return /^[a-zA-Z0-9_-]{6,32}$/.test(value);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function listen(port) {
  const server = createServer();
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port < basePort + 20) {
      listen(port + 1);
      return;
    }

    throw error;
  });

  server.listen(port, () => {
    console.log(`Wheel of Names running at http://localhost:${port}`);
  });
}

listen(basePort);
