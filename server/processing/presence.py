"""
Presence / motion detection from CSI amplitude variance.

Heuristic v1: track a rolling window of CSI amplitude per subcarrier,
compute variance across the window, and flag "motion" when variance
exceeds a baseline-derived threshold. This is intentionally simple —
it's a starting point to prove the pipeline works, not a final detector.

Improve later by replacing `PresenceDetector.update()` with a small
trained classifier (e.g. a lightweight CNN or even a random forest on
hand-engineered features) once you have labeled data from your own house
(walk around with a phone logging ground-truth room/position while
collecting CSI).
"""

from __future__ import annotations

import numpy as np
from collections import deque


class PresenceDetector:
    def __init__(self, window_size: int = 50, baseline_alpha: float = 0.02):
        """
        window_size: number of recent CSI frames to keep for variance calc
        baseline_alpha: EMA smoothing factor for the "empty room" baseline
        """
        self.window: deque[np.ndarray] = deque(maxlen=window_size)
        self.baseline_var: float | None = None
        self.baseline_alpha = baseline_alpha

    def update(self, amplitude: np.ndarray) -> dict:
        """
        amplitude: 1D array of CSI subcarrier amplitudes for this frame.
        Returns dict with motion_level (0-1ish, unbounded above) and
        a boolean presence flag.
        """
        self.window.append(amplitude)

        if len(self.window) < 5:
            return {"motion_level": 0.0, "presence": False, "confidence": 0.0}

        stacked = np.stack(self.window, axis=0)
        # Variance across time, per subcarrier, then averaged — spikes when
        # something in the environment (a person moving) perturbs multipath.
        var_per_subcarrier = np.var(stacked, axis=0)
        current_var = float(np.mean(var_per_subcarrier))

        if self.baseline_var is None:
            self.baseline_var = current_var
        else:
            # Only adapt baseline slowly, and only when things look calm,
            # so a person standing still for a while doesn't get learned
            # in as "the new normal empty room."
            if current_var < self.baseline_var * 2.0:
                self.baseline_var = (
                    (1 - self.baseline_alpha) * self.baseline_var
                    + self.baseline_alpha * current_var
                )

        motion_level = 0.0
        if self.baseline_var > 1e-9:
            motion_level = max(0.0, (current_var - self.baseline_var) / self.baseline_var)

        presence = motion_level > 0.5  # TODO: tune per-node threshold empirically
        confidence = min(1.0, motion_level / 2.0)

        return {
            "motion_level": round(motion_level, 3),
            "presence": presence,
            "confidence": round(confidence, 3),
        }
