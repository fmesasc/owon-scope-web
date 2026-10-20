from pathlib import Path

import numpy as np
import pytest

from owonscope.demo import build_legacy_dump
from owonscope.legacy import parse_dump

FIXTURE = Path(__file__).parent / "data" / "pds5022s_spbv01.bin"


def test_real_pds5022s_dump():
    cap = parse_dump(FIXTURE.read_bytes())
    assert cap.settings["format"] == "SPBV01"
    assert [w.name for w in cap.waveforms] == ["CH1", "CH2", "CHA"]
    ch1, ch2, cha = cap.waveforms
    assert len(ch1.volts) == 1000 and len(cha.volts) == 6250
    assert ch1.volts_per_div == pytest.approx(5.0)            # 200 mV/count * 25
    assert ch2.volts_per_div == pytest.approx(0.2)            # 20 mV/div with a x10 probe
    assert ch2.probe == 10
    assert ch1.dt == pytest.approx(10e-9)
    assert cha.dt == pytest.approx(0.4e-6)
    assert cha.frequency == pytest.approx(1347.11, rel=1e-4)
    assert cha.extra["timebase"] == "250us"
    # The CHA trace is a pulse train between about +1.8 V and -6 V
    assert cha.volts.max() == pytest.approx(1.84, abs=0.1)
    assert cha.volts.min() == pytest.approx(-6.08, abs=0.1)


def test_demo_dump_roundtrip():
    cap = parse_dump(build_legacy_dump())
    ch1 = cap.waveforms[0]
    assert ch1.name == "CH1"
    assert np.ptp(ch1.volts) == pytest.approx(5.0, rel=0.1)   # 2.5 V amplitude sine


def test_rejects_garbage():
    with pytest.raises(ValueError):
        parse_dump(b"HELLO WORLD" * 10)
