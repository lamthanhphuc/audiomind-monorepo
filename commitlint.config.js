module.exports = {
  extends: ['@commitlint/config-conventional'],
  // Historical Phase 1 commit bodies exceed the default 100-char line limit.
  // Keep subject/type linting strict; do not rewrite already-pushed history.
  rules: {
    'body-max-line-length': [0],
  },
  // Allow local merge commits that resolve conflicts without rewriting history.
  // GitHub's synthetic "Merge <sha> into <sha>" messages are already ignored by
  // @commitlint/is-ignored defaults in some versions; keep an explicit guard.
  ignores: [
    (message) => /^merge(\(.+\))?:/i.test(String(message || '').trim()),
    (message) => /^Merge [0-9a-f]+ into [0-9a-f]+/i.test(String(message || '').trim()),
  ],
};
