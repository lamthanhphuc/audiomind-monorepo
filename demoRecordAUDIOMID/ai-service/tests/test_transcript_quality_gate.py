from app.services.transcript_quality_gate import (
    SKIP_REASON_SHORT,
    evaluate_transcript_quality,
    normalize_transcript_text,
)


def test_normalize_strips_punctuation_and_whitespace():
    assert normalize_transcript_text("  Xin   chào!  ") == "xin chào"


def test_gate_rejects_79_chars():
    text = "a" * 79
    verdict = evaluate_transcript_quality(text)
    assert verdict.should_analyze is False
    assert verdict.normalized_chars == 79
    assert verdict.skip_reason == SKIP_REASON_SHORT


def test_gate_allows_80_chars():
    text = " ".join([f"term{i:02d}abcdefghij" for i in range(12)])
    verdict = evaluate_transcript_quality(text)
    assert verdict.should_analyze is True
    assert verdict.normalized_chars >= 80


def test_gate_rejects_11_words():
    text = " ".join(f"word{i}" for i in range(11))
    verdict = evaluate_transcript_quality(text)
    assert verdict.should_analyze is False
    assert verdict.word_count == 11


def test_gate_allows_12_words():
    text = " ".join([f"keyword{i:02d}" for i in range(12)])
    verdict = evaluate_transcript_quality(text)
    assert verdict.should_analyze is True
    assert verdict.word_count == 12


def test_gate_rejects_mostly_filler():
    text = "ừ à ờ hmm uh um ừ à ờ hmm uh um extra"
    verdict = evaluate_transcript_quality(text)
    assert verdict.should_analyze is False


def test_gate_rejects_duplicate_micro_loop():
    phrase = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"
    text = " ".join([phrase] * 4)
    verdict = evaluate_transcript_quality(text)
    assert verdict.should_analyze is False


def test_gate_disabled_always_allows():
    text = "hi"
    verdict = evaluate_transcript_quality(text, enabled=False)
    assert verdict.should_analyze is True
