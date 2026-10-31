"""Build labels with the fixture font and check them against the printer limits."""

import pytest
from conftest import label_args
from PIL import ImageChops

import printlabel

PRINTABLE_TOP = 12
PRINTABLE_BOTTOM = 75


def ink_box(image):
    """Return (left, top, right, bottom) of the dark pixels, with an inclusive edge."""
    gray = image.convert("L")
    left, top, right, bottom = gray.point(lambda v: 255 if v < 128 else 0).getbbox()
    return left, top, right - 1, bottom - 1


@pytest.mark.parametrize("text", ["KEEB", "MOUSE", "SO", "HUB 0      HUB 0"])
def test_single_line_stays_in_the_printable_band(text):
    image = printlabel.build_label(label_args(text))
    assert image.height == 88
    _, top, _, bottom = ink_box(image)
    assert top >= PRINTABLE_TOP
    assert bottom <= PRINTABLE_BOTTOM


def test_multiline_stays_in_the_printable_band():
    image = printlabel.build_label(label_args("Top\\nBottom"))
    _, top, _, bottom = ink_box(image)
    assert top >= PRINTABLE_TOP
    assert bottom <= PRINTABLE_BOTTOM


def test_emoji_print_area_does_not_move_plain_text():
    plain = printlabel.build_label(label_args("Hello"))
    area = printlabel.build_label(label_args("Hello", "--emoji-print-area"))
    assert ImageChops.difference(plain.convert("L"), area.convert("L")).getbbox() is None


def test_v_shift_moves_the_text():
    plain = ink_box(printlabel.build_label(label_args("Hi")))
    shifted = ink_box(printlabel.build_label(label_args("Hi", "--v-shift", "5")))
    assert shifted[1] == plain[1] + 5


def test_fixed_width_sets_the_label_length():
    image = printlabel.build_label(label_args("Hi", "--fixed-width", "30"))
    assert image.width == round(30 / 0.149)


def test_end_margin_adds_blank_dots():
    plain = printlabel.build_label(label_args("Hi"))
    margin = printlabel.build_label(label_args("Hi", "--end-margin", "30"))
    assert margin.width == plain.width + 30


def test_rasterize_gives_128_dot_lines():
    args = label_args("Hi")
    image = printlabel.build_label(args)
    raster = printlabel.rasterize_label(image, args)
    assert raster.width == 128
    assert raster.height == image.width
