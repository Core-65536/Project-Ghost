"""基于 Sentence-Transformers + ONNX Runtime 的 Embedding 服务。

采用懒加载模式，避免阻塞服务器启动。
使用 BAAI/bge-small-zh-v1.5 模型配合 ONNX 后端。

- 模型: BAAI/bge-small-zh-v1.5 (512维度, 中英文, 512 tokens)
- 后端: ONNX Runtime (CPU 优化)
- 内存: ~100MB
- 速度: ~5ms 每条
"""

from __future__ import annotations

import os
from typing import Optional
from sentence_transformers import SentenceTransformer

_model: Optional[SentenceTransformer] = None
MODEL_NAME = "BAAI/bge-small-zh-v1.5"
LOCAL_ONNX_PATH = "./models/bge-small-zh-onnx"


def _get_model() -> SentenceTransformer:
    """懒加载 ONNX 后端的 embedding 模型。

    优先尝试从本地缓存加载。如果未找到，则从 Hugging Face 下载并导出为 ONNX 格式保存。
    """
    global _model 
    if _model is None:
        if os.path.exists(LOCAL_ONNX_PATH):
            print(
                f"[EmbeddingService] 正在从 {LOCAL_ONNX_PATH} 加载缓存的 ONNX 模型..."
            )
            _model = SentenceTransformer(LOCAL_ONNX_PATH, backend="onnx")
        else:
            print(f"[EmbeddingService] 首次运行: 正在将 {MODEL_NAME} 导出为 ONNX...")
            print("[EmbeddingService] 这可能需要几分钟...")
            _model = SentenceTransformer(
                MODEL_NAME, backend="onnx", model_kwargs={"export": True}
            )
            _model.save_pretrained(LOCAL_ONNX_PATH)
            print(f"[EmbeddingService] ONNX 模型已保存至 {LOCAL_ONNX_PATH}")

        dim = _model.get_sentence_embedding_dimension()
        print(f"[EmbeddingService] 模型已加载。维度={dim}")
    return _model


def encode(text: str) -> list[float]:
    """将文本编码为 embedding 向量。"""
    model = _get_model()
    embedding = model.encode(text, normalize_embeddings=True)
    return embedding.tolist()


def encode_batch(texts: list[str]) -> list[list[float]]:
    """批量将文本编码为 embedding 向量。"""
    model = _get_model()
    embeddings = model.encode(texts, normalize_embeddings=True)
    return embeddings.tolist()


def init():
    """在启动时预加载 embedding 模型。"""
    print("[EmbeddingService] 正在预加载模型...")
    _get_model()
    print("[EmbeddingService] 模型就绪。")
