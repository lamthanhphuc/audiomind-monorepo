from app.logging_utils import (
    safe_error_message,
    sanitize_log_value,
    transcript_hash_prefix,
)


def test_sanitize_log_value_redacts_sensitive_tokens():
    value = "Authorization: Bearer secret-token-value"
    assert sanitize_log_value(value) == "redacted"


def test_safe_error_message_is_short_and_non_empty():
    message = safe_error_message(RuntimeError("timeout while contacting provider"))
    assert "RuntimeError" in message
    assert len(message) <= 180


def test_transcript_hash_prefix_is_stable():
    first = transcript_hash_prefix("hello world")
    second = transcript_hash_prefix("hello world")
    third = transcript_hash_prefix("different text")
    assert first == second
    assert first != third
    assert len(first) == 12
