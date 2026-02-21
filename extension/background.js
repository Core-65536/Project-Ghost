/**
 * Project Ghost — 后台服务 Worker
 *
 * 核心职责:
 * 1. Ghost 窗口管理 (创建, 检测, 保持存活)
 * 2. 标签页收纳/唤醒操作 (Vanish/Summon)
 * 3. 页面内容提取 (脚本注入)
 * 4. 后端通信
 * 5. 浏览器重启后的会话重映射
 */

// ─── 配置 ────────────────────────────────────────────────────
const BACKEND_URL = "http://127.0.0.1:8000";
const GHOST_WINDOW_KEY = "ghostWindowId";
const GHOST_TABS_KEY = "ghostTabs";                // Map<url, metadata>
const SETTINGS_KEY = "ghostSettings";

// ─── 状态 ────────────────────────────────────────────────────
let ghostWindowId = null;
let urlToTabId = new Map();  // 会话重映射: URL → 当前 TabID

// ─── 初始化 ──────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
    console.log("[Ghost] 扩展已安装/更新");
    await initGhostWindow();
    await buildUrlMap();
});

chrome.runtime.onStartup.addListener(async () => {
    console.log("[Ghost] 浏览器启动 — 重建会话映射");
    await initGhostWindow();
    await buildUrlMap();
});

// 点击扩展图标时打开侧边栏
chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId });
});

// 监听键盘快捷键
chrome.commands.onCommand.addListener(async (command) => {
    if (command === "vanish-tab") {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
            await vanishTab(activeTab.id);
        }
    }
});

// ─── Ghost 窗口管理 ──────────────────────────────────────────

/**
 * 启动时初始化 Ghost 窗口。
 * 
 * 策略 (优先级顺序):
 * 1. 检查存储的窗口 ID 是否有效 → 复用
 * 2. 扫描所有窗口寻找包含 zombie tab 的窗口 → 认领
 * 3. 什么都不做 (懒加载 — 首次收纳时再创建)
 * 
 * 避免每次 Chrome 重启都创建一个新的空白窗口。
 */
async function initGhostWindow() {
    // ── 步骤 1: 尝试使用存储的窗口 ID ──
    const data = await chrome.storage.local.get(GHOST_WINDOW_KEY);
    if (data[GHOST_WINDOW_KEY]) {
        try {
            const win = await chrome.windows.get(data[GHOST_WINDOW_KEY]);
            if (win) {
                ghostWindowId = win.id;
                await hideGhostWindow();
                console.log("[Ghost] 通过存储 ID 找到现存 Ghost 窗口:", ghostWindowId);
                return;
            }
        } catch (_) {
            // 存储的 ID 已失效 (Chrome 重启导致 ID 变更)
        }
    }

    // ── 步骤 2: 扫描窗口以寻找恢复的 Ghost 窗口 ──
    // Chrome 重启会恢复所有窗口，包括我们旧的 ghost window。
    // 我们通过检查哪个窗口包含最多的 ghost tab URL 来识别它。
    const ghostTabsData = await chrome.storage.local.get(GHOST_TABS_KEY);
    const ghostTabs = ghostTabsData[GHOST_TABS_KEY] || {};
    const ghostUrls = new Set(Object.keys(ghostTabs));

    if (ghostUrls.size > 0) {
        const allWindows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
        let bestWindow = null;
        let bestMatchCount = 0;

        for (const win of allWindows) {
            // 统计该窗口有多少 tab 匹配已知的 ghost URL
            const matchCount = win.tabs.filter(t => ghostUrls.has(t.url)).length;
            if (matchCount > bestMatchCount) {
                bestMatchCount = matchCount;
                bestWindow = win;
            }
        }

        if (bestWindow && bestMatchCount > 0) {
            ghostWindowId = bestWindow.id;
            await chrome.storage.local.set({ [GHOST_WINDOW_KEY]: ghostWindowId });
            await hideGhostWindow();
            console.log(
                `[Ghost] 认领恢复的窗口 ${ghostWindowId} ` +
                `(${bestMatchCount}/${ghostUrls.size} ghost tabs 匹配)`
            );

            // 清理 Chrome 恢复时可能添加的 about:blank 标签页
            const blankTabs = bestWindow.tabs.filter(
                t => t.url === "about:blank" || t.url === "chrome://newtab/"
            );
            // 只有当窗口确实包含 ghost tabs 时才清理空白页
            if (blankTabs.length > 0 && bestMatchCount > 0) {
                for (const bt of blankTabs) {
                    try { await chrome.tabs.remove(bt.id); } catch (_) { }
                }
            }
            return;
        }
    }

    // ── 步骤 3: 未找到窗口，推迟创建 ──
    // 暂不创建空白窗口。等到用户真正收纳标签页时（ensureGhostWindow）再创建。
    ghostWindowId = null;
    console.log("[Ghost] 暂不需要 Ghost 窗口 (懒加载)");
}

async function createGhostWindow() {
    // 创建一个最小化的隐藏窗口
    const win = await chrome.windows.create({
        url: "about:blank",
        type: "normal",
        state: "minimized",
        focused: false,
    });
    ghostWindowId = win.id;
    await chrome.storage.local.set({ [GHOST_WINDOW_KEY]: ghostWindowId });

    console.log("[Ghost] 创建了新的隐藏 Ghost 窗口:", ghostWindowId);
}

/**
 * 确保 Ghost 窗口保持隐藏（最小化且不在屏幕上）
 */
async function hideGhostWindow() {
    if (!ghostWindowId) return;
    try {
        await chrome.windows.update(ghostWindowId, {
            state: "minimized",
            focused: false,
        });
    } catch (err) {
        console.warn("[Ghost] 无法隐藏 Ghost 窗口:", err);
    }
}

async function ensureGhostWindow() {
    if (ghostWindowId) {
        try {
            await chrome.windows.get(ghostWindowId);
            return ghostWindowId;
        } catch (_) {
            // Ghost 窗口被关闭了
        }
    }
    await createGhostWindow();
    return ghostWindowId;
}

/**
 * 获取当前活动的普通窗口（非 Ghost 窗口）
 */
async function getCurrentWindow() {
    try {
        // 首先尝试获取获得焦点的窗口
        const focusedWin = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
        if (focusedWin && focusedWin.id !== ghostWindowId) {
            return focusedWin.id;
        }

        // 回退：获取所有普通窗口并选择第一个非 Ghost 窗口
        const allWindows = await chrome.windows.getAll({ windowTypes: ["normal"] });
        for (const win of allWindows) {
            if (win.id !== ghostWindowId) {
                return win.id;
            }
        }

        // 如果没有合适的窗口，新建一个
        const newWin = await chrome.windows.create({ url: "about:blank", focused: true });
        return newWin.id;
    } catch (err) {
        console.error("[Ghost] 获取当前窗口失败:", err);
        return null;
    }
}

// 处理 Ghost 窗口被关闭的情况 — 标记为 null，下次收纳时重建
chrome.windows.onRemoved.addListener(async (windowId) => {
    if (windowId === ghostWindowId) {
        console.log("[Ghost] Ghost 窗口被关闭。将在下次收纳时重建。");
        ghostWindowId = null;
        await chrome.storage.local.remove(GHOST_WINDOW_KEY);
    }
});

// 防止 Ghost 窗口意外获得焦点
chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === ghostWindowId && windowId !== chrome.windows.WINDOW_ID_NONE) {
        console.log("[Ghost] Ghost 窗口获得焦点，正在隐藏...");
        await hideGhostWindow();

        // 尝试将焦点还给最后一个活动的普通窗口
        const targetWindow = await getCurrentWindow();
        if (targetWindow) {
            await chrome.windows.update(targetWindow, { focused: true });
        }
    }
});

// ─── 会话重映射 (Session Re-mapping) ─────────────────────────

async function buildUrlMap() {
    urlToTabId.clear();
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
        if (tab.url) {
            urlToTabId.set(tab.url, tab.id);
        }
    }
    console.log(`[Ghost] URL 映射表已构建，包含 ${urlToTabId.size} 条目`);
}

// 保持 URL 映射表随标签页变化更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.url) {
        urlToTabId.set(tab.url, tabId);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    // 从 URL 映射表中移除
    for (const [url, id] of urlToTabId.entries()) {
        if (id === tabId) {
            urlToTabId.delete(url);
            break;
        }
    }
});

// ─── 标签页操作 ──────────────────────────────────────────────

/**
 * 收纳标签页 (Vanish): 提取内容 → 索引 → 移动到 Ghost 窗口
 */
async function vanishTab(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab || tab.url?.startsWith("chrome://") || tab.url?.startsWith("about:")) {
            return { success: false, error: "无法收纳 Chrome 内部页面" };
        }

        // 记住源窗口以便恢复焦点
        const sourceWindowId = tab.windowId;

        // 1. 提取页面内容
        const pageData = await extractPageContent(tabId);

        // 2. 发送给后端进行索引
        await indexPage({
            url: tab.url,
            title: tab.title || "",
            text: pageData.text || "",
            tab_id: tabId,
            favicon: tab.favIconUrl || "",
        });

        // 3. 获取自动丢弃设置
        const settings = await getSettings();

        // 4. 将标签页移动到 Ghost 窗口
        const gwId = await ensureGhostWindow();
        await chrome.tabs.move(tabId, { windowId: gwId, index: -1 });

        // 5. 移动后保持 Ghost 窗口隐藏
        await hideGhostWindow();

        // 6. 将焦点恢复给源窗口
        if (sourceWindowId && sourceWindowId !== gwId) {
            try {
                await chrome.windows.update(sourceWindowId, { focused: true });
            } catch (_) {
                // 源窗口可能已被关闭
            }
        }

        // 7.根据设置设定 autoDiscardable
        if (!settings.allowAutoDiscard) {
            await chrome.tabs.update(tabId, { autoDiscardable: false });
        }

        // 8. 本地存储 Ghost tab 元数据
        await storeGhostTab(tab.url, {
            url: tab.url,
            title: tab.title || "",
            favicon: tab.favIconUrl || "",
            tab_id: tabId,
            vanishedAt: Date.now(),
        });

        console.log(`[Ghost] 标签页已收纳至隐藏窗口: ${tab.title}`);
        return { success: true, title: tab.title };
    } catch (err) {
        console.error("[Ghost] 收纳失败:", err);
        return { success: false, error: err.message };
    }
}

/**
 * 唤醒标签页 (Summon): 按 URL 查找 → 移回当前活动窗口 → 聚焦
 */
async function summonTab(url, storedTabId) {
    try {
        // 获取当前活动窗口（非 Ghost 窗口）
        const targetWindowId = await getCurrentWindow();
        if (!targetWindowId) {
            throw new Error("没有可用的窗口用于唤醒标签页");
        }

        // 分支 1: 尝试通过 URL 查找标签页 (会话重映射)
        let realTabId = urlToTabId.get(url);

        // 也尝试使用存储的 tab ID
        if (!realTabId && storedTabId) {
            try {
                const tab = await chrome.tabs.get(storedTabId);
                if (tab) realTabId = storedTabId;
            } catch (_) {
                // 标签页不存在
            }
        }

        if (realTabId) {
            // 完美恢复 (Perfect recovery): 将标签页移回当前窗口
            await chrome.tabs.move(realTabId, { windowId: targetWindowId, index: -1 });
            await chrome.tabs.update(realTabId, { active: true, autoDiscardable: true });
            await chrome.windows.update(targetWindowId, { focused: true });
            await removeGhostTab(url);
            console.log(`[Ghost] 标签页已唤醒 (完美恢复) 至窗口 ${targetWindowId}: ${url}`);
            return { success: true, mode: "perfect", tabId: realTabId };
        } else {
            // 灾难恢复 (Disaster recovery): 在当前窗口新建标签页
            const newTab = await chrome.tabs.create({ url, windowId: targetWindowId, active: true });
            await chrome.windows.update(targetWindowId, { focused: true });
            await removeGhostTab(url);
            console.log(`[Ghost] 标签页已唤醒 (重新加载) 至窗口 ${targetWindowId}: ${url}`);
            return { success: true, mode: "recovered", tabId: newTab.id };
        }
    } catch (err) {
        console.error("[Ghost] 唤醒失败:", err);
        return { success: false, error: err.message };
    }
}

// ─── 内容提取 ────────────────────────────────────────────────

/**
 * 使用 Readability.js + MutationObserver 提取页面内容
 * 
 * 策略:
 * 1. 注入 Readability.js 库
 * 2. 使用 MutationObserver 等待动态内容加载 (可选)
 * 3. 使用 Readability 提取主要内容
 * 4. 必要时回退到特定站点提取器
 */
async function extractPageContent(tabId) {
    try {
        // 步骤 1: 注入 Readability.js 库
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['readability.js']
        });

        // 步骤 2: 立即提取当前页面内容 (不等待)
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                // ═══ 辅助: 去重 ═══
                function deduplicate(texts) {
                    const seen = new Set();
                    return texts.filter(text => {
                        // 使用前200字符作为指纹进行去重
                        const fingerprint = text.substring(0, 200).trim();
                        if (seen.has(fingerprint)) {
                            return false;
                        }
                        seen.add(fingerprint);
                        return true;
                    });
                }

                // ═══ 辅助: 检查元素是否在侧边栏 ═══
                function isInSidebar(element) {
                    let parent = element;
                    while (parent) {
                        const tag = parent.tagName?.toLowerCase();
                        const className = (parent.className || '').toLowerCase();
                        const role = parent.getAttribute?.('role') || '';

                        // 检查是否在侧边栏区域
                        if (
                            tag === 'aside' ||
                            tag === 'nav' ||
                            role === 'navigation' ||
                            role === 'complementary' ||
                            /sidebar|sidenav|side-panel|drawer|menu|nav-|navigation|history|recent/.test(className)
                        ) {
                            return true;
                        }
                        parent = parent.parentElement;
                    }
                    return false;
                }

                // ═══ 特定站点提取器 ═══
                const siteExtractors = {
                    'gemini.google.com': () => {
                        const menuButton = document.querySelector('[data-test-id="side-nav-menu-button"]');

                        // 获取当前状态的文本
                        const getText = () => {
                            let text = document.body.innerText || '';
                            return text
                                .replace(/^\s*主菜单\s*$/gm, '')
                                .replace(/^\s*新对话\s*$/gm, '')
                                .replace(/^\s*Gemini\s*$/gm, '')
                                .replace(/^\s*最近\s*$/gm, '')
                                .replace(/^\s*设置\s*$/gm, '')
                                .replace(/^\s*帮助\s*$/gm, '')
                                .replace(/^\s*活动\s*$/gm, '')
                                .replace(/^\s*Gems\s*$/gm, '')
                                .replace(/\n{3,}/g, '\n\n')
                                .trim();
                        };

                        if (menuButton) {
                            // 获取状态1的文本
                            const text1 = getText();

                            // 点击切换侧边栏
                            menuButton.click();
                            const text2 = getText();

                            // 再点击一次恢复原状态
                            menuButton.click();

                            // 返回长度较短的结果（侧边栏隐藏时内容更少）
                            const result = text1.length <= text2.length ? text1 : text2;
                            return result.substring(0, 15000);
                        }

                        // 没有按钮时直接获取文本
                        return getText().substring(0, 15000);
                    },
                    'chatgpt.com': () => {
                        const parts = [];
                        // ChatGPT 对话 - 排除侧边栏
                        const messages = document.querySelectorAll('[data-message-author-role], .text-message, .markdown');
                        messages.forEach(msg => {
                            if (isInSidebar(msg)) return;

                            const role = msg.getAttribute('data-message-author-role');
                            const text = msg.innerText?.trim();
                            if (text && text.length > 10) {
                                const label = role === 'user' ? '用户' : (role === 'assistant' ? 'ChatGPT' : '');
                                parts.push(label ? `【${label}】${text}` : text);
                            }
                        });

                        // 备用方法
                        if (parts.length === 0) {
                            const prose = document.querySelectorAll('main .prose, [role="main"] .prose');
                            prose.forEach(p => {
                                const text = p.innerText?.trim();
                                if (text && text.length > 50) {
                                    parts.push(text);
                                }
                            });
                        }

                        // 去重
                        const uniqueParts = deduplicate(parts);
                        return uniqueParts.join('\n\n---\n\n');
                    },
                    'claude.ai': () => {
                        const parts = [];
                        // 只从主区域获取消息
                        const messages = document.querySelectorAll('main [class*="message"], main .prose, [role="main"] .prose');
                        messages.forEach(msg => {
                            if (isInSidebar(msg)) return;

                            const text = msg.innerText?.trim();
                            if (text && text.length > 20) {
                                parts.push(text);
                            }
                        });

                        // 去重
                        const uniqueParts = deduplicate(parts);
                        return uniqueParts.join('\n\n---\n\n');
                    },
                    'bilibili.com': () => {
                        const parts = [];
                        // 视频标题
                        const title = document.querySelector('h1.video-title, .video-title, h1');
                        if (title) parts.push(`【视频标题】${title.innerText.trim()}`);

                        // 视频简介
                        const desc = document.querySelector('.basic-desc-info, .desc-info-text, [class*="desc-info"]');
                        if (desc) parts.push(`【视频简介】${desc.innerText.trim()}`);

                        // UP主信息
                        const upName = document.querySelector('.up-name, .username, [class*="up-name"]');
                        if (upName) parts.push(`【UP主】${upName.innerText.trim()}`);

                        // 视频标签
                        const tags = document.querySelectorAll('.tag-link, .video-tag-container .tag, [class*="tag"]');
                        const tagTexts = [...tags].map(t => t.innerText.trim()).filter(t => t && t.length < 20);
                        if (tagTexts.length) parts.push(`【标签】${tagTexts.slice(0, 10).join('、')}`);

                        // 视频数据
                        const stats = document.querySelector('.video-info-detail, [class*="video-info"]');
                        if (stats) parts.push(`【数据】${stats.innerText.trim()}`);

                        // 评论区内容
                        const comments = document.querySelectorAll('.reply-content, .root-reply-container .reply-content');
                        const commentTexts = [...comments].slice(0, 15).map(c => c.innerText.trim()).filter(Boolean);
                        if (commentTexts.length) parts.push(`【热门评论】\n${commentTexts.join('\n---\n')}`);

                        // 推荐视频标题（作为相关内容）
                        const recTitles = document.querySelectorAll('.recommend-list .title, .video-page-card .title');
                        const recTexts = [...recTitles].slice(0, 5).map(t => t.innerText.trim()).filter(Boolean);
                        if (recTexts.length) parts.push(`【相关推荐】${recTexts.join('、')}`);

                        return parts.join('\n\n');
                    },
                    'youtube.com': () => {
                        const parts = [];
                        const title = document.querySelector('h1.ytd-video-primary-info-renderer, h1.title');
                        if (title) parts.push(`【标题】${title.innerText.trim()}`);
                        const desc = document.querySelector('#description-inline-expander, #description');
                        if (desc) parts.push(`【描述】${desc.innerText.trim()}`);
                        const channel = document.querySelector('#channel-name a, ytd-channel-name a');
                        if (channel) parts.push(`【频道】${channel.innerText.trim()}`);
                        const comments = document.querySelectorAll('#content-text');
                        const commentTexts = [...comments].slice(0, 10).map(c => c.innerText.trim());
                        if (commentTexts.length) parts.push(`【评论】\n${commentTexts.join('\n---\n')}`);
                        return parts.join('\n\n');
                    },
                    'zhihu.com': () => {
                        const parts = [];
                        const title = document.querySelector('.QuestionHeader-title, .Post-Title, h1');
                        if (title) parts.push(`【问题】${title.innerText.trim()}`);
                        const answers = document.querySelectorAll('.RichContent-inner, .Post-RichTextContainer');
                        [...answers].slice(0, 5).forEach((a, i) => {
                            parts.push(`【回答${i + 1}】${a.innerText.trim().substring(0, 2000)}`);
                        });
                        return parts.join('\n\n');
                    },
                    'github.com': () => {
                        const parts = [];
                        const repoName = document.querySelector('[itemprop="name"] a, .AppHeader-context-item-label');
                        if (repoName) parts.push(`【仓库】${repoName.innerText.trim()}`);
                        const desc = document.querySelector('[itemprop="about"], .f4.my-3');
                        if (desc) parts.push(`【描述】${desc.innerText.trim()}`);
                        const readme = document.querySelector('#readme article, .markdown-body');
                        if (readme) parts.push(`【README】${readme.innerText.trim().substring(0, 5000)}`);
                        return parts.join('\n\n');
                    },
                    'weixin.qq.com': () => {
                        const article = document.querySelector('#js_content, .rich_media_content');
                        const title = document.querySelector('#activity-name, .rich_media_title');
                        let text = '';
                        if (title) text += `【标题】${title.innerText.trim()}\n\n`;
                        if (article) text += article.innerText.trim();
                        return text;
                    },
                };

                // ═══ 主提取逻辑 (立即执行，不等待) ═══
                function extract() {
                    const hostname = location.hostname.replace('www.', '');
                    let extractedText = '';

                    // 优先尝试特定站点提取器
                    for (const [domain, extractor] of Object.entries(siteExtractors)) {
                        if (hostname.includes(domain)) {
                            try {
                                extractedText = extractor();
                                console.log(`[Ghost] 站点提取器 (${domain}): ${extractedText.length} 字符`);
                            } catch (e) {
                                console.warn(`[Ghost] 站点提取器失败:`, e);
                            }
                            break;
                        }
                    }

                    // 如果站点提取器获取到了足够的内容，直接使用
                    if (extractedText.length > 200) {
                        return {
                            text: extractedText.substring(0, 50000),
                            title: document.title || '',
                            url: location.href,
                        };
                    }

                    // 使用 Readability.js
                    try {
                        if (typeof Readability !== 'undefined') {
                            const reader = new Readability(document);
                            const article = reader.parse();
                            if (article && article.textContent && article.textContent.length > 100) {
                                let text = '';
                                if (article.title) text += `【标题】${article.title}\n\n`;
                                if (article.excerpt) text += `【摘要】${article.excerpt}\n\n`;
                                if (article.byline) text += `【作者】${article.byline}\n\n`;
                                text += article.textContent;

                                console.log(`[Ghost] Readability 提取: ${text.length} 字符`);
                                return {
                                    text: text.substring(0, 50000),
                                    title: article.title || document.title || '',
                                    url: location.href,
                                };
                            }
                        }
                    } catch (e) {
                        console.warn('[Ghost] Readability 失败:', e);
                    }

                    // 最终回退: 获取所有可见文本
                    const allText = document.body?.innerText || document.body?.textContent || '';
                    const metaDesc = document.querySelector('meta[name="description"]')?.content || '';

                    let finalText = `【页面】${document.title}\n\n`;
                    if (metaDesc) finalText += `【描述】${metaDesc}\n\n`;
                    finalText += allText;

                    console.log(`[Ghost] 回退提取: ${finalText.length} 字符`);
                    return {
                        text: finalText.substring(0, 50000),
                        title: document.title || '',
                        url: location.href,
                    };
                }

                // 立即执行提取
                return extract();
            },
        });

        return results?.[0]?.result || { text: "", title: "", url: "" };
    } catch (err) {
        console.warn("[Ghost] 内容提取失败:", err.message);
        return { text: "", title: "", url: "" };
    }
}

// ─── 后端通信 ────────────────────────────────────────────────

async function indexPage(data) {
    try {
        const res = await fetch(`${BACKEND_URL}/api/index`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
        });
        return await res.json();
    } catch (err) {
        console.warn("[Ghost] 后端索引失败 (离线?):", err.message);
        return null;
    }
}

async function searchPages(query, topK = 5) {
    try {
        const res = await fetch(`${BACKEND_URL}/api/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, top_k: topK }),
        });
        return await res.json();
    } catch (err) {
        console.warn("[Ghost] 后端搜索失败 (离线?):", err.message);
        return { results: [] };
    }
}

async function deletePage(url) {
    try {
        const res = await fetch(`${BACKEND_URL}/api/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
        });
        return await res.json();
    } catch (err) {
        console.warn("[Ghost] 后端删除失败:", err.message);
        return null;
    }
}

async function llmSearchPages(query, topK = 5) {
    try {
        const res = await fetch(`${BACKEND_URL}/api/llm-search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, top_k: topK }),
        });
        return await res.json();
    } catch (err) {
        console.warn("[Ghost] LLM 搜索失败 (离线?):", err.message);
        return { keywords: [], results: [], llm_error: err.message };
    }
}

async function getLLMConfig() {
    try {
        const res = await fetch(`${BACKEND_URL}/api/llm/config`);
        return await res.json();
    } catch (err) {
        return { config: { configured: false } };
    }
}

async function saveLLMConfig(config) {
    try {
        const res = await fetch(`${BACKEND_URL}/api/llm/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config),
        });
        return await res.json();
    } catch (err) {
        return { error: err.message };
    }
}

// ─── 本地存储辅助函数 ────────────────────────────────────────

async function storeGhostTab(url, metadata) {
    const data = await chrome.storage.local.get(GHOST_TABS_KEY);
    const tabs = data[GHOST_TABS_KEY] || {};
    tabs[url] = metadata;
    await chrome.storage.local.set({ [GHOST_TABS_KEY]: tabs });
}

async function removeGhostTab(url) {
    const data = await chrome.storage.local.get(GHOST_TABS_KEY);
    const tabs = data[GHOST_TABS_KEY] || {};
    delete tabs[url];
    await chrome.storage.local.set({ [GHOST_TABS_KEY]: tabs });
    // 同时从后端索引中删除
    await deletePage(url);
}

async function getGhostTabs() {
    const data = await chrome.storage.local.get(GHOST_TABS_KEY);
    return data[GHOST_TABS_KEY] || {};
}

async function getSettings() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return data[SETTINGS_KEY] || { allowAutoDiscard: false };
}

async function saveSettings(settings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// ─── 消息处理 (Side Panel ↔ Background) ──────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        switch (msg.type) {
            case "vanish": {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (activeTab) {
                    const result = await vanishTab(activeTab.id);
                    sendResponse(result);
                } else {
                    sendResponse({ success: false, error: "无活动标签页" });
                }
                break;
            }
            case "summon": {
                const result = await summonTab(msg.url, msg.tabId);
                sendResponse(result);
                break;
            }
            case "search": {
                const result = await searchPages(msg.query, msg.topK);
                sendResponse(result);
                break;
            }
            case "llmSearch": {
                const result = await llmSearchPages(msg.query, msg.topK);
                sendResponse(result);
                break;
            }
            case "removeGhostTab": {
                await removeGhostTab(msg.url);
                sendResponse({ success: true });
                break;
            }
            case "getGhostTabs": {
                const tabs = await getGhostTabs();
                sendResponse({ tabs });
                break;
            }
            case "getSettings": {
                const settings = await getSettings();
                sendResponse(settings);
                break;
            }
            case "saveSettings": {
                await saveSettings(msg.settings);
                sendResponse({ success: true });
                break;
            }
            case "getLLMConfig": {
                const result = await getLLMConfig();
                sendResponse(result);
                break;
            }
            case "saveLLMConfig": {
                const result = await saveLLMConfig(msg.config);
                sendResponse(result);
                break;
            }
        }
    })();
    return true; // 保持消息通道开启以进行异步响应
});
