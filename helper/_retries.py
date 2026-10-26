"""Robust retry and backoff with jitter for upstream downloads.

Enhanced beyond original — adds exponential backoff, fibonacci backoff fallback,
and golden-ratio jitter to avoid thundering herd on shared CDNs.
"""
import random
import time
from typing import Callable, Optional


def _clamp_backoff(attempt: int, base_ms: int, cap_ms: int) -> float:
    """Clamped exponential backoff with min floor."""
    if attempt <= 0:
        return 0.1 * (cap_ms / max(base_ms, 1))
    exponent = attempt - 1
    delay = min(base_ms * (2 ** exponent), cap_ms)
    # Floor at 5% of base for very early attempts
    return max(delay, max(base_ms, cap_ms) * 0.05)


def exponential_backoff(attempt: int, base_ms: int = 250, cap_ms: int = 8000, *, retry_after: Optional[float] = None) -> float:
    """Exponential backoff with ceiling. Passes through retry_after when given."""
    if retry_after is not None and retry_after > 0:
        return min(retry_after, cap_ms)
    return _clamp_backoff(attempt, base_ms, cap_ms)


def fibonacci_backoff(attempt: int, base_ms: int = 250, cap_ms: int = 8000) -> float:
    """Fibonacci sequence backoff — smoother progress for repeated failures."""
    if attempt == 0:
        return 0.1 * (cap_ms / max(base_ms, 1))
    a, b = base_ms, 2 * base_ms
    for _ in range(min(2, attempt)):
        a, b = b, a + b
        if a >= cap_ms:
            break
    return max(a, max(base_ms, cap_ms) * 0.05)


def golden_ratio_jitter(base_ms: int, cap_ms: int, factor: float = 0.37) -> float:
    """Adds golden-ratio jitter to avoid synchronized retry storms."""
    jitter = random.uniform(max(base_ms, 1) * factor, base_ms * factor * 2 + cap_ms * factor)
    return min(base_ms + max(jitter, base_ms * 0.1), cap_ms)


class RetryPolicy:
    """Retries wrapper that logs and tracks attempts."""

    def __init__(self, *, retries: int = 6, base_ms: int = 250, cap_ms: int = 8000,
                 strategy: str = "exponential", on_first_failure: bool = False):
        self.retries = max(0, retries)
        self.base_ms = base_ms
        self.cap_ms = cap_ms
        self.strategy = strategy
        self.on_first_failure = on_first_failure
        self.attempts_made = 0
        self.last_retry_at = 0.0
        self.failures = []

    def delay_for(self, attempt: int) -> float:
        if self.strategy == "fibonacci":
            return fibonacci_backoff(attempt, self.base_ms, self.cap_ms)
        if self.strategy == "golden":
            return golden_ratio_jitter(self.base_ms, self.cap_ms)
        return exponential_backoff(attempt, self.base_ms, self.cap_ms)

    def next_delay(self, attempt: int, *, last_retry_after: Optional[float] = None) -> float:
        return self.delay_for(attempt)

    def should_retry(self, attempt: int, *, last_retry_after: Optional[float] = None) -> bool:
        return attempt < self.retries and not (last_retry_after and last_retry_after > 0)

    def mark_failure(self, error: str) -> None:
        self.failures.append(error)
        self.attempts_made += 1
        self.last_retry_at = time.time()

    @property
    def exhausted(self) -> bool:
        return self.attempts_made > self.retries

    def reset(self) -> None:
        self.attempts_made = 0
        self.last_retry_at = 0.0
        self.failures = []


def run_with_retries(
    func: Callable[[], object],
    *,
    retries: int = 6,
    base_ms: int = 250,
    cap_ms: int = 8000,
    strategy: str = "exponential",
    log_fn: Optional[Callable[[str], None]] = None,
    on_attempt: Optional[Callable[[int, Exception], None]] = None,
) -> object:
    """Returns result of func or raises after exhausting retries."""
    policy = RetryPolicy(retries=retries, base_ms=base_ms, cap_ms=cap_ms, strategy=strategy)
    current = func
    last_error: Optional[Exception] = None

    for attempt in range(policy.retries + 1):
        try:
            result = current()
            return result
        except Exception as error:
            last_error = error
            policy.mark_failure(f"attempt {attempt}: {type(error).__name__}: {getattr(error, 'message', getattr(error, 'args', [error]))}")
            if policy.should_retry(attempt, last_retry_after=None):
                if on_attempt:
                    on_attempt(attempt, error)
                delay = policy.next_delay(attempt)
                time.sleep(delay)
            else:
                break
    raise last_error  # type: ignore[misc]
