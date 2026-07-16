import json
import re
import time
import unicodedata
from typing import Any, Callable, Dict, List, Optional, Set

import httpx
from loguru import logger
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.logging_utils import safe_error_message, transcript_hash_prefix
from app.services.analysis_errors import (
    AnalysisConfigError,
    AnalysisNotImplementedError,
    AnalysisParseError,
    AnalysisProviderError,
    AnalysisUnavailableError,
)
from app.services.analysis_versioning import resolve_analysis_versions
from app.services.education_analysis import (
    build_education_prompt_rules,
    build_education_system_instruction,
    build_fallback_education_study,
    coerce_allowed_segment_ids,
    education_study_gemini_schema,
    extract_education_study_raw,
    normalize_education_study,
)
from app.services.gemini_fault_injection import resolve_gemini_http_client_factory
from app.services.gemini_client import GeminiClient
from app.services.gemini_key_manager import GeminiKeyConfigError, GeminiKeyManager

# Internal-only analyze metadata: used for post-validation, not Gemini prompt text.
_INTERNAL_ANALYSIS_METADATA_KEYS = frozenset(
    {
        "allowedSegmentIds",
        "allowed_segment_ids",
    }
)


class AIAnalyzer:
    PROMPT_VERSION = "gemini-business-v2"
    SCHEMA_VERSION = "gemini-business-v2"
    ANALYSIS_FEATURE_SET = "grouped-action-plan-v1"

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
    ACTION_ITEM_PRIORITIES = {"low", "medium", "high"}
    ACTION_ITEM_STATUSES = {
        "open",
        "in_progress",
        "blocked",
        "done",
    }
    LEGACY_ACTION_ITEM_STATUS_MAP = {
        "pending": "open",
        "completed": "done",
        "cancelled": "blocked",
    }

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
        gemini_rate_limit_retry_base_seconds: float = 30.0,
        gemini_rate_limit_retry_max_seconds: float = 90.0,
        gemini_retry_quota_exceeded: bool = False,
        gemini_max_tokens_retry_enabled: bool = True,
        gemini_max_single_request_chars: int = 50000,
        gemini_request_delay_seconds: float = 15.0,
        gemini_api_keys: str = "",
        gemini_multi_key_enabled: bool = False,
        gemini_max_attempts: int = 3,
        gemini_key_cooldown_seconds: float = 90.0,
        gemini_key_hard_cooldown_seconds: float = 900.0,
        gemini_backoff_base_ms: float = 500.0,
        gemini_backoff_max_ms: float = 10000.0,
        gemini_backoff_jitter: bool = True,
        gemini_fail_fast_seconds: float = 30.0,
        ollama_base_url: str = "http://127.0.0.1:11434",
        timeout_seconds: int = 300,
        http_client_factory: Callable[..., Any] | None = None,
    ):
        requested_provider = (provider or "ollama").strip().lower()
        if requested_provider == "local":
            requested_provider = "ollama"
        if requested_provider not in {"ollama", "gemini"}:
            logger.warning(
                f"AI provider '{requested_provider}' requested but falling back to Ollama."
            )
            requested_provider = "ollama"
        self.provider = requested_provider
        self.api_key = (api_key or "").strip()
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
        self.gemini_rate_limit_retry_base_seconds = max(
            0.0, float(gemini_rate_limit_retry_base_seconds or 0.0)
        )
        self.gemini_rate_limit_retry_max_seconds = max(
            0.0, float(gemini_rate_limit_retry_max_seconds or 0.0)
        )
        self.gemini_retry_quota_exceeded = bool(gemini_retry_quota_exceeded)
        self.gemini_max_tokens_retry_enabled = bool(gemini_max_tokens_retry_enabled)
        self.gemini_max_single_request_chars = max(
            1, int(gemini_max_single_request_chars or 50000)
        )
        self.gemini_request_delay_seconds = max(
            0.0, float(gemini_request_delay_seconds or 0.0)
        )
        self.gemini_multi_key_enabled = bool(gemini_multi_key_enabled)
        self.gemini_max_attempts = max(1, int(gemini_max_attempts or 1))
        self.gemini_key_cooldown_seconds = max(
            0.0, float(gemini_key_cooldown_seconds or 0.0)
        )
        self.gemini_key_hard_cooldown_seconds = max(
            0.0, float(gemini_key_hard_cooldown_seconds or 0.0)
        )
        self.gemini_backoff_base_ms = max(0.0, float(gemini_backoff_base_ms or 0.0))
        self.gemini_backoff_max_ms = max(0.0, float(gemini_backoff_max_ms or 0.0))
        self.gemini_backoff_jitter = bool(gemini_backoff_jitter)
        self.gemini_fail_fast_seconds = max(0.0, float(gemini_fail_fast_seconds or 0.0))
        self.ollama_base_url = (ollama_base_url or "http://127.0.0.1:11434").rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.gemini_key_manager = None
        self.gemini_client = None
        if self.provider == "gemini" and (
            self.api_key or (gemini_api_keys or "").strip()
        ):
            try:
                cooldown_store = None
                if self.gemini_multi_key_enabled:
                    from app.config import get_settings

                    settings = get_settings()
                    if settings.gemini_shared_cooldown_enabled:
                        import redis

                        from app.services.gemini_key_cooldown_store import (
                            RedisGeminiKeyCooldownStore,
                        )

                        redis_client = redis.Redis.from_url(
                            settings.job_state_redis_url,
                            decode_responses=True,
                        )
                        cooldown_store = RedisGeminiKeyCooldownStore(redis_client)
                self.gemini_key_manager = GeminiKeyManager.from_config(
                    gemini_api_key=self.api_key,
                    gemini_api_keys=gemini_api_keys,
                    multi_key_enabled=self.gemini_multi_key_enabled,
                    cooldown_store=cooldown_store,
                )
            except GeminiKeyConfigError as exc:
                raise AnalysisConfigError(str(exc), provider="gemini") from exc
            from app.config import get_settings
            from app.services.gemini_client import resolve_http_client_factory

            settings = get_settings()
            test_mode = str(settings.gemini_client_test_mode or "").strip()
            if http_client_factory is not None:
                resolved_http_client_factory = http_client_factory
                gemini_http_proxy = ""
            elif test_mode:
                resolved_http_client_factory = resolve_gemini_http_client_factory(
                    test_mode
                )
                gemini_http_proxy = ""
            else:
                resolved_http_client_factory, gemini_http_proxy = (
                    resolve_http_client_factory(
                        proxy=settings.gemini_http_proxy,
                        base_factory=httpx.Client,
                    )
                )
            self.gemini_client = GeminiClient(
                self.gemini_key_manager,
                max_attempts=self.gemini_max_attempts,
                key_cooldown_seconds=self.gemini_key_cooldown_seconds,
                key_hard_cooldown_seconds=self.gemini_key_hard_cooldown_seconds,
                backoff_base_ms=self.gemini_backoff_base_ms,
                backoff_max_ms=self.gemini_backoff_max_ms,
                backoff_jitter=self.gemini_backoff_jitter,
                fail_fast_seconds=self.gemini_fail_fast_seconds,
                http_proxy=gemini_http_proxy,
                http_client_factory=resolved_http_client_factory,
                sleep=time.sleep,
            )
        if self.provider == "gemini":
            logger.info(
                f"Initialized AI Analyzer provider=gemini, analysis_model={self.model}, summary_model={self.summary_model}, domain_mode={self.analysis_domain_mode}, max_input_tokens={self.analysis_max_input_tokens}, max_output_tokens={self.analysis_max_output_tokens}, retry_max_attempts={self.analysis_retry_max_attempts}, timeout_seconds={self.timeout_seconds}, rate_limit_retry_base_seconds={self.gemini_rate_limit_retry_base_seconds}, rate_limit_retry_max_seconds={self.gemini_rate_limit_retry_max_seconds}, retry_quota_exceeded={self.gemini_retry_quota_exceeded}, max_tokens_retry_enabled={self.gemini_max_tokens_retry_enabled}"
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

    def _resolve_analysis_domain_mode(
        self, metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        if metadata:
            requested = metadata.get("domainMode") or metadata.get("domain_mode")
            if requested:
                return self._normalize_domain_mode(
                    requested,
                    default=self.analysis_domain_mode,
                )
        return self.analysis_domain_mode

    def _domain_guidance_for_mode(self, domain_mode: str) -> str:
        if domain_mode == "it":
            return (
                "Nếu domainMode=it, ưu tiên thuật ngữ công nghệ, API, framework, "
                "giao thức, chuẩn, hệ thống, bảo mật và từ viết tắt kỹ thuật."
            )
        if domain_mode == "business":
            return (
                "Nếu domainMode=business, ưu tiên quyết định, rủi ro, blocker, owner, "
                "deadline, KPI, tác động kinh doanh/khách hàng và bước tiếp theo có thể thực thi."
            )
        if domain_mode == "education":
            return (
                "Nếu domainMode=education, ưu tiên mục tiêu học tập, nội dung bài giảng, "
                "đánh giá, bài tập, tiến độ học viên, câu hỏi cần làm rõ và việc cần chuẩn bị. "
                "Đồng thời luôn trả về educationStudy (object bắt buộc) đúng schema education-study-v1; "
                "không được bỏ trống hoặc omit field educationStudy."
            )
        if domain_mode == "general":
            return (
                "Nếu domainMode=general, giữ ngôn ngữ trung tính, tóm tắt quyết định và "
                "việc cần làm mà không ép thuật ngữ chuyên ngành ngoài transcript."
            )
        return "Chỉ suy luận trong phạm vi domainMode đã nêu và không thêm chi tiết ngoài transcript."

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

    def _grouped_subtask_schema(self) -> Dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "id": {"type": "STRING"},
                "text": {"type": "STRING"},
                "confidence": {
                    "type": "STRING",
                    "enum": ["SUPPORTED", "INFERRED", "NEEDS_REVIEW"],
                },
                "evidenceKeywords": {"type": "ARRAY", "items": {"type": "STRING"}},
            },
        }

    def _grouped_item_schema(self) -> Dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "id": {"type": "STRING"},
                "title": {"type": "STRING"},
                "description": {"type": "STRING"},
                "subtasks": {"type": "ARRAY", "items": self._grouped_subtask_schema()},
                "owner": {"type": "STRING"},
                "deadline": {"type": "STRING"},
                "priority": {"type": "STRING", "enum": ["low", "medium", "high"]},
                "status": {
                    "type": "STRING",
                    "enum": ["open", "in_progress", "blocked", "done"],
                },
                "confidence": {
                    "type": "STRING",
                    "enum": ["SUPPORTED", "INFERRED", "NEEDS_REVIEW"],
                },
                "evidenceKeywords": {"type": "ARRAY", "items": {"type": "STRING"}},
                "sourceActionItemIds": {"type": "ARRAY", "items": {"type": "STRING"}},
            },
        }

    def _grouped_section_schema(self) -> Dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "id": {"type": "STRING"},
                "order": {"type": "NUMBER"},
                "title": {"type": "STRING"},
                "summary": {"type": "STRING"},
                "items": {"type": "ARRAY", "items": self._grouped_item_schema()},
            },
        }

    def _grouped_note_schema(self) -> Dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "text": {"type": "STRING"},
                "confidence": {
                    "type": "STRING",
                    "enum": ["SUPPORTED", "INFERRED", "NEEDS_REVIEW"],
                },
                "evidenceKeywords": {"type": "ARRAY", "items": {"type": "STRING"}},
            },
        }

    def _grouped_action_plan_schema(self) -> Dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "version": {"type": "STRING"},
                "language": {"type": "STRING", "enum": ["vi", "en", "mixed"]},
                "intro": {"type": "STRING"},
                "sections": {"type": "ARRAY", "items": self._grouped_section_schema()},
                "notes": {"type": "ARRAY", "items": self._grouped_note_schema()},
            },
        }

    def _action_item_schema(self) -> Dict[str, Any]:
        return {
            "type": "OBJECT",
            "properties": {
                "task": {"type": "STRING"},
                "owner": {"type": "STRING"},
                "deadline": {"type": "STRING"},
                "dueDate": {"type": "STRING"},
                "priority": {"type": "STRING", "enum": ["low", "medium", "high"]},
                "status": {
                    "type": "STRING",
                    "enum": [
                        "open",
                        "in_progress",
                        "blocked",
                        "done",
                    ],
                },
                "evidenceKeywords": {"type": "ARRAY", "items": {"type": "STRING"}},
                "evidence": {"type": "STRING"},
            },
        }

    def _build_gemini_response_schema(
        self, domain_mode: str | None = None
    ) -> Dict[str, Any]:
        schema: Dict[str, Any] = {
            "type": "OBJECT",
            "properties": {
                "summary": {"type": "STRING"},
                "meetingSummary": {"type": "STRING"},
                "keywords": {"type": "ARRAY", "items": {"type": "STRING"}},
                "technicalTerms": {
                    "type": "ARRAY",
                    "items": self._technical_term_schema(),
                },
                "painPoints": {
                    "type": "ARRAY",
                    "items": self._pain_point_schema(),
                },
                "action_items": {"type": "ARRAY", "items": self._action_item_schema()},
                "keyDecisions": {"type": "ARRAY", "items": {"type": "STRING"}},
                "risks": {"type": "ARRAY", "items": {"type": "STRING"}},
                "blockers": {"type": "ARRAY", "items": {"type": "STRING"}},
                "questions": {"type": "ARRAY", "items": {"type": "STRING"}},
                "deadlines": {"type": "ARRAY", "items": {"type": "STRING"}},
                "owners": {"type": "ARRAY", "items": {"type": "STRING"}},
                "nextSteps": {"type": "ARRAY", "items": {"type": "STRING"}},
                "businessImpact": {"type": "STRING"},
                "customerImpact": {"type": "STRING"},
                "technicalImpact": {"type": "STRING"},
                "confidence": {"type": "NUMBER"},
                "promptVersion": {"type": "STRING"},
                "schemaVersion": {"type": "STRING"},
                "domainMode": {
                    "type": "STRING",
                    "enum": ["general", "it", "business", "education"],
                },
                "groupedActionPlan": self._grouped_action_plan_schema(),
                "analysisFeatureSet": {"type": "STRING"},
            },
        }
        normalized_domain = self._normalize_domain_mode(
            domain_mode or self.analysis_domain_mode,
            default=self.analysis_domain_mode,
        )
        required = [
            "summary",
            "meetingSummary",
            "keywords",
            "technicalTerms",
            "domainMode",
        ]
        if normalized_domain == "education":
            schema["properties"]["educationStudy"] = education_study_gemini_schema()
            required.append("educationStudy")
        schema["required"] = required
        return schema

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

    def _normalize_optional_text(
        self, value: Any, max_chars: int = 240
    ) -> Optional[str]:
        text = str(value or "").strip()
        if not text:
            return None
        if len(text) > max_chars:
            return text[:max_chars].rstrip() + "..."
        return text

    def _normalize_confidence(self, value: Any) -> Optional[float]:
        if isinstance(value, bool) or value is None:
            return None

        parsed: Optional[float] = None
        if isinstance(value, (int, float)):
            parsed = float(value)
        elif isinstance(value, str):
            raw = value.strip().replace("%", "")
            if not raw:
                return None
            try:
                parsed = float(raw)
            except ValueError:
                return None

        if parsed is None:
            return None

        if parsed > 1.0 and parsed <= 100.0:
            parsed = parsed / 100.0

        parsed = max(0.0, min(1.0, parsed))
        return round(parsed, 3)

    def _normalize_action_item_priority(self, value: Any) -> Optional[str]:
        normalized = str(value or "").strip().lower()
        if normalized in self.ACTION_ITEM_PRIORITIES:
            return normalized
        return None

    def _normalize_action_item_status(self, value: Any) -> Optional[str]:
        normalized = str(value or "").strip().lower()
        if normalized in self.ACTION_ITEM_STATUSES:
            return normalized
        if normalized in self.LEGACY_ACTION_ITEM_STATUS_MAP:
            return self.LEGACY_ACTION_ITEM_STATUS_MAP[normalized]
        return "open"

    def _normalize_business_action_items(self, values: Any) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        seen: Set[str] = set()
        for item in values or []:
            if isinstance(item, dict):
                task = str(
                    item.get("task")
                    or item.get("description")
                    or item.get("text")
                    or item.get("title")
                    or ""
                ).strip()
                if not task:
                    continue
                key = task.lower()
                if key in seen:
                    continue
                seen.add(key)

                owner = self._normalize_optional_text(item.get("owner"))
                due_date = self._normalize_optional_text(
                    item.get("dueDate") or item.get("due_date") or item.get("deadline")
                )
                evidence = self._normalize_optional_text(item.get("evidence"))
                evidence_quote = self._normalize_optional_text(
                    item.get("evidenceQuote") or item.get("evidence_quote")
                )
                evidence_keywords = self._coerce_string_list(
                    item.get("evidenceKeywords") or item.get("evidence_keywords") or []
                )[:5]
                priority = self._normalize_action_item_priority(item.get("priority"))
                status = self._normalize_action_item_status(item.get("status"))

                normalized.append(
                    {
                        "task": task,
                        "owner": owner,
                        "dueDate": due_date,
                        "deadline": due_date,
                        "priority": priority,
                        "status": status,
                        "evidence": evidence,
                        "evidenceQuote": evidence_quote,
                        "evidenceKeywords": evidence_keywords,
                    }
                )
                continue

            task = str(item or "").strip()
            if not task:
                continue
            key = task.lower()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(
                {
                    "task": task,
                    "owner": None,
                    "dueDate": None,
                    "deadline": None,
                    "priority": None,
                    "status": "open",
                    "evidence": None,
                    "evidenceQuote": None,
                    "evidenceKeywords": [],
                }
            )
        return normalized

    def _empty_grouped_action_plan(self) -> Dict[str, Any]:
        return {
            "version": self.ANALYSIS_FEATURE_SET,
            "language": "vi",
            "intro": "Chưa có công việc đủ rõ để phân nhóm.",
            "sections": [],
            "notes": [],
        }

    def _normalize_grouped_action_plan(
        self,
        value: Any,
        action_items: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        if not isinstance(value, dict):
            return self._fallback_grouped_action_plan(action_items)

        sections = []
        seen_tasks: Set[str] = set()
        for raw_section in (value.get("sections") or [])[:8]:
            if not isinstance(raw_section, dict):
                continue
            items = []
            for raw_item in (raw_section.get("items") or [])[:8]:
                if not isinstance(raw_item, dict):
                    continue
                title = self._trim_text(
                    raw_item.get("title") or raw_item.get("task"), 120
                )
                if not title:
                    continue
                key = title.lower()
                if key in seen_tasks:
                    continue
                seen_tasks.add(key)
                source_ids = self._coerce_string_list(
                    raw_item.get("sourceActionItemIds")
                    or raw_item.get("source_action_item_ids")
                    or []
                )[:8]
                confidence = self._normalize_grouped_confidence(
                    raw_item.get("confidence"), bool(source_ids)
                )
                items.append(
                    {
                        "id": self._trim_text(raw_item.get("id"), 80)
                        or f"item-{len(items) + 1}",
                        "title": title,
                        "description": self._trim_text(raw_item.get("description"), 500)
                        or None,
                        "subtasks": self._normalize_grouped_subtasks(
                            raw_item.get("subtasks")
                        ),
                        "owner": self._normalize_optional_text(raw_item.get("owner")),
                        "deadline": self._normalize_optional_text(
                            raw_item.get("deadline")
                            or raw_item.get("dueDate")
                            or raw_item.get("due_date")
                        ),
                        "priority": self._normalize_action_item_priority(
                            raw_item.get("priority")
                        ),
                        "status": self._normalize_action_item_status(
                            raw_item.get("status")
                        ),
                        "confidence": confidence,
                        "evidenceKeywords": self._coerce_string_list(
                            raw_item.get("evidenceKeywords")
                            or raw_item.get("evidence_keywords")
                            or []
                        )[:8],
                        "sourceActionItemIds": source_ids,
                    }
                )
            if not items:
                continue
            sections.append(
                {
                    "id": self._trim_text(raw_section.get("id"), 80)
                    or f"section-{len(sections) + 1}",
                    "order": len(sections) + 1,
                    "title": self._trim_text(raw_section.get("title"), 80)
                    or "Công việc chung",
                    "summary": self._trim_text(raw_section.get("summary"), 240) or None,
                    "items": items,
                }
            )

        notes = []
        for raw_note in (value.get("notes") or [])[:8]:
            note = raw_note if isinstance(raw_note, dict) else {"text": raw_note}
            text = self._trim_text(note.get("text") or note.get("note"), 240)
            if not text:
                continue
            notes.append(
                {
                    "text": text,
                    "confidence": self._normalize_grouped_confidence(
                        note.get("confidence"), False
                    ),
                    "evidenceKeywords": self._coerce_string_list(
                        note.get("evidenceKeywords")
                        or note.get("evidence_keywords")
                        or []
                    )[:8],
                }
            )

        if not sections and not notes:
            return self._fallback_grouped_action_plan(action_items)
        return {
            "version": self.ANALYSIS_FEATURE_SET,
            "language": self._normalize_grouped_language(value.get("language")),
            "intro": self._trim_text(value.get("intro"), 360)
            or "Dựa trên nội dung cuộc thảo luận trong file audio, dưới đây là danh sách các công việc cần thực hiện, được phân chia theo các nhóm chức năng chính:",
            "sections": sections,
            "notes": notes,
        }

    def _normalize_grouped_subtasks(self, value: Any) -> List[Dict[str, Any]]:
        subtasks = []
        for raw_subtask in (value or [])[:8]:
            subtask = (
                raw_subtask if isinstance(raw_subtask, dict) else {"text": raw_subtask}
            )
            text = self._trim_text(
                subtask.get("text") or subtask.get("title") or subtask.get("task"),
                180,
            )
            if not text:
                continue
            subtasks.append(
                {
                    "id": self._trim_text(subtask.get("id"), 80)
                    or f"subtask-{len(subtasks) + 1}",
                    "text": text,
                    "confidence": self._normalize_grouped_confidence(
                        subtask.get("confidence"), False
                    ),
                    "evidenceKeywords": self._coerce_string_list(
                        subtask.get("evidenceKeywords")
                        or subtask.get("evidence_keywords")
                        or []
                    )[:8],
                }
            )
        return subtasks

    def _fallback_grouped_action_plan(
        self, action_items: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        items = []
        for index, item in enumerate((action_items or [])[:8], start=1):
            task = self._trim_text(item.get("task"), 120)
            if not task:
                continue
            items.append(
                {
                    "id": f"fallback-item-{index}",
                    "title": task,
                    "description": None,
                    "subtasks": [],
                    "owner": item.get("owner"),
                    "deadline": item.get("deadline") or item.get("dueDate"),
                    "priority": item.get("priority"),
                    "status": item.get("status") or "open",
                    "confidence": "SUPPORTED",
                    "evidenceKeywords": self._coerce_string_list(
                        item.get("evidenceKeywords") or []
                    )[:8],
                    "sourceActionItemIds": [str(item.get("id") or f"action-{index}")],
                }
            )
        if not items:
            return self._empty_grouped_action_plan()
        return {
            "version": self.ANALYSIS_FEATURE_SET,
            "language": "vi",
            "intro": "Dựa trên nội dung cuộc thảo luận trong file audio, dưới đây là danh sách các công việc cần thực hiện, được phân chia theo các nhóm chức năng chính:",
            "sections": [
                {
                    "id": "fallback-section-1",
                    "order": 1,
                    "title": "Công việc chung",
                    "summary": None,
                    "items": items,
                }
            ],
            "notes": [],
        }

    def _normalize_grouped_language(self, value: Any) -> str:
        normalized = str(value or "").strip().lower()
        if normalized in {"vi", "en", "mixed"}:
            return normalized
        return "mixed"

    def _normalize_grouped_confidence(self, value: Any, has_source: bool) -> str:
        normalized = str(value or "").strip().upper()
        if normalized not in {"SUPPORTED", "INFERRED", "NEEDS_REVIEW"}:
            return "NEEDS_REVIEW"
        if normalized == "SUPPORTED" and not has_source:
            return "NEEDS_REVIEW"
        return normalized

    def _trim_text(self, value: Any, limit: int) -> str:
        text = re.sub(r"\s+", " ", str(value or "")).strip()
        if len(text) <= limit:
            return text
        return text[: max(0, limit - 3)].rstrip() + "..."

    def _default_structured_analysis(
        self, transcript: str, reason: str
    ) -> Dict[str, Any]:
        summary = self._build_concise_fallback_summary(transcript)
        confidence = 0.2 if str(transcript or "").strip() else 0.0

        logger.warning("GEMINI_ANALYSIS_FALLBACK reason={}", safe_error_message(reason))
        return {
            "summary": summary,
            "meetingSummary": summary,
            "keywords": [],
            "technicalTerms": [],
            "painPoints": [],
            "actionItems": [],
            "businessActionItems": [],
            "keyDecisions": [],
            "risks": [],
            "blockers": [],
            "questions": [],
            "deadlines": [],
            "owners": [],
            "nextSteps": [],
            "businessImpact": "",
            "customerImpact": "",
            "technicalImpact": "",
            "confidence": confidence,
            "promptVersion": self.PROMPT_VERSION,
            "schemaVersion": self.SCHEMA_VERSION,
            "analysisFeatureSet": self.ANALYSIS_FEATURE_SET,
            "groupedActionPlan": self._empty_grouped_action_plan(),
            "domainMode": self.analysis_domain_mode,
            "technical_terms": [],
            "pain_points": [],
            "action_items": [],
            "domain_mode": self.analysis_domain_mode,
            "key_points": [],
            "decisions": [],
            "risks_blockers": [],
            "topics": [],
            "transcriptHash": None,
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
        is_realtime: bool = False,
    ) -> str:
        grouped_action_plan_example = json.dumps(
            {
                "version": self.ANALYSIS_FEATURE_SET,
                "language": "vi|en|mixed",
                "intro": "Dựa trên nội dung cuộc thảo luận trong file audio, dưới đây là danh sách các công việc cần thực hiện, được phân chia theo các nhóm chức năng chính:",
                "sections": [
                    {
                        "id": "section-1",
                        "order": 1,
                        "title": "Tên nhóm chức năng tự nhiên theo nội dung cuộc họp",
                        "summary": "Mô tả ngắn nhóm việc",
                        "items": [
                            {
                                "id": "item-1",
                                "title": "Tên công việc",
                                "description": "Mô tả ngắn việc cần làm",
                                "subtasks": [
                                    {
                                        "id": "subtask-1",
                                        "text": "Việc con cụ thể",
                                        "confidence": "SUPPORTED|INFERRED|NEEDS_REVIEW",
                                        "evidenceKeywords": ["từ khóa ngắn"],
                                    }
                                ],
                                "owner": None,
                                "deadline": None,
                                "priority": "low|medium|high|null",
                                "status": "open|in_progress|blocked|done",
                                "confidence": "SUPPORTED|INFERRED|NEEDS_REVIEW",
                                "evidenceKeywords": ["từ khóa ngắn"],
                                "sourceActionItemIds": ["action-1"],
                            }
                        ],
                    }
                ],
                "notes": [],
            },
            ensure_ascii=False,
            indent=2,
        )
        realtime_guidance = ""
        if is_realtime:
            realtime_guidance = (
                "- REALTIME_MODE: prefer concise output for fast UI display.\n"
                "- For realtime only: summary and meetingSummary max 2 short sentences each.\n"
                "- For realtime only: keywords and technicalTerms max 5 each.\n"
                "- For realtime only: painPoints and action_items max 3 each.\n"
                "- For realtime only: keyDecisions, risks, blockers, questions, deadlines, owners, nextSteps max 3 each.\n"
                "- For realtime only: evidenceKeywords and list items max 120 characters; impacts max 1 short sentence each.\n"
            )
        return f"""
Hãy phân tích transcript sau và trả về đúng MỘT object JSON hợp lệ.

YÊU CẦU:
- Return JSON only.
- No markdown fences.
- No explanation.
- Do not copy transcript.
- Tất cả nội dung trong value phải bằng tiếng Việt (trừ tên riêng/thuật ngữ kỹ thuật).
- summary và meetingSummary mỗi mục tối đa 3 câu.
- keywords tối đa 8.
- technicalTerms tối đa 8.
- painPoints tối đa 5.
- action_items tối đa 5.
- keyDecisions, risks, blockers, questions, deadlines, owners, nextSteps: mỗi mục tối đa 5.
- Nếu không đủ bằng chứng, dùng mảng rỗng.
- severity chỉ dùng: low, medium, high.
- owner chỉ điền khi transcript/speaker nêu rõ người chịu trách nhiệm.
- dueDate chỉ điền khi transcript có ngày hoặc deadline rõ ràng.
- Không suy đoán owner/dueDate khi thiếu bằng chứng.
- evidenceKeywords là các từ khóa/cụm từ ngắn để tìm lại bằng chứng ở bước Search-A; không tạo evidenceQuote.
- evidence chỉ là ghi chú tương thích ngắn khi thật sự cần, không phải bằng chứng đã xác minh.
- confidence phải phản ánh độ chắc chắn của transcript, không mặc định luôn cao.
- domainMode phải là một trong: general, it, business, education.
- groupedActionPlan phải chia theo nhóm chức năng tự nhiên của cuộc họp.
- Không hard-code Hackathon headings.
- Không bịa owner/deadline/done/blocked.
- status=open là trạng thái hiển thị mặc định cho task có thể làm.
- Mỗi grouped item nên map về action_items qua sourceActionItemIds nếu có.
- Nếu không đủ dữ liệu để phân nhóm, dùng sections=[] hoặc một section Công việc chung, không bịa task.
- promptVersion phải là "{self.PROMPT_VERSION}".
- schemaVersion phải là "{self.SCHEMA_VERSION}".

{realtime_guidance}

{metadata_text}

{it_guidance}

Schema:
{{
    "summary": "string",
    "meetingSummary": "string",
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
    "action_items": [
        {{
            "task": "string",
            "owner": "string|null",
            "deadline": "string|null",
            "dueDate": "string|null",
            "priority": "low|medium|high|null",
            "status": "open|in_progress|blocked|done",
            "evidenceKeywords": ["string"],
            "evidence": "string|null"
        }}
    ],
    "keyDecisions": ["string"],
    "risks": ["string"],
    "blockers": ["string"],
    "questions": ["string"],
    "deadlines": ["string"],
    "owners": ["string"],
    "nextSteps": ["string"],
    "businessImpact": "string",
    "customerImpact": "string",
    "technicalImpact": "string",
    "confidence": 0.0,
    "promptVersion": "{self.PROMPT_VERSION}",
    "schemaVersion": "{self.SCHEMA_VERSION}",
    "analysisFeatureSet": "{self.ANALYSIS_FEATURE_SET}",
    "groupedActionPlan": {grouped_action_plan_example},
    "domainMode": "general|it|business|education"
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
            or payload.get("meetingSummary")
            or payload.get("overview")
            or payload.get("synthesis")
            or ""
        ).strip()
        meeting_summary = str(payload.get("meetingSummary") or summary).strip()
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
        business_action_items = self._normalize_business_action_items(
            payload.get("action_items")
            or payload.get("businessActionItems")
            or payload.get("actionItems")
            or payload.get("nextSteps")
            or []
        )
        action_items = [
            str(item.get("task") or "").strip() for item in business_action_items
        ]
        action_items = [item for item in action_items if item]
        domain_mode = self._normalize_domain_mode(
            payload.get("domainMode")
            or payload.get("domain_mode")
            or self.analysis_domain_mode,
            default=self.analysis_domain_mode,
        )
        key_decisions = self._coerce_string_list(
            payload.get("keyDecisions") or payload.get("decisions") or []
        )
        blockers = self._coerce_string_list(payload.get("blockers") or [])
        risks = self._coerce_string_list(
            payload.get("risks") or payload.get("risks_blockers") or []
        )
        questions = self._coerce_string_list(payload.get("questions") or [])
        deadlines = self._coerce_string_list(payload.get("deadlines") or [])
        owners = self._coerce_string_list(payload.get("owners") or [])
        next_steps = self._coerce_string_list(
            payload.get("nextSteps")
            or payload.get("next_steps")
            or payload.get("followUps")
            or []
        )
        if not next_steps and action_items:
            next_steps = action_items[:3]

        if not owners:
            owners = self._coerce_string_list(
                [
                    item.get("owner")
                    for item in business_action_items
                    if item.get("owner")
                ]
            )
        if not deadlines:
            deadlines = self._coerce_string_list(
                [
                    item.get("dueDate") or item.get("deadline")
                    for item in business_action_items
                    if item.get("dueDate") or item.get("deadline")
                ]
            )

        business_impact = (
            self._normalize_optional_text(payload.get("businessImpact")) or ""
        )
        customer_impact = (
            self._normalize_optional_text(payload.get("customerImpact")) or ""
        )
        technical_impact = (
            self._normalize_optional_text(payload.get("technicalImpact")) or ""
        )
        confidence = self._normalize_confidence(payload.get("confidence"))
        prompt_version = (
            str(
                payload.get("promptVersion") or payload.get("prompt_version") or ""
            ).strip()
            or self.PROMPT_VERSION
        )
        schema_version = (
            str(
                payload.get("schemaVersion") or payload.get("schema_version") or ""
            ).strip()
            or self.SCHEMA_VERSION
        )
        transcript_hash = (
            str(
                payload.get("transcriptHash") or payload.get("transcript_hash") or ""
            ).strip()
            or None
        )
        grouped_action_plan = self._normalize_grouped_action_plan(
            payload.get("groupedActionPlan") or payload.get("grouped_action_plan"),
            business_action_items,
        )
        analysis_feature_set = (
            str(
                payload.get("analysisFeatureSet")
                or payload.get("analysis_feature_set")
                or ""
            ).strip()
            or self.ANALYSIS_FEATURE_SET
        )

        term_keys = {item["term"].lower() for item in technical_terms}
        keywords = [item for item in keywords if item.lower() not in term_keys]
        risks_blockers = self._coerce_string_list(
            risks + blockers + [item["title"] for item in pain_points]
        )

        return {
            "summary": summary,
            "meetingSummary": meeting_summary or summary,
            "keywords": keywords,
            "technicalTerms": technical_terms,
            "painPoints": pain_points,
            "actionItems": action_items,
            "businessActionItems": business_action_items,
            "domainMode": domain_mode,
            "technical_terms": [item["term"] for item in technical_terms],
            "pain_points": pain_points,
            "action_items": business_action_items,
            "domain_mode": domain_mode,
            "key_points": keywords,
            "decisions": key_decisions,
            "keyDecisions": key_decisions,
            "risks": risks,
            "blockers": blockers,
            "questions": questions,
            "deadlines": deadlines,
            "owners": owners,
            "nextSteps": next_steps,
            "risks_blockers": risks_blockers,
            "businessImpact": business_impact,
            "customerImpact": customer_impact,
            "technicalImpact": technical_impact,
            "confidence": confidence,
            "promptVersion": prompt_version,
            "schemaVersion": schema_version,
            "analysisFeatureSet": analysis_feature_set,
            "groupedActionPlan": grouped_action_plan,
            "transcriptHash": transcript_hash,
            "topics": self._coerce_string_list(
                payload.get("topics")
                or keywords
                or [item["term"] for item in technical_terms]
            ),
        }

    def _compact_realtime_structured_analysis(
        self, data: Dict[str, Any]
    ) -> Dict[str, Any]:
        compacted = dict(data)

        def trim_text(value: Any, limit: int) -> str:
            text = re.sub(r"\s+", " ", str(value or "")).strip()
            if len(text) <= limit:
                return text
            return text[: limit - 3].rstrip() + "..."

        def trim_list(key: str, limit: int, text_limit: int = 120) -> None:
            values = compacted.get(key)
            if not isinstance(values, list):
                compacted[key] = []
                return
            compacted[key] = [trim_text(item, text_limit) for item in values[:limit]]

        compacted["summary"] = trim_text(compacted.get("summary"), 360)
        compacted["meetingSummary"] = trim_text(
            compacted.get("meetingSummary") or compacted.get("summary"), 360
        )
        trim_list("keywords", 5, 80)
        trim_list("key_points", 5, 80)
        trim_list("topics", 5, 80)
        for key in (
            "keyDecisions",
            "decisions",
            "risks",
            "blockers",
            "questions",
            "deadlines",
            "owners",
            "nextSteps",
            "risks_blockers",
        ):
            trim_list(key, 3, 120)

        technical_terms = compacted.get("technicalTerms")
        if isinstance(technical_terms, list):
            compacted["technicalTerms"] = [
                {
                    **item,
                    "term": trim_text(item.get("term"), 80),
                    "meaning": trim_text(item.get("meaning"), 80),
                    "category": trim_text(item.get("category"), 40),
                }
                for item in technical_terms[:5]
                if isinstance(item, dict)
            ]
            compacted["technical_terms"] = [
                item["term"] for item in compacted["technicalTerms"] if item.get("term")
            ]

        pain_points = compacted.get("painPoints")
        if isinstance(pain_points, list):
            compacted["painPoints"] = [
                {
                    **item,
                    "title": trim_text(item.get("title"), 120),
                    "evidence": trim_text(item.get("evidence"), 100),
                }
                for item in pain_points[:3]
                if isinstance(item, dict)
            ]
            compacted["pain_points"] = compacted["painPoints"]

        business_action_items = compacted.get("businessActionItems")
        if isinstance(business_action_items, list):
            compacted["businessActionItems"] = [
                {
                    **item,
                    "task": trim_text(item.get("task"), 120),
                    "evidence": trim_text(item.get("evidence"), 100),
                    "evidenceQuote": trim_text(item.get("evidenceQuote"), 100),
                    "evidenceKeywords": [
                        trim_text(keyword, 80)
                        for keyword in (
                            item.get("evidenceKeywords")
                            if isinstance(item.get("evidenceKeywords"), list)
                            else []
                        )[:5]
                    ],
                }
                for item in business_action_items[:3]
                if isinstance(item, dict)
            ]
            compacted["action_items"] = compacted["businessActionItems"]
            compacted["actionItems"] = [
                item["task"]
                for item in compacted["businessActionItems"]
                if item.get("task")
            ]
        else:
            trim_list("actionItems", 3, 120)

        compacted["businessImpact"] = trim_text(compacted.get("businessImpact"), 160)
        compacted["customerImpact"] = trim_text(compacted.get("customerImpact"), 160)
        compacted["technicalImpact"] = trim_text(compacted.get("technicalImpact"), 160)
        return compacted

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
                owner = self._normalize_optional_text(item.get("owner"))
                due_date = self._normalize_optional_text(
                    item.get("dueDate") or item.get("due_date") or item.get("deadline")
                )
                priority = self._normalize_action_item_priority(item.get("priority"))
                status = self._normalize_action_item_status(item.get("status"))
                evidence = self._normalize_optional_text(item.get("evidence"))
                evidence_quote = self._normalize_optional_text(
                    item.get("evidenceQuote") or item.get("evidence_quote")
                )
                evidence_keywords = self._coerce_string_list(
                    item.get("evidenceKeywords") or item.get("evidence_keywords") or []
                )[:5]
                normalized.append(
                    {
                        "task": task,
                        "owner": owner,
                        "dueDate": due_date,
                        "deadline": due_date,
                        "priority": priority,
                        "status": status,
                        "evidence": evidence,
                        "evidenceQuote": evidence_quote,
                        "evidenceKeywords": evidence_keywords,
                    }
                )
                continue

            task = str(item).strip()
            if task:
                normalized.append(
                    {
                        "task": task,
                        "owner": None,
                        "dueDate": None,
                        "deadline": None,
                        "priority": None,
                        "status": "open",
                        "evidence": None,
                        "evidenceQuote": None,
                        "evidenceKeywords": [],
                    }
                )
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

    def _parse_gemini_analysis_content(self, content: str) -> Dict[str, Any]:
        return self._loads_json_strict(content)

    def _repair_gemini_analysis_json(self, malformed_content: str) -> str:
        repair_system_prompt = (
            "Bạn là bộ sửa JSON. Chỉ được trả về đúng một object JSON hợp lệ, "
            "không markdown, không giải thích, không thêm field ngoài schema."
        )
        repair_prompt = (
            "Sửa JSON bị lỗi cú pháp sau thành JSON hợp lệ theo schema cũ. "
            "Giữ nguyên ý nghĩa nội dung, chỉ chỉnh cú pháp thiếu dấu ngoặc/dấu phẩy/ký tự thoát."
            f"\n\nJSON lỗi:\n{malformed_content}"
        )
        return self._call_gemini_text(
            prompt=repair_prompt,
            system_prompt=repair_system_prompt,
            model=self.model,
            temperature=0,
            response_json=True,
            response_schema=None,
            max_output_tokens=self.analysis_max_output_tokens,
        )

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
            if key in _INTERNAL_ANALYSIS_METADATA_KEYS:
                continue
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
        if not self.api_key and not (
            self.gemini_key_manager is not None and self.gemini_key_manager.has_keys()
        ):
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
            def __init__(
                self,
                response_chars: int,
                schema_mode: str,
                output_tokens: Any,
                max_output_tokens: Optional[int],
            ):
                self.response_chars = response_chars
                self.schema_mode = schema_mode
                self.output_tokens = output_tokens
                self.max_output_tokens = max_output_tokens
                super().__init__("Gemini response incomplete: finish_reason=MAX_TOKENS")

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

        def _retry_after_seconds(
            response: httpx.Response | None, attempt: int
        ) -> float:
            if response is not None and response.status_code == 429:
                retry_headers = getattr(response, "headers", None) or {}
                retry_after = str(retry_headers.get("Retry-After", "")).strip()
                if retry_after:
                    try:
                        parsed_retry_after = max(0.0, float(retry_after))
                        if self.gemini_rate_limit_retry_max_seconds > 0:
                            return min(
                                parsed_retry_after,
                                self.gemini_rate_limit_retry_max_seconds,
                            )
                        return parsed_retry_after
                    except ValueError:
                        pass
                wait_seconds = self.gemini_rate_limit_retry_base_seconds * attempt
                if self.gemini_rate_limit_retry_max_seconds > 0:
                    wait_seconds = min(
                        wait_seconds, self.gemini_rate_limit_retry_max_seconds
                    )
                return float(wait_seconds)

            return float(2**attempt)

        def _is_quota_exceeded_response(response_preview: str) -> bool:
            preview = str(response_preview or "").lower()
            return (
                "quota" in preview
                or "resource_exhausted" in preview
                or "resource exhausted" in preview
            )

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

            if self.gemini_client is None:
                raise AnalysisConfigError(
                    "Gemini client is not configured",
                    provider=self.provider,
                )

            response = self.gemini_client.post_json(
                url=url,
                payload=request_payload,
                timeout_seconds=self.timeout_seconds,
            )
            body = response.json()
            text, candidates, body_dict = _extract_response_text(body)

            input_tokens = None
            output_tokens = None
            total_tokens = None
            usage_metadata = body_dict.get("usageMetadata") or body_dict.get(
                "usage_metadata"
            )
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
                finish_reason = candidates[0].get("finishReason") or candidates[0].get(
                    "finish_reason"
                )

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
                    "GEMINI_ANALYSIS_INCOMPLETE reason=max_tokens output_tokens={} max_output_tokens={} response_chars={} schema_mode={}",
                    output_tokens,
                    request_max_output_tokens,
                    len(text),
                    schema_mode,
                )
                raise _GeminiMaxTokensError(
                    response_chars=len(text),
                    schema_mode=schema_mode,
                    output_tokens=output_tokens,
                    max_output_tokens=request_max_output_tokens,
                )
            logger.info(
                f"Gemini response parse success model={model} response_chars={len(text)}"
            )
            return text

        base_max_output_tokens = max_output_tokens
        if base_max_output_tokens is None:
            base_max_output_tokens = self.analysis_max_output_tokens
        # Primary analysis defaults to 4096; retry must exceed that cap (gemini-2.5-flash allows 8192+).
        max_tokens_retry_output_budget = min(
            8192, max(2048, int(base_max_output_tokens or 2048) * 2)
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
                    f"Gemini response incomplete due to MAX_TOKENS (output_tokens={exc.output_tokens}, max_output_tokens={exc.max_output_tokens}, response_chars={exc.response_chars})",
                    provider=self.provider,
                )
                if not self.gemini_max_tokens_retry_enabled:
                    logger.warning(
                        "GEMINI_ANALYSIS_MAX_TOKENS_RETRY_SKIPPED reason=disabled output_tokens={} max_output_tokens={} response_chars={}",
                        exc.output_tokens,
                        exc.max_output_tokens,
                        exc.response_chars,
                    )
                    raise last_exc
                if max_tokens_retry_enqueued:
                    raise last_exc
                max_tokens_retry_enqueued = True
                logger.warning(
                    "GEMINI_ANALYSIS_MAX_TOKENS_RETRY_ENQUEUED output_tokens={} max_output_tokens={} retry_max_output_tokens={}",
                    exc.output_tokens,
                    exc.max_output_tokens,
                    max_tokens_retry_output_budget,
                )
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
                is_http_400 = (
                    "HTTP 400" in str(exc)
                    or getattr(exc, "error_code", "") == "GEMINI_INVALID_REQUEST"
                )
                if is_http_400 and current_schema is not None:
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
        domain_mode = self._resolve_analysis_domain_mode(metadata)
        versions = resolve_analysis_versions(domain_mode)
        metadata_source = str((metadata or {}).get("source") or "").strip().lower()
        is_realtime = metadata_source == "realtime"
        if domain_mode == "education":
            system_prompt = build_education_system_instruction(domain_mode)
        else:
            system_prompt = (
                "Bạn là trợ lý phân tích biên bản họp. Hãy trả về đúng một object JSON hợp lệ và không thêm gì khác. "
                "Tất cả nội dung trong các value phải bằng tiếng Việt, trừ tên riêng và thuật ngữ kỹ thuật cần giữ nguyên. "
                f"domainMode hiện tại là {domain_mode}."
            )
        metadata_text = self._metadata_to_prompt_lines(metadata)
        domain_guidance = self._domain_guidance_for_mode(domain_mode)
        if domain_mode == "education":
            language_hint = None
            if metadata:
                language_hint = metadata.get("language") or metadata.get(
                    "meetingLanguage"
                )
            domain_guidance = (
                f"{domain_guidance}\n\n"
                f"{build_education_prompt_rules(language_hint=language_hint)}"
            )
        json_prompt = self._build_gemini_analysis_json_prompt(
            transcript=prompt,
            metadata_text=metadata_text,
            it_guidance=domain_guidance,
            is_realtime=is_realtime,
        )

        content = self._call_gemini_text(
            prompt=json_prompt,
            system_prompt=system_prompt,
            model=self.model,
            temperature=0.1,
            response_json=True,
            response_schema=self._build_gemini_response_schema(domain_mode),
            max_output_tokens=self.analysis_max_output_tokens,
        )
        try:
            parsed = self._parse_gemini_analysis_content(content)
        except AnalysisParseError as exc:
            logger.warning(
                "GEMINI_ANALYSIS_PARSE_FAILED reason={} response_chars={} retrying_without_schema=true",
                exc,
                len(content),
            )
            retry_content = self._call_gemini_text(
                prompt=json_prompt,
                system_prompt=system_prompt,
                model=self.model,
                temperature=0.1,
                response_json=True,
                response_schema=None,
                max_output_tokens=self.analysis_max_output_tokens,
            )
            try:
                parsed = self._parse_gemini_analysis_content(retry_content)
            except AnalysisParseError as retry_exc:
                logger.warning(
                    "GEMINI_ANALYSIS_PARSE_FAILED reason={} response_chars={} attempting_llm_json_repair=true",
                    retry_exc,
                    len(retry_content),
                )
                repaired_content = self._repair_gemini_analysis_json(retry_content)
                parsed = self._parse_gemini_analysis_content(repaired_content)
        structured = self._normalize_gemini_structured_analysis(prompt, parsed)
        structured["domainMode"] = domain_mode
        structured["domain_mode"] = domain_mode
        structured["promptVersion"] = versions["promptVersion"]
        structured["schemaVersion"] = versions["schemaVersion"]
        structured["analysisFeatureSet"] = versions["analysisFeatureSet"]

        if domain_mode == "education":
            allowed_ids = coerce_allowed_segment_ids(
                (metadata or {}).get("allowedSegmentIds")
                or (metadata or {}).get("allowed_segment_ids")
            )
            meeting_id_raw = (metadata or {}).get("meetingId") or (metadata or {}).get(
                "meeting_id"
            )
            meeting_id: int | None = None
            try:
                if meeting_id_raw is not None:
                    meeting_id = int(meeting_id_raw)
            except (TypeError, ValueError):
                meeting_id = None
            try:
                education_study = normalize_education_study(
                    extract_education_study_raw(parsed),
                    allowed_segment_ids=allowed_ids,
                    meeting_id=meeting_id,
                )
            except Exception as exc:  # noqa: BLE001 — soft-fail education only
                logger.warning(
                    "EDUCATION_STUDY_NORMALIZE_FAILED meeting_id={} domain_mode={} error_class={} detail={}",
                    meeting_id,
                    domain_mode,
                    type(exc).__name__,
                    safe_error_message(exc),
                )
                education_study = None
            if education_study is None:
                education_study = normalize_education_study(
                    build_fallback_education_study(
                        summary=str(structured.get("summary") or ""),
                        meeting_summary=str(structured.get("meetingSummary") or ""),
                        keywords=structured.get("keywords")
                        if isinstance(structured.get("keywords"), list)
                        else [],
                        technical_terms=structured.get("technicalTerms")
                        if isinstance(structured.get("technicalTerms"), list)
                        else [],
                    ),
                    allowed_segment_ids=allowed_ids,
                    meeting_id=meeting_id,
                )
                logger.warning(
                    "EDUCATION_STUDY_FALLBACK_APPLIED meeting_id={} domain_mode={} reason=normalize_failed_or_missing",
                    meeting_id,
                    domain_mode,
                )
            if education_study is not None:
                structured["educationStudy"] = education_study
            else:
                structured.pop("educationStudy", None)
                logger.warning(
                    "EDUCATION_STUDY_OMITTED meeting_id={} domain_mode={} reason=normalize_failed_or_missing",
                    meeting_id,
                    domain_mode,
                )
            if (metadata or {}).get("evidenceUnavailable") is True or (
                not allowed_ids
                and str((metadata or {}).get("source") or "").lower() == "realtime"
            ):
                structured["evidenceUnavailable"] = True
                logger.info(
                    "EDUCATION_EVIDENCE_UNAVAILABLE meeting_id={} source=realtime",
                    meeting_id,
                )

        if is_realtime:
            structured = self._compact_realtime_structured_analysis(structured)
        if metadata:
            metadata_hash = str(metadata.get("transcriptHash") or "").strip()
            if metadata_hash:
                structured["transcriptHash"] = metadata_hash
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
            "meetingSummary": preview,
            "keywords": keywords,
            "technical_terms": [],
            "action_items": [],
            "technicalTerms": [],
            "painPoints": [],
            "actionItems": [],
            "businessActionItems": [],
            "domainMode": self.analysis_domain_mode,
            "pain_points": [],
            "domain_mode": self.analysis_domain_mode,
            "keyDecisions": [],
            "decisions": [],
            "risks": [],
            "blockers": [],
            "questions": [],
            "deadlines": [],
            "owners": [],
            "nextSteps": [],
            "businessImpact": "",
            "customerImpact": "",
            "technicalImpact": "",
            "confidence": 0.2 if text else 0.0,
            "promptVersion": self.PROMPT_VERSION,
            "schemaVersion": self.SCHEMA_VERSION,
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
            "meetingSummary": summary,
            "keywords": keywords,
            "technical_terms": self._extract_technical_terms_fallback(text, keywords),
            "action_items": self._extract_action_items_fallback(text, summary),
            "technicalTerms": [],
            "painPoints": [],
            "actionItems": self._extract_action_items_fallback(text, summary),
            "businessActionItems": self._extract_action_items_fallback(text, summary),
            "domainMode": self.analysis_domain_mode,
            "pain_points": [],
            "domain_mode": self.analysis_domain_mode,
            "key_points": keywords,
            "decisions": [],
            "keyDecisions": [],
            "risks": [],
            "blockers": [],
            "questions": [],
            "deadlines": [],
            "owners": [],
            "nextSteps": [],
            "risks_blockers": [],
            "topics": keywords,
            "businessImpact": "",
            "customerImpact": "",
            "technicalImpact": "",
            "confidence": 0.35 if text else 0.0,
            "promptVersion": self.PROMPT_VERSION,
            "schemaVersion": self.SCHEMA_VERSION,
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

        return [
            {
                "task": task,
                "owner": None,
                "dueDate": None,
                "deadline": None,
                "priority": None,
                "status": None,
                "evidence": None,
            }
            for task in tasks[:3]
        ]

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
            business_action_items = self._normalize_business_action_items(
                data.get("action_items")
                or data.get("businessActionItems")
                or data.get("actionItems")
                or []
            )
            action_item_strings = [
                str(item.get("task") or "").strip()
                for item in business_action_items
                if str(item.get("task") or "").strip()
            ]
            legacy_payload = {
                "summary": str(data.get("summary", "")),
                "meetingSummary": str(
                    data.get("meetingSummary") or data.get("summary") or ""
                ).strip(),
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
                "technicalTerms": self._coerce_structured_technical_terms(
                    data.get("technicalTerms") or []
                ),
                "painPoints": self._coerce_structured_pain_points(
                    data.get("painPoints") or data.get("pain_points") or []
                ),
                "action_items": business_action_items,
                "actionItems": action_item_strings,
                "businessActionItems": business_action_items,
                "keyDecisions": self._coerce_string_list(
                    data.get("keyDecisions") or data.get("decisions") or []
                ),
                "decisions": self._coerce_string_list(
                    data.get("decisions") or data.get("keyDecisions") or []
                ),
                "risks": self._coerce_string_list(data.get("risks") or []),
                "blockers": self._coerce_string_list(data.get("blockers") or []),
                "questions": self._coerce_string_list(data.get("questions") or []),
                "deadlines": self._coerce_string_list(data.get("deadlines") or []),
                "owners": self._coerce_string_list(data.get("owners") or []),
                "nextSteps": self._coerce_string_list(data.get("nextSteps") or []),
                "businessImpact": str(data.get("businessImpact") or "").strip(),
                "customerImpact": str(data.get("customerImpact") or "").strip(),
                "technicalImpact": str(data.get("technicalImpact") or "").strip(),
                "confidence": self._normalize_confidence(data.get("confidence")),
                "promptVersion": (
                    str(data.get("promptVersion") or "").strip() or self.PROMPT_VERSION
                ),
                "schemaVersion": (
                    str(data.get("schemaVersion") or "").strip() or self.SCHEMA_VERSION
                ),
                "analysisFeatureSet": (
                    str(
                        data.get("analysisFeatureSet")
                        or data.get("analysis_feature_set")
                        or ""
                    ).strip()
                    or self.ANALYSIS_FEATURE_SET
                ),
                "groupedActionPlan": self._normalize_grouped_action_plan(
                    data.get("groupedActionPlan") or data.get("grouped_action_plan"),
                    business_action_items,
                ),
                "transcriptHash": (
                    str(data.get("transcriptHash") or "").strip() or None
                ),
            }
            if isinstance(data.get("educationStudy"), dict):
                legacy_payload["educationStudy"] = data["educationStudy"]
            if data.get("evidenceUnavailable") is True:
                legacy_payload["evidenceUnavailable"] = True
            prepared = self._ensure_analysis_completeness(transcript, legacy_payload)

            # F8 rule: Gemini missing action items must remain empty.
            # Do not fabricate action items from transcript/summary for Gemini structured output.
            if not business_action_items:
                prepared["action_items"] = []
                prepared["businessActionItems"] = []
                prepared["actionItems"] = []

            return prepared

        if self.provider in {"ollama", "local"}:
            prepared = self._ensure_analysis_completeness(transcript, data)
            prepared.setdefault("promptVersion", self.PROMPT_VERSION)
            prepared.setdefault("schemaVersion", self.SCHEMA_VERSION)
            return prepared

        raise AnalysisNotImplementedError(
            f"Unsupported analysis provider: {self.provider}",
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
            resolved_domain_mode = self._resolve_analysis_domain_mode(metadata)
            transcript_prefix = transcript_hash_prefix(truncated_transcript)
            logger.info(
                "GEMINI_ANALYSIS_REQUEST provider=gemini model={} source={} domainMode={} transcript_chars={} transcript_tokens={} transcriptHashPrefix={}",
                self.model,
                source,
                resolved_domain_mode,
                len(truncated_transcript),
                used_tokens,
                transcript_prefix,
            )

            started_at = time.time()
            result = self._analyze_with_gemini(truncated_transcript, metadata=metadata)
            logger.info(
                "GEMINI_ANALYSIS_RESPONSE_PARSED provider=gemini model={} source={} durationMs={}",
                self.model,
                source,
                int((time.time() - started_at) * 1000),
            )
            return result

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
