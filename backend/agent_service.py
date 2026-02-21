"""Ghost Agent 核心服务 — ReAct 推理循环。

实现基于 OpenAI Function Calling 的 ReAct Agent：
1. 接收用户查询
2. LLM 思考并决定调用哪个工具
3. 执行工具并将结果反馈给 LLM
4. 循环直到 LLM 生成最终回答或达到最大步数

支持 SSE 流式推送，实时展示思考过程。
"""

from __future__ import annotations

import json
from typing import Any, AsyncGenerator

import httpx

import llm_service
from agent_tools import TOOLS_SCHEMA, dispatch_tool


# ─── 配置 ──────────────────────────────────────────────────

MAX_STEPS = 15  # 最大推理步数，防止无限循环
REQUEST_TIMEOUT = 60.0  # LLM API 超时时间（秒）

AGENT_SYSTEM_PROMPT = """你是 Ghost Agent，一个行动导向的智能标签页助手。你不仅能搜索信息，更重要的是你能**执行操作**——帮用户将标签页重新打开到浏览器中。

你的工具：
1. **search_tabs(query, top_k)** - 语义搜索，返回标题、URL、相似度分数和内容预览
2. **read_tab(url)** - 读取某个标签页的完整文本（仅在需要深入了解内容时使用）
3. **list_tabs()** - 列出所有已收纳的标签页
4. **batch_restore(urls, reason)** - 【核心能力】批量恢复标签页，在用户浏览器中重新打开

⚠️ 关键行为规则（务必遵守）：
1. **你是行动型 Agent，不是搜索引擎。** 当用户要求"找到XX"、"帮我找XX"、"显示XX"、"打开XX"时，你应该在搜索到结果后**主动调用 batch_restore 恢复这些页面**，而不是仅仅列出链接。
2. **搜索结果已经包含预览**，不需要逐个 read_tab。只在用户明确要求"总结内容"、"对比分析"时才使用 read_tab，且最多读 2-3 篇。
3. **回答要简洁**。找到结果后简短说明找到了什么、已恢复了哪些页面即可。不要写冗长的总结报告。
4. 用中文回答。回答时提及页面标题作为引用。

典型工作流程：
- 用户说"找到Golang相关的文章" → search_tabs("Golang") → batch_restore(相关URLs) → 简短回答"已为你恢复N个Golang相关页面"
- 用户说"我之前看的Redis文章讲了什么" → search_tabs("Redis") → read_tab(最佳匹配URL) → 总结内容
- 用户说"列出我所有的收藏" → list_tabs() → 展示列表"""


# ─── SSE 事件类型 ───────────────────────────────────────────

class AgentEvent:
    """Agent 推理过程中的事件，用于 SSE 流式推送。"""

    THINKING = "thinking"       # Agent 正在思考（LLM 推理中）
    TOOL_CALL = "tool_call"     # Agent 决定调用工具
    TOOL_RESULT = "tool_result" # 工具执行结果
    ANSWER = "answer"           # 最终回答
    ERROR = "error"             # 错误
    ACTION = "action"           # 需要前端执行的动作（如 batch_restore）

    def __init__(self, event_type: str, data: dict[str, Any]):
        self.type = event_type
        self.data = data

    def to_sse(self) -> str:
        """转为 SSE 格式字符串。"""
        payload = json.dumps(
            {"type": self.type, **self.data},
            ensure_ascii=False,
        )
        return f"data: {payload}\n\n"


# ─── Agent 核心循环 ────────────────────────────────────────


async def run_agent(user_query: str) -> AsyncGenerator[AgentEvent, None]:
    """执行 Agent 推理循环，yield SSE 事件。

    这是一个异步生成器，每个 yield 都会通过 SSE 实时推送给前端。
    """
    config = llm_service.get_config()
    if not config or not config.api_key:
        yield AgentEvent(AgentEvent.ERROR, {
            "message": "LLM 未配置，请在设置中填写 API 信息后再使用 Agent 功能",
        })
        return

    # 构建初始消息列表
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": AGENT_SYSTEM_PROMPT},
        {"role": "user", "content": user_query},
    ]

    # 收集所有 batch_restore 动作
    restore_actions: list[dict[str, Any]] = []

    # ReAct 循环
    for step in range(MAX_STEPS):
        yield AgentEvent(AgentEvent.THINKING, {
            "step": step + 1,
            "message": f"正在思考 (步骤 {step + 1}/{MAX_STEPS})...",
        })

        # 调用 LLM
        try:
            response = await _call_llm(config, messages)
        except Exception as e:
            yield AgentEvent(AgentEvent.ERROR, {
                "message": f"LLM 调用失败: {str(e)}",
            })
            return

        choice = response["choices"][0]
        message = choice["message"]

        # 检查是否有工具调用
        tool_calls = message.get("tool_calls")

        if tool_calls:
            # Agent 决定调用工具
            # 先将 assistant 消息（含 tool_calls）加入历史
            messages.append(message)

            for tool_call in tool_calls:
                func = tool_call["function"]
                tool_name = func["name"]
                tool_id = tool_call["id"]

                # 解析参数
                try:
                    tool_args = json.loads(func["arguments"])
                except json.JSONDecodeError:
                    tool_args = {}

                yield AgentEvent(AgentEvent.TOOL_CALL, {
                    "step": step + 1,
                    "tool": tool_name,
                    "arguments": tool_args,
                })

                # 执行工具
                print(f"[Agent] Step {step + 1}: {tool_name}({tool_args})")
                tool_result = dispatch_tool(tool_name, tool_args)

                # 如果是 batch_restore，收集动作
                if tool_name == "batch_restore" and tool_result.get("action") == "batch_restore":
                    restore_actions.append(tool_result)

                yield AgentEvent(AgentEvent.TOOL_RESULT, {
                    "step": step + 1,
                    "tool": tool_name,
                    "result": _summarize_result(tool_result),
                })

                # 将工具结果加入消息历史
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_id,
                    "content": json.dumps(tool_result, ensure_ascii=False),
                })

        else:
            # 没有工具调用 → Agent 生成了最终回答
            answer = message.get("content", "")

            # 如果有 batch_restore 动作，先发送动作事件
            if restore_actions:
                # 合并所有要恢复的 URL
                all_urls = []
                for action in restore_actions:
                    all_urls.extend(action.get("urls", []))
                # 去重
                all_urls = list(dict.fromkeys(all_urls))

                yield AgentEvent(AgentEvent.ACTION, {
                    "action": "batch_restore",
                    "urls": all_urls,
                    "count": len(all_urls),
                })

            yield AgentEvent(AgentEvent.ANSWER, {
                "content": answer,
                "steps_used": step + 1,
            })
            return

    # 达到最大步数仍未完成
    yield AgentEvent(AgentEvent.ANSWER, {
        "content": "抱歉，我进行了多步推理但未能得出最终结论。请尝试更具体的问题。",
        "steps_used": MAX_STEPS,
        "truncated": True,
    })


# ─── LLM 通信 ─────────────────────────────────────────────


async def _call_llm(config, messages: list[dict]) -> dict:
    """调用 OpenAI 兼容的 LLM API（含 Function Calling）。"""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config.api_key}",
    }

    payload = {
        "model": config.model,
        "messages": messages,
        "tools": TOOLS_SCHEMA,
        "temperature": 0.3,
        "max_completion_tokens": 2048,
    }

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        url = config.base_url.rstrip("/") + "/chat/completions"
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()

    return resp.json()


# ─── 辅助函数 ──────────────────────────────────────────────


def _summarize_result(result: dict) -> dict:
    """精简工具结果的展示信息（用于前端显示，非 LLM 上下文）。"""
    summary = {}

    if "error" in result:
        summary["status"] = "error"
        summary["message"] = result["error"]
    elif "found" in result:
        summary["status"] = "success"
        summary["found"] = result["found"]
        if result.get("results"):
            summary["titles"] = [r["title"] for r in result["results"][:5]]
    elif "count" in result and "tabs" in result:
        summary["status"] = "success"
        summary["count"] = result["count"]
    elif "content" in result:
        summary["status"] = "success"
        summary["title"] = result.get("title", "")
        summary["length"] = len(result.get("content", ""))
    elif "action" in result:
        summary["status"] = "action"
        summary["action"] = result["action"]
        summary["count"] = result.get("count", 0)
    else:
        summary["status"] = "success"

    return summary
