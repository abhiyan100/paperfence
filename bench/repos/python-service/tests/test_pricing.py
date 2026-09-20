from app.pricing import tier_for, total


def test_standard_tier():
    assert tier_for(10) == "standard"


def test_total_applies_tax():
    assert total(100.0) == 107.0
