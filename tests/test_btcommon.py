import btcommon
import pytest


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("98:6E:E8:4B:33:E5", True),
        ("98-6e-e8-4b-33-e5", True),
        ("986EE84B33E5", True),
        ("PT-P300", False),
        ("98:6E:E8", False),
    ],
)
def test_looks_like_mac(value, expected):
    assert btcommon._looks_like_mac(value) is expected


class FakeSocket:
    def __init__(self, reply=b"", error=None):
        self.reply = reply
        self.error = error
        self.sent = b""
        self.closed = False

    def sendall(self, data):
        self.sent += data

    def settimeout(self, _timeout):
        pass

    def recv(self, size):
        if self.error:
            raise self.error
        return self.reply[:size]

    def close(self):
        self.closed = True


def test_socket_adapter_writes_and_reads():
    sock = FakeSocket(reply=b"abcdef")
    with btcommon._SocketSerialAdapter(sock) as port:
        assert port.write(b"xy") == 2
        assert port.read(3) == b"abc"
    assert sock.sent == b"xy"
    assert sock.closed
    assert not port.is_open


def test_socket_adapter_returns_no_data_on_timeout():
    port = btcommon._SocketSerialAdapter(FakeSocket(error=TimeoutError()))
    assert port.read(1) == b""
