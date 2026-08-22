"""
Breathing rate estimation from CSI amplitude time series.

Approach: bandpass-filter the mean CSI amplitude signal to the typical
human respiration band (~0.15-0.4 Hz, i.e. 9-24 breaths/min), then find
the dominant frequency via FFT peak-picking over a sliding window.

Works best when the subject is relatively still (seated, sleeping) —
walking/motion will swamp the tiny amplitude modulation breathing causes.
Pair this with PresenceDetector's motion_level: only trust breathing
estimates when motion_level is low.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, filtfilt
from collections import deque

BREATH_BAND_HZ = (0.15, 0.4)  # ~9-24 breaths/min


class BreathingEstimator:
    def __init__(self, sample_rate_hz: float, window_seconds: float = 20.0):
        """
        sample_rate_hz: expected CSI frame rate from this node (frames/sec).
            NOTE: real-world CSI arrival is often irregular (packet-driven,
            not a fixed clock) — for v1 we assume it's roughly steady and
            resample isn't implemented yet. If your packet rate is bursty,
            add a resampling step to a uniform time base before filtering.
        window_seconds: how much history to analyze per estimate.
        """
        self.sample_rate_hz = sample_rate_hz
        self.window_len = max(16, int(sample_rate_hz * window_seconds))
        self.buffer: deque[float] = deque(maxlen=self.window_len)

    def update(self, amplitude: np.ndarray) -> dict:
        """
        amplitude: 1D array of CSI subcarrier amplitudes for this frame.
        Returns dict with breath_rate_bpm (or None if not enough data /
        signal too weak) and a rough confidence score.
        """
        self.buffer.append(float(np.mean(amplitude)))

        if len(self.buffer) < self.window_len // 2:
            return {"breath_rate_bpm": None, "confidence": 0.0}

        signal = np.array(self.buffer, dtype=np.float64)
        signal = signal - np.mean(signal)

        try:
            nyquist = self.sample_rate_hz / 2.0
            low, high = BREATH_BAND_HZ
            low_n, high_n = low / nyquist, min(0.99, high / nyquist)
            b, a = butter(N=4, Wn=[low_n, high_n], btype="band")
            filtered = filtfilt(b, a, signal)
        except Exception:
            # Sample rate too low for this band, or not enough samples for
            # filtfilt's default padding — bail out gracefully.
            return {"breath_rate_bpm": None, "confidence": 0.0}

        # FFT peak-pick within the breathing band
        freqs = np.fft.rfftfreq(len(filtered), d=1.0 / self.sample_rate_hz)
        spectrum = np.abs(np.fft.rfft(filtered))

        band_mask = (freqs >= BREATH_BAND_HZ[0]) & (freqs <= BREATH_BAND_HZ[1])
        if not np.any(band_mask):
            return {"breath_rate_bpm": None, "confidence": 0.0}

        band_freqs = freqs[band_mask]
        band_power = spectrum[band_mask]
        peak_idx = int(np.argmax(band_power))
        peak_freq = band_freqs[peak_idx]
        peak_power = band_power[peak_idx]

        total_power = np.sum(spectrum) + 1e-9
        confidence = float(min(1.0, peak_power / total_power * 10))  # rough, tune later

        breath_rate_bpm = round(peak_freq * 60.0, 1)

        return {
            "breath_rate_bpm": breath_rate_bpm,
            "confidence": round(confidence, 3),
        }
