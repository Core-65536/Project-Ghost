"""搜索结果重排序服务（Reranker）。

使用 LLM 作为 Cross-Encoder（或本地模型）对初步检索结果进行重排序，
基于文档与查询的深层语义相关性进行打分。
"""

from __future__ import annotations

import json
from typing import Optional

import httpx

from models import LLMConfig

# 复用 llm_service 中的配置
import llm_service


RERANK_SYSTEM_PROMPT = """你是一个搜索结果重排序专家。用户会给你一个搜索查询和多个候选文档。

你的任务：
1. 评估每个文档与查询的相关性
2. 重点考虑：文档是否真正回答/解决了用户的问题，而不仅仅是提到了关键词
3. 目录、导航、列表类内容应该被降权，因为它们只是提及问题而没有展开
4. 给每个文档打分（0-100），分数越高表示越相关

请严格以 JSON 格式返回：
{"scores": [{"index": 0, "score": 85, "reason": "简短理由"}, ...]}"""


async def rerank_with_llm(
    query: str,
    documents: list[dict],
    top_k: int = 5,
) -> list[dict]:
    """使用 LLM 作为 Cross-Encoder 对文档进行重排序。

    Args:
        query: 原始用户查询
        documents: 包含 url, title, text, score 等字段的文档列表
        top_k: 返回结果数量

    Returns:
        重排序后的文档列表（格式同输入）
    """
    config = llm_service.get_config()

    if not config or not config.api_key:
        print("[Reranker] LLM 未配置，跳过重排序")
        return documents[:top_k]

    if not documents:
        return []

    # 构建文档描述供 LLM 评估
    doc_descriptions = []
    for i, doc in enumerate(documents):
        title = doc.get("title", "无标题")
        # 使用文本预览（如果有），否则仅使用标题
        text_preview = doc.get("text", "")[:500] if doc.get("text") else ""
        doc_descriptions.append(f"[文档 {i}]\n标题: {title}\n内容预览: {text_preview}")

    user_message = f"""搜索查询: {query}

候选文档:
{chr(10).join(doc_descriptions)}

请对以上 {len(documents)} 个文档进行相关性评分。"""

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config.api_key}",
    }

    payload = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": RERANK_SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        "temperature": 0.1,  # 低温以保证评分稳定性
        "max_completion_tokens": 2048,
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            url = config.base_url.rstrip("/") + "/chat/completions"
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()

        data = resp.json()
        content = data["choices"][0]["message"]["content"].strip()

        # 解析 LLM 返回的 JSON
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]
            content = content.strip()

        result = json.loads(content)
        scores = result.get("scores", [])

        # 构建分数映射表
        score_map = {item["index"]: item["score"] for item in scores}

        # 应用 LLM 评分
        for i, doc in enumerate(documents):
            llm_score = score_map.get(i, 50)  # 默认 50 分
            doc["rerank_score"] = llm_score
            # 结合原始 embedding 分数与 rerank 分数
            # 公式: 0.3 * embedding_score + 0.7 * rerank_score (归一化后)
            original_score = doc.get("score", 0)
            doc["final_score"] = 0.3 * (original_score * 100) + 0.7 * llm_score

        # 按最终分数排序
        reranked = sorted(
            documents, key=lambda x: x.get("final_score", 0), reverse=True
        )

        print(f"[Reranker] 已重排序 {len(documents)} 个文档")
        for i, doc in enumerate(reranked[:top_k]):
            print(
                f"  #{i+1}: {doc.get('title', 'N/A')[:40]} | "
                f"embed={doc.get('score', 0):.3f} | "
                f"rerank={doc.get('rerank_score', 0)} | "
                f"final={doc.get('final_score', 0):.1f}"
            )

        return reranked[:top_k]

    except Exception as e:
        print(f"[Reranker] 错误: {e}, 回退到原始顺序")
        return documents[:top_k]


def rerank_by_heuristics(
    query: str,
    documents: list[dict],
    top_k: int = 5,
) -> list[dict]:
    """轻量级启发式重排序（无需 LLM）。

    对看起来像目录/导航的内容进行降权。
    这是当 LLM 不可用时的回退方案。
    """
    import re

    query_lower = query.lower()
    query_terms = set(re.findall(r"\w+", query_lower))

    for doc in documents:
        score = doc.get("score", 0)
        text = doc.get("text", "") or doc.get("title", "")
        text_lower = text.lower()

        # 惩罚因子
        penalty = 1.0

        # 检查是否像目录(TOC)
        lines = text.strip().split("\n")
        lines = [l.strip() for l in lines if l.strip()]

        if lines:
            avg_line_len = sum(len(l) for l in lines) / len(lines)

            # 平均行长过短（可能是目录）
            if avg_line_len < 20:
                penalty *= 0.7

            # 列表项密度过高
            list_pattern = re.compile(r"^(\d+\.|-|•|\*|\[)", re.IGNORECASE)
            list_ratio = sum(1 for l in lines if list_pattern.match(l)) / len(lines)
            if list_ratio > 0.5:
                penalty *= 0.6

        # 奖励因子：查询关键词命中给加分
        term_matches = sum(1 for term in query_terms if term in text_lower)
        bonus = 1 + (term_matches * 0.05)

        # 应用调整
        doc["final_score"] = score * penalty * bonus

    reranked = sorted(documents, key=lambda x: x.get("final_score", 0), reverse=True)
    return reranked[:top_k]


async def rerank(
    query: str,
    documents: list[dict],
    top_k: int = 5,
    use_llm: bool = True,
) -> list[dict]:
    """重排序主入口函数。

    Args:
        query: 原始搜索查询
        documents: 向量检索召回的文档
        top_k: 返回结果数量
        use_llm: 是否使用 LLM 进行重排序（False 则使用启发式规则）

    Returns:
        重排序后的文档列表
    """
    if not documents:
        return []

    if use_llm:
        config = llm_service.get_config()
        if config and config.api_key:
            return await rerank_with_llm(query, documents, top_k)

    # 回退到启发式重排序
    return rerank_by_heuristics(query, documents, top_k)
