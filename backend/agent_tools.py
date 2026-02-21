"""Ghost Agent 工具集定义。

每个工具对应 Agent 可以调用的一个能力：
- search_tabs: 语义搜索 ghost tabs
- read_tab: 读取某个 ghost tab 的完整内容
- list_tabs: 列出所有 ghost tabs
- batch_restore: 批量恢复一组 ghost tabs
"""

from __future__ import annotations

from typing import Any

import embedding_service
import vector_store


# ─── 工具注册表 ────────────────────────────────────────────

TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "search_tabs",
            "description": (
                "在用户的 Ghost Tabs（已收纳的浏览器标签页）中进行语义搜索。"
                "输入自然语言查询，返回最相关的标签页列表及其相似度分数。"
                "适用于：用户想找某个主题/关键词相关的标签页时。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索查询（自然语言），例如 'Redis 分布式锁' 或 'Python 异步编程'",
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "返回结果数量，默认 5",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_tab",
            "description": (
                "读取某个 Ghost Tab 的完整文本内容。"
                "需要先通过 search_tabs 或 list_tabs 获取 URL，然后用此工具读取详细内容。"
                "适用于：需要深入了解某篇文章的具体内容、提取关键信息、对比多篇文章时。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "要读取的标签页 URL",
                    },
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_tabs",
            "description": (
                "列出用户所有已收纳的 Ghost Tabs 的基本信息（标题、URL）。"
                "不包含文本内容，仅用于概览。"
                "适用于：想了解用户收纳了哪些标签页、统计数量时。"
            ),
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "batch_restore",
            "description": (
                "批量恢复一组 Ghost Tabs，将它们重新打开为浏览器标签页。"
                "这是一个ACTION工具，会真正在用户的浏览器中打开这些页面。"
                "使用前务必先搜索/确认要恢复的页面，不要盲目恢复。"
                "适用于：用户要求打开/恢复某些标签页时。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "urls": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "要恢复的标签页 URL 列表",
                    },
                    "reason": {
                        "type": "string",
                        "description": "简述恢复这些标签页的理由",
                    },
                },
                "required": ["urls", "reason"],
            },
        },
    },
]


# ─── 工具实现 ──────────────────────────────────────────────


def execute_search_tabs(query: str, top_k: int = 5) -> dict[str, Any]:
    """执行语义搜索。"""
    query_embedding = embedding_service.encode(query)
    results = vector_store.search(
        query_embedding, top_k=top_k, include_text=True
    )

    # 格式化输出供 Agent 阅读
    if not results:
        return {"found": 0, "message": "没有找到匹配的标签页", "results": []}

    formatted = []
    for r in results:
        formatted.append({
            "title": r["title"],
            "url": r["url"],
            "score": r["score"],
            "text_preview": (r.get("text", "")[:200] + "...") if r.get("text") else "",
        })

    return {
        "found": len(formatted),
        "results": formatted,
    }


def execute_read_tab(url: str) -> dict[str, Any]:
    """读取某个 tab 的完整内容。通过 URL 在 ChromaDB 中查找。"""
    col = vector_store._get_collection()
    url_hash = vector_store._url_to_id(url)

    try:
        existing = col.get(
            where={"url_hash": url_hash},
            include=["documents", "metadatas"],
        )

        if not existing or not existing["ids"]:
            return {"error": f"未找到 URL 对应的内容: {url}"}

        # 将所有 chunks 拼接为完整文本
        chunks = []
        title = ""
        for i, (doc, meta) in enumerate(
            zip(existing["documents"], existing["metadatas"])
        ):
            if not title and meta.get("title"):
                title = meta["title"]
            chunks.append({"index": meta.get("chunk_index", i), "text": doc})

        # 按 chunk_index 排序
        chunks.sort(key=lambda x: x["index"])
        full_text = "\n".join(c["text"] for c in chunks)

        return {
            "url": url,
            "title": title,
            "total_chunks": len(chunks),
            "content": full_text[:5000],  # 限制长度以防上下文溢出
            "truncated": len(full_text) > 5000,
        }

    except Exception as e:
        return {"error": f"读取失败: {str(e)}"}


def execute_list_tabs() -> dict[str, Any]:
    """列出所有已索引的 ghost tabs。"""
    pages = vector_store.get_all()

    if not pages:
        return {"count": 0, "message": "当前没有任何收纳的标签页", "tabs": []}

    tabs = []
    for p in pages:
        tabs.append({
            "title": p["title"],
            "url": p["url"],
            "chunks": p.get("chunks", 1),
        })

    return {"count": len(tabs), "tabs": tabs}


def execute_batch_restore(urls: list[str], reason: str) -> dict[str, Any]:
    """批量恢复标签页（返回动作描述，实际打开由前端完成）。"""
    if not urls:
        return {"error": "未指定要恢复的 URL"}

    return {
        "action": "batch_restore",
        "urls": urls,
        "count": len(urls),
        "reason": reason,
    }


# ─── 工具调度器 ────────────────────────────────────────────


def dispatch_tool(name: str, arguments: dict) -> dict[str, Any]:
    """根据工具名和参数，调度执行对应的工具函数。"""
    if name == "search_tabs":
        return execute_search_tabs(
            query=arguments["query"],
            top_k=arguments.get("top_k", 5),
        )
    elif name == "read_tab":
        return execute_read_tab(url=arguments["url"])
    elif name == "list_tabs":
        return execute_list_tabs()
    elif name == "batch_restore":
        return execute_batch_restore(
            urls=arguments["urls"],
            reason=arguments.get("reason", ""),
        )
    else:
        return {"error": f"未知工具: {name}"}
