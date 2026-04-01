from openai import OpenAI
from typing import List, Dict, Set
from loguru import logger
import json
import re
import httpx
import unicodedata


class AIAnalyzer:
    STOPWORDS = {
        "trong", "va", "và", "cua", "của", "nhau", "la", "là", "mot", "một", "cac", "các",
        "cho", "tai", "tại", "the", "of", "in", "on"
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
        provider: str = "openai",
        ollama_base_url: str = "http://127.0.0.1:11434",
        timeout_seconds: int = 300,
    ):
        requested_provider = (provider or "ollama").lower()
        if requested_provider != "ollama":
            logger.warning(
                f"AI provider '{requested_provider}' requested but Ollama-only mode is enforced."
            )
        self.provider = "ollama"
        self.api_key = (api_key or "").strip()
        self.client = OpenAI(api_key=self.api_key) if self.api_key else None
        self.model = model
        self.ollama_base_url = (ollama_base_url or "http://127.0.0.1:11434").rstrip("/")
        self.timeout_seconds = timeout_seconds
        logger.info(
            f"Initialized AI Analyzer provider=ollama-only, model={model}, base_url={self.ollama_base_url}"
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
        return re.search(rf"(?<!\\w){re.escape(phrase)}(?!\\w)", normalized_text) is not None

    def _extract_candidate_phrases_by_regex(self, transcript: str) -> Set[str]:
        normalized_text = self._normalize_text(transcript)
        if not normalized_text:
            return set()

        words = [w for w in normalized_text.split() if w]
        candidates: Set[str] = set(words)

        max_ngram = 5
        for n in range(2, max_ngram + 1):
            for idx in range(0, max(0, len(words) - n + 1)):
                ngram_words = words[idx:idx + n]
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
            self._normalize_text(term): term
            for term in self.IT_WHITELIST_TERMS
        }
        whitelist_order = list(whitelist_map.keys())

        normalized_terms = {
            self._normalize_text(item)
            for item in (technical_terms or [])
            if str(item).strip()
        }
        normalized_keywords = {
            self._normalize_text(item)
            for item in (keywords or [])
            if str(item).strip()
        }
        normalized_transcript = self._normalize_text(transcript)

        selected_keys: List[str] = []
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
                    selected_keys.append(phrase_key)

        # 2) Match single-token whitelist entries (excluding stopwords).
        single_token_whitelist = {
            key: value
            for key, value in whitelist_map.items()
            if " " not in key
        }
        token_candidates: Set[str] = set()
        for value in normalized_terms.union(normalized_keywords):
            token_candidates.add(value)
            token_candidates.update(value.split())

        for token in token_candidates:
            if token in self.STOPWORDS:
                continue
            if token in single_token_whitelist and token not in selected_seen:
                selected_seen.add(token)
                selected_keys.append(token)

        # 3) Fallback when model returns empty/noisy technical terms:
        # whitelist + regex phrase candidates + intersection with keywords.
        if not selected_keys:
            regex_candidates = self._extract_candidate_phrases_by_regex(transcript)
            keyword_intersection = normalized_keywords.intersection(whitelist_map.keys())

            for phrase_key in whitelist_order:
                if phrase_key in keyword_intersection or phrase_key in regex_candidates:
                    if phrase_key not in selected_seen:
                        selected_seen.add(phrase_key)
                        selected_keys.append(phrase_key)

        return [whitelist_map[key] for key in selected_keys[:12]]

    def _chunk_transcript(self, transcript: str, max_chars: int = 2000):
        chunks = []
        current = ""

        for line in transcript.split("\n"):
            if len(current) + len(line) < max_chars:
                current += line + "\n"
            else:
                if current.strip():
                    chunks.append(current)
                current = line + "\n"

        if current.strip():
            chunks.append(current)

        return chunks

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
            text = text[start:end + 1]

        return text.strip()

    def _loads_json_safe(self, text: str) -> Dict:
        cleaned = self._extract_json_object(text)
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError as e:
            repaired = self._repair_json_string(cleaned)
            if repaired != cleaned:
                try:
                    data = json.loads(repaired)
                    logger.warning("Recovered malformed JSON from Ollama response using local repair.")
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
        prompt = f"""
Hãy tóm tắt đoạn nội dung cuộc họp sau bằng tiếng Việt trong 2-3 câu.
Chỉ trả về phần tóm tắt.
Không thêm giải thích.
Giữ nguyên tên riêng, tên công nghệ, API, framework, thư viện, tên hàm, biến code hoặc thuật ngữ kỹ thuật nếu cần.

NỘI DUNG:
{chunk}
"""

        return self._summarize_chunk_with_ollama(prompt)

    def _summarize_chunk_with_ollama(self, prompt: str) -> str:
        system_prompt = "Bạn là trợ lý tóm tắt cuộc họp. Luôn trả lời bằng tiếng Việt, trừ tên riêng và thuật ngữ kỹ thuật cần giữ nguyên."
        payload = {
            "model": self.model,
            "stream": False,
            "options": {
                "temperature": 0.2,
                "num_predict": 150
            },
            "messages": [
                {
                "role": "system",
                "content": system_prompt
            },
                {"role": "user", "content": prompt}
            ],
        }

        return self._call_ollama(
            prompt=prompt,
            system_prompt=system_prompt,
            chat_payload=payload,
            expect_json=False,
        )

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

        keywords = [k for k, _ in sorted(freq.items(), key=lambda kv: kv[1], reverse=True)[:10]]

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

        keywords = [k for k, _ in sorted(freq.items(), key=lambda kv: kv[1], reverse=True)[:10]]

        return {
            "summary": summary,
            "keywords": keywords,
            "technical_terms": self._extract_technical_terms_fallback(text, keywords),
            "action_items": self._extract_action_items_fallback(text, summary),
        }

    def _extract_technical_terms_fallback(self, transcript: str, keywords: List[str]) -> List[str]:
        return self.sanitize_technical_terms(
            transcript=transcript,
            technical_terms=[],
            keywords=keywords,
        )

    def _extract_action_items_fallback(self, transcript: str, summary: str) -> List[Dict]:
        lines = [line.strip() for line in (transcript or "").splitlines() if line.strip()]
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
                default_task = base[:180] if base else "Tổng hợp nội dung chính của buổi họp và lập danh sách việc cần làm."
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
            for item in (items or []):
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
            fallback_terms = self._extract_technical_terms_fallback(transcript, keywords)
            fallback_terms = _normalize_list(fallback_terms)
            technical_terms = [t for t in fallback_terms if t.lower() not in keyword_keys]

        # Ensure keywords don't become too technical-only by removing exact duplicates both ways.
        term_keys = {t.lower() for t in technical_terms}
        keywords = [k for k in keywords if k.lower() not in term_keys]

        # Keep stable lengths and avoid empty output.
        data["keywords"] = keywords[:12] if keywords else data.get("keywords", [])[:12]
        data["technical_terms"] = technical_terms[:12]

        return data

    def analyze_meeting(self, transcript: str) -> Dict:
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
            logger.error(f"AI analysis error (Ollama-only mode): {e}")
            raise RuntimeError(f"Ollama analysis failed: {e}") from e

    def _analyze_with_ollama(self, prompt: str) -> Dict:
        system_prompt = "Bạn là trợ lý phân tích biên bản họp. Hãy trả về đúng một object JSON hợp lệ và không thêm gì khác. Tất cả nội dung trong các value phải bằng tiếng Việt, trừ tên riêng và thuật ngữ kỹ thuật cần giữ nguyên."
        payload = {
            "model": self.model,
            "stream": False,
            "format": "json",
            "options": {
                "temperature": 0.1,
                "num_predict": 1000
            },
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
            logger.warning("Primary Ollama analysis returned malformed JSON; requesting JSON repair from Ollama.")

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

    def _call_ollama(
        self,
        prompt: str,
        system_prompt: str,
        chat_payload: Dict,
        expect_json: bool,
    ) -> str:
        with httpx.Client(timeout=self.timeout_seconds) as client:
            chat_response = client.post(f"{self.ollama_base_url}/api/chat", json=chat_payload)
            if chat_response.status_code != 404:
                chat_response.raise_for_status()
                chat_body = chat_response.json()
                content = (chat_body.get("message", {}) or {}).get("content", "")
                if content:
                    return content.strip()

            logger.warning("Ollama /api/chat unavailable; falling back to Ollama /api/generate compatibility endpoint")

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
                raise ValueError(f"Empty response from Ollama generate API: {generate_body}")
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