"""ChromaDB 向量数据库封装（支持文本分块）。

提供了一个轻量级的接口，用于管理 Ghost Tab 页面 Embedding 的存储和检索。

为了解决 embedding 模型的 512 token 限制，文本在存储前会被切分为重叠的 chunk。
"""

from __future__ import annotations

import hashlib
import re
from typing import Optional

import chromadb

_client: Optional[chromadb.PersistentClient] = None
_collection: Optional[chromadb.Collection] = None

DB_PATH = "./chroma_data"
COLLECTION_NAME = "ghost_tabs"

EXPECTED_DIM = 512  # bge-small-zh-v1.5 的向量维度

# ─── 分块参数 ────────────────────────────────────────────────
# bge-small-zh-v1.5 限制为 512 tokens。
# 中文: ~1.5 字符/token → 安全长度 ≈ 384 字符
# 英文: ~4 字符/token → 安全长度 ≈ 1500 字符
# 这里使用保守的 400 字符窗口和 100 字符重叠，以兼顾中英文混合内容。
CHUNK_SIZE = 400       # 每个 chunk 的字符数
CHUNK_OVERLAP = 100    # 相邻 chunk 之间的重叠字符数
MIN_CHUNK_SIZE = 50    # 最小 chunk 长度（小于此值会被合并）


def _split_into_chunks(text: str) -> list[str]:
    """使用滑动窗口将文本切分为重叠的 chunk。

    策略：
    1. 优先尝试在句子边界（。！？.!?\n）切分，保持语义完整。
    2. 如果窗口内没有句子边界，退而求其次在标点或空白处切分。
    3. 最后手段：在 CHUNK_SIZE 处强制截断。

    返回非空文本 chunk 列表。
    """
    if not text or len(text) <= CHUNK_SIZE:
        return [text] if text and len(text) >= MIN_CHUNK_SIZE else ([text] if text else [])

    chunks = []
    start = 0
    text_len = len(text)

    while start < text_len:
        end = start + CHUNK_SIZE

        if end >= text_len:
            # 最后一个 chunk：取剩余所有内容
            chunk = text[start:].strip()
            if chunk and len(chunk) >= MIN_CHUNK_SIZE:
                chunks.append(chunk)
            elif chunk and chunks:
                # 内容太少，合并到前一个 chunk
                chunks[-1] = chunks[-1] + " " + chunk
            elif chunk:
                chunks.append(chunk)
            break

        # 尝试寻找合适的切分点
        # 在窗口末尾前 80 字符范围内寻找句子结束符
        search_region = text[max(start, end - 80):end]
        # 句末标点：中英文句号、感叹号、问号、换行
        boundary_match = None
        for m in re.finditer(r'[。！？.!?\n]', search_region):
            boundary_match = m

        if boundary_match:
            # 在句末标点后切分
            cut_pos = max(start, end - 80) + boundary_match.end()
        else:
            # 未找到句末标点，尝试空白或逗号
            search_region2 = text[max(start, end - 40):end]
            boundary_match2 = None
            for m in re.finditer(r'[\s,，;；、]', search_region2):
                boundary_match2 = m

            if boundary_match2:
                cut_pos = max(start, end - 40) + boundary_match2.end()
            else:
                # 强制截断
                cut_pos = end

        chunk = text[start:cut_pos].strip()
        if chunk and len(chunk) >= MIN_CHUNK_SIZE:
            chunks.append(chunk)
        elif chunk and chunks:
            chunks[-1] = chunks[-1] + " " + chunk

        # 移动窗口（带重叠）
        start = cut_pos - CHUNK_OVERLAP
        if start <= (cut_pos - CHUNK_SIZE):
            # 安全检查：确保窗口始终向前移动
            start = cut_pos

    return chunks if chunks else [text]


def _get_collection() -> chromadb.Collection:
    """获取或创建 ghost_tabs 集合。

    如果检测到现有集合使用不兼容的 embedding 维度，会自动重建。
    """
    global _client, _collection
    if _collection is None:
        _client = chromadb.PersistentClient(path=DB_PATH)

        # 检查现有集合是否使用了不兼容的 embedding
        try:
            existing = _client.get_collection(name=COLLECTION_NAME)
            if existing.count() > 0:
                sample = existing.get(limit=1, include=["embeddings"])
                embs = sample.get("embeddings")
                if embs is not None and len(embs) > 0 and len(embs[0]) != EXPECTED_DIM:
                    old_dim = len(embs[0])
                    print(
                        f"[VectorStore] 维度变更 ({old_dim} → {EXPECTED_DIM})。 "
                        f"正在清空集合..."
                    )
                    _client.delete_collection(name=COLLECTION_NAME)
        except Exception as e:
            print(f"[VectorStore] 跳过维度检查: {e}")
            pass  # 集合不存在，将在下面创建

        _collection = _client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
        print(
            f"[VectorStore] 集合 '{COLLECTION_NAME}' 就绪。 "
            f"({_collection.count()} 文档)"
        )
    return _collection


def _url_to_id(url: str) -> str:
    """根据 URL 生成确定性 ID（SHA256 前缀）。"""
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


def _chunk_id(url_hash: str, chunk_index: int) -> str:
    """生成 chunk 级别的文档 ID。"""
    return f"{url_hash}_chunk_{chunk_index}"


def init():
    """启动时预加载向量数据库集合。"""
    print("[VectorStore] 正在预加载集合...")
    _get_collection()
    print("[VectorStore] 集合就绪。")


def add_page(
    url: str,
    title: str,
    text: str,
    tab_id: int,
    favicon: str,
    embeddings: list[list[float]],
    chunks: list[str],
) -> dict:
    """向向量数据库添加或更新页面。

    文本已经由调用方（routes.py）切分，每个 chunk 都有对应的 embedding。
    每个 chunk 存储为一条独立的文档。

    返回包含 doc_id 前缀和 chunk 数量的字典。
    """
    col = _get_collection()
    url_hash = _url_to_id(url)

    # 首先删除该 URL 下已存在的所有 chunks
    _delete_chunks_by_url_hash(col, url_hash)

    # 准备批量数据
    ids = []
    documents = []
    embedding_list = []
    metadatas = []

    for i, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
        doc_id = _chunk_id(url_hash, i)
        ids.append(doc_id)
        documents.append(chunk_text)
        embedding_list.append(embedding)
        metadatas.append(
            {
                "url": url,
                "title": title,
                "tab_id": tab_id,
                "favicon": favicon,
                "chunk_index": i,
                "total_chunks": len(chunks),
                "url_hash": url_hash,
            }
        )

    if ids:
        col.upsert(
            ids=ids,
            documents=documents,
            embeddings=embedding_list,
            metadatas=metadatas,
        )
        print(
            f"[VectorStore] 已索引 {len(ids)} 个 chunks: {title[:50]} "
            f"(URL hash: {url_hash})"
        )

    return {"doc_id": url_hash, "chunks": len(ids)}


def _delete_chunks_by_url_hash(col: chromadb.Collection, url_hash: str):
    """根据 url_hash metadata 删除归属于某 URL 的所有 chunk。"""
    try:
        existing = col.get(
            where={"url_hash": url_hash},
            include=[],
        )
        if existing and existing["ids"]:
            col.delete(ids=existing["ids"])
    except Exception:
        # 兼容旧版本数据（可能没有 url_hash 字段）
        # 尝试按旧格式 ID 删除
        try:
            old_id = url_hash
            old_existing = col.get(ids=[old_id])
            if old_existing and old_existing["ids"]:
                col.delete(ids=old_existing["ids"])
        except Exception:
            pass


def search(
    query_embedding: list[float], top_k: int = 5, include_text: bool = False
) -> list[dict]:
    """搜索最相似的页面。

    返回包含 url, title, tab_id, favicon, score 的字典列表。
    如果 include_text=True，还会包含最佳匹配 chunk 的文本内容。

    同一 URL 的多个 chunk 会被去重 —— 只保留得分最高的那个 chunk。
    """
    col = _get_collection()
    if col.count() == 0:
        return []

    include_fields = ["metadatas", "distances"]
    if include_text:
        include_fields.append("documents")

    # 获取更多结果以便去重（top_k * 5）
    fetch_k = min(top_k * 5, col.count())

    results = col.query(
        query_embeddings=[query_embedding],
        n_results=fetch_k,
        include=include_fields,
    )

    # 按 URL 去重 —— 保留最高分
    seen_urls: dict[str, dict] = {}
    metadatas = results["metadatas"][0]
    distances = results["distances"][0]
    documents = results.get("documents", [[]])[0] if include_text else []

    for i, (meta, dist) in enumerate(zip(metadatas, distances)):
        url = meta["url"]
        score = round(1 - dist, 4)  # 余弦距离转相似度

        if url not in seen_urls or score > seen_urls[url]["score"]:
            item = {
                "url": url,
                "title": meta["title"],
                "tab_id": meta["tab_id"],
                "favicon": meta.get("favicon", ""),
                "score": score,
            }
            if include_text and i < len(documents):
                item["text"] = documents[i]
            seen_urls[url] = item

    # 按分数降序排列并截取 top_k
    items = sorted(seen_urls.values(), key=lambda x: x["score"], reverse=True)
    return items[:top_k]


def delete(url: str) -> bool:
    """根据 URL 删除页面的所有 chunks。如有删除返回 True。"""
    col = _get_collection()
    url_hash = _url_to_id(url)

    deleted_any = False

    # 按 url_hash 删除 (新格式)
    try:
        existing = col.get(
            where={"url_hash": url_hash},
            include=[],
        )
        if existing and existing["ids"]:
            col.delete(ids=existing["ids"])
            deleted_any = True
    except Exception:
        pass

    # 尝试按旧格式 ID 删除 (兼容性)
    try:
        old_existing = col.get(ids=[url_hash])
        if old_existing and old_existing["ids"]:
            col.delete(ids=old_existing["ids"])
            deleted_any = True
    except Exception:
        pass

    return deleted_any


def get_all() -> list[dict]:
    """返回所有已索引页面的元数据（已按 URL 去重）。"""
    col = _get_collection()
    if col.count() == 0:
        return []

    results = col.get(include=["metadatas"])
    seen_urls = {}
    for meta in results["metadatas"]:
        url = meta["url"]
        if url not in seen_urls:
            seen_urls[url] = {
                "url": url,
                "title": meta["title"],
                "tab_id": meta["tab_id"],
                "favicon": meta.get("favicon", ""),
                "chunks": meta.get("total_chunks", 1),
            }
    return list(seen_urls.values())


def split_text(text: str) -> list[str]:
    """文本分块的公共接口。供 routes.py 调用。"""
    return _split_into_chunks(text)
