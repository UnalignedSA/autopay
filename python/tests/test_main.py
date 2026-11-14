from pathlib import Path

from autopay.__main__ import load_env_file, parse_env_file


def test_parses_key_value_lines_comments_quotes_and_export() -> None:
    text = """
# a comment
A=1
export B=two words
C="quoted # not a comment"
D='single'
E=value # trailing comment
  F = spaced  
EMPTY=
NOEQUALS
=nokey
"""
    assert parse_env_file(text) == {
        "A": "1",
        "B": "two words",
        "C": "quoted # not a comment",
        "D": "single",
        "E": "value",
        "F": "spaced",
        "EMPTY": "",
    }


def test_a_single_quoted_value_is_taken_literally() -> None:
    assert parse_env_file("""QUOTED='p#ss $HOME "q" x'\n""") == {"QUOTED": 'p#ss $HOME "q" x'}


def test_the_file_never_overrides_a_variable_that_is_already_set(tmp_path: Path) -> None:
    path = tmp_path / ".env"
    path.write_text("A=from-file\nB=from-file\n")
    env = {"A": "from-env"}
    load_env_file(path, env)
    assert env == {"A": "from-env", "B": "from-file"}


def test_a_missing_env_file_is_fine(tmp_path: Path) -> None:
    env: dict[str, str] = {}
    load_env_file(tmp_path / "nope", env)
    assert env == {}
