import importlib.util
import json
from pathlib import Path

MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "app" / "services" / "ai_analyzer.py"
)
SPEC = importlib.util.spec_from_file_location("ai_analyzer", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
AIAnalyzer = MODULE.AIAnalyzer


def test_sanitize_technical_terms_prefers_whitelist_phrases():
    analyzer = AIAnalyzer(api_key="", provider="ollama")

    transcript = (
        "Nhom ban ve cong nghe thong tin va lap trinh API cho he thong thong tin."
    )
    technical_terms = ["Công nghệ thông tin", "API"]
    keywords = ["hệ thống thông tin", "api"]

    result = analyzer.sanitize_technical_terms(transcript, technical_terms, keywords)

    lowered = {item.lower() for item in result}
    assert "công nghệ thông tin" in lowered
    assert "hệ thống thông tin" in lowered
    assert len(result) == len(lowered)


def test_repair_json_string_closes_trailing_structures():
    analyzer = AIAnalyzer(api_key="", provider="ollama")

    malformed = '{"summary":"ok","keywords":["api",],"technical_terms":["python"]'
    repaired = analyzer._repair_json_string(malformed)
    parsed = json.loads(repaired)

    assert parsed["summary"] == "ok"
    assert parsed["keywords"] == ["api"]
    assert parsed["technical_terms"] == ["python"]


def test_ensure_analysis_completeness_fills_missing_and_removes_overlap():
    analyzer = AIAnalyzer(api_key="", provider="ollama")

    transcript = "Can hoan thanh cong nghe thong tin va lap trinh trong sprint nay."
    data = {
        "summary": "Tong hop",
        "keywords": ["công nghệ thông tin", "lập trình"],
        "technical_terms": ["lập trình"],
        "action_items": [],
    }

    result = analyzer._ensure_analysis_completeness(transcript, data)

    assert result["summary"] == "Tong hop"
    assert isinstance(result["action_items"], list)
    assert len(result["action_items"]) >= 1

    keyword_keys = {item.lower() for item in result["keywords"]}
    term_keys = {item.lower() for item in result["technical_terms"]}
    assert keyword_keys.isdisjoint(term_keys)
