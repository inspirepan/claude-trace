from mitmproxy import http
from urllib.parse import urlparse
import json
import os
import time


OUTPUT_FILE = os.environ["CLAUDE_TRACE_OUTPUT_FILE"]
INCLUDE_ALL_REQUESTS = os.environ.get("CLAUDE_TRACE_INCLUDE_ALL_REQUESTS") == "true"
ANTHROPIC_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
ANTHROPIC_HOST = urlparse(ANTHROPIC_BASE_URL).hostname or "api.anthropic.com"


def is_claude_api(url: str) -> bool:
    is_anthropic_api = ANTHROPIC_HOST in url
    is_bedrock_api = "bedrock-runtime." in url and ".amazonaws.com" in url
    if INCLUDE_ALL_REQUESTS:
        return is_anthropic_api or is_bedrock_api
    return (is_anthropic_api and "/v1/messages" in url) or is_bedrock_api


def redact_sensitive_headers(headers: dict[str, str]) -> dict[str, str]:
    sensitive_keys = [
        "authorization",
        "x-api-key",
        "x-auth-token",
        "cookie",
        "set-cookie",
        "x-session-token",
        "x-access-token",
        "bearer",
        "proxy-authorization",
    ]
    redacted = dict(headers)
    for key, value in list(redacted.items()):
        lower_key = key.lower()
        if any(sensitive in lower_key for sensitive in sensitive_keys):
            if value and len(value) > 14:
                redacted[key] = f"{value[:10]}...{value[-4:]}"
            elif value and len(value) > 4:
                redacted[key] = f"{value[:2]}...{value[-2:]}"
            else:
                redacted[key] = "[REDACTED]"
    return redacted


def parse_request_body(request: http.Request):
    if not request.content:
        return None
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            return json.loads(request.get_text(strict=False))
        except Exception:
            return request.get_text(strict=False)
    return request.get_text(strict=False)


def parse_response_body(response: http.Response) -> dict:
    content_type = response.headers.get("content-type", "")
    text = response.get_text(strict=False)
    if "application/json" in content_type:
        try:
            return {"body": json.loads(text)}
        except Exception:
            return {"body_raw": text}
    return {"body_raw": text}


def response(flow: http.HTTPFlow) -> None:
    url = flow.request.pretty_url
    if not is_claude_api(url):
        return

    pair = {
        "request": {
            "timestamp": flow.request.timestamp_start or time.time(),
            "method": flow.request.method,
            "url": url,
            "headers": redact_sensitive_headers(dict(flow.request.headers.items())),
            "body": parse_request_body(flow.request),
        },
        "response": {
            "timestamp": flow.response.timestamp_end or time.time(),
            "status_code": flow.response.status_code,
            "headers": redact_sensitive_headers(dict(flow.response.headers.items())),
            **parse_response_body(flow.response),
        },
        "logged_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
    }

    with open(OUTPUT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(pair) + "\n")