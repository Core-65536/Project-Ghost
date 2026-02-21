"""基于 OpenAI 兼容接口的 LLM 智能搜索服务。

支持任何 OpenAI 兼容的 API 端点（如 OpenAI, DeepSeek, Ollama, vLLM 等）。
LLM 负责分析用户查询并生成用于向量检索的搜索关键词。
"""

from __future__ import annotations

import json
import os
from typing import Optional

import httpx

from models import LLMConfig

# ─── 默认配置 ────────────────────────────────────────────────
_config: Optional[LLMConfig] = None
CONFIG_FILE = "./llm_config.json"

SYSTEM_PROMPT = """你是一个搜索查询优化助手。用户会用自然语言描述他们想找的网页标签页。

你的任务：
1. 理解用户的真实搜索意图
2. 生成3-5个最可能匹配目标网页内容的搜索关键词/短语
3. 关键词应该覆盖不同角度（标题关键词、内容关键词、主题关键词）
4. 同时生成中文和英文关键词以提高召回率

请严格以 JSON 格式返回，不要有其他文字：
{"keywords": ["关键词1", "keyword2", "关键词3", ...]}"""


def _save_config_to_file(config: LLMConfig) -> None:
    """将 LLM 配置保存到本地持久化文件。"""
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "base_url": config.base_url,
                    "api_key": config.api_key,
                    "model": config.model,
                },
                f,
                ensure_ascii=False,
                indent=2,
            )
        print(f"[LLMService] 配置已保存至 {CONFIG_FILE}")
    except Exception as e:
        print(f"[LLMService] 保存配置失败: {e}")


def _load_config_from_file() -> Optional[LLMConfig]:
    """从本地文件加载 LLM 配置。"""
    if not os.path.exists(CONFIG_FILE):
        return None
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return LLMConfig(
            base_url=data.get("base_url", ""),
            api_key=data.get("api_key", ""),
            model=data.get("model", ""),
        )
    except Exception as e:
        print(f"[LLMService] 加载配置失败: {e}")
        return None


def init() -> None:
    """初始化 LLM 服务，加载配置文件。"""
    global _config
    print("[LLMService] 正在加载配置文件...")
    _config = _load_config_from_file()
    if _config and _config.api_key:
        masked_key = _config.api_key[:8] + "..." if len(_config.api_key) > 8 else "***"
        print(
            f"[LLMService] 配置已加载: {_config.model} @ {_config.base_url} (key: {masked_key})"
        )
    else:
        print("[LLMService] 未找到配置。相关功能暂不可用。")


def get_config() -> Optional[LLMConfig]:
    """获取当前 LLM 配置。"""
    return _config


def set_config(config: LLMConfig) -> None:
    """设置并保存新的 LLM 配置。"""
    global _config
    _config = config
    # 持久化保存
    _save_config_to_file(config)


async def generate_keywords(user_query: str) -> dict:
    """调用 LLM 将自然语言查询转换为搜索关键词。

    返回:
        包含 "keywords" 列表和 "raw_response" 字符串的字典。
    """
    if not _config or not _config.api_key:
        return {"error": "LLM 未配置，请在设置中填写 API 信息", "keywords": []}

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {_config.api_key}",
    }

    payload = {
        "model": _config.model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"我想找的网页：{user_query}"},
        ],
        "temperature": 0.3,
        "max_completion_tokens": 1024,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            url = _config.base_url.rstrip("/") + "/chat/completions"
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()

        data = resp.json()
        content = data["choices"][0]["message"]["content"].strip()

        # 解析 LLM 返回的 JSON (处理 markdown 代码块)
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]
            content = content.strip()

        result = json.loads(content)
        keywords = result.get("keywords", [])
        return {"keywords": keywords, "raw_response": content}

    except httpx.HTTPStatusError as e:
        return {"error": f"LLM API 错误: {e.response.status_code}", "keywords": []}
    except json.JSONDecodeError:
        # LLM 没有返回有效的 JSON
        return {"error": "LLM 返回格式异常", "keywords": [], "raw_response": content}
    except Exception as e:
        return {"error": f"LLM 调用失败: {str(e)}", "keywords": []}
