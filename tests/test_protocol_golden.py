"""Compare the Python protocol bytes with the fixture that web/tests also reads.

Run `UPDATE_GOLDEN=1 pytest tests/test_protocol_golden.py` after a real protocol change.
"""

import json
import os
from pathlib import Path

import labelmaker
import labelmaker_encode
import ptcbp

GOLDEN = Path(__file__).parent / "fixtures" / "protocol.json"


class Sink:
    def __init__(self):
        self.parts = []

    def write(self, data):
        self.parts.append(bytes(data))


def configure(*args, **kwargs):
    sink = Sink()
    labelmaker.configure_printer(sink, *args, **kwargs)
    return b"".join(sink.parts).hex()


def raster(data, nocomp=False):
    return [line.hex() for line in labelmaker_encode.encode_raster_transfer(data, nocomp)]


def snapshot():
    line = bytes(range(16))
    return {
        "control": {
            "reset": ptcbp.serialize_control("reset").hex(),
            "get_status": ptcbp.serialize_control("get_status").hex(),
            "print": ptcbp.serialize_control("print").hex(),
            "zerofill": ptcbp.serialize_control("zerofill").hex(),
            "set_page_margin": ptcbp.serialize_control("set_page_margin", 300).hex(),
        },
        "data": {
            "none": ptcbp.serialize_data(b"\x01\x02\x03", "none").hex(),
            "rle": ptcbp.serialize_data(b"\x00" * 5, "rle").hex(),
        },
        "raster": {
            "input": (bytes(16) + line).hex(),
            "compressed": raster(bytes(16) + line),
            "uncompressed": raster(bytes(16) + line, nocomp=True),
        },
        "configure": {
            "default": configure(16, (1, 12, 0)),
            "auto_cut_chain_margin": configure(
                640, (1, 12, 0), compress=False, chaining=True, auto_cut=True, end_margin=14
            ),
        },
    }


def test_protocol_matches_golden_file():
    current = snapshot()
    if os.environ.get("UPDATE_GOLDEN"):
        GOLDEN.write_text(json.dumps(current, indent=2) + "\n")
    assert current == json.loads(GOLDEN.read_text())
