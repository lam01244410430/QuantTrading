import socket

import pytest


def deny_socket(*args, **kwargs):
    raise AssertionError("Test attempted to use sockets")


@pytest.fixture(scope="session", autouse=True)
def offline():
    with pytest.MonkeyPatch.context() as patch:
        for attribute in ("socket", "create_connection", "getaddrinfo", "gethostbyname",
                          "gethostbyname_ex", "gethostbyaddr", "getnameinfo"):
            patch.setattr(socket, attribute, deny_socket)
        yield
