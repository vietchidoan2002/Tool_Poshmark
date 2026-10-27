const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isRetryable(error) {
    const status = Number(error.response?.status || error.code);
    const reasons = error.response?.data?.error?.errors || [];
    return status === 429 || status >= 500 && status <= 599 ||
        status === 403 && reasons.some(x => /^(userRateLimitExceeded|rateLimitExceeded|quotaExceeded)$/.test(x.reason));
}

function createGoogleRequest({ wait = sleep, now = Date.now, random = Math.random,
    minInterval = 650, maxRetries = 3, budgetMs = 150000, onRetry = () => {} } = {}) {
    const deadline = now() + budgetMs;
    let lastRequest = -Infinity;
    return async function request(operation) {
        for (let attempt = 0; ; attempt++) {
            const delay = Math.max(0, lastRequest + minInterval - now());
            if (now() + delay >= deadline) throw new Error('Đã hết thời gian xử lý an toàn. Chạy lại để tiếp tục các email còn lại.');
            if (delay) await wait(delay);
            lastRequest = now();
            try {
                return await operation({ timeout: Math.max(1, Math.min(15000, deadline - now())), retry: false });
            } catch (error) {
                if (!isRetryable(error) || attempt >= maxRetries) throw error;
                const headers = error.response?.headers;
                const raw = headers?.get?.('retry-after') ?? headers?.['retry-after'];
                const retryAfter = raw == null ? 0 : /^\d+(\.\d+)?$/.test(String(raw))
                    ? Number(raw) * 1000 : Math.max(0, Date.parse(raw) - now()) || 0;
                const backoff = Math.max(retryAfter, 5000 * 2 ** attempt + Math.floor(random() * 1000));
                if (now() + backoff >= deadline) throw error;
                onRetry(attempt + 1, backoff);
                await wait(backoff);
            }
        }
    };
}
module.exports = { createGoogleRequest, isRetryable };
