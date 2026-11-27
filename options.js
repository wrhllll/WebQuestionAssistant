const form = document.getElementById("settings-form");
const editorTitle = document.getElementById("editor-title");
const providerSelect = document.getElementById("provider-preset");
const nameInput = document.getElementById("profile-name");
const endpointInput = document.getElementById("endpoint");
const modelInput = document.getElementById("model");
const modelSuggestions = document.getElementById("model-suggestions");
const apiKeyInput = document.getElementById("api-key");
const profileList = document.getElementById("profile-list");
const newProfileButton = document.getElementById("new-profile");
const saveOnlyButton = document.getElementById("save-only");
const clearKeyButton = document.getElementById("clear-key");
const cancelEditButton = document.getElementById("cancel-edit");
const statusElement = document.getElementById("settings-status");
const modeRadios = [...document.querySelectorAll('input[name="default-mode"]')];
const localDownloadOptions = document.getElementById("local-auto-download-options");
const autoDownloadLocalCheckbox = document.getElementById("auto-download-local");
const formatPngCheckbox = document.getElementById("format-png");
const formatPdfCheckbox = document.getElementById("format-pdf");
const updateBanner = document.getElementById("update-banner");
const updateText = document.getElementById("update-text");
const updateDownloadButton = document.getElementById("update-download");
const updateDismissButton = document.getElementById("update-dismiss");
let pendingUpdate = null;
let autoDownloadInLocal = true;
let exportFormats = ["png"];

let currentState = {
  profiles: [],
  activeProfileId: "",
  activeProfile: null,
  defaultWorkflowMode: "ai"
};
let editingProfileId = "";

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

function populateProviderPresets() {
  providerSelect.replaceChildren();
  const groups = new Map();
  for (const preset of ApiProfiles.PROVIDER_PRESETS) {
    const groupName = preset.group || "其他";
    if (!groups.has(groupName)) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = groupName;
      groups.set(groupName, optgroup);
      providerSelect.append(optgroup);
    }
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    groups.get(groupName).append(option);
  }
}

function updateModelSuggestions(providerId) {
  const preset = ApiProfiles.getPreset(providerId);
  modelSuggestions.replaceChildren();
  for (const model of preset.models) {
    const option = document.createElement("option");
    option.value = model;
    modelSuggestions.append(option);
  }
}

function applyPresetToForm(providerId, { overwriteFields = true } = {}) {
  const preset = ApiProfiles.getPreset(providerId);
  updateModelSuggestions(preset.id);
  if (overwriteFields) {
    if (preset.endpoint) {
      endpointInput.value = preset.endpoint;
    }
    if (preset.models.length > 0) {
      modelInput.value = preset.models[0];
    } else if (preset.id === "custom") {
      modelInput.value = "";
    }
    if (!editingProfileId) {
      nameInput.value = preset.id === "custom" ? "" : preset.label.split(" ")[0];
    }
  }
}

function startNewProfile() {
  editingProfileId = "";
  editorTitle.textContent = "新增 API 配置";
  providerSelect.value = "gemini";
  applyPresetToForm("gemini", { overwriteFields: true });
  apiKeyInput.value = "";
  apiKeyInput.placeholder = "输入 API Key";
  clearKeyButton.hidden = true;
  cancelEditButton.hidden = true;
}

function startEditProfile(profile) {
  editingProfileId = profile.id;
  editorTitle.textContent = `编辑配置：${profile.name}`;
  providerSelect.value = profile.providerId || "custom";
  updateModelSuggestions(providerSelect.value);
  nameInput.value = profile.name || "";
  endpointInput.value = profile.endpoint || "";
  modelInput.value = profile.model || "";
  apiKeyInput.value = "";
  apiKeyInput.placeholder = profile.apiKey
    ? "已保存 API Key（留空则保持不变）"
    : "输入 API Key";
  clearKeyButton.hidden = !profile.apiKey;
  cancelEditButton.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderProfiles() {
  profileList.replaceChildren();
  if (currentState.profiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "尚未保存任何 API 配置。如果只使用“本地自动框选并导出 PNG/PDF”，无需配置 API。";
    profileList.append(empty);
    return;
  }

  for (const profile of currentState.profiles) {
    const isActive = profile.id === currentState.activeProfileId;
    const card = document.createElement("article");
    card.className = `profile-card${isActive ? " is-active" : ""}`;

    const info = document.createElement("div");
    info.className = "profile-info";

    const titleRow = document.createElement("div");
    titleRow.className = "profile-title-row";
    const nameEl = document.createElement("strong");
    nameEl.textContent = profile.name;
    titleRow.append(nameEl);

    if (isActive) {
      const badge = document.createElement("span");
      badge.className = "profile-badge";
      badge.textContent = "当前生效";
      titleRow.append(badge);
    }

    const meta = document.createElement("p");
    meta.className = "profile-meta";
    const presetLabel = ApiProfiles.getPreset(profile.providerId).label.split(" ")[0];
    const keyStatus = profile.apiKey ? "已配置 Key" : "未填写 Key";
    meta.textContent = `${presetLabel} · ${profile.model || "未填模型"} · ${keyStatus}`;

    const endpointEl = document.createElement("p");
    endpointEl.className = "profile-endpoint";
    endpointEl.textContent = profile.endpoint;

    info.append(titleRow, meta, endpointEl);

    const actions = document.createElement("div");
    actions.className = "profile-actions";

    if (!isActive) {
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "secondary-button";
      useBtn.textContent = "切换启用";
      useBtn.addEventListener("click", async () => {
        try {
          await ApiProfiles.setActiveProfile(profile.id);
          await refreshState();
          setStatus(`已切换生效配置为：${profile.name}`);
        } catch (error) {
          setStatus(error?.message || "切换失败。", true);
        }
      });
      actions.append(useBtn);
    }

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "secondary-button";
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", () => startEditProfile(profile));
    actions.append(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "secondary-button remove-question";
    deleteBtn.textContent = "删除";
    deleteBtn.addEventListener("click", async () => {
      try {
        await ApiProfiles.deleteProfile(profile.id);
        if (editingProfileId === profile.id) {
          startNewProfile();
        }
        await refreshState();
        setStatus(`已删除配置：${profile.name}`);
      } catch (error) {
        setStatus(error?.message || "删除失败。", true);
      }
    });
    actions.append(deleteBtn);

    card.append(info, actions);
    profileList.append(card);
  }
}

function renderModeSelection() {
  for (const radio of modeRadios) {
    radio.checked = radio.value === currentState.defaultWorkflowMode;
  }
  if (localDownloadOptions) {
    localDownloadOptions.hidden = currentState.defaultWorkflowMode !== "local";
  }
  if (autoDownloadLocalCheckbox) {
    autoDownloadLocalCheckbox.checked = autoDownloadInLocal;
  }
  if (formatPngCheckbox) {
    formatPngCheckbox.checked = exportFormats.includes("png");
  }
  if (formatPdfCheckbox) {
    formatPdfCheckbox.checked = exportFormats.includes("pdf");
  }
}

async function refreshState() {
  const [state, extra] = await Promise.all([
    ApiProfiles.loadState(),
    chrome.storage.local.get(["autoDownloadInLocal", "exportFormats"])
  ]);
  currentState = state;
  autoDownloadInLocal = extra.autoDownloadInLocal !== false;
  if (Array.isArray(extra.exportFormats) && extra.exportFormats.length > 0) {
    const valid = extra.exportFormats.filter((f) => f === "png" || f === "pdf");
    exportFormats = valid.length > 0 ? valid : ["png"];
  }
  renderModeSelection();
  renderProfiles();
}

async function submitProfile(activate) {
  try {
    const saved = await ApiProfiles.saveProfile({
      id: editingProfileId || undefined,
      providerId: providerSelect.value,
      name: nameInput.value.trim(),
      endpoint: endpointInput.value.trim(),
      model: modelInput.value.trim(),
      apiKey: apiKeyInput.value.trim()
    }, { activate });
    await refreshState();
    startEditProfile(saved.profile);
    setStatus(activate ? `已保存并启用配置：${saved.profile.name}` : `已保存配置：${saved.profile.name}`);
  } catch (error) {
    setStatus(error?.message || "保存失败，请检查填写内容。", true);
  }
}

providerSelect.addEventListener("change", () => {
  applyPresetToForm(providerSelect.value, { overwriteFields: true });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitProfile(true);
});

saveOnlyButton.addEventListener("click", () => {
  submitProfile(false);
});

newProfileButton.addEventListener("click", () => {
  startNewProfile();
  setStatus("已切换到新增配置表单。");
});

cancelEditButton.addEventListener("click", () => {
  startNewProfile();
});

clearKeyButton.addEventListener("click", async () => {
  if (!editingProfileId) {
    return;
  }
  try {
    await ApiProfiles.clearProfileKey(editingProfileId);
    await refreshState();
    const updated = currentState.profiles.find((item) => item.id === editingProfileId);
    if (updated) {
      startEditProfile(updated);
    }
    setStatus("已清除该配置保存的 API Key。");
  } catch (error) {
    setStatus(`清除 API Key 失败：${error?.message || "请稍后重试。"}`, true);
  }
});

for (const radio of modeRadios) {
  radio.addEventListener("change", async () => {
    if (!radio.checked) {
      return;
    }
    try {
      await ApiProfiles.setDefaultWorkflowMode(radio.value);
      currentState.defaultWorkflowMode = radio.value;
      renderModeSelection();
      setStatus(radio.value === "local"
        ? "默认模式已设为：本地自动框选并导出（无需 API）。"
        : "默认模式已设为：AI 视觉识别与逐题解答。");
    } catch (error) {
      setStatus(`保存默认模式失败：${error?.message || "请稍后重试。"}`, true);
    }
  });
}

if (autoDownloadLocalCheckbox) {
  autoDownloadLocalCheckbox.addEventListener("change", async () => {
    autoDownloadInLocal = autoDownloadLocalCheckbox.checked;
    try {
      await chrome.storage.local.set({ autoDownloadInLocal });
      setStatus(autoDownloadInLocal
        ? "已开启：本地模式截完直接自动下载（不跳微调页）。"
        : "已关闭直接自动下载，截完后将进入微调页。");
    } catch {
      setStatus("保存自动下载设置失败。", true);
    }
  });
}

for (const checkbox of [formatPngCheckbox, formatPdfCheckbox]) {
  if (!checkbox) {
    continue;
  }
  checkbox.addEventListener("change", async () => {
    const next = [];
    if (formatPngCheckbox?.checked) next.push("png");
    if (formatPdfCheckbox?.checked) next.push("pdf");
    if (next.length === 0) {
      checkbox.checked = true;
      setStatus("至少需要保留一种默认下载格式。", true);
      return;
    }
    exportFormats = next;
    try {
      await chrome.storage.local.set({ exportFormats });
      setStatus(`默认下载格式已更新：${exportFormats.map((f) => f.toUpperCase()).join(" + ")}。`);
    } catch {
      setStatus("保存下载格式失败。", true);
    }
  });
}

function isSafeGithubUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" &&
      (parsed.hostname === "github.com" || parsed.hostname.endsWith(".githubusercontent.com"));
  } catch {
    return false;
  }
}

function compareVersions(left, right) {
  const parse = (v) => String(v || "").trim().replace(/^v/i, "").split(".")
    .map((p) => Number((/^\d+/.exec(p) || [0])[0]));
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkUpdatesInOptions() {
  if (!updateBanner || !chrome.runtime?.sendMessage) {
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "CHECK_FOR_UPDATES" }).catch(() => null);
  const info = res?.info;
  const currentVersion = chrome.runtime.getManifest?.()?.version || "0.0.0";
  if (!info?.latestVersion ||
      !isSafeGithubUrl(info.downloadUrl) ||
      info.dismissedVersion === info.latestVersion ||
      compareVersions(info.latestVersion, currentVersion) <= 0) {
    updateBanner.hidden = true;
    return;
  }
  pendingUpdate = info;
  updateText.textContent = `发现新版本 v${info.latestVersion}（当前 v${currentVersion}）`;
  updateBanner.hidden = false;
}

if (updateDownloadButton) {
  updateDownloadButton.addEventListener("click", () => {
    if (pendingUpdate && isSafeGithubUrl(pendingUpdate.downloadUrl)) {
      chrome.tabs.create({ url: pendingUpdate.downloadUrl, active: true });
    }
  });
}

if (updateDismissButton) {
  updateDismissButton.addEventListener("click", async () => {
    updateBanner.hidden = true;
    if (pendingUpdate?.latestVersion) {
      await chrome.runtime.sendMessage({
        type: "DISMISS_UPDATE",
        version: pendingUpdate.latestVersion
      }).catch(() => {});
    }
  });
}

(async () => {
  populateProviderPresets();
  await refreshState();
  checkUpdatesInOptions().catch(() => {});
  if (currentState.activeProfile) {
    startEditProfile(currentState.activeProfile);
  } else {
    startNewProfile();
  }
})().catch((error) => setStatus(`读取设置失败：${error?.message || "请重新加载此页面。"}`, true));
