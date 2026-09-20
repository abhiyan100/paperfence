"""Pricing for the billing service."""

TAX_RATE = 0.07
BULK_THRESHOLD = 100


def tier_for(units):
    if units >= BULK_THRESHOLD:
        return "bulk"
    return "standard"


def total(subtotal):
    return round(subtotal * (1 + TAX_RATE), 2)
