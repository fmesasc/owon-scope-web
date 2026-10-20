import pytest

from owonscope.demo import DemoScpiDriver
from owonscope.model import format_si, parse_si
from owonscope.scpi import ScpiDriver, decode_samples


def test_parse_si():
    assert parse_si("500mV", "V") == pytest.approx(0.5)
    assert parse_si("2.5us", "s") == pytest.approx(2.5e-6)
    assert parse_si("1Ms", "s") == pytest.approx(1e-3)  # OWON writes milliseconds as "Ms" sometimes
    assert parse_si("10V", "V") == 10
    assert format_si(0.5, "V") == "500mV"


def test_capture_and_scaling():
    drv = DemoScpiDriver()
    assert drv.info["model"].startswith("SDS1102")
    cap = drv.capture()
    names = [w.name for w in cap.waveforms]
    assert names == ["CH1", "CH2"]
    ch1 = cap.waveforms[0]
    assert ch1.volts_per_div == pytest.approx(1.0)
    assert ch1.volts.max() == pytest.approx(1.5, abs=0.15)   # simulated 1.5 V sine
    assert cap.time_per_div == pytest.approx(500e-6)
    assert ch1.dt * len(ch1.volts) == pytest.approx(5e-3)


def test_controls_send_scpi():
    drv = DemoScpiDriver()
    assert drv.apply("volts_div", {"channel": "CH2", "value": "200mv"})["sent"] == ":CHANnel2:SCALe 200mv"
    assert drv.apply("timebase", {"value": "1ms"})["sent"] == ":HORizontal:SCALe 1ms"
    assert drv.apply("channel_display", {"channel": "CH1", "value": False})["sent"] == ":CHANnel1:DISPlay OFF"
    assert drv.apply("trigger_level", {"value": "1.5"})["sent"] == ":TRIGger:SINGle:EDGe:LEVel 1.5v"
    cap = drv.capture()
    assert [w.name for w in cap.waveforms] == ["CH2"]
    with pytest.raises(ValueError):
        drv.apply("volts_div", {"channel": "CH1", "value": "3V"})
    with pytest.raises(ValueError):
        drv.apply("format_disk", {})


def test_decode_8_and_16_bit():
    codes, per_div = decode_samples(bytes([1, 255, 2]), 3)
    assert list(codes) == [1, -1, 2] and per_div == 25
    import numpy as np
    big = (np.array([6400, -6400], dtype="<i2")).tobytes()
    codes, per_div = decode_samples(big, 2)
    assert per_div == 25 * 256


def test_channel_count_guess():
    assert ScpiDriver._guess_channels("XDS3104AE") == 4
    assert ScpiDriver._guess_channels("SDS1102") == 2
    assert ScpiDriver._guess_channels("HDS272S") == 2
