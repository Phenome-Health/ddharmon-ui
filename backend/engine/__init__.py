"""The insulation boundary between the GUI and the ddharmon pipeline.

``contract`` defines the stable, UI-owned record shapes; ``adapter`` is the one place that imports
ddharmon and maps its output into the contract. See ``docs/GUI-BUILD-PLAN.md`` §1.
"""

from backend.engine.adapter import build_ui_result, run_pipeline
from backend.engine.contract import CONTRACT_VERSION, PHASES_PREVIEW, PHASES_RUN, UIRecord, UIResult

__all__ = [
    "CONTRACT_VERSION",
    "PHASES_PREVIEW",
    "PHASES_RUN",
    "UIRecord",
    "UIResult",
    "build_ui_result",
    "run_pipeline",
]
