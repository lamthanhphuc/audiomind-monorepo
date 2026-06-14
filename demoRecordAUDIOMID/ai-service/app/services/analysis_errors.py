class AnalysisProviderError(Exception):
    def __init__(
        self,
        message: str,
        *,
        provider: str,
        status_code: int,
        retryable: bool = False,
        error_code: str | None = None,
        retry_after_seconds: int | None = None,
    ):
        super().__init__(message)
        self.provider = provider
        self.status_code = status_code
        self.retryable = retryable
        self.error_code = error_code
        self.retry_after_seconds = retry_after_seconds


class AnalysisConfigError(AnalysisProviderError):
    def __init__(
        self,
        message: str,
        *,
        provider: str,
        error_code: str | None = None,
        retry_after_seconds: int | None = None,
    ):
        super().__init__(
            message,
            provider=provider,
            status_code=503,
            retryable=False,
            error_code=error_code,
            retry_after_seconds=retry_after_seconds,
        )


class AnalysisUnavailableError(AnalysisProviderError):
    def __init__(
        self,
        message: str,
        *,
        provider: str,
        error_code: str | None = None,
        retry_after_seconds: int | None = None,
        retryable: bool = True,
    ):
        super().__init__(
            message,
            provider=provider,
            status_code=503,
            retryable=retryable,
            error_code=error_code,
            retry_after_seconds=retry_after_seconds,
        )


class AnalysisRateLimitError(AnalysisProviderError):
    def __init__(
        self,
        message: str,
        *,
        provider: str,
        error_code: str | None = None,
        retry_after_seconds: int | None = None,
    ):
        super().__init__(
            message,
            provider=provider,
            status_code=429,
            retryable=True,
            error_code=error_code,
            retry_after_seconds=retry_after_seconds,
        )


class AnalysisParseError(AnalysisProviderError):
    def __init__(self, message: str, *, provider: str):
        super().__init__(message, provider=provider, status_code=502, retryable=False)


class AnalysisNotImplementedError(AnalysisProviderError):
    def __init__(self, message: str, *, provider: str):
        super().__init__(message, provider=provider, status_code=501, retryable=False)
