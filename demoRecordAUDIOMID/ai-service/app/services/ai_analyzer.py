import json
import re
import time
import unicodedata
from typing import Any, Dict, List, Optional, Set

import httpx
from loguru import logger
from openai import OpenAI
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.services.analysis_errors import (
    AnalysisConfigError,
    AnalysisNotImplementedError,
    AnalysisParseError,
    AnalysisProviderError,
    AnalysisUnavailableError,
)
from app.logging_utils import safe_error_message, transcript_hash_prefix


class AIAnalyzer:
    STOPWORDS = {
        "trong",
        "va",
        "và",
        "cua",
        "của",
        "nhau",
        "la",
        "là",
        "mot",
        "một",
        "cac",
        "các",
        "cho",
        "tai",
        "tại",
        "the",
        "of",
        "in",
        "on",
    }

    IT_WHITELIST_TERMS = [
        "công nghệ thông tin",
        "quản lý hệ thống máy tính",
        "bảo mật thông tin",
        "phân tích dữ liệu",
        "tự động hóa kinh doanh",
        "công nghệ phần mềm",
        "quản trị máy tính",
        "hệ thống thông tin",
        "lập trình",
    ]

    STRUCTURED_DOMAIN_MODES = {"general", "it", "business", "education"}
    STRUCTURED_SEVERITIES = {"low", "medium", "high"}

    def __init__(
        self,
        api_key: str,
        model: str = "gpt-4o",
        provider: str = "ollama",
        summary_model: str | None = None,
        analysis_domain_mode: str = "it",
        analysis_max_input_tokens: int = 12000,
        analysis_max_output_tokens: int = 4096,
        analysis_thinking_budget: Optional[int] = 0,
        analysis_retry_max_attempts: int = 3,
        gemini_max_single_request_chars: int = 50000,
        gemini_request_delay_seconds: float = 15.0,
        ollama_base_url: str = "http://127.0.0.1:11434",
        timeout_seconds: int = 300,
    ):
        requested_provider = (provider or "ollama").strip().lower()
        if requested_provider == "local":
            requested_provider = "ollama"
        if requested_provider not in {"ollama", "gemini", "openai"}:
            logger.warning(
                f"AI provider '{requested_provider}' requested but falling back to Ollama."
            )
            requested_provider = "ollama"
        self.provider = requested_provider
        self.api_key = (api_key or "").strip()
        self.client = OpenAI(api_key=self.api_key) if self.api_key else None
        self.model = model
        self.summary_model = (summary_model or model).strip() or model
        self.analysis_domain_mode = self._normalize_domain_mode(
            analysis_domain_mode, default="it"
        )
        self.analysis_max_input_tokens = max(1, int(analysis_max_input_tokens or 1))
        self.analysis_max_output_tokens = max(1, int(analysis_max_output_tokens or 1))
        self.analysis_thinking_budget = (
            None
            if analysis_thinking_budget is None
            else max(0, int(analysis_thinking_budget))
        )
        self.analysis_retry_max_attempts = max(1, int(analysis_retry_max_attempts or 1))
        self.gemini_max_single_request_chars = max(
            1, int(gemini_max_single_request_chars or 50000)
        )
        self.gemini_request_delay_seconds = max(
            0.0, float(gemini_request_delay_seconds or 0.0)
        )
        self.ollama_base_url = (ollama_base_url or "http://127.0.0.1:11434").rstrip("/")
        self.timeout_seconds = timeout_seconds
        if self.provider == "gemini":
            logger.info(
                f"Initialized AI Analyzer provider=gemini, analysis_model={self.model}, summary_model={self.summary_model}, domain_mode={self.analysis_domain_mode}, max_input_tokens={self.analysis_max_input_tokens}, max_output_tokens={self.analysis_max_output_tokens}, retry_max_attempts={self.analysis_retry_max_attempts}, timeout_seconds={self.timeout_seconds}"
            )
        elif self.provider == "openai":
            logger.info(
                f"Initialized AI Analyzer provider=openai, model={self.model}, timeout_seconds={self.timeout_seconds}"
            )
        else:
            logger.info(
                f"Initialized AI Analyzer provider=ollama, model={self.model}, base_url={self.ollama_base_url}, timeout_seconds={self.timeout_seconds}"
            )

    def _normalize_text(self, value: str) -> str:
        text = str(value or "").strip().lower()
        text = unicodedata.normalize("NFD", text)
        text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
        text = re.sub(r"[^\w\s#\+\.-]", " ", text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()

    def _phrase_in_text(self, phrase: str, normalized_text: str) -> bool:
        if not phrase or not normalized_text:
            return False
        return (
            re.search(rf"(?<!\\w){re.escape(phrase)}(?!\\w)", normalized_text)
            is not None
        )

    def _extract_candidate_phrases_by_regex(self, transcript: str) -> Set[str]:
        normalized_text = self._normalize_text(transcript)
        if not normalized_text:
            return set()

        words = [w for w in normalized_text.split() if w]
        candidates: Set[str] = set(words)

        max_ngram = 5
        for n in range(2, max_ngram + 1):
            for idx in range(0, max(0, len(words) - n + 1)):
                ngram_words = words[idx : idx + n]
                if all(word in self.STOPWORDS for word in ngram_words):
                    continue
                candidates.add(" ".join(ngram_words))

        return candidates

    def sanitize_technical_terms(
        self,
        transcript: str,
        technical_terms: List[str],
        keywords: List[str],
    ) -> List[str]:
        whitelist_map = {
            self._normalize_text(term): term for term in self.IT_WHITELIST_TERMS
        }
        whitelist_order = list(whitelist_map.keys())

        normalized_terms = {
            self._normalize_text(item)
            for item in (technical_terms or [])
            if str(item).strip()
        }
        normalized_keywords = {
            self._normalize_text(item) for item in (keywords or []) if str(item).strip()
        }
        normalized_transcript = self._normalize_text(transcript)

        selected_seen: Set[str] = set()

        # 1) Match phrase whitelist first.
        for phrase_key in whitelist_order:
            if " " not in phrase_key:
                continue
            if (
                phrase_key in normalized_terms
                or phrase_key in normalized_keywords
                or self._phrase_in_text(phrase_key, normalized_transcript)
            ):
                if phrase_key not in selected_seen:
                    selected_seen.add(phrase_key)

        # 2) Collect one-word whitelist matches (acronyms/short terms).
        for key in normalized_terms | normalized_keywords:
            if " " in key:
                continue
            if key in whitelist_map and (
                self._phrase_in_text(key, normalized_transcript)
                or key in normalized_terms
                or key in normalized_keywords
            ):
                selected_seen.add(key)

        # 3) Add transcript candidates that are in whitelist.
        for candidate in self._extract_candidate_phrases_by_regex(transcript):
            if candidate in whitelist_map:
                selected_seen.add(candidate)

        # Keep whitelist ordering stable and deterministic.
        ordered = [key for key in whitelist_order if key in selected_seen]
        return [whitelist_map[key] for key in ordered]

    def _coerce_string_list(self, values: Any) -> List[str]:
        normalized: List[str] = []
        seen: Set[str] = set()
        for item in values or []:
            text = str(item).strip()
            if not text:
                continue
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(text)
        return normalized

    def _normalize_domain_mode(self, value: Any, default: str = "it") -> str:
        normalized = str(value or default).strip().lower()
        if normalized not in self.STRUCTURED_DOMAIN_MODES:
            return default
        return normalized

    def _normalize_severity(self, value: Any) -> str:
        normalized = str(value or "").strip().lower()
        if normalized in self.STRUCTURED_SEVERITIES:
            return normalized
        return "medium"

    def _estimate_tokens(self, text: str) -> int:
        clean_text = str(text or "").strip()
        if not clean_text:
            return 0
        return max(1, len(re.findall(r"\S+", clean_text)))

    def _truncate_to_token_budget(
        self, text: str, max_tokens: int
    ) -> tuple[str, int, int]:
        clean_text = str(text or "").strip()
        if not clean_text:
            return "", 0, 0

        words = re.findall(r"\S+", clean_text)
        original_tokens = len(words)
        if original_tokens <= max_tokens:
            return clean_text, original_tokens, original_tokens

        truncated_text = " ".join(words[:max_tokens]).strip()
        return truncated_text, original_tokens, max_tokens

    def _technical_term_schema(self) -> Dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "term": {"type": "STRING"},
                "meaning": {"type": "STRING"},
                "category": {"type": "STRING"},
            },
        }

    def _pain_point_schema(self) -> Dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "title": {"type": "STRING"},
                "evidence": {"type": "STRING"},
                "severity": {"type": "STRING", "enum": ["low", "medium", "high"]},
            },
        }

    def _build_gemini_response_schema(self) -> Dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "summary": {"type": "STRING"},
                "keywords": {"type": "ARRAY", "items": {"type": "STRING"}},
                "technicalTerms": {
                    "type": "ARRAY",
                    "items": self._technical_term_schema(),
                },
                "painPoints": {
                    "type": "ARRAY",
                    "items": self._pain_point_schema(),
                },
                "actionItems": {"type": "ARRAY", "items": {"type": "STRING"}},
                "domainMode": {
                    "type": "STRING",
                    "enum": ["general", "it", "business", "education"],
                },
            },
        }

    def _coerce_structured_technical_terms(self, values: Any) -> List[Dict[str, str]]:
        normalized: List[Dict[str, str]] = []
        seen: Set[str] = set()

        for item in values or []:
            if isinstance(item, dict):
                term = str(
                    item.get("term") or item.get("name") or item.get("label") or ""
                ).strip()
                meaning = str(
                    item.get("meaning") or item.get("definition") or ""
                ).strip()
                category = str(item.get("category") or item.get("type") or "").strip()
            else:
                term = str(item).strip()
                meaning = ""
                category = ""

            if not term:
                continue

            key = term.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(
                {
                    "term": term,
                    "meaning": meaning,
                    "category": category,
                }
            )

        return normalized

    def _coerce_structured_pain_points(self, values: Any) -> List[Dict[str, str]]:
        normalized: List[Dict[str, str]] = []
        seen: Set[str] = set()

        for item in values or []:
            if isinstance(item, dict):
                title = str(item.get("title") or item.get("summary") or "").strip()
                evidence = str(item.get("evidence") or item.get("detail") or "").strip()
                severity = self._normalize_severity(item.get("severity"))
            else:
                title = str(item).strip()
                evidence = ""
                severity = "medium"

            if not title:
                continue

            key = title.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(
                {
                    "title": title,
                    "evidence": evidence,
                    "severity": severity,
                }
            )

        return normalized

    def _coerce_action_item_strings(self, values: Any) -> List[str]:
        items: List[str] = []
        seen: Set[str] = set()
        for item in values or []:
            if isinstance(item, dict):
                text = str(
                    item.get("task")
                    or item.get("description")
                    or item.get("text")
                    or item.get("title")
                    or ""
                ).strip()
            else:
                text = str(item).strip()

            if not text:
                continue

            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            items.append(text)

        return items

    def _default_structured_analysis(
        self, transcript: str, reason: str
    ) -> Dict[str, Any]:
        summary = self._build_concise_fallback_summary(transcript)

        logger.warning("GEMINI_ANALYSIS_FALLBACK reason={}", safe_error_message(reason))
        return {
            "summary": summary,
            "keywords": [],
            "technicalTerms": [],
            "painPoints": [],
            "actionItems": [],
            "domainMode": self.analysis_domain_mode,
            "technical_terms": [],
            "pain_points": [],
            "action_items": [],
            "domain_mode": self.analysis_domain_mode,
            "key_points": [],
            "decisions": [],
            "risks_blockers": [],
            "topics": [],
        }

    def _build_concise_fallback_summary(self, transcript: str) -> str:
        text = re.sub(r"\s+", " ", str(transcript or "")).strip()
        if not text:
            return "Không có nội dung transcript."

        cleaned = re.sub(r"(?i)\bSPEAKER_\d+\s*[:\-]\s*", "", text)
        cleaned = re.sub(r"(?i)\bspeaker\s*\d+\s*[:\-]\s*", "", cleaned)
        sentences = [
            sentence.strip()
            for sentence in re.split(r"(?<=[.!?。！？])\s+", cleaned)
            if sentence.strip()
        ]
        lead = sentences[0] if sentences else ""
        lead = re.sub(r"\s+", " ", lead).strip()
        if len(lead) > 120:
            lead = lead[:117].rstrip() + "..."

        if lead:
            summary = (
                f"Cuộc họp tập trung vào: {lead} "
                "Các nội dung còn lại đã được ghi nhận trong transcript."
            )
        else:
            summary = (
                "Cuộc họp đã được ghi nhận và xử lý transcript thành công. "
                "Các nội dung chi tiết vui lòng đối chiếu transcript."
            )

        if not summary:
            words = [word.strip() for word in cleaned.split() if word.strip()]
            summary = " ".join(words[:40]).strip()

        summary = re.sub(r"\s+", " ", summary).strip()
        if len(summary) > 240:
            summary = summary[:237].rstrip() + "..."

        return summary or "Không có nội dung transcript."

    def _build_gemini_analysis_json_prompt(
        self,
        transcript: str,
        metadata_text: str,
        it_guidance: str,
    ) -> str:
        return f"""
Hãy phân tích transcript sau và trả về đúng MỘT object JSON hợp lệ.

YÊU CẦU:
- Return JSON only.
- No markdown fences.
- No explanation.
- Do not copy transcript.
- Tất cả nội dung trong value phải bằng tiếng Việt (trừ tên riêng/thuật ngữ kỹ thuật).
- summary tối đa 3 câu.
- keywords tối đa 8.
- technicalTerms tối đa 8.
- painPoints tối đa 5.
- actionItems tối đa 5.
- Nếu không đủ bằng chứng, dùng mảng rỗng.
- severity chỉ dùng: low, medium, high.
- domainMode phải là "it".

{metadata_text}

{it_guidance}

Schema:
{{
    "summary": "string",
    "keywords": ["string"],
    "technicalTerms": [
        {{
            "term": "string",
            "meaning": "string",
            "category": "string"
        }}
    ],
    "painPoints": [
        {{
            "title": "string",
            "evidence": "string",
            "severity": "low|medium|high"
        }}
    ],
    "actionItems": ["string"],
    "domainMode": "it"
}}

TEXT:
{transcript}
"""

    def _extract_json_candidate(self, text: str) -> str:
        candidate = (text or "").strip()
        if not candidate:
            return candidate

        candidate = re.sub(r"^```(?:json)?\s*", "", candidate, flags=re.IGNORECASE)
        candidate = re.sub(r"\s*```$", "", candidate)

        start = candidate.find("{")
        end = candidate.rfind("}")
        if start != -1 and end != -1 and end > start:
            candidate = candidate[start : end + 1].strip()

        return candidate

    def _response_preview(self, text: str, limit: int = 200) -> str:
        preview = re.sub(r"\s+", " ", str(text or "")).strip()
        if len(preview) > limit:
            preview = preview[: limit - 3].rstrip() + "..."
        return preview

    def _response_error_preview(
        self, response: httpx.Response, limit: int = 300
    ) -> str:
        try:
            body_text = response.text
        except Exception:
            body_text = ""

        preview = self._response_preview(body_text, limit=limit)
        return preview or f"HTTP {response.status_code}"

    def _normalize_gemini_structured_analysis(
        self,
        transcript: str,
        data: Any,
    ) -> Dict[str, Any]:
        payload = data if isinstance(data, dict) else {}
        summary = str(
            payload.get("summary")
            or payload.get("overview")
            or payload.get("synthesis")
            or ""
        ).strip()
        keywords = self._coerce_string_list(
            payload.get("keywords")
            or payload.get("keyPoints")
            or payload.get("key_points")
            or payload.get("topics")
            or []
        )
        technical_terms = self._coerce_structured_technical_terms(
            payload.get("technicalTerms")
            or payload.get("technical_terms")
            or payload.get("terms")
            or []
        )
        pain_points = self._coerce_structured_pain_points(
            payload.get("painPoints") or payload.get("pain_points") or []
        )
        action_items = self._coerce_action_item_strings(
            payload.get("actionItems")
            or payload.get("action_items")
            or payload.get("nextSteps")
            or []
        )
        domain_mode = self._normalize_domain_mode(
            payload.get("domainMode")
            or payload.get("domain_mode")
            or self.analysis_domain_mode,
            default=self.analysis_domain_mode,
        )

        term_keys = {item["term"].lower() for item in technical_terms}
        keywords = [item for item in keywords if item.lower() not in term_keys]

        return {
            "summary": summary,
            "keywords": keywords,
            "technicalTerms": technical_terms,
            "painPoints": pain_points,
            "actionItems": action_items,
            "domainMode": domain_mode,
            "technical_terms": [item["term"] for item in technical_terms],
            "pain_points": pain_points,
            "action_items": [
                {"task": item, "owner": None, "deadline": None} for item in action_items
            ],
            "domain_mode": domain_mode,
            "key_points": keywords,
            "decisions": [],
            "risks_blockers": [item["title"] for item in pain_points],
            "topics": self._coerce_string_list(
                payload.get("topics")
                or keywords
                or [item["term"] for item in technical_terms]
            ),
        }

    def _resolve_gemini_thinking_budget(self, model: str, response_json: bool) -> int:
        configured_budget = self.analysis_thinking_budget
        model_name = str(model or "").strip().lower()

        if configured_budget is not None:
            return configured_budget

        if response_json and "gemini-2.5-flash" in model_name:
            return 0

        return 0

    def _normalize_action_items(self, values: Any) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        for item in values or []:
            if isinstance(item, dict):
                task = str(
                    item.get("task")
                    or item.get("description")
                    or item.get("text")
                    or ""
                ).strip()
                if not task:
                    continue
                owner = item.get("owner")
                deadline = item.get("deadline")
                normalized.append(
                    {
                        "task": task,
                        "owner": owner if str(owner).strip() else None,
                        "deadline": deadline if str(deadline).strip() else None,
                    }
                )
                continue

            task = str(item).strip()
            if task:
                normalized.append({"task": task, "owner": None, "deadline": None})
        return normalized

    def _loads_json_safe(self, text: str) -> Dict:
        cleaned = self._extract_json_object(text)
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError as e:
            repaired = self._repair_json_string(cleaned)
            if repaired != cleaned:
                try:
                    data = json.loads(repaired)
                    logger.warning(
                        "Recovered malformed JSON from Ollama response using local repair."
                    )
                except json.JSONDecodeError:
                    logger.error(f"JSON decode failed at pos={e.pos}: {e}")
                    logger.error(f"Raw response: {text}")
                    logger.error(f"Cleaned response: {cleaned}")
                    logger.error(f"Repaired attempt: {repaired}")
                    raise
            else:
                logger.error(f"JSON decode failed at pos={e.pos}: {e}")
                logger.error(f"Raw response: {text}")
                logger.error(f"Cleaned response: {cleaned}")
                raise

        if not isinstance(data, dict):
            raise ValueError(f"Expected JSON object, got {type(data).__name__}")

        data.setdefault("summary", "")
        data.setdefault("keywords", [])
        data.setdefault("technical_terms", [])
        data.setdefault("action_items", [])
        return data

    def _loads_json_strict(self, text: str) -> Dict[str, Any]:
        cleaned = self._extract_json_candidate(text)
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            repaired = self._repair_json_string(cleaned)
            if repaired != cleaned:
                try:
                    data = json.loads(repaired)
                except json.JSONDecodeError as repair_exc:
                    raise AnalysisParseError(
                        f"Gemini returned invalid JSON at pos={repair_exc.pos}: {repair_exc.msg}",
                        provider=self.provider,
                    ) from repair_exc
            else:
                raise AnalysisParseError(
                    f"Gemini returned invalid JSON at pos={exc.pos}: {exc.msg}",
                    provider=self.provider,
                ) from exc

        if not isinstance(data, dict):
            raise AnalysisParseError(
                f"Gemini returned {type(data).__name__} instead of a JSON object",
                provider=self.provider,
            )

        return data

    def _coerce_gemini_analysis(self, data: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(data, dict):
            raise AnalysisParseError(
                f"Gemini analysis payload must be an object, got {type(data).__name__}",
                provider=self.provider,
            )

        return {
            "summary": str(data.get("summary", "")).strip(),
            "key_points": self._coerce_string_list(data.get("key_points", [])),
            "decisions": self._coerce_string_list(data.get("decisions", [])),
            "action_items": self._normalize_action_items(data.get("action_items", [])),
            "risks_blockers": self._coerce_string_list(data.get("risks_blockers", [])),
            "topics": self._coerce_string_list(data.get("topics", [])),
        }

    def _metadata_to_prompt_lines(self, metadata: Optional[Dict[str, Any]]) -> str:
        if not metadata:
            return ""

        lines = ["NGỮ CẢNH BỔ SUNG:"]
        for key, value in metadata.items():
            if value is None:
                continue
            text = str(value).strip()
            if not text:
                continue
            lines.append(f"- {key}: {text}")
        return "\n".join(lines)

    def _repair_json_string(self, content: str) -> str:
        candidate = (content or "").strip()
        if not candidate:
            return candidate

        candidate = re.sub(r",\s*([}\]])", r"\1", candidate)

        # Close an unclosed quote if response is cut off.
        in_string = False
        escape = False
        for ch in candidate:
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"':
                in_string = not in_string
        if in_string:
            candidate += '"'

        # Auto-close unclosed brackets/braces while respecting string literals.
        stack = []
        in_string = False
        escape = False
        for ch in candidate:
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if ch in "[{":
                stack.append(ch)
            elif ch == "]":
                if stack and stack[-1] == "[":
                    stack.pop()
            elif ch == "}":
                if stack and stack[-1] == "{":
                    stack.pop()

        while stack:
            opener = stack.pop()
            candidate += "]" if opener == "[" else "}"

        candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
        return candidate

    def _summarize_chunk(self, chunk: str) -> str:
        if self.provider == "gemini":
            return self._summarize_chunk_with_gemini(chunk)
        if self.provider == "openai":
            raise AnalysisNotImplementedError(
                "OpenAI analysis provider is not implemented yet",
                provider=self.provider,
            )

        prompt = f"""
Hãy tóm tắt đoạn nội dung cuộc họp sau bằng tiếng Việt trong 2-3 câu.
Chỉ trả về phần tóm tắt.
Không thêm giải thích.
Giữ nguyên tên riêng, tên công nghệ, API, framework, thư viện, tên hàm, biến code hoặc thuật ngữ kỹ thuật nếu cần.

NỘI DUNG:
{chunk}
"""

        return self._summarize_chunk_with_ollama(prompt)

    def _summarize_chunk_with_gemini(
        self, chunk: str, metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        self._require_gemini_api_key()
        system_prompt = "Bạn là trợ lý tóm tắt cuộc họp. Luôn trả lời bằng tiếng Việt, trừ tên riêng và thuật ngữ kỹ thuật cần giữ nguyên."
        metadata_text = self._metadata_to_prompt_lines(metadata)
        prompt = f"""
Hãy tóm tắt đoạn nội dung cuộc họp sau bằng tiếng Việt trong 2-3 câu.
Chỉ trả về phần tóm tắt.
Không thêm giải thích.
Giữ nguyên tên riêng, tên công nghệ, API, framework, thư viện, tên hàm, biến code hoặc thuật ngữ kỹ thuật nếu cần.

{metadata_text}

NỘI DUNG:
{chunk}
"""

        return self._call_gemini_text(
            prompt=prompt,
            system_prompt=system_prompt,
            model=self.summary_model,
            temperature=0.2,
        )

    def _summarize_chunk_with_ollama(self, prompt: str) -> str:
        system_prompt = "Bạn là trợ lý tóm tắt cuộc họp. Luôn trả lời bằng tiếng Việt, trừ tên riêng và thuật ngữ kỹ thuật cần giữ nguyên."
        payload = {
            "model": self.model,
            "stream": False,
            "options": {"temperature": 0.2, "num_predict": 150},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
        }

        return self._call_ollama(
            prompt=prompt,
            system_prompt=system_prompt,
            chat_payload=payload,
            expect_json=False,
        )

    def _require_gemini_api_key(self) -> None:
        if not self.api_key:
            raise AnalysisConfigError(
                "GEMINI_API_KEY is required when analysis_provider=gemini",
                provider=self.provider,
            )

    def _call_gemini_text(
        self,
        *,
        prompt: str,
        system_prompt: str,
        model: str,
        temperature: float,
        response_json: bool = False,
        response_schema: Optional[Dict[str, Any]] = None,
        max_output_tokens: Optional[int] = None,
    ) -> str:
        self._require_gemini_api_key()
        retryable_statuses = {429, 500, 502, 503, 504}
        thinking_budget = self._resolve_gemini_thinking_budget(
            model=model,
            response_json=response_json,
        )
        base_payload: Dict[str, Any] = {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": prompt}],
                }
            ],
            "systemInstruction": {
                "parts": [{"text": system_prompt}],
            },
            "generationConfig": {
                "temperature": temperature,
                "thinkingConfig": {"thinkingBudget": thinking_budget},
            },
        }
        if max_output_tokens is not None:
            base_payload["generationConfig"]["maxOutputTokens"] = max_output_tokens
        if response_json:
            base_payload["generationConfig"]["responseMimeType"] = "application/json"

        class _GeminiMaxTokensError(Exception):
            def __init__(self, response_chars: int, schema_mode: str):
                self.response_chars = response_chars
                self.schema_mode = schema_mode
                super().__init__("Gemini response incomplete: finish_reason=MAX_TOKENS")

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.api_key,
        }

        def _retry_after_seconds(
            response: httpx.Response | None, attempt: int
        ) -> float:
            if response is not None and response.status_code == 429:
                retry_headers = getattr(response, "headers", None) or {}
                retry_after = str(retry_headers.get("Retry-After", "")).strip()
                if retry_after:
                    try:
                        return max(0.0, float(retry_after))
                    except ValueError:
                        pass
                return float(30 * attempt)

            return float(2**attempt)

        def _extract_response_text(body: Any) -> tuple[str, list[Any], Any]:
            if not isinstance(body, dict):
                raise AnalysisParseError(
                    "Gemini returned a non-JSON HTTP response",
                    provider=self.provider,
                )

            if body.get("error"):
                error_block = body.get("error")
                error_message = (
                    error_block.get("message")
                    if isinstance(error_block, dict)
                    else str(error_block)
                )
                raise AnalysisUnavailableError(
                    f"Gemini API error: {error_message}",
                    provider=self.provider,
                )

            candidates = body.get("candidates")
            if not candidates:
                raise AnalysisParseError(
                    "Gemini response did not include any candidates",
                    provider=self.provider,
                )

            content = (candidates[0].get("content") or {}).get("parts") or []
            text = "".join(
                str(part.get("text", "")) for part in content if isinstance(part, dict)
            ).strip()
            if not text:
                raise AnalysisParseError(
                    "Gemini response did not include any text content",
                    provider=self.provider,
                )
            return text, candidates, body

        def _call_once(
            current_schema: Optional[Dict[str, Any]],
            request_max_output_tokens: Optional[int],
        ) -> str:
            request_payload = json.loads(json.dumps(base_payload))
            schema_mode = "schema" if current_schema is not None else "json"
            if current_schema is not None:
                request_payload["generationConfig"]["responseSchema"] = current_schema
            else:
                request_payload["generationConfig"].pop("responseSchema", None)
            if request_max_output_tokens is not None:
                request_payload["generationConfig"][
                    "maxOutputTokens"
                ] = request_max_output_tokens

            logger.info(
                "Calling Gemini model={} response_json={} transcript_chars={} max_output_tokens={} schema_mode={} thinking_budget={}",
                model,
                response_json,
                len(prompt),
                request_max_output_tokens,
                schema_mode,
                thinking_budget,
            )

            try:
                with httpx.Client(timeout=self.timeout_seconds) as client:
                    response = None
                    max_attempts = max(1, self.analysis_retry_max_attempts)
                    for attempt in range(1, max_attempts + 1):
                        response = client.post(
                            url, headers=headers, json=request_payload
                        )

                        if response.status_code < 400:
                            body = response.json()
                            text, candidates, body_dict = _extract_response_text(body)

                            usage_metadata = body_dict.get(
                                "usageMetadata"
                            ) or body_dict.get("usage_metadata")
                            if isinstance(usage_metadata, dict):
                                input_tokens = usage_metadata.get(
                                    "promptTokenCount"
                                ) or usage_metadata.get("input_tokens")
                                output_tokens = usage_metadata.get(
                                    "candidatesTokenCount"
                                ) or usage_metadata.get("output_tokens")
                                total_tokens = usage_metadata.get(
                                    "totalTokenCount"
                                ) or usage_metadata.get("total_tokens")
                                logger.info(
                                    "GEMINI_ANALYSIS_TOKEN_USAGE input_tokens={} output_tokens={} total_tokens={}",
                                    input_tokens,
                                    output_tokens,
                                    total_tokens,
                                )

                            finish_reason = None
                            if candidates and isinstance(candidates[0], dict):
                                finish_reason = candidates[0].get(
                                    "finishReason"
                                ) or candidates[0].get("finish_reason")

                            logger.info(
                                "GEMINI_ANALYSIS_RESPONSE_META finish_reason={} response_chars={} schema_mode={} max_output_tokens={} thinking_budget={}",
                                finish_reason,
                                len(text),
                                schema_mode,
                                request_max_output_tokens,
                                thinking_budget,
                            )
                            if str(finish_reason or "").strip().upper() == "MAX_TOKENS":
                                logger.warning(
                                    "GEMINI_ANALYSIS_INCOMPLETE reason=max_tokens response_chars={}",
                                    len(text),
                                )
                                raise _GeminiMaxTokensError(
                                    response_chars=len(text),
                                    schema_mode=schema_mode,
                                )
                            logger.info(
                                f"Gemini response parse success model={model} response_chars={len(text)}"
                            )
                            return text

                        response_preview = self._response_error_preview(response)
                        logger.warning(
                            "GEMINI_ANALYSIS_HTTP_ERROR status={} response_preview={}",
                            response.status_code,
                            response_preview,
                        )

                        if response.status_code == 400:
                            raise AnalysisUnavailableError(
                                "Gemini request failed with HTTP 400",
                                provider=self.provider,
                            )

                        if response.status_code in retryable_statuses and (
                            (response.status_code == 429 and attempt < max_attempts)
                            or (response.status_code != 429 and attempt < max_attempts)
                        ):
                            wait_seconds = _retry_after_seconds(response, attempt)
                            if response.status_code == 429:
                                logger.warning(
                                    "GEMINI_ANALYSIS_RATE_LIMIT_RETRY attempt={} reason=status_429 wait_seconds={}",
                                    attempt,
                                    wait_seconds,
                                )
                            else:
                                logger.warning(
                                    "Gemini transient error status={} attempt={}/{}; retrying in {}s",
                                    response.status_code,
                                    attempt,
                                    max_attempts,
                                    wait_seconds,
                                )
                            time.sleep(wait_seconds)
                            continue

                        if response.status_code in {401, 403}:
                            raise AnalysisConfigError(
                                "Gemini API key was rejected or is missing",
                                provider=self.provider,
                            )

                        raise AnalysisUnavailableError(
                            f"Gemini request failed with HTTP {response.status_code}",
                            provider=self.provider,
                        )
            except httpx.TimeoutException as exc:
                logger.warning(
                    "GEMINI_ANALYSIS_TIMEOUT timeout_seconds={}",
                    self.timeout_seconds,
                )
                raise AnalysisUnavailableError(
                    "Gemini request timed out",
                    provider=self.provider,
                ) from exc
            except httpx.HTTPError as exc:
                raise AnalysisUnavailableError(
                    f"Gemini request failed: {exc}",
                    provider=self.provider,
                ) from exc

            raise AnalysisUnavailableError(
                "Gemini request failed without a response",
                provider=self.provider,
            )

        base_max_output_tokens = max_output_tokens
        if base_max_output_tokens is None:
            base_max_output_tokens = self.analysis_max_output_tokens
        max_tokens_retry_output_budget = min(
            4096, max(2048, int(base_max_output_tokens or 2048) * 2)
        )

        attempt_variants: List[Dict[str, Any]] = [
            {
                "schema": response_schema,
                "max_output_tokens": base_max_output_tokens,
                "reason": "primary",
            }
        ]
        schema_retry_enqueued = False
        max_tokens_retry_enqueued = False

        last_exc: Optional[AnalysisProviderError] = None
        while attempt_variants:
            variant = attempt_variants.pop(0)
            current_schema = variant["schema"]
            variant_reason = variant["reason"]
            variant_max_output_tokens = variant["max_output_tokens"]
            try:
                if variant_reason == "http_400_without_schema":
                    logger.warning(
                        "GEMINI_ANALYSIS_SCHEMA_RETRY reason=http_400_without_schema"
                    )
                if variant_reason == "max_tokens_retry":
                    logger.warning(
                        "GEMINI_ANALYSIS_SCHEMA_RETRY reason=max_tokens_response_retry_without_schema"
                    )
                return _call_once(current_schema, variant_max_output_tokens)
            except _GeminiMaxTokensError as exc:
                last_exc = AnalysisUnavailableError(
                    f"Gemini response incomplete due to MAX_TOKENS (response_chars={exc.response_chars})",
                    provider=self.provider,
                )
                if max_tokens_retry_enqueued:
                    raise last_exc
                max_tokens_retry_enqueued = True
                attempt_variants.append(
                    {
                        "schema": None,
                        "max_output_tokens": max_tokens_retry_output_budget,
                        "reason": "max_tokens_retry",
                    }
                )
                continue
            except AnalysisUnavailableError as exc:
                last_exc = exc
                if "HTTP 400" in str(exc) and current_schema is not None:
                    if not schema_retry_enqueued:
                        schema_retry_enqueued = True
                        attempt_variants.append(
                            {
                                "schema": None,
                                "max_output_tokens": variant_max_output_tokens,
                                "reason": "http_400_without_schema",
                            }
                        )
                    continue
                if variant_reason != "primary":
                    raise
                raise
            except AnalysisConfigError:
                raise

        if last_exc is not None:
            raise last_exc

        raise AnalysisUnavailableError(
            "Gemini request failed",
            provider=self.provider,
        )

    def _analyze_with_gemini(
        self, prompt: str, metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        domain_mode = self.analysis_domain_mode
        system_prompt = (
            "Bạn là trợ lý phân tích biên bản họp. Hãy trả về đúng một object JSON hợp lệ và không thêm gì khác. "
            "Tất cả nội dung trong các value phải bằng tiếng Việt, trừ tên riêng và thuật ngữ kỹ thuật cần giữ nguyên. "
            f"domainMode hiện tại là {domain_mode}."
        )
        metadata_text = self._metadata_to_prompt_lines(metadata)
        it_guidance = (
            "Nếu domainMode=it, ưu tiên thuật ngữ công nghệ, API, framework, giao thức, chuẩn, hệ thống, bảo mật và từ viết tắt kỹ thuật."
            if domain_mode == "it"
            else "Chỉ suy luận trong phạm vi domainMode đã nêu và không thêm chi tiết ngoài transcript."
        )
        json_prompt = self._build_gemini_analysis_json_prompt(
            transcript=prompt,
            metadata_text=metadata_text,
            it_guidance=it_guidance,
        )

        content = self._call_gemini_text(
            prompt=json_prompt,
            system_prompt=system_prompt,
            model=self.model,
            temperature=0.1,
            response_json=True,
            response_schema=self._build_gemini_response_schema(),
            max_output_tokens=self.analysis_max_output_tokens,
        )
        try:
            parsed = self._loads_json_strict(content)
        except AnalysisParseError as exc:
            logger.warning(
                "GEMINI_ANALYSIS_PARSE_FAILED reason={} response_preview={}",
                exc,
                self._response_preview(content),
            )
            raise
        structured = self._normalize_gemini_structured_analysis(prompt, parsed)
        if not str(structured.get("summary") or "").strip():
            raise AnalysisParseError("missing_summary", provider=self.provider)
        logger.info(
            "GEMINI_ANALYSIS_RESPONSE_PARSED keywords_count={} terms_count={} pain_points_count={} action_items_count={}",
            len(structured.get("keywords", [])),
            len(structured.get("technicalTerms", [])),
            len(structured.get("painPoints", [])),
            len(structured.get("actionItems", [])),
        )
        return structured

    def _is_usable_api_key(self) -> bool:
        if not self.api_key:
            return False

        lowered = self.api_key.lower()
        placeholder_markers = ["replace", "your_api_key", "changeme", "dummy", "test"]
        return not any(marker in lowered for marker in placeholder_markers)

    def _fallback_analysis(self, transcript: str, reason: str) -> Dict:
        text = (transcript or "").strip()
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        preview = " ".join(lines[:5]) if lines else "Không có nội dung transcript."

        words = re.findall(r"[A-Za-zÀ-ỹ][A-Za-zÀ-ỹ0-9_\-]{2,}", text)
        freq: Dict[str, int] = {}
        for w in words:
            k = w.lower()
            if k.startswith("speaker"):
                continue
            freq[k] = freq.get(k, 0) + 1

        keywords = [
            k for k, _ in sorted(freq.items(), key=lambda kv: kv[1], reverse=True)[:10]
        ]

        logger.warning(f"Using fallback analysis: {reason}")
        return {
            "summary": preview,
            "keywords": keywords,
            "technical_terms": [],
            "action_items": [],
            "technicalTerms": [],
            "painPoints": [],
            "actionItems": [],
            "domainMode": self.analysis_domain_mode,
            "pain_points": [],
            "domain_mode": self.analysis_domain_mode,
        }

    def _local_analysis(self, transcript: str) -> Dict:
        text = (transcript or "").strip()
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        summary = " ".join(lines[:5]) if lines else "Không có nội dung transcript."

        words = re.findall(r"[A-Za-zÀ-ỹ][A-Za-zÀ-ỹ0-9_\-]{2,}", text)
        freq: Dict[str, int] = {}
        for w in words:
            k = w.lower()
            if k.startswith("speaker"):
                continue
            freq[k] = freq.get(k, 0) + 1

        keywords = [
            k for k, _ in sorted(freq.items(), key=lambda kv: kv[1], reverse=True)[:10]
        ]

        return {
            "summary": summary,
            "keywords": keywords,
            "technical_terms": self._extract_technical_terms_fallback(text, keywords),
            "action_items": self._extract_action_items_fallback(text, summary),
            "technicalTerms": [],
            "painPoints": [],
            "actionItems": self._extract_action_items_fallback(text, summary),
            "domainMode": self.analysis_domain_mode,
            "pain_points": [],
            "domain_mode": self.analysis_domain_mode,
            "key_points": keywords,
            "decisions": [],
            "risks_blockers": [],
            "topics": keywords,
        }

    def _extract_technical_terms_fallback(
        self, transcript: str, keywords: List[str]
    ) -> List[str]:
        return self.sanitize_technical_terms(
            transcript=transcript,
            technical_terms=[],
            keywords=keywords,
        )

    def _extract_action_items_fallback(
        self, transcript: str, summary: str
    ) -> List[Dict]:
        lines = [
            line.strip() for line in (transcript or "").splitlines() if line.strip()
        ]
        triggers = ("cần", "nên", "phải", "hãy", "chuẩn bị", "thực hiện", "hoàn thành")

        tasks: List[str] = []
        for line in lines:
            lowered = line.lower()
            if any(trigger in lowered for trigger in triggers):
                cleaned = line.split(":", 1)[-1].strip()
                if cleaned and cleaned not in tasks:
                    tasks.append(cleaned)
            if len(tasks) >= 3:
                break

            if not tasks:
                base = summary.strip() if isinstance(summary, str) else ""
                default_task = (
                    base[:180]
                    if base
                    else "Tổng hợp nội dung chính của buổi họp và lập danh sách việc cần làm."
                )
                tasks = [default_task]

        return [{"task": task, "owner": None, "deadline": None} for task in tasks[:3]]

    def _ensure_analysis_completeness(self, transcript: str, data: Dict) -> Dict:
        if not isinstance(data, dict):
            data = {}

        data.setdefault("summary", "")
        data.setdefault("keywords", [])
        data.setdefault("technical_terms", [])
        data.setdefault("action_items", [])

        if not data.get("technical_terms"):
            data["technical_terms"] = self._extract_technical_terms_fallback(
                transcript,
                data.get("keywords", []),
            )

        if not data.get("action_items"):
            data["action_items"] = self._extract_action_items_fallback(
                transcript,
                data.get("summary", ""),
            )

        # Normalize and separate keyword vs technical_terms to avoid 100% duplication.
        def _normalize_list(items):
            normalized = []
            seen_local = set()
            for item in items or []:
                value = str(item).strip()
                if not value:
                    continue
                key = value.lower()
                if key in seen_local:
                    continue
                seen_local.add(key)
                normalized.append(value)
            return normalized

        keywords = _normalize_list(data.get("keywords", []))
        technical_terms = _normalize_list(data.get("technical_terms", []))

        technical_terms = self.sanitize_technical_terms(
            transcript=transcript,
            technical_terms=technical_terms,
            keywords=keywords,
        )

        keyword_keys = {k.lower() for k in keywords}
        technical_terms = [t for t in technical_terms if t.lower() not in keyword_keys]

        if not technical_terms:
            fallback_terms = self._extract_technical_terms_fallback(
                transcript, keywords
            )
            fallback_terms = _normalize_list(fallback_terms)
            technical_terms = [
                t for t in fallback_terms if t.lower() not in keyword_keys
            ]

        # Ensure keywords don't become too technical-only by removing exact duplicates both ways.
        term_keys = {t.lower() for t in technical_terms}
        keywords = [k for k in keywords if k.lower() not in term_keys]

        # Keep stable lengths and avoid empty output.
        data["keywords"] = keywords[:12] if keywords else data.get("keywords", [])[:12]
        data["technical_terms"] = technical_terms[:12]

        return data

    def prepare_analysis_for_storage(self, transcript: str, data: Dict) -> Dict:
        if self.provider == "gemini":
            if not isinstance(data, dict):
                data = {}
            legacy_payload = {
                "summary": str(data.get("summary", "")),
                "keywords": self._coerce_string_list(
                    data.get("keywords")
                    or data.get("key_points")
                    or data.get("topics")
                    or []
                ),
                "technical_terms": self._coerce_string_list(
                    [
                        item.get("term")
                        for item in data.get("technicalTerms", [])
                        if isinstance(item, dict) and item.get("term")
                    ]
                    or data.get("technical_terms")
                    or []
                ),
                "action_items": self._normalize_action_items(
                    data.get("actionItems") or data.get("action_items") or []
                ),
            }
            return self._ensure_analysis_completeness(transcript, legacy_payload)

        if self.provider in {"ollama", "local"}:
            return self._ensure_analysis_completeness(transcript, data)

        raise AnalysisNotImplementedError(
            "OpenAI analysis provider is not implemented yet",
            provider=self.provider,
        )

    def analyze_meeting(
        self, transcript: str, metadata: Optional[Dict[str, Any]] = None
    ) -> Dict:
        if self.provider == "gemini":
            transcript_text = str(transcript or "")
            if not transcript_text.strip():
                return self._default_structured_analysis(
                    transcript_text, "empty_transcript"
                )

            truncated_transcript, original_tokens, used_tokens = (
                self._truncate_to_token_budget(
                    transcript_text,
                    self.analysis_max_input_tokens,
                )
            )
            if original_tokens > used_tokens:
                logger.info(
                    "GEMINI_ANALYSIS_INPUT_TRUNCATED original_tokens={} used_tokens={}",
                    original_tokens,
                    used_tokens,
                )

            source = str((metadata or {}).get("source") or "unknown").strip().lower()
            transcript_prefix = transcript_hash_prefix(truncated_transcript)
            logger.info(
                "GEMINI_ANALYSIS_REQUEST provider=gemini model={} source={} domainMode={} transcript_chars={} transcript_tokens={} transcriptHashPrefix={}",
                self.model,
                source,
                self.analysis_domain_mode,
                len(truncated_transcript),
                used_tokens,
                transcript_prefix,
            )

            try:
                started_at = time.time()
                result = self._analyze_with_gemini(
                    truncated_transcript, metadata=metadata
                )
                logger.info(
                    "GEMINI_ANALYSIS_RESPONSE_PARSED provider=gemini model={} source={} durationMs={}",
                    self.model,
                    source,
                    int((time.time() - started_at) * 1000),
                )
                return result
            except AnalysisConfigError as exc:
                logger.warning(
                    "GEMINI_ANALYSIS_FAILED provider=gemini model={} source={} errorCode=ANALYSIS_CONFIG_ERROR error={}",
                    self.model,
                    source,
                    safe_error_message(exc),
                )
                logger.warning(
                    "GEMINI_ANALYSIS_FALLBACK reason={}", safe_error_message(exc)
                )
                return self._default_structured_analysis(truncated_transcript, str(exc))
            except AnalysisParseError as exc:
                logger.warning(
                    "GEMINI_ANALYSIS_FAILED provider=gemini model={} source={} errorCode=ANALYSIS_PARSE_ERROR error={}",
                    self.model,
                    source,
                    safe_error_message(exc),
                )
                logger.warning(
                    "GEMINI_ANALYSIS_FALLBACK reason={}", safe_error_message(exc)
                )
                return self._default_structured_analysis(truncated_transcript, str(exc))
            except AnalysisUnavailableError as exc:
                logger.warning(
                    "GEMINI_ANALYSIS_FAILED provider=gemini model={} source={} errorCode=ANALYSIS_UNAVAILABLE error={}",
                    self.model,
                    source,
                    safe_error_message(exc),
                )
                logger.warning(
                    "GEMINI_ANALYSIS_FALLBACK reason={}", safe_error_message(exc)
                )
                return self._default_structured_analysis(truncated_transcript, str(exc))

        if self.provider == "openai":
            raise AnalysisNotImplementedError(
                "OpenAI analysis provider is not implemented yet",
                provider=self.provider,
            )

        try:
            logger.info("Starting AI meeting analysis (chunked)")

            chunks = self._chunk_transcript(transcript)
            logger.info(f"Split into {len(chunks)} chunks")

            summaries = []
            for i, chunk in enumerate(chunks):
                logger.info(f"Processing chunk {i+1}/{len(chunks)}")
                s = self._summarize_chunk(chunk)
                summaries.append(s)

            combined_summary = "\n".join(summaries)

            final_prompt = f"""
Hãy phân tích phần tóm tắt cuộc họp sau và trả về đúng MỘT object JSON hợp lệ.

YÊU CẦU:
- Tất cả nội dung trong các value phải bằng tiếng Việt.
- Không dùng markdown.
- Không thêm giải thích ngoài JSON.
- Nếu không biết owner hoặc deadline thì để null.
- Giữ nguyên tên riêng, tên công nghệ, API, framework, thư viện, tên hàm, biến code hoặc thuật ngữ kỹ thuật nếu cần.
- "keywords" là các từ khóa chính của cuộc họp.
- "technical_terms" là các thuật ngữ kỹ thuật/chuyên ngành xuất hiện trong nội dung.
- Không lặp lại cùng một mục ở cả "keywords" và "technical_terms".
- "keywords" ưu tiên ý/chủ đề tổng quát; "technical_terms" ưu tiên tên công nghệ, chuẩn, framework, thư viện, giao thức, API, viết tắt kỹ thuật.
- "action_items" là các đầu việc cần thực hiện.

Schema:
{{
  "summary": "string",
  "keywords": ["string"],
  "technical_terms": ["string"],
  "action_items": [
    {{
      "task": "string",
      "owner": null,
      "deadline": null
    }}
  ]
}}

TEXT:
{combined_summary}
"""

            result = self._analyze_with_ollama(final_prompt)

            result = self._ensure_analysis_completeness(transcript, result)
            logger.info("AI analysis completed (chunked)")
            return result

        except Exception as e:
            logger.warning(
                "GEMINI_ANALYSIS_FAILED provider=ollama model={} source=unknown errorCode=OLLAMA_FAILURE error={}",
                self.model,
                safe_error_message(e),
            )
            fallback = self._local_analysis(transcript)
            return self._ensure_analysis_completeness(transcript, fallback)

    def _analyze_with_ollama(self, prompt: str) -> Dict:
        system_prompt = "Bạn là trợ lý phân tích biên bản họp. Hãy trả về đúng một object JSON hợp lệ và không thêm gì khác. Tất cả nội dung trong các value phải bằng tiếng Việt, trừ tên riêng và thuật ngữ kỹ thuật cần giữ nguyên."
        payload = {
            "model": self.model,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.1, "num_predict": 1000},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
        }

        try:
            content = self._call_ollama(
                prompt=prompt,
                system_prompt=system_prompt,
                chat_payload=payload,
                expect_json=True,
            )
            return self._loads_json_safe(content)
        except json.JSONDecodeError:
            logger.warning(
                "Primary Ollama analysis returned malformed JSON; requesting JSON repair from Ollama."
            )

            repair_system_prompt = (
                "Bạn là bộ sửa JSON. Chỉ được trả về đúng một object JSON hợp lệ, "
                "không markdown, không giải thích, không thêm field ngoài schema."
            )
            repair_prompt = (
                "Sửa JSON bị lỗi cú pháp sau thành JSON hợp lệ theo schema cũ. "
                "Giữ nguyên ý nghĩa nội dung, chỉ chỉnh cú pháp thiếu dấu ngoặc/dấu phẩy/ký tự thoát."
                f"\n\nJSON lỗi:\n{content}"
            )

            repair_payload = {
                "model": self.model,
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": 0,
                    "num_predict": 1200,
                },
                "messages": [
                    {"role": "system", "content": repair_system_prompt},
                    {"role": "user", "content": repair_prompt},
                ],
            }

            repaired_content = self._call_ollama(
                prompt=repair_prompt,
                system_prompt=repair_system_prompt,
                chat_payload=repair_payload,
                expect_json=True,
            )
            return self._loads_json_safe(repaired_content)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        retry=retry_if_exception_type(
            (httpx.HTTPError, httpx.TimeoutException, ValueError)
        ),
        reraise=True,
    )
    def _call_ollama(
        self,
        prompt: str,
        system_prompt: str,
        chat_payload: Dict,
        expect_json: bool,
    ) -> str:
        """Retry transient HTTP/runtime failures when calling Ollama endpoints."""
        with httpx.Client(timeout=self.timeout_seconds) as client:
            chat_response = client.post(
                f"{self.ollama_base_url}/api/chat", json=chat_payload
            )
            if chat_response.status_code != 404:
                chat_response.raise_for_status()
                chat_body = chat_response.json()
                content = (chat_body.get("message", {}) or {}).get("content", "")
                if content:
                    return content.strip()

            logger.warning(
                "Ollama /api/chat unavailable; falling back to Ollama /api/generate compatibility endpoint"
            )

            generate_payload = {
                "model": self.model,
                "stream": False,
                "prompt": f"{system_prompt}\n\n{prompt}",
                "options": chat_payload.get("options", {}),
            }
            if expect_json:
                generate_payload["format"] = "json"

            generate_response = client.post(
                f"{self.ollama_base_url}/api/generate",
                json=generate_payload,
            )
            generate_response.raise_for_status()
            generate_body = generate_response.json()
            content = (generate_body.get("response", "") or "").strip()
            if not content:
                raise ValueError(
                    f"Empty response from Ollama generate API: {generate_body}"
                )
            return content

    def generate_summary(self, transcript: str) -> str:
        result = self.analyze_meeting(transcript)
        return result.get("summary", "")

    def extract_keywords(self, transcript: str) -> List[str]:
        result = self.analyze_meeting(transcript)
        return result.get("keywords", [])

    def extract_technical_terms(self, transcript: str) -> List[str]:
        result = self.analyze_meeting(transcript)
        return result.get("technical_terms", [])

    def extract_action_items(self, transcript: str) -> List[Dict]:
        result = self.analyze_meeting(transcript)
        return result.get("action_items", [])

    def format_transcript_for_analysis(self, aligned_segments: List[Dict]) -> str:
        lines = []

        for segment in aligned_segments:
            speaker = segment.get("speaker", "UNKNOWN")
            text = segment.get("text", "")
            start = segment.get("start", 0)

            time_str = f"[{int(start//60):02d}:{int(start%60):02d}]"
            lines.append(f"{time_str} {speaker}: {text}")

        return "\n".join(lines)
