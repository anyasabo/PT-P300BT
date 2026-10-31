import pytest

import ptcbp
import ptstatus


def test_control_commands_have_expected_bytes():
    assert ptcbp.serialize_control("reset") == b"\x1b@"
    assert ptcbp.serialize_control("get_status") == b"\x1biS"
    assert ptcbp.serialize_control("print") == b"\x1a"
    assert ptcbp.serialize_control("set_page_margin", 14) == b"\x1bid\x0e\x00"


def test_data_length_prefix_is_little_endian():
    payload = bytes(300)
    encoded = ptcbp.serialize_data(payload, "none")
    assert encoded[:3] == b"G\x2c\x01"
    assert encoded[3:] == payload


def test_data2_is_for_uncompressed_data_only():
    assert ptcbp.serialize_data(b"\x01", "none", use_data2=True)[0:1] == b"g"
    assert ptcbp.serialize_data(b"\x01", "rle", use_data2=True)[0:1] == b"G"


@pytest.mark.parametrize("size", [0, 31, 33])
def test_unpack_status_rejects_a_wrong_size(size):
    with pytest.raises(ValueError, match="32 bytes"):
        ptstatus.unpack_status(bytes(size))
