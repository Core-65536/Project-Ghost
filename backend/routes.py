"""Ghost RAG 后端 API 路由定义。"""

from __future__ import annotations

from fastapi import APIRouter

from models import (
    IndexRequest,
    DeleteRequest,
    SearchRequest,
    SearchResponse,
    SearchResult,
    LLMConfig,
    LLMSearchRequest,
    LLMSearchResponse,
)
import embedding_service
import vector_store
import llm_service
import reranker_service

router = APIRouter(prefix="/api")


@router.post("/index")
async def index_page(req: IndexRequest):
    """索引页面：文本分块 -> 批量 Embedding -> 存储至 ChromaDB。"""
    # 如果没有文本内容，尝试回退使用标题
    text_to_embed = req.text.strip() if req.text else ""
    if not text_to_embed:
        text_to_embed = req.title

    if not text_to_embed:
        return {
            "status": "error",
            "message": "没有可索引的内容（文本和标题均为空）",
        }

    # 步骤 1: 将文本切割为重叠的 chunks
    chunks = vector_store.split_text(text_to_embed)

    # 打印日志
    print(f"\n{'='*60}")
    print(f"[Index] URL: {req.url}")
    print(f"[Index] 标题: {req.title}")
    print(f"[Index] 文本长度: {len(text_to_embed)} 字符 → {len(chunks)} chunks")
    for i, chunk in enumerate(chunks[:3]):
        print(f"[Index] Chunk {i}: {chunk[:80]}...")
    if len(chunks) > 3:
        print(f"[Index] ... 还有 {len(chunks) - 3} 个 chunks")
    print(f"{'='*60}\n")

    # 步骤 2: 批量生成 Embedding
    embeddings = embedding_service.encode_batch(chunks)

    # 步骤 3: 存储所有 chunks
    result = vector_store.add_page(
        url=req.url,
        title=req.title,
        text=text_to_embed,
        tab_id=req.tab_id,
        favicon=req.favicon,
        embeddings=embeddings,
        chunks=chunks,
    )
    return {"status": "ok", "doc_id": result["doc_id"], "chunks": result["chunks"]}


@router.post("/search", response_model=SearchResponse)
async def search_pages(req: SearchRequest):
    """在所有索引的 Ghost Tab 中进行语义搜索。"""
    query_embedding = embedding_service.encode(req.query)
    results = vector_store.search(query_embedding, top_k=req.top_k)
    return SearchResponse(results=[SearchResult(**r) for r in results])


@router.post("/llm-search", response_model=LLMSearchResponse)
async def llm_search(req: LLMSearchRequest):
    """基于 LLM 的智能搜索与重排序。

    流程:
    1. 用户查询 -> LLM -> 生成优化后的搜索关键词
    2. 对每个关键词 -> 向量检索 (召回阶段)
    3. 合并并去重结果
    4. Cross-Encoder (LLM) 重排序 (精排阶段)
    5. 返回 Top-K 结果
    """
    # 步骤 1: LLM 生成关键词
    llm_result = await llm_service.generate_keywords(req.query)
    keywords = llm_result.get("keywords", [])
    llm_error = llm_result.get("error")

    # 如果 LLM 失败或未生成关键词，降级为直接搜索
    if not keywords:
        keywords = [req.query]

    # 步骤 2: 召回阶段 - 扩大搜索范围以供后续重排
    recall_top_k = min(req.top_k * 3, 20)
    seen_urls = {}  # url → best SearchResult
    for keyword in keywords:
        query_embedding = embedding_service.encode(keyword)
        results = vector_store.search(
            query_embedding, top_k=recall_top_k, include_text=True
        )
        for r in results:
            url = r["url"]
            if url not in seen_urls or r["score"] > seen_urls[url]["score"]:
                seen_urls[url] = r

    # 步骤 3: 合并结果
    merged = sorted(seen_urls.values(), key=lambda x: x["score"], reverse=True)

    # 步骤 4: 重排序阶段 - 使用 Cross-Encoder
    reranked = await reranker_service.rerank(
        query=req.query,
        documents=merged,
        top_k=req.top_k,
        use_llm=True,
    )

    # 清理内部字段并归一化分数
    for r in reranked:
        # 使用 final_score 作为展示分数
        if "final_score" in r:
            r["score"] = r.pop("final_score") / 100.0  # 归一化到 0-1
        r.pop("text", None)
        r.pop("rerank_score", None)

    return LLMSearchResponse(
        keywords=keywords,
        results=[SearchResult(**r) for r in reranked],
        llm_error=llm_error,
    )


@router.post("/delete")
async def delete_page(req: DeleteRequest):
    """从索引中移除页面。"""
    deleted = vector_store.delete(req.url)
    return {"status": "ok", "deleted": deleted}


@router.get("/list")
async def list_pages():
    """列出所有已索引的 Ghost Tabs。"""
    pages = vector_store.get_all()
    return {"status": "ok", "pages": pages}


# ─── LLM 配置接口 ─────────────────────────────────────────────


@router.get("/llm/config")
async def get_llm_config():
    """获取当前 LLM 配置（API Key 已脱敏）。"""
    config = llm_service.get_config()
    if config:
        masked_key = config.api_key[:8] + "..." if len(config.api_key) > 8 else "***"
        return {
            "status": "ok",
            "config": {
                "base_url": config.base_url,
                "api_key_masked": masked_key,
                "model": config.model,
                "configured": bool(config.api_key),
            },
        }
    return {"status": "ok", "config": {"configured": False}}


@router.post("/llm/config")
async def set_llm_config(config: LLMConfig):
    """更新 LLM 配置。"""
    llm_service.set_config(config)
    return {"status": "ok"}
