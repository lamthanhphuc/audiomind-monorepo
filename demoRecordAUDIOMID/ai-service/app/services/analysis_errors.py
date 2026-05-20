class AnalysisProviderError(Exception):
    def __init__(
        self,
        message: str,
        *,
        provider: str,
        status_code: int,
        retryable: bool = False,
    ):
        super().__init__(message)
        self.provider = provider
        self.status_code = status_code
        self.retryable = retryable


class AnalysisConfigError(AnalysisProviderError):
    def __init__(self, message: str, *, provider: str):
        super().__init__(message, provider=provider, status_code=503, retryable=False)


class AnalysisUnavailableError(AnalysisProviderError):
    def __init__(self, message: str, *, provider: str):
        super().__init__(message, provider=provider, status_code=503, retryable=True)


class AnalysisRateLimitError(AnalysisProviderError):
    def __init__(self, message: str, *, provider: str):
        super().__init__(message, provider=provider, status_code=429, retryable=True)


class AnalysisParseError(AnalysisProviderError):
    def __init__(self, message: str, *, provider: str):
        super().__init__(message, provider=provider, status_code=502, retryable=False)


class AnalysisNotImplementedError(AnalysisProviderError):
    def __init__(self, message: str, *, provider: str):
        super().__init__(message, provider=provider, status_code=501, retryable=False)
