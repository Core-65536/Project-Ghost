<p align="center">
  <img src="extension/icons/icon128.png" alt="Project Ghost Logo" width="80" />
</p>

<h1 align="center">👻 Project Ghost</h1>

<p align="center">
  <strong>内存常驻型 AI Agent 标签页管理系统 — 不关闭，只隐身</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white" />
  <img src="https://img.shields.io/badge/Python-3.12+-3776AB?logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white" />
  <img src="https://img.shields.io/badge/ChromaDB-向量数据库-FF6F00" />
  <img src="https://img.shields.io/badge/Agent-ReAct-4ade80?logo=openai&logoColor=white" />
  <img src="https://img.shields.io/badge/License-MIT-green" />
</p>

---

## 📖 简介

**Project Ghost** 是一个基于 Chrome 扩展 + 本地 RAG 后端的智能标签页管理系统。它允许你将当前标签页"幽灵化"——从浏览器中隐藏，但内容会被自动提取、向量化并存入本地数据库。之后，你可以通过**语义搜索**、**AI 智能搜索**或**智能 Agent 对话**随时找回这些页面。

### ✨ 核心特性

- 🔮 **一键收纳** — 快捷键 `Alt+G` 将当前标签页收入幽灵空间
- 🔍 **语义搜索** — 基于 BGE 向量模型的本地语义检索，支持中英文
- 🤖 **AI 搜索** — LLM 驱动的关键词生成 + Cross-Encoder 重排序，搜索更精准
- 🧠 **Ghost Agent** — 基于 ReAct 框架的智能助手，支持多步推理、自主调用工具、批量恢复标签页
- 📦 **完全本地** — 所有数据存储在本地 ChromaDB，隐私无忧
- ⚡ **ONNX 加速** — Embedding 模型使用 ONNX Runtime，CPU 推理仅需 ~5ms

---

## 🖼️ 截图预览

### 主界面

> 简洁的侧边栏设计，一键收纳，快速搜索。

<!-- 截图1: 主界面 -->
<img width="584" height="676" alt="dc7c22847a6420fe7c09c767ddc497ae" src="https://github.com/user-attachments/assets/0b02189c-d362-4388-b63e-3c69d8b4f72b" />


### AI 搜索结果

> LLM 自动生成多维度关键词，召回最相关的幽灵标签页。

<!-- 截图2: AI 搜索结果 -->
<img width="587" height="625" alt="image" src="https://github.com/user-attachments/assets/89713883-0880-4c62-9e18-6dd0be5f7eaf" />


### Agent 自动回答网页内容问题 + 自动恢复相关网页

> LLM 自动回答网页内容问题 + 自动恢复相关网页。

<!-- 截图3: Agent 工作 -->
<img width="585" height="836" alt="4d17c58dfdd3f3077ac076b61b8a06fd" src="https://github.com/user-attachments/assets/c65e15fa-ed36-4c42-a1f0-546878df3812" />



### 实际使用效果

> 在浏览网页时打开侧边栏，即可从幽灵空间中检索相关页面。

<!-- 截图4: 实际使用效果 -->
<img width="2013" height="1257" alt="image" src="https://github.com/user-attachments/assets/54b65ce2-b919-4110-a2e5-928de2b33526" />

---

## 🏗️ 架构概览

```
Chrome-RAG/
├── extension/                # Chrome 扩展 (Manifest V3)
│   ├── manifest.json         # 扩展配置
│   ├── background.js         # Service Worker (标签页管理 + Agent 通信)
│   ├── sidepanel.html/js/css # 侧边栏 UI (搜索/管理/Agent 对话)
│   ├── readability.js        # 网页正文提取
│   └── icons/                # 扩展图标
│
├── backend/                  # Python 本地后端
│   ├── main.py               # FastAPI 入口 (uvicorn)
│   ├── routes.py             # API 路由定义
│   ├── models.py             # Pydantic 数据模型
│   ├── embedding_service.py  # ONNX Embedding 服务 (BGE-small-zh)
│   ├── vector_store.py       # ChromaDB 向量数据库封装
│   ├── llm_service.py        # LLM 智能搜索服务
│   ├── reranker_service.py   # 搜索结果重排序 (Cross-Encoder)
│   ├── agent_service.py      # Ghost Agent 核心 (ReAct 推理循环)
│   ├── agent_tools.py        # Agent 工具集定义 (4 个工具)
│   ├── llm_config.json       # LLM 配置文件 (API Key 等)
│   ├── models/               # 本地 ONNX 模型缓存
│   └── requirements.txt      # Python 依赖
│
├── .gitignore
└── README.md
```

---

## 🔧 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| **浏览器扩展** | Chrome Extension (MV3) | Service Worker + Side Panel API |
| **后端框架** | FastAPI + Uvicorn | 异步 Python Web 层 |
| **Embedding 模型** | BAAI/bge-small-zh-v1.5 | 512 维, 中英文, ONNX 加速 |
| **向量数据库** | ChromaDB | 本地持久化, 轻量级 |
| **LLM 接口** | OpenAI 兼容 API | 支持 OpenAI / DeepSeek / Ollama 等 |
| **重排序** | LLM Cross-Encoder | 结合 Embedding 分数与 LLM 评分 |
| **Agent 框架** | ReAct + Function Calling | 多步推理，自主调用工具链 |
| **网页正文提取** | Readability.js | 自动提取页面主体内容 |

---

## 🚀 快速开始

### 前置要求

- **Python** 3.12+
- **Google Chrome** 浏览器
- （可选）任意 OpenAI 兼容 LLM API（用于 AI 搜索和 Agent 功能）

### 1. 启动后端服务

```bash
# 克隆项目
git clone https://github.com/your-repo/Chrome-RAG.git
cd Chrome-RAG/backend

# 创建虚拟环境
python -m venv venv

# 激活虚拟环境
# Windows:
.\venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 启动服务 (默认监听 127.0.0.1:8000)
python main.py
```

> ⚠️ 首次启动会自动下载并导出 ONNX 格式的 Embedding 模型（约 100MB），请耐心等待。后续启动将直接从本地缓存加载。

### 2. 安装 Chrome 扩展

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择项目中的 `extension/` 目录
5. 固定扩展到工具栏

### 3. 配置 LLM（可选）

如需使用 AI 搜索和 Agent 功能，点击侧边栏中的 ⚙️ 设置按钮，填写：

- **Base URL** — LLM API 地址（如 `https://api.openai.com/v1`）
- **API Key** — 你的 API Key
- **Model** — 模型名称（如 `gpt-4o-mini`，需支持 Function Calling）

---

## 📡 API 接口

后端服务运行在 `http://127.0.0.1:8000`，提供以下接口：

| 方法 | 端点 | 说明 |
|------|------|------|
| `POST` | `/api/index` | 索引页面（文本分块 → Embedding → 存储） |
| `POST` | `/api/search` | 语义搜索 |
| `POST` | `/api/llm-search` | AI 智能搜索（LLM 关键词 + 重排序） |
| `POST` | `/api/agent-chat` | Agent 对话（SSE 流式响应） |
| `POST` | `/api/delete` | 删除已索引页面 |
| `GET`  | `/api/list` | 列出所有幽灵标签页 |
| `GET`  | `/api/llm/config` | 获取 LLM 配置（Key 已脱敏） |
| `POST` | `/api/llm/config` | 更新 LLM 配置 |

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt + G` | 收纳当前标签页到幽灵空间 |
| `Alt + S` | 打开搜索侧边栏 |

---

## 🔍 搜索流程

### 语义搜索
```
用户查询 → Embedding → ChromaDB 向量检索 → Top-K 结果
```

### AI 智能搜索
```
用户查询 → LLM 生成关键词 → 多关键词向量召回 → 合并去重
         → LLM Cross-Encoder 重排序 → Top-K 精排结果
```

重排序评分公式：`final_score = 0.3 × embedding_score + 0.7 × rerank_score`

### 🧠 Ghost Agent

```
用户提问
    ↓
┌── ReAct 推理循环 (最多 15 步) ──────────────┐
│                                              │
│  LLM 思考 → 选择工具 → 执行 → 观察结果       │
│       ↑                          ↓           │
│       └──────── 继续推理 ←───────┘           │
│                                              │
│  可用工具:                                    │
│  ├─ search_tabs  — 语义搜索幽灵标签页         │
│  ├─ read_tab     — 阅读页面完整内容           │
│  ├─ list_tabs    — 列出所有收纳页面           │
│  └─ batch_restore— 批量恢复到浏览器 (Action)  │
│                                              │
└──────────────────────────────────────────────┘
    ↓
SSE 实时推送思考过程 → 前端展示
    ↓
最终回答 + 执行操作 (如: 自动打开相关标签页)
```

**Agent 对话示例：**

| 用户输入 | Agent 行为 |
|---------|-----------|
| "找到所有 Golang 相关的文章" | 搜索 → 批量恢复 → "已为你打开 7 个相关页面" |
| "我之前看的 Redis 文章讲了什么" | 搜索 → 阅读内容 → 总结核心要点 |
| "对比 React 和 Vue 收藏文章的观点" | 多次搜索 → 分别阅读 → 生成对比分析 |

---

## 📝 开发说明

- 后端开发模式启用了 `reload=True`，代码修改后自动重载
- Embedding 模型缓存位于 `backend/models/`，该目录已被 `.gitignore` 忽略
- LLM 配置文件 `llm_config.json` 包含 API Key 等敏感信息，同样已被忽略
- Agent 功能依赖 LLM 的 **Function Calling** 能力，需使用支持该特性的模型

---

## 📄 License

MIT License
