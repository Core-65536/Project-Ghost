"""API 请求/响应的 Pydantic 模型定义。"""

from __future__ import annotations

from typing import Optional
from pydantic import BaseModel


class IndexRequest(BaseModel):
    """索引页面请求（从 Chrome 侧边栏发送）。"""
    url: str
    title: str
    text: str
    tab_id: int
    favicon: str = ""


class DeleteRequest(BaseModel):
    """从向量库删除页面的请求。"""
    url: str


class SearchRequest(BaseModel):
    """普通语义搜索请求。"""
    query: str
    top_k: int = 5


class SearchResult(BaseModel):
    """单条搜索结果。"""
    url: str
    title: str
    tab_id: int
    favicon: str
    score: float


class SearchResponse(BaseModel):
    """搜索结果响应。"""
    results: list[SearchResult]


# ─── LLM 配置相关 ─────────────────────────────────────────────

class LLMConfig(BaseModel):
    """OpenAI 兼容的 LLM API 配置。"""
    base_url: str = "https://api.xiaomimimo.com/v1"
    api_key: str = ""
    model: str = "mimo-v2-flash"


class LLMSearchRequest(BaseModel):
    """基于 LLM 的智能搜索请求。"""
    query: str
    top_k: int = 5


class LLMSearchResponse(BaseModel):
    """智能搜索响应（包含生成的关键词和重排序结果）。"""
    keywords: list[str]
    results: list[SearchResult]
    llm_error: Optional[str] = None


# ─── Agent 相关 ────────────────────────────────────────────

class AgentChatRequest(BaseModel):
    """Agent 对话请求。"""
    query: str
