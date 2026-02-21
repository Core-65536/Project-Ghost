"""Ghost RAG 本地后端服务。

提供基于 FastAPI 的语义索引和搜索服务。
使用 ChromaDB + Sentence-Transformers 对 Chrome Ghost Tab 内容进行处理。
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routes import router
import embedding_service
import vector_store
import llm_service


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理（启动与关闭）。"""
    # ─── 启动：预加载所有服务 ───
    print("=" * 60)
    print("[Startup] 正在初始化所有服务...")
    print("=" * 60)

    # 加载 embedding 模型 (可能需要几秒钟)
    embedding_service.init()

    # 初始化向量数据库集合
    vector_store.init()

    # 从持久化存储加载 LLM 配置
    llm_service.init()

    print("=" * 60)
    print("[Startup] 所有服务就绪！")
    print("=" * 60)

    yield

    # ─── 关闭 ───
    print("[Shutdown] 服务正在停止...")


app = FastAPI(
    title="Project Ghost RAG Backend",
    version="1.0.0",
    description="本地语义搜索引擎（Ghost Tabs）",
    lifespan=lifespan,
)

# 允许来自任何 Chrome 扩展域名的请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/")
async def root():
    return {"status": "alive", "service": "Project Ghost RAG Backend"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
