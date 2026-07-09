const API_BASE = "/api/wheels";
const DEFAULT_TITLE = "Wheel of Names";
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
const CONFETTI_COLORS = ["#0f766e", "#f2c94c", "#e05c43", "#4778c7", "#7a4fb3", "#2d9c72"];

const elements = {
  canvas: document.querySelector("#wheelCanvas"),
  confettiCanvas: document.querySelector("#confettiCanvas"),
  copyLinkButton: document.querySelector("#copyLinkButton"),
  nameCount: document.querySelector("#nameCount"),
  nameForm: document.querySelector("#nameForm"),
  nameInput: document.querySelector("#nameInput"),
  nameList: document.querySelector("#nameList"),
  newWheelButton: document.querySelector("#newWheelButton"),
  resultText: document.querySelector("#resultText"),
  spinButton: document.querySelector("#spinButton"),
  syncStatus: document.querySelector("#syncStatus"),
  wheelIdLabel: document.querySelector("#wheelIdLabel"),
  wheelTitleForm: document.querySelector("#wheelTitleForm"),
  wheelTitleInput: document.querySelector("#wheelTitleInput"),
  winnerCloseButton: document.querySelector("#winnerCloseButton"),
  winnerName: document.querySelector("#winnerName"),
  winnerOverlay: document.querySelector("#winnerOverlay"),
  winnerRemoveButton: document.querySelector("#winnerRemoveButton")
};

const ctx = elements.canvas.getContext("2d");
const confettiCtx = elements.confettiCanvas.getContext("2d");
const wheelId = getOrCreateWheelId();
const centerLogo = new Image();

let currentTitle = DEFAULT_TITLE;
let names = [];
let rotation = 0;
let spinning = false;
let lastWinner = "";
let lastWinnerAt = 0;
let lastWinnerId = "";
let popupWinnerId = "";
let hasInitialSnapshot = false;
let store = null;
let unsubscribe = null;
let confettiFrame = 0;
let confettiPieces = [];

centerLogo.onload = drawWheel;
centerLogo.onerror = drawWheel;
centerLogo.src = "./assets/fx-logo.svg";

boot();

async function boot() {
  elements.wheelIdLabel.textContent = wheelId;
  setDocumentTitle(currentTitle);
  drawWheel();
  updateSpinState();

  store = await createStore(wheelId);
  setSyncStatus(store.mode, store.label);
  bindUi();

  unsubscribe = store.subscribe((nextState) => {
    const wasInitialSnapshot = !hasInitialSnapshot;
    const previousWinnerAt = lastWinnerAt;

    currentTitle = nextState.title || DEFAULT_TITLE;
    names = nextState.names;
    lastWinner = nextState.lastWinner || "";
    lastWinnerAt = nextState.lastWinnerAt || 0;
    lastWinnerId = nextState.lastWinnerId || "";

    updateTitleField(currentTitle);
    renderNames();
    drawWheel();
    updateSpinState();

    if (!spinning && lastWinner) {
      elements.resultText.textContent = `Last picked: ${lastWinner}`;
    }

    if (!wasInitialSnapshot && lastWinner && lastWinnerAt && lastWinnerAt !== previousWinnerAt) {
      showWinnerPopup(lastWinner, lastWinnerId);
    }

    hasInitialSnapshot = true;
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

  elements.wheelTitleForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveWheelTitle();
    elements.wheelTitleInput.blur();
  });

  elements.wheelTitleInput.addEventListener("blur", saveWheelTitle);
  elements.wheelTitleInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      updateTitleField(currentTitle, true);
      elements.wheelTitleInput.blur();
    }
  });

  elements.spinButton.addEventListener("click", spinWheel);
  elements.canvas.addEventListener("click", spinWheel);
  elements.canvas.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    spinWheel();
  });
  elements.winnerCloseButton.addEventListener("click", closeWinnerPopup);
  elements.winnerRemoveButton.addEventListener("click", removePopupWinner);
  elements.winnerOverlay.addEventListener("click", (event) => {
    if (event.target === elements.winnerOverlay) {
      closeWinnerPopup();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.winnerOverlay.hidden) {
      closeWinnerPopup();
    }
  });

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

  window.addEventListener("resize", () => {
    drawWheel();
    if (!elements.winnerOverlay.hidden) {
      resizeConfettiCanvas();
    }
  });
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
    setLastWinner(text, nameId) {
      return mutate(apiPath(id, "last-winner"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, nameId })
      });
    },
    setTitle(title) {
      return mutate(apiPath(id, "title"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title })
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
    setLastWinner(text, nameId) {
      state.lastWinner = text;
      state.lastWinnerId = nameId || "";
      state.lastWinnerAt = Date.now();
      save();
      return Promise.resolve();
    },
    setTitle(title) {
      state.title = normalizeTitle(title) || DEFAULT_TITLE;
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
    title: normalizeTitle(value?.title) || DEFAULT_TITLE,
    names: parsedNames,
    lastWinner: String(value?.lastWinner || ""),
    lastWinnerAt: Number(value?.lastWinnerAt || 0),
    lastWinnerId: String(value?.lastWinnerId || "")
  };
}

function readLocalState(storageKey) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "{}");
    return {
      title: normalizeTitle(parsed.title) || DEFAULT_TITLE,
      names: Array.isArray(parsed.names) ? parsed.names.filter((item) => item?.id && item?.text) : [],
      lastWinner: typeof parsed.lastWinner === "string" ? parsed.lastWinner : "",
      lastWinnerAt: Number(parsed.lastWinnerAt || 0),
      lastWinnerId: typeof parsed.lastWinnerId === "string" ? parsed.lastWinnerId : ""
    };
  } catch {
    return { title: DEFAULT_TITLE, names: [], lastWinner: "", lastWinnerAt: 0, lastWinnerId: "" };
  }
}

function cloneState(state) {
  return {
    title: state.title,
    names: state.names.map((name) => ({ ...name })),
    lastWinner: state.lastWinner,
    lastWinnerAt: state.lastWinnerAt,
    lastWinnerId: state.lastWinnerId
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
    removeButton.textContent = "x";

    row.append(label, removeButton);
    fragment.append(row);
  });

  elements.nameList.append(fragment);
}

function drawWheel() {
  const size = elements.canvas.width;
  const center = size / 2;
  const outerRadius = center - 26;
  const innerRadius = Math.max(92, size * 0.13);
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

  drawCenterHub(innerRadius);
  ctx.restore();
}

function drawCenterHub(radius) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, TAU);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  ctx.save();
  ctx.clip();
  if (centerLogo.complete && centerLogo.naturalWidth > 0) {
    const diameter = radius * 2;
    ctx.drawImage(centerLogo, -radius, -radius, diameter, diameter);
  } else {
    ctx.fillStyle = "#7a4fb3";
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.fillStyle = "#ffffff";
    ctx.font = "900 64px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("fx", 0, -3);
  }
  ctx.restore();

  ctx.lineWidth = 8;
  ctx.strokeStyle = "#1d211f";
  ctx.stroke();
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

  const maxWidth = outerRadius * 0.52;
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

  closeWinnerPopup();
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
    store.setLastWinner(winner.text, winner.id);
  };

  window.requestAnimationFrame(frame);
}

function showWinnerPopup(name, nameId) {
  popupWinnerId = nameId || "";
  elements.winnerName.textContent = name;
  elements.winnerRemoveButton.disabled = !popupWinnerId;
  elements.winnerOverlay.hidden = false;
  launchConfetti();
  window.setTimeout(() => elements.winnerCloseButton.focus(), 0);
}

async function removePopupWinner() {
  if (!store || !popupWinnerId) {
    return;
  }

  const nameId = popupWinnerId;
  elements.winnerRemoveButton.disabled = true;
  await store.removeName(nameId);
  closeWinnerPopup();
}

function closeWinnerPopup() {
  if (elements.winnerOverlay.hidden) {
    return;
  }

  elements.winnerOverlay.hidden = true;
  popupWinnerId = "";
  stopConfetti();
}

function launchConfetti() {
  stopConfetti();
  const rect = resizeConfettiCanvas();
  confettiPieces = Array.from({ length: 150 }, () => createConfettiPiece(rect));
  const startedAt = performance.now();

  const animate = (timestamp) => {
    const elapsed = timestamp - startedAt;
    confettiCtx.clearRect(0, 0, rect.width, rect.height);

    confettiPieces.forEach((piece) => {
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.vy += piece.gravity;
      piece.rotation += piece.spin;

      if (piece.y > rect.height + 24) {
        piece.y = -24;
        piece.x = Math.random() * rect.width;
        piece.vy = 2 + Math.random() * 4;
      }

      confettiCtx.save();
      confettiCtx.translate(piece.x, piece.y);
      confettiCtx.rotate(piece.rotation);
      confettiCtx.fillStyle = piece.color;
      confettiCtx.fillRect(-piece.width / 2, -piece.height / 2, piece.width, piece.height);
      confettiCtx.restore();
    });

    if (elapsed < 3600 && !elements.winnerOverlay.hidden) {
      confettiFrame = window.requestAnimationFrame(animate);
      return;
    }

    stopConfetti();
  };

  confettiFrame = window.requestAnimationFrame(animate);
}

function createConfettiPiece(rect) {
  return {
    x: Math.random() * rect.width,
    y: -30 - Math.random() * rect.height * 0.45,
    vx: -2.2 + Math.random() * 4.4,
    vy: 2 + Math.random() * 4,
    gravity: 0.08 + Math.random() * 0.05,
    width: 7 + Math.random() * 8,
    height: 10 + Math.random() * 14,
    rotation: Math.random() * TAU,
    spin: -0.18 + Math.random() * 0.36,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]
  };
}

function resizeConfettiCanvas() {
  const rect = elements.winnerOverlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  elements.confettiCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  elements.confettiCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
  confettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {
    width: rect.width,
    height: rect.height
  };
}

function stopConfetti() {
  if (confettiFrame) {
    window.cancelAnimationFrame(confettiFrame);
    confettiFrame = 0;
  }

  confettiCtx.clearRect(0, 0, elements.confettiCanvas.width, elements.confettiCanvas.height);
  confettiPieces = [];
}

async function saveWheelTitle() {
  if (!store) {
    return;
  }

  const title = normalizeTitle(elements.wheelTitleInput.value) || DEFAULT_TITLE;
  updateTitleField(title, true);

  if (title === currentTitle) {
    return;
  }

  currentTitle = title;
  setDocumentTitle(title);
  await store.setTitle(title);
}

function updateTitleField(title, force = false) {
  setDocumentTitle(title);
  if (force || document.activeElement !== elements.wheelTitleInput) {
    elements.wheelTitleInput.value = title;
  }
}

function setDocumentTitle(title) {
  document.title = `${title || DEFAULT_TITLE} - Shared Wheel`;
}

function updateSpinState() {
  const isDisabled = spinning || !names.length;
  elements.spinButton.disabled = isDisabled;
  elements.canvas.setAttribute("aria-disabled", String(isDisabled));
}

function createPlaceholderNames() {
  return Array.from({ length: 8 }, (_, index) => ({ text: String(index + 1) }));
}

function fitCanvasText(text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }

  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}...`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}...`;
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

function normalizeTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 60);
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
