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


def test_normalize_gemini_structured_analysis_handles_defaults_and_legacy_aliases():
    analyzer = AIAnalyzer(api_key="", provider="gemini")

    transcript = "Bug log cho API gateway va cache layer."
    payload = {
        "summary": "Tong hop san pham",
        "keywords": ["API", "api", "cache"],
        "technicalTerms": [
            {
                "term": "API",
                "meaning": "Giao dien lap trinh ung dung",
                "category": "protocol",
            },
            {"term": "Cache", "meaning": "Bo nho dem", "category": "infra"},
        ],
        "painPoints": [
            {"title": "Do tre", "evidence": "phuc hoi cham", "severity": "urgent"}
        ],
        "actionItems": [
            {
                "task": "Toi uu cache",
                "priority": "high",
                "status": "open",
                "evidence": "Speaker 2: can toi uu cache",
            }
        ],
        "keyDecisions": ["Uu tien cache truoc"],
        "risks": ["Do tre cao gio cao diem"],
        "blockers": ["Chua co monitoring day du"],
        "questions": ["Can bo sung autoscaling khong"],
        "nextSteps": ["Cap nhat cau hinh cache"],
        "businessImpact": "Giam thoi gian cho cua khach hang",
        "customerImpact": "Trai nghiem on dinh hon",
        "technicalImpact": "Giam tai backend",
        "confidence": 0.62,
        "promptVersion": "gemini-business-v1",
        "schemaVersion": "gemini-business-v1",
        "domainMode": "business",
        "topics": ["van de hien thi"],
    }

    result = analyzer._normalize_gemini_structured_analysis(transcript, payload)

    assert result["summary"] == "Tong hop san pham"
    assert result["domainMode"] == "business"
    assert result["meetingSummary"] == "Tong hop san pham"
    assert result["keywords"] == []
    assert result["technicalTerms"][0]["term"] == "API"
    assert result["painPoints"][0]["severity"] == "medium"
    assert result["actionItems"] == ["Toi uu cache"]
    assert result["businessActionItems"][0]["priority"] == "high"
    assert result["businessActionItems"][0]["status"] == "open"
    assert result["key_points"] == []
    assert result["keyDecisions"] == ["Uu tien cache truoc"]
    assert result["risks"] == ["Do tre cao gio cao diem"]
    assert result["blockers"] == ["Chua co monitoring day du"]
    assert result["risks_blockers"] == [
        "Do tre cao gio cao diem",
        "Chua co monitoring day du",
        "Do tre",
    ]
    assert result["businessImpact"] == "Giam thoi gian cho cua khach hang"
    assert result["confidence"] == 0.62
    assert result["promptVersion"] == "gemini-business-v1"
    assert result["schemaVersion"] == "gemini-business-v1"
    assert result["topics"] == ["van de hien thi"]


def test_normalize_gemini_structured_analysis_does_not_invent_owner_or_due_date():
    analyzer = AIAnalyzer(api_key="", provider="gemini")
    payload = {
        "summary": "Ban ve backlog sprint",
        "actionItems": [{"task": "Cap nhat backlog"}],
        "domainMode": "business",
    }

    result = analyzer._normalize_gemini_structured_analysis("transcript", payload)
    item = result["businessActionItems"][0]
    assert item["task"] == "Cap nhat backlog"
    assert item["owner"] is None
    assert item["dueDate"] is None
    assert item["deadline"] is None


def test_default_structured_analysis_uses_concise_fallback_summary():
    analyzer = AIAnalyzer(api_key="", provider="gemini")

    transcript = (
        "Speaker 1: Hôm nay chúng ta bàn về API gateway và cache layer. "
        "Speaker 2: Cần cập nhật cấu hình triển khai. "
        "Speaker 1: Sau đó kiểm tra lại luồng xác thực và theo dõi lỗi."
    )

    result = analyzer._default_structured_analysis(transcript, "parse_error")

    assert result["summary"] != transcript
    assert len(result["summary"]) < len(transcript)
    assert result["summary"]
    assert result["keywords"] == []
    assert result["technicalTerms"] == []
    assert result["painPoints"] == []
    assert result["actionItems"] == []
