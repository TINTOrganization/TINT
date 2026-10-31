import json
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from media_worker.storage import (
    CACHE_CONTROL,
    BlobNotFoundError,
    S3BlobStore,
    ambilight_key,
    rendition_key,
    source_key,
)


def test_rendition_key_is_height_suffixed_mp4():
    assert rendition_key("abc", 720) == "abc/720p.mp4"
    assert rendition_key("abc", 360) == "abc/360p.mp4"


def client_error(code):
    return ClientError({"Error": {"Code": code, "Message": "x"}}, "GetObject")


def test_ambilight_key_is_deterministic_per_video():
    assert ambilight_key("abc") == "abc/ambilight.json"


def test_source_key_is_always_mp4():
    assert source_key("abc") == "abc/source.mp4"


@pytest.mark.parametrize("key", ["v1/source.mp4", "v1/720p.mp4", "v1/360p.mp4"])
def test_upload_file_puts_mp4_with_content_type_and_cache_control(tmp_path, key):
    client = Mock()
    path = tmp_path / "clip.mp4"
    S3BlobStore(client, "tint-media").upload_file(path, key)
    client.upload_file.assert_called_once_with(
        str(path),
        "tint-media",
        key,
        ExtraArgs={"ContentType": "video/mp4", "CacheControl": "public, max-age=86400"},
    )


def test_upload_file_falls_back_to_octet_stream_for_unknown_types(tmp_path):
    client = Mock()
    S3BlobStore(client, "tint-media").upload_file(tmp_path / "x", "v1/blob.bin")
    extra = client.upload_file.call_args.kwargs["ExtraArgs"]
    assert extra["ContentType"] == "application/octet-stream"
    assert extra["CacheControl"] == CACHE_CONTROL


def test_cache_control_is_not_immutable_because_reprocessing_overwrites_keys():
    assert CACHE_CONTROL == "public, max-age=86400"
    assert "immutable" not in CACHE_CONTROL


def test_download_fetches_object_to_destination(tmp_path):
    client = Mock()
    S3BlobStore(client, "tint-media").download("v1/source.mp4", tmp_path / "source.mp4")
    client.download_file.assert_called_once_with(
        "tint-media", "v1/source.mp4", str(tmp_path / "source.mp4")
    )


@pytest.mark.parametrize("code", ["404", "NoSuchKey", "NotFound"])
def test_download_missing_object_raises_blob_not_found(tmp_path, code):
    client = Mock()
    client.download_file.side_effect = client_error(code)
    with pytest.raises(BlobNotFoundError, match="v1/source.mp4"):
        S3BlobStore(client, "tint-media").download("v1/source.mp4", tmp_path / "s.mp4")


def test_download_propagates_other_errors(tmp_path):
    client = Mock()
    client.download_file.side_effect = client_error("AccessDenied")
    with pytest.raises(ClientError):
        S3BlobStore(client, "tint-media").download("v1/source.mp4", tmp_path / "s.mp4")


def test_put_json_overwrites_key_with_compact_json():
    client = Mock()
    data = [
        {"t_ms": 0, "top": "#000000", "bottom": "#000000", "left": "#000000", "right": "#000000"}
    ]
    S3BlobStore(client, "tint-media").put_json("v1/ambilight.json", data)
    kwargs = client.put_object.call_args.kwargs
    assert kwargs["Bucket"] == "tint-media"
    assert kwargs["Key"] == "v1/ambilight.json"
    assert kwargs["ContentType"] == "application/json"
    assert kwargs["CacheControl"] == CACHE_CONTROL
    assert json.loads(kwargs["Body"]) == data
    assert b" " not in kwargs["Body"]
