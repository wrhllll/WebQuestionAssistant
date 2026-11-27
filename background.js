importScripts("result-store.js", "local-question-detector.js");

const MAX_STITCHED_WIDTH = 16000;
const MAX_STITCHED_HEIGHT = 30000;
const MAX_STITCHED_PIXELS = 40000000;
const MAX_TILES = 300;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

let activeCapture = null;

function preparePageForCapture() {
  const root = document.documentElement;
  const body = document.body;
  if (!root) {
    throw new Error("当前页面没有可滚动的文档。");
  }

  const rootOverflowX = getComputedStyle(root).overflowX;
  const bodyOverflowX = body ? getComputedStyle(body).overflowX : "";
  const canScrollX = !["hidden", "clip"].includes(rootOverflowX) &&
    !["hidden", "clip"].includes(bodyOverflowX);
  const rawPageWidth = Math.max(root.scrollWidth, body?.scrollWidth || 0, root.clientWidth);
  const state = {
    pageUrl: location.href,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    rootScrollBehavior: root.style.scrollBehavior,
    bodyScrollBehavior: body?.style.scrollBehavior || "",
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pageWidth: canScrollX ? rawPageWidth : window.innerWidth,
    pageHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0, root.clientHeight)
  };
  root.style.scrollBehavior = "auto";
  if (body) {
    body.style.scrollBehavior = "auto";
  }
  return state;
}

async function scrollPageTo(x, y, expectedUrl, verifyUrl) {
  if (verifyUrl && location.href !== expectedUrl) {
    throw new Error("页面已跳转，长截图已停止。");
  }
  window.scrollTo(x, y);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 140));
  const root = document.documentElement;
  const body = document.body;
  const rootOverflowX = getComputedStyle(root).overflowX;
  const bodyOverflowX = body ? getComputedStyle(body).overflowX : "";
  const canScrollX = !["hidden", "clip"].includes(rootOverflowX) &&
    !["hidden", "clip"].includes(bodyOverflowX);
  const rawPageWidth = Math.max(root.scrollWidth, body?.scrollWidth || 0, root.clientWidth);
  return {
    pageUrl: location.href,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pageWidth: canScrollX ? rawPageWidth : window.innerWidth,
    pageHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0, root.clientHeight)
  };
}

function readPageMetrics() {
  const root = document.documentElement;
  const body = document.body;
  const rootOverflowX = getComputedStyle(root).overflowX;
  const bodyOverflowX = body ? getComputedStyle(body).overflowX : "";
  const canScrollX = !["hidden", "clip"].includes(rootOverflowX) &&
    !["hidden", "clip"].includes(bodyOverflowX);
  const rawPageWidth = Math.max(root.scrollWidth, body?.scrollWidth || 0, root.clientWidth);
  return {
    pageUrl: location.href,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pageWidth: canScrollX ? rawPageWidth : window.innerWidth,
    pageHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0, root.clientHeight)
  };
}

async function restorePagePosition(state, verifyUrl) {
  if (verifyUrl && location.href !== state.pageUrl) {
    return false;
  }
  const root = document.documentElement;
  const body = document.body;
  if (root) {
    root.style.scrollBehavior = "auto";
  }
  if (body) {
    body.style.scrollBehavior = "auto";
  }
  window.scrollTo(state.scrollX, state.scrollY);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (root) {
    root.style.scrollBehavior = state.rootScrollBehavior;
  }
  if (body) {
    body.style.scrollBehavior = state.bodyScrollBehavior;
  }
  return true;
}

async function runPageScript(tabId, documentId, pageUrl, func, args = []) {
  const target = { tabId };
  if (documentId) {
    target.documentIds = [documentId];
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({ target, func, args });
  } catch (error) {
    throw new Error(
      `无法操作当前页面。浏览器内部页面、扩展商店页面或受限页面不支持长截图。${error.message || ""}`
    );
  }

  const injection = results?.[0];
  if (!injection) {
    throw new Error("无法访问当前页面。受限页面可能不支持长截图。");
  }
  if (!documentId && injection.result?.pageUrl !== pageUrl) {
    throw new Error("页面已跳转，长截图已停止。");
  }
  return injection;
}

function checkCanvasSize(width, height) {
  const pixelWidth = Math.ceil(width);
  const pixelHeight = Math.ceil(height);
  if (pixelWidth < 1 || pixelHeight < 1 ||
      pixelWidth > MAX_STITCHED_WIDTH ||
      pixelHeight > MAX_STITCHED_HEIGHT ||
      pixelWidth * pixelHeight > MAX_STITCHED_PIXELS) {
    throw new Error("页面尺寸超过长截图拼接限制（最大宽 16,000、高 30,000 CSS 像素或 4,000 万像素）。");
  }
  return { width: pixelWidth, height: pixelHeight };
}

function resizeCanvas(canvas, context, pageWidth, pageHeight) {
  const size = checkCanvasSize(pageWidth, pageHeight);
  if (canvas && canvas.width >= size.width && canvas.height >= size.height) {
    return { canvas, context };
  }

  const expandedCanvas = new OffscreenCanvas(
    Math.max(size.width, canvas?.width || 0),
    Math.max(size.height, canvas?.height || 0)
  );
  const expandedContext = expandedCanvas.getContext("2d", { alpha: false });
  if (!expandedContext) {
    throw new Error("浏览器无法创建长截图画布。");
  }
  expandedContext.fillStyle = "#fff";
  expandedContext.fillRect(0, 0, expandedCanvas.width, expandedCanvas.height);
  if (canvas) {
    expandedContext.drawImage(canvas, 0, 0);
  }
  return { canvas: expandedCanvas, context: expandedContext };
}

function imageDataUrlToBlob(dataUrl) {
  const separator = dataUrl.indexOf(",");
  if (separator < 0) {
    throw new Error("浏览器返回的截图格式无效。");
  }
  const mimeType = /^data:([^;]+)/.exec(dataUrl.slice(0, separator))?.[1] || "image/png";
  const binary = atob(dataUrl.slice(separator + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return `data:${blob.type};base64,${btoa(chunks.join(""))}`;
}

function reportProgress(done, estimatedTotal) {
  chrome.runtime.sendMessage({
    type: "FULL_PAGE_CAPTURE_PROGRESS",
    done,
    total: Math.max(done, estimatedTotal)
  }).catch(() => {});
}

async function captureFullPage(tabId, windowId, task) {
  let pageState;
  let documentId;
  let canvas;
  let context;
  let captureResult;
  let failure;
  let cancelled = false;
  let wasRestored = false;
  let tiles = 0;

  try {
    if (typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") {
      throw new Error("当前浏览器版本不支持长图拼接，请更新浏览器后重试。");
    }
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeTab?.id !== tabId) {
      throw new Error("当前活动标签页已变化，请回到原页面后重新截取。");
    }

    let prepared;
    try {
      prepared = await chrome.scripting.executeScript({
        target: { tabId },
        func: preparePageForCapture
      });
    } catch (error) {
      throw new Error(
        `无法操作当前页面。浏览器内部页面、扩展商店页面或受限页面不支持长截图。${error.message || ""}`
      );
    }
    const injection = prepared?.[0];
    if (!injection?.result) {
      throw new Error("无法读取页面滚动尺寸。受限页面可能不支持长截图。");
    }
    pageState = injection.result;
    documentId = injection.documentId;
    const verifyUrl = !documentId;
    let pageWidth = pageState.pageWidth;
    let pageHeight = pageState.pageHeight;
    const viewportWidth = pageState.viewportWidth;
    const viewportHeight = pageState.viewportHeight;
    if (viewportWidth < 1 || viewportHeight < 1) {
      throw new Error("无法取得页面可视区域尺寸。");
    }

    const overlapX = Math.min(80, Math.max(8, Math.floor(viewportWidth * 0.08)));
    const overlapY = Math.min(80, Math.max(8, Math.floor(viewportHeight * 0.08)));
    const stepX = Math.max(1, viewportWidth - overlapX * 2);
    const stepY = Math.max(1, viewportHeight - overlapY * 2);
    let rawLocalRegions = [];
    let localDetectionError = "";
    try {
      const detected = await runPageScript(
        tabId,
        documentId,
        pageState.pageUrl,
        detectLocalQuestionRegions
      );
      if (Array.isArray(detected?.result?.regions)) {
        rawLocalRegions = detected.result.regions;
      }
    } catch (error) {
      rawLocalRegions = [];
      localDetectionError = error?.message || "本地检测暂不可用。";
    }
    let lastCaptureTime = 0;
    let currentY = 0;
    let coveredHeight = 0;

    while (true) {
      if (task.cancelled) {
        cancelled = true;
        throw new Error("长截图已取消。");
      }

      let currentX = 0;
      let coveredWidth = 0;
      let rowCoveredHeight = coveredHeight;
      let rowScrollY = currentY;

      while (true) {
        if (task.cancelled) {
          cancelled = true;
          throw new Error("长截图已取消。");
        }

        const moved = await runPageScript(
          tabId,
          documentId,
          pageState.pageUrl,
          scrollPageTo,
          [currentX, currentY, pageState.pageUrl, verifyUrl]
        );
        const metrics = moved.result;
        if (task.cancelled) {
          cancelled = true;
          throw new Error("长截图已取消。");
        }
        if (Math.abs(metrics.viewportWidth - viewportWidth) > 1 ||
            Math.abs(metrics.viewportHeight - viewportHeight) > 1) {
          throw new Error("截图过程中页面可视区域发生变化，请重试。");
        }
        pageWidth = Math.max(pageWidth, metrics.pageWidth);
        pageHeight = Math.max(pageHeight, metrics.pageHeight);
        ({ canvas, context } = resizeCanvas(canvas, context, pageWidth, pageHeight));

        const actualX = metrics.scrollX;
        const actualY = metrics.scrollY;
        const hitRightLimit = currentX > actualX + 2;
        const hitBottomLimit = currentY > actualY + 2;
        if (hitRightLimit) {
          pageWidth = Math.max(coveredWidth, actualX + viewportWidth);
        }
        if (hitBottomLimit) {
          pageHeight = Math.max(coveredHeight, actualY + viewportHeight);
        }
        if (currentX > 0 && Math.abs(actualY - rowScrollY) > 4) {
          throw new Error("页面滚动位置发生变化，长截图已停止。");
        }
        if (currentX === 0) {
          rowScrollY = actualY;
        }

        const delay = 600 - (Date.now() - lastCaptureTime);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        if (task.cancelled) {
          cancelled = true;
          throw new Error("长截图已取消。");
        }
        const [visibleTab] = await chrome.tabs.query({ active: true, windowId });
        if (visibleTab?.id !== tabId) {
          throw new Error("当前活动标签页已变化，长截图已停止。");
        }

        let screenshot;
        try {
          screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
          lastCaptureTime = Date.now();
        } catch (error) {
          throw new Error(`无法截取当前页面。受限页面可能禁止截图。${error.message || ""}`);
        }
        const bitmap = await createImageBitmap(imageDataUrlToBlob(screenshot));

        try {
          const afterCapture = await runPageScript(
            tabId,
            documentId,
            pageState.pageUrl,
            readPageMetrics
          );
          pageWidth = Math.max(pageWidth, afterCapture.result.pageWidth);
          pageHeight = Math.max(pageHeight, afterCapture.result.pageHeight);
          ({ canvas, context } = resizeCanvas(canvas, context, pageWidth, pageHeight));

          const scaleX = bitmap.width / viewportWidth;
          const scaleY = bitmap.height / viewportHeight;
          const cropLeft = Math.min(viewportWidth, Math.max(0, coveredWidth - actualX));
          const cropTop = Math.min(viewportHeight, Math.max(0, coveredHeight - actualY));
          const isLastColumn = hitRightLimit || actualX + viewportWidth >= pageWidth - 2;
          const isLastRow = hitBottomLimit || actualY + viewportHeight >= pageHeight - 2;
          const cropRight = isLastColumn ? 0 : overlapX;
          const cropBottom = isLastRow ? 0 : overlapY;
          const destinationX = Math.max(coveredWidth, actualX);
          const destinationY = Math.max(coveredHeight, actualY);
          const destinationWidth = Math.min(
            pageWidth - destinationX,
            viewportWidth - cropLeft - cropRight
          );
          const destinationHeight = Math.min(
            pageHeight - destinationY,
            viewportHeight - cropTop - cropBottom
          );

          if (destinationWidth > 0 && destinationHeight > 0) {
            context.drawImage(
              bitmap,
              cropLeft * scaleX,
              cropTop * scaleY,
              (viewportWidth - cropLeft - cropRight) * scaleX,
              (viewportHeight - cropTop - cropBottom) * scaleY,
              destinationX,
              destinationY,
              destinationWidth,
              destinationHeight
            );
            coveredWidth = destinationX + destinationWidth;
            rowCoveredHeight = Math.max(rowCoveredHeight, destinationY + destinationHeight);
          }
        } finally {
          bitmap.close();
        }
        tiles += 1;
        if (tiles > MAX_TILES) {
          throw new Error(`页面需要超过 ${MAX_TILES} 次滚动截图，已停止以避免占用过多资源。`);
        }

        const estimatedColumns = 1 + Math.ceil(Math.max(0, pageWidth - viewportWidth) / stepX);
        const estimatedRows = 1 + Math.ceil(Math.max(0, pageHeight - viewportHeight) / stepY);
        reportProgress(tiles, estimatedColumns * estimatedRows);

        const maxX = Math.max(0, pageWidth - viewportWidth);
        if (hitRightLimit || coveredWidth >= pageWidth - 2 || actualX >= maxX - 2) {
          break;
        }
        const nextX = Math.min(actualX + stepX, maxX);
        if (nextX <= actualX) {
          break;
        }
        currentX = nextX;
      }

      coveredHeight = Math.max(coveredHeight, rowCoveredHeight);
      if (coveredHeight >= pageHeight - 2) {
        break;
      }
      const maxY = Math.max(0, pageHeight - viewportHeight);
      const nextY = Math.min(rowScrollY + stepY, maxY);
      if (nextY <= rowScrollY) {
        break;
      }
      currentY = nextY;
    }

    if (task.cancelled) {
      cancelled = true;
      throw new Error("长截图已取消。");
    }
    const output = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
    if (task.cancelled) {
      cancelled = true;
      throw new Error("长截图已取消。");
    }
    if (output.size > MAX_IMAGE_BYTES) {
      throw new Error("拼接后的长图超过 10 MB，请缩小页面内容或调整缩放后重试。");
    }
    const dataUrl = await blobToDataUrl(output);
    if (task.cancelled) {
      cancelled = true;
      throw new Error("长截图已取消。");
    }
    const scaleRect = (rect) => {
      const x = Math.max(0, Math.min(canvas.width - 1, Math.round(rect.x)));
      const y = Math.max(0, Math.min(canvas.height - 1, Math.round(rect.y)));
      const width = Math.min(canvas.width - x, Math.round(rect.width));
      const height = Math.min(canvas.height - y, Math.round(rect.height));
      return { x, y, width, height };
    };
    const localDetections = rawLocalRegions
      .map((region) => {
        const stemRect = scaleRect(region.stemRect || region);
        const fullRect = scaleRect(region.fullRect || region);
        return {
          number: region.number,
          ...stemRect,
          stemRect,
          fullRect
        };
      })
      .filter((region) => region.width >= 24 && region.height >= 24);
    const resultId = await ResultStore.create({
      status: "captured",
      imageData: dataUrl,
      width: canvas.width,
      height: canvas.height,
      tiles,
      localDetections,
      localDetectionError,
      createdAt: Date.now()
    });
    captureResult = {
      ok: true,
      resultId,
      dataUrl,
      width: canvas.width,
      height: canvas.height,
      tiles,
      localDetections,
      localDetectionError
    };
  } catch (error) {
    cancelled = cancelled || task.cancelled;
    failure = error?.message || "长截图失败。";
  } finally {
    if (pageState) {
      try {
        const restored = await runPageScript(
          tabId,
          documentId,
          pageState.pageUrl,
          restorePagePosition,
          [pageState, !documentId]
        );
        if (restored.result === true) {
          wasRestored = true;
        } else {
          failure = `${failure || "长截图已完成。"} 页面已跳转，无法恢复原滚动位置。`;
          captureResult = null;
        }
      } catch (error) {
        failure = `${failure || "长截图已完成。"} 页面滚动位置恢复失败：${error.message || "页面可能已关闭或跳转。"}`;
        captureResult = null;
      }
    }
  }

  if (failure) {
    return {
      ok: false,
      cancelled,
      restored: wasRestored,
      error: `${failure}${wasRestored ? " 已恢复原滚动位置。" : ""}`
    };
  }
  return { ...captureResult, restored: wasRestored };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CHECK_FOR_UPDATES") {
    checkForReleaseUpdate(Boolean(message.force))
      .then((info) => sendResponse({ ok: true, info }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "DISMISS_UPDATE") {
    dismissUpdateVersion(message.version)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "CANCEL_FULL_PAGE_CAPTURE") {
    if (activeCapture) {
      activeCapture.cancelled = true;
    }
    sendResponse({ ok: true });
    return;
  }

  if (message?.type !== "CAPTURE_FULL_PAGE") {
    return;
  }
  if (activeCapture) {
    sendResponse({ ok: false, error: "已有长截图正在进行。" });
    return;
  }

  const task = { cancelled: false };
  activeCapture = task;
  captureFullPage(message.tabId, message.windowId, task)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || "长截图失败。" }))
    .finally(() => {
      if (activeCapture === task) {
        activeCapture = null;
      }
    });
  return true;
});

const UPDATE_REPO = "wrhllll/WebQuestionAssistant";
const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

function parseVersionParts(version) {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => {
      const match = /^\d+/.exec(part);
      return match ? Number(match[0]) : 0;
    });
}

function compareVersions(left, right) {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
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

async function syncUpdateBadge(info) {
  if (!chrome.action?.setBadgeText) {
    return;
  }
  const currentVersion = chrome.runtime.getManifest()?.version || "0.0.0";
  const hasNewer = Boolean(
    info?.latestVersion &&
    isSafeGithubUrl(info.downloadUrl) &&
    info.dismissedVersion !== info.latestVersion &&
    compareVersions(info.latestVersion, currentVersion) > 0
  );
  await chrome.action.setBadgeText({ text: hasNewer ? "NEW" : "" }).catch(() => {});
  if (hasNewer && chrome.action.setBadgeBackgroundColor) {
    await chrome.action.setBadgeBackgroundColor({ color: "#0969da" }).catch(() => {});
  }
}

async function checkForReleaseUpdate(force = false) {
  const saved = await chrome.storage.local.get(["updateCheck"]);
  const cached = saved.updateCheck || {};
  await syncUpdateBadge(cached);
  if (!force && cached.checkedAt && Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
    return cached;
  }

  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { "Accept": "application/vnd.github+json" },
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    });
  } catch {
    return cached;
  }

  const nextCache = { ...cached, checkedAt: Date.now() };
  if (response.ok) {
    const release = await response.json().catch(() => null);
    const latestVersion = String(release?.tag_name || "").replace(/^v/i, "").trim();
    const zipAsset = Array.isArray(release?.assets)
      ? release.assets.find((asset) =>
          typeof asset?.name === "string" &&
          asset.name.toLowerCase().endsWith(".zip") &&
          isSafeGithubUrl(asset.browser_download_url)
        )
      : null;
    const downloadUrl = zipAsset?.browser_download_url ||
      (isSafeGithubUrl(release?.html_url) ? release.html_url : "");
    if (latestVersion && downloadUrl) {
      nextCache.latestVersion = latestVersion;
      nextCache.downloadUrl = downloadUrl;
    }
  }
  await chrome.storage.local.set({ updateCheck: nextCache }).catch(() => {});
  await syncUpdateBadge(nextCache);
  return nextCache;
}

async function dismissUpdateVersion(version) {
  const saved = await chrome.storage.local.get(["updateCheck"]);
  const nextCache = {
    ...(saved.updateCheck || {}),
    dismissedVersion: String(version || "")
  };
  await chrome.storage.local.set({ updateCheck: nextCache }).catch(() => {});
  await syncUpdateBadge(nextCache);
}

chrome.runtime.onInstalled.addListener(() => {
  checkForReleaseUpdate(false).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  checkForReleaseUpdate(false).catch(() => {});
});
