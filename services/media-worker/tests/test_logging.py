import io
import json
import logging

import pytest

from media_worker.logging_config import (
    JsonFormatter,
    LogLevelError,
    install_logging,
    parse_level,
)


def test_parse_level_defaults_and_accepts_case_insensitive_values():
    assert parse_level(None) == logging.INFO
    assert parse_level("") == logging.INFO
    assert parse_level("DEBUG") == logging.DEBUG
    assert parse_level("Warn") == logging.WARNING
    assert parse_level("error") == logging.ERROR


def test_parse_level_rejects_unknown_values():
    with pytest.raises(LogLevelError, match="LOG_LEVEL"):
        parse_level("verbose")


def test_install_logging_writes_contract_json_to_the_given_stream():
    stream = io.StringIO()
    install_logging("media-worker", {"LOG_LEVEL": "info"}, stream=stream)
    logging.getLogger("media_worker").info("consumiendo media:uploads")

    entry = json.loads(stream.getvalue())
    assert entry["level"] == "info"
    assert entry["service"] == "media-worker"
    assert entry["message"] == "consumiendo media:uploads"
    assert entry["timestamp"].endswith("Z")
    assert "correlation_id" not in entry


def test_install_logging_filters_below_the_configured_level():
    stream = io.StringIO()
    install_logging("media-worker", {"LOG_LEVEL": "warn"}, stream=stream)
    logger = logging.getLogger("media_worker")

    logger.debug("hidden")
    logger.info("hidden")
    logger.warning("shown")

    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert [line["level"] for line in lines] == ["warn"]


def test_json_formatter_maps_warning_to_warn_and_includes_errors():
    record = logging.LogRecord(
        name="media_worker",
        level=logging.WARNING,
        pathname=__file__,
        lineno=1,
        msg="algo falló",
        args=(),
        exc_info=None,
    )
    entry = json.loads(JsonFormatter("media-worker").format(record))
    assert entry["level"] == "warn"
    assert entry["message"] == "algo falló"
