const API_BASE = "/api/wheels";
const TAU = Math.PI * 2;
const WHEEL_COLORS = [
  "#0f766e",
  "#f2c94c",
  "#e05c43",
  "#4778c7",
  "#7a4fb3",
  "#2d9c72",
  "#f2994a",
  "#56a4b5"
];

const elements = {
  canvas: document.querySelector("#wheelCanvas"),
  copyLinkButton: document.querySelector("#copyLinkButton"),
  nameCount: document.querySelector("#nameCount"),
  nameForm: document.querySelector("#nameForm"),
  nameInput: document.querySelector("#nameInput"),
  nameList: document.querySelector("#nameList"),
  newWheelButton: document.querySelector("#newWheelButton"),
  resultText: document.querySelector("#resultText"),
  spinButton: document.querySelector("#spinButton"),
  syncStatus: document.querySelector("#syncStatus"),
  wheelIdLabel: document.querySelector("#wheelIdLabel")
};

const ctx = elements.canvas.getContext("2d");
const wheelId = getOrCreateWheelId();

let names = [];
let rotation = 0;
let spinning = false;
let lastWinner = "";
let store = null;
let unsubscribe = null;

boot();

async function boot() {
  elements.wheelIdLabel.textContent = wheelId;
  drawWheel();
  updateSpinState();

  store = await createStore(wheelId);
  setSyncStatus(store.mode, store.label);
  bindUi();

  unsubscribe = store.subscribe((nextState) => {
    names = nextState.names;
    lastWinner = nextState.lastWinner || lastWinner;
    renderNames();
    drawWheel();
    updateSpinState();
    if (!spinning && lastWinner) {
      elements.resultText.textContent = `Last picked: ${lastWinner}`;
    }
  });
}

function bindUi() {
  elements.nameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!store) {
      return;
    }

    const text = normalizeName(elements.nameInput.value);
    if (!text) {
      elements.nameInput.focus();
      return;
    }

    await store.addName(text);
    elements.nameInput.value = "";
    elements.nameInput.focus();
  });

  elements.nameList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-id]");
    if (!button || !store) {
      return;
    }

    await store.removeName(button.dataset.removeId);
  });

  elements.spinButton.addEventListener("click", spinWheel);

  elements.copyLinkButton.addEventListener("click", async () => {
    const copied = await copyToClipboard(window.location.href);
    flashStatus(copied ? "Link copied" : "Copy failed");
  });

  elements.newWheelButton.addEventListener("click", () => {
    const nextId = createWheelId();
    const url = new URL(window.location.href);
    url.searchParams.set("wheel", nextId);
    window.location.href = url.toString();
  });

  window.addEventListener("resize", drawWheel);
}

async function createStore(id) {
  try {
    const initialState = await fetchJson(apiPath(id));
    return createServerStore(id, initialState);
  } catch (error) {
    console.warn("Shared API unavailable; falling back to local mode.", error);
    return createLocalStore(id);
  }
}

function createServerStore(id, initialState) {
  let state = normalizeServerState(initialState);
  const listeners = new Set();
  let events = null;

  const notify = () => {
    const snapshot = cloneState(state);
    listeners.forEach((listener) => listener(snapshot));
  };

  const connectEvents = () => {
    if (!window.EventSource || events) {
      return;
    }

    events = new EventSource(apiPath(id, "events"));
    events.onmessage = (event) => {
      state = normalizeServerState(JSON.parse(event.data));
      notify();
    };
    events.onerror = () => {
      setSyncStatus("local", "Reconnecting");
    };
    events.onopen = () => {
      setSyncStatus("live", "Live sync");
    };
  };

  const mutate = async (path, options) => {
    state = normalizeServerState(await fetchJson(path, options));
    notify();
  };

  return {
    mode: "live",
    label: "Live sync",
    subscribe(onChange) {
      listeners.add(onChange);
      connectEvents();
      window.setTimeout(() => onChange(cloneState(state)), 0);
      return () => {
        listeners.delete(onChange);
        if (!listeners.size && events) {
          events.close();
          events = null;
        }
      };
    },
    addName(text) {
      return mutate(apiPath(id, "names"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
    },
    removeName(nameId) {
      return mutate(apiPath(id, "names", nameId), { method: "DELETE" });
    },
    setLastWinner(text) {
      return mutate(apiPath(id, "last-winner"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
    }
  };
}

function createLocalStore(id) {
  const storageKey = `thomas-wheel:${id}`;
  let state = readLocalState(storageKey);
  const listeners = new Set();

  const notify = () => {
    const snapshot = cloneState(state);
    listeners.forEach((listener) => listener(snapshot));
  };

  const save = () => {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
    notify();
  };

  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey) {
      return;
    }

    state = readLocalState(storageKey);
    notify();
  });

  return {
    mode: "local",
    label: "Local mode",
    subscribe(onChange) {
      listeners.add(onChange);
      window.setTimeout(() => onChange(cloneState(state)), 0);
      return () => listeners.delete(onChange);
    },
    addName(text) {
      state.names.push({
        id: createRecordId(),
        text,
        createdAt: Date.now()
      });
      save();
      return Promise.resolve();
    },
    removeName(nameId) {
      state.names = state.names.filter((name) => name.id !== nameId);
      save();
      return Promise.resolve();
    },
    setLastWinner(text) {
      state.lastWinner = text;
      save();
      return Promise.resolve();
    }
  };
}

function normalizeServerState(value) {
  const parsedNames = Array.isArray(value?.names)
    ? value.names
        .map((item) => ({
          id: String(item?.id || ""),
          text: String(item?.text || "").trim(),
          createdAt: Number(item?.createdAt || 0)
        }))
        .filter((item) => item.id && item.text)
        .sort((a, b) => a.createdAt - b.createdAt)
    : [];

  return {
    names: parsedNames,
    lastWinner: String(value?.lastWinner || "")
  };
}

function readLocalState(storageKey) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "{}");
    return {
      names: Array.isArray(parsed.names) ? parsed.names.filter((item) => item?.id && item?.text) : [],
      lastWinner: typeof parsed.lastWinner === "string" ? parsed.lastWinner : ""
    };
  } catch {
    return { names: [], lastWinner: "" };
  }
}

function cloneState(state) {
  return {
    names: state.names.map((name) => ({ ...name })),
    lastWinner: state.lastWinner
  };
}

function renderNames() {
  elements.nameCount.textContent = String(names.length);
  elements.nameList.replaceChildren();

  if (!names.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No names yet";
    elements.nameList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  names.forEach((name) => {
    const row = document.createElement("div");
    row.className = "name-row";

    const label = document.createElement("span");
    label.textContent = name.text;

    const removeButton = document.createElement("button");
    removeButton.className = "remove-button";
    removeButton.type = "button";
    removeButton.title = `Remove ${name.text}`;
    removeButton.setAttribute("aria-label", `Remove ${name.text}`);
    removeButton.dataset.removeId = name.id;
    removeButton.textContent = "×";

    row.append(label, removeButton);
    fragment.append(row);
  });

  elements.nameList.append(fragment);
}

function drawWheel() {
  const size = elements.canvas.width;
  const center = size / 2;
  const outerRadius = center - 26;
  const innerRadius = Math.max(54, size * 0.084);
  const displayNames = names.length ? names : createPlaceholderNames();
  const slice = TAU / displayNames.length;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(center, center);

  displayNames.forEach((name, index) => {
    const start = rotation + index * slice - Math.PI / 2;
    const end = start + slice;

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, outerRadius, start, end);
    ctx.closePath();
    ctx.fillStyle = names.length ? WHEEL_COLORS[index % WHEEL_COLORS.length] : "#dfe4dc";
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    drawSegmentText(name.text, start + slice / 2, outerRadius);
  });

  ctx.beginPath();
  ctx.arc(0, 0, innerRadius, 0, TAU);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = "#1d211f";
  ctx.stroke();

  ctx.fillStyle = "#1d211f";
  ctx.font = "800 30px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(names.length ? "SPIN" : "ADD", 0, -3);
  ctx.restore();
}

function drawSegmentText(text, angle, outerRadius) {
  ctx.save();
  ctx.rotate(angle);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0, 0, 0, 0.28)";
  ctx.shadowBlur = 2;
  ctx.font = "800 32px Inter, system-ui, sans-serif";

  const maxWidth = outerRadius * 0.58;
  const label = fitCanvasText(text, maxWidth);
  ctx.fillText(label, outerRadius - 34, 0, maxWidth);
  ctx.restore();
}

function spinWheel() {
  if (spinning || !names.length || !store) {
    return;
  }

  const spinNames = [...names];
  const winnerIndex = Math.floor(Math.random() * spinNames.length);
  const winner = spinNames[winnerIndex];
  const slice = TAU / spinNames.length;
  const current = normalizeAngle(rotation);
  const targetAngle = normalizeAngle(-(winnerIndex + 0.5) * slice);
  const travel = ((targetAngle - current + TAU) % TAU) + TAU * (5 + Math.floor(Math.random() * 3));
  const startRotation = rotation;
  const targetRotation = startRotation + travel;
  const duration = 4400;
  const startedAt = performance.now();

  spinning = true;
  updateSpinState();
  elements.resultText.textContent = "Spinning";

  const frame = (timestamp) => {
    const progress = Math.min(1, (timestamp - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 4);
    rotation = startRotation + (targetRotation - startRotation) * eased;
    drawWheel();

    if (progress < 1) {
      window.requestAnimationFrame(frame);
      return;
    }

    rotation = normalizeAngle(targetRotation);
    spinning = false;
    elements.resultText.textContent = winner.text;
    updateSpinState();
    store.setLastWinner(winner.text);
  };

  window.requestAnimationFrame(frame);
}

function updateSpinState() {
  elements.spinButton.disabled = spinning || !names.length;
}

function createPlaceholderNames() {
  return Array.from({ length: 8 }, (_, index) => ({ text: String(index + 1) }));
}

function fitCanvasText(text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }

  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}…`;
}

function getOrCreateWheelId() {
  const url = new URL(window.location.href);
  const existing = sanitizeWheelId(url.searchParams.get("wheel"));
  if (existing) {
    return existing;
  }

  const created = createWheelId();
  url.searchParams.set("wheel", created);
  window.history.replaceState({}, "", url);
  return created;
}

function createWheelId() {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function createRecordId() {
  if (window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeWheelId(value) {
  const cleaned = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{6,32}$/.test(cleaned) ? cleaned : "";
}

function normalizeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeAngle(value) {
  return ((value % TAU) + TAU) % TAU;
}

function apiPath(id, ...segments) {
  const encoded = [id, ...segments].map((part) => encodeURIComponent(part));
  return `${API_BASE}/${encoded.join("/")}`;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
  }

  return response.json();
}

function setSyncStatus(mode, label) {
  elements.syncStatus.dataset.mode = mode;
  elements.syncStatus.textContent = label;
}

function flashStatus(message) {
  const previousMode = elements.syncStatus.dataset.mode;
  const previousText = elements.syncStatus.textContent;
  elements.syncStatus.textContent = message;
  window.setTimeout(() => {
    elements.syncStatus.dataset.mode = previousMode;
    elements.syncStatus.textContent = previousText;
  }, 1300);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

window.addEventListener("beforeunload", () => {
  if (unsubscribe) {
    unsubscribe();
  }
});
