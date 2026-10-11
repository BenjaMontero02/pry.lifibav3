import pytest

from app.errors import UnsupportedActionError, describe_error
from app.router import handle_action


def test_unknown_action_raises_instead_of_succeeding():
    with pytest.raises(UnsupportedActionError) as caught:
        handle_action("accion-inventada", {}, "req-1")

    assert "accion-inventada" in str(caught.value)
    assert describe_error(caught.value).startswith("UnsupportedActionError: ")


def test_ping_is_still_handled():
    assert handle_action("ping", {}, "req-2") == {"pong": True}
