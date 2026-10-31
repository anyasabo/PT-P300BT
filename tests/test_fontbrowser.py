import pytest

import fontbrowser


@pytest.mark.parametrize(
    ("filename", "label"),
    [
        ("Arial-Bold.ttf", "Arial Bold"),
        ("calibri.ttf", "Calibri"),
        ("texgyreadventor-bold.otf", "Texgyreadventor Bold"),
        ("wingding.ttf", None),
    ],
)
def test_humanize(filename, label):
    assert fontbrowser._humanize(filename) == label


def test_list_and_find_use_the_font_dirs(tmp_path, monkeypatch):
    nested = tmp_path / "nested"
    nested.mkdir()
    (nested / "Demo.TTF").touch()
    (tmp_path / "notes.txt").touch()
    monkeypatch.setattr(fontbrowser, "_font_dirs", lambda: [str(tmp_path)])

    assert fontbrowser.list_system_fonts() == [("Demo", str(nested / "Demo.TTF"))]
    assert fontbrowser.find_font_path("missing.ttf") == "missing.ttf"
    assert fontbrowser.find_font_path(str(nested / "Demo.TTF")) == str(nested / "Demo.TTF")
