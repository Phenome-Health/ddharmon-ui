"""The verify driver's in-flight check (I12) is recorded, and each leg keeps its own evidence (08-28 Wave 4).

Before this, the driver launched the live in-flight spec on legs 2-4 but every leg wrote the SAME
``playwright_inflight.log`` and nothing read the result, so I12 read "skip" in every iteration even when a long batch
leg had been watched — the last leg (Gate 4, which buys nothing and parks in 0 s) always overwrote the evidence.
"""

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("live_verify", ROOT / "scripts" / "live_verify.py")
assert _spec and _spec.loader
live_verify = importlib.util.module_from_spec(_spec)
sys.modules["live_verify"] = live_verify  # its dataclasses resolve annotations through sys.modules
_spec.loader.exec_module(live_verify)


def test_each_leg_writes_its_own_playwright_log():
    assert live_verify.playwright_log_name("inflight", "leg2") != live_verify.playwright_log_name("inflight", "leg3")
    # the per-gate display runs keep their existing names
    assert live_verify.playwright_log_name("gate1") == "playwright_gate1.log"


def test_the_inflight_outcome_is_read_from_the_line_reporter_summary():
    # LIVE_STAGE=inflight skips every other live spec, so only the in-flight spec's own result decides it
    assert live_verify.inflight_outcome("[6/6] ...\n  1 passed (41.2s)\n  5 skipped\n") == "pass"
    assert live_verify.inflight_outcome("[6/6] ...\n  1 failed\n  5 skipped\n") == "fail"
    assert live_verify.inflight_outcome("[6/6] ...\n  6 skipped\n") == "skip"  # the leg parked before a look
    assert live_verify.inflight_outcome("") == "skip"
