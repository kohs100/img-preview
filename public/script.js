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

let state = null;
let currentView = {
  mode: "main",
  characterIndex: null,
  clothesIndex: null,
};
const POLL_INTERVAL_MS = 1200;
const MAX_POLL_RETRY = 60;

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
    const rangeMatch = chunk.match(/^(-?\d+)\.\.(-?\d+)$/);
    if (!rangeMatch) {
      out.push(chunk);
      continue;
    }

    const startToken = rangeMatch[1];
    const endToken = rangeMatch[2];
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
        out.push(String(n));
        continue;
      }
      const sign = n < 0 ? "-" : "";
      const absText = String(Math.abs(n)).padStart(padWidth, "0");
      out.push(`${sign}${absText}`);
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
  return `/cached/${encodeURIComponent(originUrl)}?${params.toString()}`;
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
  for (let retryCount = 0; retryCount <= MAX_POLL_RETRY; retryCount += 1) {
    let response;
    try {
      response = await fetch(cachedUrl, { cache: "no-store" });
    } catch {
      response = null;
    }

    if (response && response.status === 200) {
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      img.src = objectUrl;
      return;
    }

    if (!response || response.status !== 503) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
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
  setImagePolling(img, src);
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
