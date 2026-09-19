const form = document.getElementById("generatorForm");
const characterInput = document.getElementById("characterInput");
const clothesInput = document.getElementById("clothesInput");
const typeInput = document.getElementById("typeInput");
const templateInput = document.getElementById("templateInput");
const referrerSelect = document.getElementById("referrerSelect");
const statusEl = document.getElementById("status");
const modeLabelEl = document.getElementById("modeLabel");
const listEl = document.getElementById("list");
const backButton = document.getElementById("backButton");
const encryptionPanel = document.getElementById("encryptionPanel");
const encryptionForm = document.getElementById("encryptionForm");
const encryptionPassphrase = document.getElementById("encryptionPassphrase");
const encryptionStatus = document.getElementById("encryptionStatus");
const savePassphraseButton = document.getElementById("savePassphraseButton");
const forgetPassphraseButton = document.getElementById("forgetPassphraseButton");

let state = null;
let currentView = {
  mode: "main",
  characterIndex: null,
  clothesIndex: null,
};
const POLL_INTERVAL_MS = 1200;
const MAX_POLL_RETRY = 60;
const textEncoder = new TextEncoder();
const PASSPHRASE_STORAGE_KEY = "img-preview.cache-passphrase.v1";
let encryptionConfigPromise = null;
let masterKeyPromise = null;
let pendingUnlockResolve = null;

function decodeBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function encryptionConfig() {
  if (!encryptionConfigPromise) {
    encryptionConfigPromise = fetch("/api/encryption/config", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Encryption configuration is unavailable");
        return response.json();
      })
      .then((config) => {
        encryptionPanel.hidden = !config.enabled;
        if (config.enabled) updateEncryptionStatus();
        return config;
      });
  }
  return encryptionConfigPromise;
}

function getStoredPassphrase() {
  try {
    return localStorage.getItem(PASSPHRASE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storePassphrase(passphrase) {
  try {
    localStorage.setItem(PASSPHRASE_STORAGE_KEY, passphrase);
    return true;
  } catch {
    return false;
  }
}

function forgetStoredPassphrase() {
  try {
    localStorage.removeItem(PASSPHRASE_STORAGE_KEY);
  } catch {
    // Storage may be disabled; the in-memory key is still cleared below.
  }
}

function updateEncryptionStatus(message, isError = false) {
  if (message) {
    encryptionStatus.textContent = message;
  } else if (getStoredPassphrase()) {
    encryptionStatus.textContent = "Passphrase remembered on this browser.";
  } else {
    encryptionStatus.textContent = "Locked. Enter the passphrase to decrypt images.";
  }
  encryptionStatus.className = isError ? "error" : "";
}

async function deriveMasterKey(envelope, passphrase) {
  if (
    envelope.version !== 1 ||
    envelope.kdf !== "PBKDF2-SHA256" ||
    !Number.isSafeInteger(envelope.iterations) ||
    envelope.iterations < 100000 ||
    envelope.iterations > 5000000
  ) {
    throw new Error("Unsupported master-key envelope");
  }
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: decodeBase64(envelope.salt),
      iterations: envelope.iterations,
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const iv = decodeBase64(envelope.iv);
  const ciphertext = decodeBase64(envelope.ciphertext);
  const rawMasterKey = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: textEncoder.encode("img-preview-master-key-v1"),
      tagLength: 128,
    },
    wrappingKey,
    ciphertext
  );
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    rawMasterKey,
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode("img-preview-v1"),
      info: textEncoder.encode("content-encryption"),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

async function obtainMasterKey() {
  const config = await encryptionConfig();
  const saved = getStoredPassphrase();
  if (saved) {
    try {
      const key = await deriveMasterKey(config.envelope, saved);
      updateEncryptionStatus("Unlocked with the remembered passphrase.");
      return key;
    } catch {
      forgetStoredPassphrase();
      updateEncryptionStatus(
        "Saved passphrase is no longer valid. Enter the current passphrase.",
        true
      );
    }
  }
  encryptionPanel.hidden = false;
  encryptionPassphrase.focus();
  return new Promise((resolve) => {
    pendingUnlockResolve = resolve;
  });
}

async function decryptImagePayload(payload) {
  const bytes = new Uint8Array(payload);
  if (
    bytes.length < 32 ||
    bytes[0] !== 0x49 || bytes[1] !== 0x50 ||
    bytes[2] !== 0x56 || bytes[3] !== 0x31
  ) {
    throw new Error("Invalid encrypted image format");
  }
  const config = await encryptionConfig();
  if (!masterKeyPromise) masterKeyPromise = obtainMasterKey();
  const key = await masterKeyPromise;
  return crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.slice(4, 16),
      additionalData: bytes.slice(0, 4),
      tagLength: 128,
    },
    key,
    bytes.slice(16)
  );
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "";
}

function parseChoices(raw) {
  const chunks = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const out = [];

  for (const chunk of chunks) {
    // Optional non-numeric prefix on the start bound, e.g. "a1..3" => a1,a2,a3.
    // The prefix is everything before the first number (excluding a sign); an
    // optional matching prefix on the end bound ("a1..a3") is accepted too.
    const rangeMatch = chunk.match(/^([^\d-]*)(-?\d+)\.\.([^\d-]*)(-?\d+)$/);
    if (!rangeMatch) {
      out.push(chunk);
      continue;
    }

    const prefix = rangeMatch[1];
    const startToken = rangeMatch[2];
    const endToken = rangeMatch[4];
    const start = Number(startToken);
    const end = Number(endToken);
    const step = start <= end ? 1 : -1;
    const startAbs = startToken.startsWith("-")
      ? startToken.slice(1)
      : startToken;
    const endAbs = endToken.startsWith("-")
      ? endToken.slice(1)
      : endToken;
    const hasLeadingZeroPattern =
      (startAbs.length > 1 && startAbs.startsWith("0")) ||
      (endAbs.length > 1 && endAbs.startsWith("0"));
    const padWidth = Math.max(startAbs.length, endAbs.length);

    for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
      if (!hasLeadingZeroPattern) {
        out.push(`${prefix}${n}`);
        continue;
      }
      const sign = n < 0 ? "-" : "";
      const absText = String(Math.abs(n)).padStart(padWidth, "0");
      out.push(`${prefix}${sign}${absText}`);
    }
  }

  return out;
}

function validateTemplate(template) {
  const required = ["캐릭터", "상황"];
  return required.every((token) => template.includes(token));
}

function buildUrl(characterIndex, clothesIndex, typeIndex) {
  const ch = state.characters[characterIndex];
  const cl = state.clothes[clothesIndex];
  const ty = state.types[typeIndex];

  return state.template
    .replaceAll("캐릭터", ch)
    .replaceAll("의상", cl)
    .replaceAll("상황", ty);
}

function selectedReferrer() {
  return referrerSelect.value || "babechat.ai";
}

function toCachedUrl(originUrl) {
  const params = new URLSearchParams({
    referrer: selectedReferrer(),
  });
  // The /cached/:imageUrl(*) route captures the rest of the path verbatim, and
  // the server re-adds the https:// scheme, so we can drop the scheme and skip
  // encoding for clean CDN URLs (alphanumerics, "/", ".", "_", "$", ...).
  const schemeless = originUrl.replace(/^https?:\/\//i, "");
  return `/cached/${schemeless}?${params.toString()}`;
}

async function logSubmissionRecord({
  rawCharacter,
  rawClothes,
  rawType,
  template,
  characterCount,
  clothesCount,
  typeCount,
}) {
  try {
    await fetch("/api/submissions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        rawCharacter,
        rawClothes,
        rawType,
        template,
        characterCount,
        clothesCount,
        typeCount,
      }),
    });
  } catch {
    // Ignore log transport errors to keep UI flow unaffected.
  }
}

async function setImagePolling(img, cachedUrl) {
  const config = await encryptionConfig();
  for (let retryCount = 0; retryCount <= MAX_POLL_RETRY; retryCount += 1) {
    let response;
    try {
      response = await fetch(cachedUrl, { cache: "no-store" });
    } catch {
      response = null;
    }

    if (response && response.status === 200) {
      let blob;
      if (config.enabled) {
        let encryptedResponse = response;
        let contentType = response.headers.get("X-Image-Content-Type") || "";
        if ((response.headers.get("content-type") || "").includes("application/json")) {
          const descriptor = await response.json();
          if (!descriptor.encrypted || !descriptor.url) {
            throw new Error("Invalid encrypted image descriptor");
          }
          contentType = descriptor.contentType || "";
          encryptedResponse = await fetch(descriptor.url, { cache: "no-store" });
          if (!encryptedResponse.ok) throw new Error("Encrypted image download failed");
        }
        const plaintext = await decryptImagePayload(
          await encryptedResponse.arrayBuffer()
        );
        blob = new Blob([plaintext], { type: contentType });
      } else {
        blob = await response.blob();
      }
      const objectUrl = URL.createObjectURL(blob);
      img.src = objectUrl;
      return objectUrl;
    }

    if (!response || response.status !== 503) {
      return null;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

function clearList() {
  listEl.innerHTML = "";
}

function saveStateToQuery() {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  params.set("character", characterInput.value.trim());
  params.set("clothes", clothesInput.value.trim());
  params.set("type", typeInput.value.trim());
  params.set("template", templateInput.value.trim());
  params.set("referrer", selectedReferrer());
  params.set("mode", currentView.mode);

  if (currentView.mode === "type") {
    if (typeof currentView.characterIndex === "number") {
      params.set("chIndex", String(currentView.characterIndex));
    }
    if (typeof currentView.clothesIndex === "number") {
      params.set("clIndex", String(currentView.clothesIndex));
    }
  } else {
    params.delete("chIndex");
    params.delete("clIndex");
  }

  window.history.replaceState(null, "", `${url.pathname}?${params.toString()}`);
}

function restoreFormFromQuery() {
  const params = new URLSearchParams(window.location.search);
  characterInput.value = params.get("character") || "";
  clothesInput.value = params.get("clothes") || "";
  typeInput.value = params.get("type") || "";
  templateInput.value = params.get("template") || "";
  const referrer = params.get("referrer");
  if (referrer === "genit.ai" || referrer === "babechat.ai") {
    referrerSelect.value = referrer;
  } else {
    referrerSelect.value = "babechat.ai";
  }
}

function buildTypeViewHref(characterIndex, clothesIndex) {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  params.set("character", characterInput.value.trim());
  params.set("clothes", clothesInput.value.trim());
  params.set("type", typeInput.value.trim());
  params.set("template", templateInput.value.trim());
  params.set("referrer", selectedReferrer());
  params.set("mode", "type");
  params.set("chIndex", String(characterIndex));
  params.set("clIndex", String(clothesIndex));
  return `${url.pathname}?${params.toString()}`;
}

function makeCard({ src, label, onClick }) {
  const card = document.createElement("article");
  card.className = "item";

  let mediaWrapper = null;
  if (typeof onClick === "function") {
    mediaWrapper = document.createElement("button");
    mediaWrapper.addEventListener("click", onClick);
  } else {
    mediaWrapper = document.createElement("a");
    mediaWrapper.href = onClick;
  }

  const img = document.createElement("img");
  img.loading = "lazy";
  void setImagePolling(img, src).then((objectUrl) => {
    if (objectUrl && mediaWrapper instanceof HTMLAnchorElement) {
      mediaWrapper.href = objectUrl;
    }
  }).catch((error) => {
    img.alt = error instanceof Error ? error.message : "Image decryption failed";
  });
  img.alt = label;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = label;

  mediaWrapper.appendChild(img);
  card.appendChild(mediaWrapper);
  card.appendChild(meta);
  return card;
}

function renderMainList() {
  clearList();
  modeLabelEl.textContent = "Main List: f(*, *, 0)";
  backButton.hidden = true;
  currentView = {
    mode: "main",
    characterIndex: null,
    clothesIndex: null,
  };
  saveStateToQuery();

  for (let ch = 0; ch < state.characters.length; ch += 1) {
    for (let cl = 0; cl < state.clothes.length; cl += 1) {
      const url = buildUrl(ch, cl, 0);
      const cachedUrl = toCachedUrl(url);

      const chValue = state.characters[ch];
      const clValue = state.clothes[cl];
      const label = `${chValue}-${clValue}`;
      const card = makeCard({
        src: cachedUrl,
        label,
        onClick: buildTypeViewHref(ch, cl)
      });
      listEl.appendChild(card);
    }
  }
}

function renderTypeList(characterIndex, clothesIndex) {
  clearList();
  backButton.hidden = false;
  currentView = {
    mode: "type",
    characterIndex,
    clothesIndex,
  };
  saveStateToQuery();

  const chValue = state.characters[characterIndex];
  const clValue = state.clothes[clothesIndex];
  modeLabelEl.textContent = `Type List: f(${characterIndex}, ${clothesIndex}, *) | ch=${chValue}, cl=${clValue}`;

  for (let ty = 0; ty < state.types.length; ty += 1) {
    const url = buildUrl(characterIndex, clothesIndex, ty);
    const cachedUrl = toCachedUrl(url);

    const tyValue = state.types[ty];
    const card = makeCard({
      src: cachedUrl,
      label: tyValue,
      onClick: cachedUrl
    });
    listEl.appendChild(card);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  setStatus("");

  const rawCharacter = characterInput.value.trim();
  const rawClothes = clothesInput.value.trim();
  const rawType = typeInput.value.trim();
  const characters = parseChoices(rawCharacter);
  const clothesRaw = clothesInput.value.trim();
  const clothes = clothesRaw ? parseChoices(clothesRaw) : [""];
  const types = parseChoices(rawType);
  const template = templateInput.value.trim();

  if (!characters.length || !types.length || !template) {
    setStatus("Character, type, and template are required.", true);
    clearList();
    modeLabelEl.textContent = "";
    return;
  }

  if (!validateTemplate(template)) {
    setStatus(
      "URL template must include 캐릭터, and 상황.",
      true
    );
    clearList();
    modeLabelEl.textContent = "";
    return;
  }

  state = { characters, clothes, types, template };
  saveStateToQuery();
  void logSubmissionRecord({
    rawCharacter,
    rawClothes,
    rawType,
    template,
    characterCount: characters.length,
    clothesCount: clothes.length,
    typeCount: types.length,
  });
  setStatus(
    `Generated tokens: character=${characters.length}, clothes=${clothes.length}, type=${types.length}`
  );
  renderMainList();
});

backButton.addEventListener("click", () => {
  if (!state) return;
  renderMainList();
});

encryptionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const passphrase = encryptionPassphrase.value;
  if (!passphrase) {
    updateEncryptionStatus("Enter the cache passphrase.", true);
    return;
  }

  savePassphraseButton.disabled = true;
  updateEncryptionStatus("Validating passphrase…");
  try {
    const config = await encryptionConfig();
    const key = await deriveMasterKey(config.envelope, passphrase);
    const remembered = storePassphrase(passphrase);
    masterKeyPromise = Promise.resolve(key);
    if (pendingUnlockResolve) {
      pendingUnlockResolve(key);
      pendingUnlockResolve = null;
    }
    encryptionPassphrase.value = "";
    updateEncryptionStatus(
      remembered
        ? "Unlocked. Passphrase remembered on this browser."
        : "Unlocked for this page, but browser storage is unavailable.",
      !remembered
    );
  } catch {
    updateEncryptionStatus("Wrong passphrase or damaged key envelope.", true);
    encryptionPassphrase.select();
  } finally {
    savePassphraseButton.disabled = false;
  }
});

forgetPassphraseButton.addEventListener("click", () => {
  forgetStoredPassphrase();
  masterKeyPromise = null;
  encryptionPassphrase.value = "";
  updateEncryptionStatus(
    "Forgotten and locked. Already displayed images remain visible."
  );
  encryptionPassphrase.focus();
});

function hydrateFromQuery() {
  restoreFormFromQuery();
  const rawCharacter = characterInput.value.trim();
  const rawClothes = clothesInput.value.trim();
  const rawType = typeInput.value.trim();
  const template = templateInput.value.trim();

  if (!rawCharacter || !rawType || !template || !validateTemplate(template)) {
    return;
  }

  const characters = parseChoices(rawCharacter);
  const clothes = rawClothes ? parseChoices(rawClothes) : [""];
  const types = parseChoices(rawType);

  if (!characters.length || !types.length) {
    return;
  }

  state = { characters, clothes, types, template };

  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  const chIndex = Number(params.get("chIndex"));
  const clIndex = Number(params.get("clIndex"));

  if (
    mode === "type" &&
    Number.isInteger(chIndex) &&
    Number.isInteger(clIndex) &&
    chIndex >= 0 &&
    clIndex >= 0 &&
    chIndex < characters.length &&
    clIndex < clothes.length
  ) {
    renderTypeList(chIndex, clIndex);
    setStatus(
      `Restored tokens: character=${characters.length}, clothes=${clothes.length}, type=${types.length}`
    );
    return;
  }

  renderMainList();
  setStatus(
    `Restored tokens: character=${characters.length}, clothes=${clothes.length}, type=${types.length}`
  );
}

hydrateFromQuery();
void encryptionConfig().catch(() => {
  encryptionPanel.hidden = false;
  updateEncryptionStatus("Could not load encryption configuration.", true);
});
