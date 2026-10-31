from pathlib import Path

import pytest

import printlabel

FIXTURES = Path(__file__).parent / "fixtures"
FONT = FIXTURES / "FiraCode-subset.ttf"


def label_args(text, *flags):
    return printlabel.set_args().parse_args(["-n", *flags, "x", str(FONT), text])


@pytest.fixture
def font_path():
    return str(FONT)
