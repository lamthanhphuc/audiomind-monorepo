"""Golden-vector tests for shared tokenizer (Epic 3 §2.4)."""

from app.services.tokenizer import (
    normalize_token,
    term_frequency_map,
    tokenize_for_tf_idf,
)


def test_normalize_vietnamese_diacritics():
    assert normalize_token("Hợp") == "hop"
    assert normalize_token("đồng") == "dong"
    assert normalize_token("Đồng") == "dong"


def test_tokenize_for_tf_idf_basic():
    tokens = tokenize_for_tf_idf("Hợp đồng luật sư đã ký")
    assert "hop" in tokens
    assert "dong" in tokens
    assert "luat" in tokens


def test_term_frequency_counts_duplicates():
    tf = term_frequency_map("hop dong hop dong")
    assert tf["hop"] == 2
    assert tf["dong"] == 2
