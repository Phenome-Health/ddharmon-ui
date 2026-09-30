"""The live-verify rig's spend tap — an INDEPENDENT meter of what a run actually cost (08-28 Wave 0).

Loaded only by the rig backend (``scripts/rig.sh`` puts this directory on ``PYTHONPATH``, so Python imports it
as ``sitecustomize`` at startup); nothing in the product imports it. It wraps the two Anthropic SDK calls that
bill — ``messages.create`` (every sync call) and ``messages.batches.results`` (every batch answer) — and
appends one JSON line per billed answer to ``$DDHARMON_RIG_TAP_LOG``: transport, model, token counts, and a
stage hint (the batch ``custom_id``, or a short digest of the system prompt for a sync call).

Why it exists: the loop's cost invariant (I2) compares what the APP says it spent against what it spent, and
the app's own ledger is the thing under test — so the reference cannot be the app's ledger. This reads the
provider's usage block on each response, which is what the bill is computed from.

It never touches credentials: it reads ``response.usage`` / ``response.model`` / a result's ``custom_id``, never
headers, keys or prompt text. A tap failure is swallowed — it must not be able to break a paid call.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from typing import Any

_LOG = os.environ.get("DDHARMON_RIG_TAP_LOG")
_LOCK = threading.Lock()


def _write(row: dict[str, Any]) -> None:
    if not _LOG:
        return
    try:
        with _LOCK, open(_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")
    except Exception:  # noqa: BLE001 - a meter must never break the thing it meters
        pass


def _usage(message: Any) -> tuple[int, int]:
    usage = getattr(message, "usage", None)
    return int(getattr(usage, "input_tokens", 0) or 0), int(getattr(usage, "output_tokens", 0) or 0)


def _system_digest(system: Any) -> str:
    text = system if isinstance(system, str) else json.dumps(system, default=str)
    return hashlib.sha256(text[:400].encode("utf-8", "replace")).hexdigest()[:10]


def _install() -> None:
    try:
        from anthropic.resources.messages import Messages
        from anthropic.resources.messages.batches import Batches
    except Exception:  # noqa: BLE001 - no SDK, nothing to meter
        return

    create = Messages.create

    def tapped_create(self: Any, *args: Any, **kwargs: Any) -> Any:
        response = create(self, *args, **kwargs)
        try:
            tokens_in, tokens_out = _usage(response)
            tools = kwargs.get("tools") or []
            _write(
                {
                    "ts": time.time(),
                    "transport": "sync",
                    "model": getattr(response, "model", None) or kwargs.get("model"),
                    "inputTokens": tokens_in,
                    "outputTokens": tokens_out,
                    "system": _system_digest(kwargs.get("system") or ""),
                    "tool": (tools[0].get("name") if tools and isinstance(tools[0], dict) else None),
                    "temperature": kwargs.get("temperature"),
                    "maxTokens": kwargs.get("max_tokens"),
                }
            )
        except Exception:  # noqa: BLE001
            pass
        return response

    results = Batches.results

    def tapped_results(self: Any, message_batch_id: str, *args: Any, **kwargs: Any) -> Any:
        inner = results(self, message_batch_id, *args, **kwargs)

        def gen() -> Any:
            for item in inner:
                try:
                    if getattr(item.result, "type", None) == "succeeded":
                        message = item.result.message
                        tokens_in, tokens_out = _usage(message)
                        _write(
                            {
                                "ts": time.time(),
                                "transport": "batch",
                                "batchId": message_batch_id,
                                "customId": item.custom_id,
                                "model": getattr(message, "model", None),
                                "inputTokens": tokens_in,
                                "outputTokens": tokens_out,
                            }
                        )
                except Exception:  # noqa: BLE001
                    pass
                yield item

        return gen()

    Messages.create = tapped_create  # type: ignore[method-assign]
    Batches.results = tapped_results  # type: ignore[method-assign]
    _write({"ts": time.time(), "transport": "tap", "event": "installed", "pid": os.getpid()})


if _LOG:
    _install()
