/**
 * Project Ghost — 侧边栏 UI 逻辑
 *
 * 处理用户交互：搜索（向量 + LLM）、收纳、唤醒、设置，
 * 并与后台服务 Worker 通信。
 */

// ─── DOM 元素 ────────────────────────────────────────────────
const searchInput = document.getElementById("searchInput");
const searchSpinner = document.getElementById("searchSpinner");
const btnVectorSearch = document.getElementById("btnVectorSearch");
const btnLLMSearch = document.getElementById("btnLLMSearch");
const btnVanish = document.getElementById("btnVanish");
const btnSettings = document.getElementById("btnSettings");
const btnRefresh = document.getElementById("btnRefresh");
const resultsSection = document.getElementById("resultsSection");
const resultsList = document.getElementById("resultsList");
const searchModeBadge = document.getElementById("searchModeBadge");
const keywordsBar = document.getElementById("keywordsBar");
const keywordsList = document.getElementById("keywordsList");
const ghostTabsList = document.getElementById("ghostTabsList");
const ghostCount = document.getElementById("ghostCount");
const emptyState = document.getElementById("emptyState");
const settingsPanel = document.getElementById("settingsPanel");
const toggleAutoDiscard = document.getElementById("toggleAutoDiscard");
const backendStatus = document.getElementById("backendStatus");

// LLM 配置相关元素
const llmBaseUrl = document.getElementById("llmBaseUrl");
const llmApiKey = document.getElementById("llmApiKey");
const llmModel = document.getElementById("llmModel");
const btnSaveLLM = document.getElementById("btnSaveLLM");
const llmConfigStatus = document.getElementById("llmConfigStatus");

// ─── 状态管理 ────────────────────────────────────────────────
let settingsVisible = false;

// ─── 初始化 ──────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    loadGhostTabs();
    loadSettings();
    checkBackendStatus();
    loadLLMConfig();
});

// ─── 搜索功能 (仅手动触发) ───────────────────────────────────

// 回车键默认触发向量搜索
searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        const query = e.target.value.trim();
        if (query) performVectorSearch(query);
    }
});

// 向量搜索按钮
btnVectorSearch.addEventListener("click", () => {
    const query = searchInput.value.trim();
    if (query) performVectorSearch(query);
});

// LLM 搜索按钮
btnLLMSearch.addEventListener("click", () => {
    const query = searchInput.value.trim();
    if (query) performLLMSearch(query);
});

async function performVectorSearch(query) {
    searchSpinner.classList.add("active");
    resultsSection.style.display = "block";
    searchModeBadge.textContent = "语义搜索";
    searchModeBadge.className = "search-mode-badge mode-vector";
    keywordsBar.style.display = "none";
    resultsList.innerHTML = '<div class="empty-state"><p>搜索中...</p></div>';

    const response = await chrome.runtime.sendMessage({
        type: "search",
        query,
        topK: 8,
    });

    searchSpinner.classList.remove("active");

    if (!response?.results?.length) {
        resultsList.innerHTML = '<div class="empty-state"><p>没有找到匹配的标签页</p></div>';
        return;
    }

    resultsList.innerHTML = "";
    response.results.forEach((result) => {
        const card = createTabCard(result, true);
        resultsList.appendChild(card);
    });
}

async function performLLMSearch(query) {
    searchSpinner.classList.add("active");
    resultsSection.style.display = "block";
    searchModeBadge.textContent = "AI 搜索";
    searchModeBadge.className = "search-mode-badge mode-llm";
    keywordsBar.style.display = "none";
    resultsList.innerHTML = '<div class="empty-state"><p>AI 正在分析你的意图...</p></div>';

    const response = await chrome.runtime.sendMessage({
        type: "llmSearch",
        query,
        topK: 8,
    });

    searchSpinner.classList.remove("active");

    // 如果有 LLM 错误则显示
    if (response?.llm_error) {
        showToast(`LLM: ${response.llm_error}`, "error");
    }

    // 显示生成的关键词
    if (response?.keywords?.length) {
        keywordsBar.style.display = "flex";
        keywordsList.innerHTML = response.keywords
            .map(k => `<span class="keyword-tag">${escapeHtml(k)}</span>`)
            .join("");
    }

    if (!response?.results?.length) {
        resultsList.innerHTML = '<div class="empty-state"><p>没有找到匹配的标签页</p></div>';
        return;
    }

    resultsList.innerHTML = "";
    response.results.forEach((result) => {
        const card = createTabCard(result, true);
        resultsList.appendChild(card);
    });
}

// ─── 收纳 (Vanish) ───────────────────────────────────────────
btnVanish.addEventListener("click", async () => {
    btnVanish.disabled = true;
    btnVanish.querySelector("span:nth-child(2)").textContent = "收纳中...";

    const response = await chrome.runtime.sendMessage({ type: "vanish" });

    if (response?.success) {
        showToast(`已收纳: ${response.title}`, "success");
        loadGhostTabs();
    } else {
        showToast(response?.error || "收纳失败", "error");
    }

    btnVanish.disabled = false;
    btnVanish.querySelector("span:nth-child(2)").textContent = "收纳当前标签页";
});

// ─── Ghost Tab 列表 ──────────────────────────────────────────
async function loadGhostTabs() {
    const response = await chrome.runtime.sendMessage({ type: "getGhostTabs" });
    const tabs = response?.tabs || {};
    const tabArray = Object.values(tabs);

    ghostCount.textContent = tabArray.length;

    if (tabArray.length === 0) {
        ghostTabsList.innerHTML = "";
        ghostTabsList.appendChild(emptyState);
        emptyState.style.display = "block";
        return;
    }

    emptyState.style.display = "none";
    ghostTabsList.innerHTML = "";

    // 按收纳时间排序（最近的在前）
    tabArray.sort((a, b) => (b.vanishedAt || 0) - (a.vanishedAt || 0));

    tabArray.forEach((tab) => {
        const card = createTabCard(tab, false);
        ghostTabsList.appendChild(card);
    });
}

btnRefresh.addEventListener("click", () => loadGhostTabs());

// ─── 标签页卡片工厂函数 ──────────────────────────────────────
function createTabCard(data, isSearchResult) {
    const card = document.createElement("div");
    card.className = "tab-card";

    // Favicon 处理
    let faviconHtml;
    if (data.favicon) {
        faviconHtml = `<img class="favicon" src="${escapeHtml(data.favicon)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="favicon-placeholder" style="display:none">🌐</div>`;
    } else {
        faviconHtml = `<div class="favicon-placeholder">🌐</div>`;
    }

    // 分数徽章（仅搜索结果显示）
    const scoreBadge = isSearchResult && data.score != null
        ? `<span class="tab-card-score">${Math.round(data.score * 100)}%</span>`
        : "";

    // URL 显示处理（截断）
    let displayUrl = "";
    try {
        const u = new URL(data.url);
        displayUrl = u.hostname + (u.pathname.length > 1 ? u.pathname.substring(0, 40) : "");
    } catch {
        displayUrl = data.url?.substring(0, 50) || "";
    }

    card.innerHTML = `
    ${faviconHtml}
    <div class="tab-card-info">
      <div class="tab-card-title">${escapeHtml(data.title || "Untitled")}</div>
      <div class="tab-card-url">${escapeHtml(displayUrl)}</div>
    </div>
    ${scoreBadge}
    <button class="btn-remove" title="移除">✕</button>
  `;

    // 点击卡片 → 唤醒
    card.addEventListener("click", (e) => {
        if (e.target.closest(".btn-remove")) return;
        summonTab(data.url, data.tab_id);
    });

    // 移除按钮
    card.querySelector(".btn-remove").addEventListener("click", async (e) => {
        e.stopPropagation();
        await chrome.runtime.sendMessage({ type: "removeGhostTab", url: data.url });
        card.style.opacity = "0";
        card.style.transform = "translateX(20px)";
        setTimeout(() => {
            card.remove();
            loadGhostTabs(); // 刷新计数
        }, 200);
    });

    return card;
}

// ─── 唤醒 (Summon) ───────────────────────────────────────────
async function summonTab(url, tabId) {
    const response = await chrome.runtime.sendMessage({
        type: "summon",
        url,
        tabId,
    });

    if (response?.success) {
        const mode = response.mode === "perfect" ? "无损恢复" : "重新加载";
        showToast(`已唤醒 (${mode})`, "success");
        loadGhostTabs();
        // 如果是从搜索结果点击，清理搜索状态
        if (resultsSection.style.display !== "none") {
            searchInput.value = "";
            resultsSection.style.display = "none";
        }
    } else {
        showToast(response?.error || "唤醒失败", "error");
    }
}

// ─── 设置 (Settings) ─────────────────────────────────────────
btnSettings.addEventListener("click", () => {
    settingsVisible = !settingsVisible;
    settingsPanel.style.display = settingsVisible ? "block" : "none";
    if (settingsVisible) {
        checkBackendStatus();
        loadLLMConfig();
    }
});

async function loadSettings() {
    const settings = await chrome.runtime.sendMessage({ type: "getSettings" });
    toggleAutoDiscard.checked = settings?.allowAutoDiscard || false;
}

toggleAutoDiscard.addEventListener("change", async () => {
    await chrome.runtime.sendMessage({
        type: "saveSettings",
        settings: { allowAutoDiscard: toggleAutoDiscard.checked },
    });
    showToast("设置已保存", "success");
});

async function checkBackendStatus() {
    backendStatus.textContent = "检测中...";
    backendStatus.className = "backend-status checking";

    try {
        const res = await fetch("http://127.0.0.1:8000/", { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            backendStatus.textContent = "在线 ✓";
            backendStatus.className = "backend-status online";
        } else {
            throw new Error();
        }
    } catch {
        backendStatus.textContent = "离线 ✗";
        backendStatus.className = "backend-status offline";
    }
}

// ─── LLM 配置 ───────────────────────────────────────────────

async function loadLLMConfig() {
    const response = await chrome.runtime.sendMessage({ type: "getLLMConfig" });
    const config = response?.config;
    if (config?.configured) {
        llmConfigStatus.textContent = "已配置 ✓";
        llmConfigStatus.className = "llm-config-status configured";
        if (config.base_url) llmBaseUrl.value = config.base_url;
        if (config.model) llmModel.value = config.model;
        llmApiKey.placeholder = config.api_key_masked || "sk-...";
    } else {
        llmConfigStatus.textContent = "未配置";
        llmConfigStatus.className = "llm-config-status";
    }
}

btnSaveLLM.addEventListener("click", async () => {
    const config = {
        base_url: llmBaseUrl.value.trim(),
        api_key: llmApiKey.value.trim(),
        model: llmModel.value.trim() || "gpt-4o-mini",
    };

    if (!config.api_key) {
        showToast("请输入 API Key", "error");
        return;
    }

    btnSaveLLM.disabled = true;
    btnSaveLLM.textContent = "保存中...";

    const result = await chrome.runtime.sendMessage({
        type: "saveLLMConfig",
        config,
    });

    btnSaveLLM.disabled = false;
    btnSaveLLM.textContent = "保存 LLM 配置";

    if (result?.error) {
        showToast(`保存失败: ${result.error}`, "error");
    } else {
        showToast("LLM 配置已保存", "success");
        llmConfigStatus.textContent = "已配置 ✓";
        llmConfigStatus.className = "llm-config-status configured";
        llmApiKey.value = "";
        llmApiKey.placeholder = config.api_key.substring(0, 8) + "...";
    }
});

// ─── Agent 对话 ──────────────────────────────────────────────

const btnAgentChat = document.getElementById("btnAgentChat");
const agentSection = document.getElementById("agentSection");
const agentChat = document.getElementById("agentChat");
const btnCloseAgent = document.getElementById("btnCloseAgent");

let agentActive = false;

btnAgentChat.addEventListener("click", () => {
    const query = searchInput.value.trim();
    if (query) performAgentChat(query);
});

btnCloseAgent.addEventListener("click", () => {
    agentSection.style.display = "none";
    agentActive = false;
});

async function performAgentChat(query) {
    agentActive = true;
    agentSection.style.display = "block";
    resultsSection.style.display = "none";
    searchSpinner.classList.add("active");

    // 清空并显示用户消息
    agentChat.innerHTML = "";

    // 用户消息
    const userMsg = document.createElement("div");
    userMsg.className = "agent-msg agent-msg-user";
    userMsg.innerHTML = `<div class="agent-msg-label">你</div><div class="agent-msg-content">${escapeHtml(query)}</div>`;
    agentChat.appendChild(userMsg);

    // 思考过程容器
    const thinkingContainer = document.createElement("div");
    thinkingContainer.className = "agent-thinking-container";
    thinkingContainer.innerHTML = `<div class="agent-thinking-header">
        <span class="agent-thinking-icon">⚙️</span>
        <span>推理过程</span>
        <span class="agent-thinking-spinner"></span>
    </div>
    <div class="agent-thinking-steps"></div>`;
    agentChat.appendChild(thinkingContainer);

    const stepsContainer = thinkingContainer.querySelector(".agent-thinking-steps");

    // 发送请求
    const response = await chrome.runtime.sendMessage({
        type: "agentChat",
        query,
    });

    searchSpinner.classList.remove("active");

    // 停止 spinner
    const spinner = thinkingContainer.querySelector(".agent-thinking-spinner");
    if (spinner) spinner.style.display = "none";

    if (response?.error) {
        const errorMsg = document.createElement("div");
        errorMsg.className = "agent-msg agent-msg-error";
        errorMsg.innerHTML = `<div class="agent-msg-content">❌ ${escapeHtml(response.error)}</div>`;
        agentChat.appendChild(errorMsg);
        agentChat.scrollTop = agentChat.scrollHeight;
        return;
    }

    // 渲染事件
    const events = response?.events || [];
    let hasAnswer = false;

    for (const event of events) {
        switch (event.type) {
            case "thinking": {
                const step = document.createElement("div");
                step.className = "agent-step agent-step-thinking";
                step.innerHTML = `<span class="step-icon">🤔</span><span>${escapeHtml(event.message)}</span>`;
                stepsContainer.appendChild(step);
                break;
            }
            case "tool_call": {
                const step = document.createElement("div");
                step.className = "agent-step agent-step-tool";
                const toolIcon = {
                    search_tabs: "🔍",
                    read_tab: "📖",
                    list_tabs: "📋",
                    batch_restore: "🚀",
                }[event.tool] || "🔧";
                const argsStr = event.arguments
                    ? Object.entries(event.arguments).map(([k, v]) => {
                        const val = Array.isArray(v) ? `[${v.length}项]` :
                            typeof v === "string" && v.length > 40 ? v.substring(0, 40) + "..." : v;
                        return `${k}=${val}`;
                    }).join(", ")
                    : "";
                step.innerHTML = `<span class="step-icon">${toolIcon}</span><span>调用 <strong>${escapeHtml(event.tool)}</strong>(${escapeHtml(argsStr)})</span>`;
                stepsContainer.appendChild(step);
                break;
            }
            case "tool_result": {
                const step = document.createElement("div");
                step.className = "agent-step agent-step-result";
                const r = event.result || {};
                let desc = "";
                if (r.status === "error") {
                    desc = `❌ ${r.message}`;
                } else if (r.found !== undefined) {
                    desc = `找到 ${r.found} 个结果`;
                    if (r.titles?.length) desc += `: ${r.titles.slice(0, 3).join(", ")}`;
                } else if (r.count !== undefined) {
                    desc = `共 ${r.count} 个标签页`;
                } else if (r.length !== undefined) {
                    desc = `已读取 "${r.title}" (${r.length} 字符)`;
                } else if (r.action === "batch_restore") {
                    desc = `准备恢复 ${r.count} 个标签页`;
                } else {
                    desc = "已完成";
                }
                step.innerHTML = `<span class="step-icon">📋</span><span>${desc}</span>`;
                stepsContainer.appendChild(step);
                break;
            }
            case "action": {
                if (event.action === "batch_restore" && event.urls?.length) {
                    // 执行批量恢复
                    const restoreResult = await chrome.runtime.sendMessage({
                        type: "batchSummon",
                        urls: event.urls,
                    });

                    const actionMsg = document.createElement("div");
                    actionMsg.className = "agent-step agent-step-action";
                    actionMsg.innerHTML = `<span class="step-icon">🚀</span><span>已恢复 ${event.count} 个标签页</span>`;
                    stepsContainer.appendChild(actionMsg);

                    // 刷新 ghost tab 列表
                    loadGhostTabs();
                }
                break;
            }
            case "answer": {
                hasAnswer = true;
                const answerMsg = document.createElement("div");
                answerMsg.className = "agent-msg agent-msg-answer";
                answerMsg.innerHTML = `<div class="agent-msg-label">🤖 Ghost Agent</div><div class="agent-msg-content">${formatAgentAnswer(event.content)}</div>`;
                if (event.steps_used) {
                    answerMsg.innerHTML += `<div class="agent-msg-meta">使用了 ${event.steps_used} 步推理</div>`;
                }
                agentChat.appendChild(answerMsg);
                break;
            }
            case "error": {
                const errorStep = document.createElement("div");
                errorStep.className = "agent-msg agent-msg-error";
                errorStep.innerHTML = `<div class="agent-msg-content">❌ ${escapeHtml(event.message)}</div>`;
                agentChat.appendChild(errorStep);
                break;
            }
        }
    }

    if (!hasAnswer && !events.some(e => e.type === "error")) {
        const noAnswer = document.createElement("div");
        noAnswer.className = "agent-msg agent-msg-error";
        noAnswer.innerHTML = `<div class="agent-msg-content">Agent 未能生成回答，请重试</div>`;
        agentChat.appendChild(noAnswer);
    }

    agentChat.scrollTop = agentChat.scrollHeight;
}

function formatAgentAnswer(text) {
    // 简单的 markdown-like 格式化
    return escapeHtml(text)
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
}

// ─── Toast 提示 ───────────────────────────────────────────────
function showToast(message, type = "success") {
    // 移除已有的 toast
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add("show");
    });

    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 400);
    }, 2500);
}

// ─── 工具函数 ────────────────────────────────────────────────
function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}
