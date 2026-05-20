import json
import re
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
    AnalysisRateLimitError,
    AnalysisUnavailableError,
)


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

    def __init__(
        self,
        api_key: str,
        model: str = "gpt-4o",
        provider: str = "ollama",
        summary_model: str | None = None,
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
        self.ollama_base_url = (ollama_base_url or "http://127.0.0.1:11434").rstrip("/")
        self.timeout_seconds = timeout_seconds
        if self.provider == "gemini":
            logger.info(
                f"Initialized AI Analyzer provider=gemini, analysis_model={self.model}, summary_model={self.summary_model}, timeout_seconds={self.timeout_seconds}"
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

    def _chunk_transcript(self, transcript: str, max_chars: int = 2500) -> List[str]:
        chunks: List[str] = []
        current = ""

        for line in str(transcript or "").split("\n"):
            if len(current) + len(line) + 1 < max_chars:
                current += line + "\n"
            else:
                if current.strip():
                    chunks.append(current.strip())
                current = line + "\n"

        if current.strip():
            chunks.append(current.strip())

        return chunks if chunks else [str(transcript or "")]

    def _extract_json_object(self, text: str) -> str:
        text = (text or "").strip()

        if text.startswith("```json"):
            text = text[7:].strip()
        elif text.startswith("```"):
            text = text[3:].strip()

        if text.endswith("```"):
            text = text[:-3].strip()

        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            text = text[start : end + 1]

        return text.strip()

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
        cleaned = (text or "").strip()
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError as exc:
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
    ) -> str:
        self._require_gemini_api_key()
        payload: Dict[str, Any] = {
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
            },
        }
        if response_json:
            payload["generationConfig"]["responseMimeType"] = "application/json"

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        logger.info(
            f"Calling Gemini model={model} response_json={response_json} transcript_chars={len(prompt)}"
        )

        try:
            with httpx.Client(timeout=self.timeout_seconds) as client:
                response = client.post(url, params={"key": self.api_key}, json=payload)
        except httpx.TimeoutException as exc:
            raise AnalysisUnavailableError(
                "Gemini request timed out",
                provider=self.provider,
            ) from exc
        except httpx.HTTPError as exc:
            raise AnalysisUnavailableError(
                f"Gemini request failed: {exc}",
                provider=self.provider,
            ) from exc

        if response.status_code == 429:
            raise AnalysisRateLimitError(
                "Gemini quota or rate limit exceeded",
                provider=self.provider,
            )
        if response.status_code in {401, 403}:
            raise AnalysisConfigError(
                "Gemini API key was rejected or is missing",
                provider=self.provider,
            )
        if response.status_code >= 400:
            raise AnalysisUnavailableError(
                f"Gemini request failed with HTTP {response.status_code}",
                provider=self.provider,
            )

        try:
            body = response.json()
        except ValueError as exc:
            raise AnalysisParseError(
                "Gemini returned a non-JSON HTTP response",
                provider=self.provider,
            ) from exc

        if isinstance(body, dict) and body.get("error"):
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

        candidates = body.get("candidates") if isinstance(body, dict) else None
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

        logger.info(
            f"Gemini response parse success model={model} response_chars={len(text)}"
        )
        return text

    def _analyze_with_gemini(
        self, prompt: str, metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        system_prompt = (
            "Bạn là trợ lý phân tích biên bản họp. Hãy trả về đúng một object JSON hợp lệ và không thêm gì khác. "
            "Tất cả nội dung trong các value phải bằng tiếng Việt, trừ tên riêng và thuật ngữ kỹ thuật cần giữ nguyên."
        )
        metadata_text = self._metadata_to_prompt_lines(metadata)
        json_prompt = f"""
Hãy phân tích phần tóm tắt cuộc họp sau và trả về đúng MỘT object JSON hợp lệ.

YÊU CẦU:
- Tất cả nội dung trong các value phải bằng tiếng Việt.
- Không dùng markdown.
- Không thêm giải thích ngoài JSON.
- Nếu không biết thì để mảng rỗng.
- Giữ nguyên tên riêng, tên công nghệ, API, framework, thư viện, tên hàm, biến code hoặc thuật ngữ kỹ thuật nếu cần.

{metadata_text}

Schema:
{{
  "summary": "string",
  "key_points": ["string"],
  "decisions": ["string"],
  "action_items": [
    {{
      "task": "string",
      "owner": null,
      "deadline": null
    }}
  ],
  "risks_blockers": ["string"],
  "topics": ["string"]
}}

TEXT:
{prompt}
"""

        content = self._call_gemini_text(
            prompt=json_prompt,
            system_prompt=system_prompt,
            model=self.model,
            temperature=0.1,
            response_json=True,
        )
        parsed = self._loads_json_strict(content)
        return self._coerce_gemini_analysis(parsed)

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
                    data.get("key_points") or data.get("topics") or []
                ),
                "technical_terms": self._coerce_string_list(data.get("topics") or []),
                "action_items": self._normalize_action_items(
                    data.get("action_items") or []
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
            logger.info(
                f"Starting AI meeting analysis (Gemini) transcript_chars={len(transcript or '')}"
            )
            chunks = self._chunk_transcript(transcript)
            logger.info(f"Split Gemini transcript into {len(chunks)} chunks")

            summaries = []
            for i, chunk in enumerate(chunks):
                logger.info(f"Processing Gemini chunk {i+1}/{len(chunks)}")
                summaries.append(
                    self._summarize_chunk_with_gemini(chunk, metadata=metadata)
                )

            combined_summary = "\n".join(summaries)
            result = self._analyze_with_gemini(combined_summary, metadata=metadata)
            logger.info("AI analysis completed (Gemini)")
            return result

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
            logger.warning(f"AI analysis fallback activated due to Ollama error: {e}")
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
